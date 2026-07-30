"""Persistent, privacy-bounded operational logging for Settings > App Logs."""
from __future__ import annotations

import inspect
import json
import logging
from pathlib import Path
import re
import traceback
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import SessionLocal
from app.core.pagination import PageParams, paginate
from app.platform.admin.schemas import FrontendErrorIn
from app.platform.settings.models import AppLog

log = logging.getLogger("app.error_reporting")

MAX_MESSAGE = 4_000
MAX_STACK = 30_000
MAX_CONTEXT_BYTES = 8_000
MAX_CONTEXT_DEPTH = 4
MAX_CONTEXT_ENTRIES = 30
MAX_CONTEXT_ARRAY = 20
MAX_CONTEXT_STRING = 1_000
REDACTED = "[REDACTED]"

SENSITIVE_KEY = re.compile(
    r"password|passwd|pwd|token|authorization|cookie|secret|api[_-]?key|"
    r"credential|session|jwt|database[_-]?url|hcm[_-]?(?:key|token)",
    re.IGNORECASE,
)
UNSAFE_CONTAINER_KEY = re.compile(
    r"(?:^|_)(?:body|form|form_data|request_body|response_body|headers?|query|"
    r"query_string|search_params|params|payload|values)(?:$|_)",
    re.IGNORECASE,
)
REQUEST_ID = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
KEY_VALUE_SECRET = re.compile(
    r"\b(password|passwd|pwd|token|authorization|cookie|secret|api[_-]?key|"
    r"database[_-]?url|hcm[_-]?(?:key|token))\b"
    r"([\"']?\s*[:=]\s*[\"']?)([^\s,;}]+)",
    re.IGNORECASE,
)
DATABASE_URL = re.compile(
    r"\b(?:mysql|postgres(?:ql)?)(?:\+\w+)?://\S+",
    re.IGNORECASE,
)
BEARER = re.compile(r"\bBearer\s+\S+", re.IGNORECASE)


def _trim(value: str | None, limit: int) -> str | None:
    clean = value.strip() if value else ""
    return clean[:limit] if clean else None


def _redact_text(value: str | None, limit: int) -> str | None:
    clean = _trim(value, limit)
    if not clean:
        return None
    clean = BEARER.sub("Bearer [REDACTED]", clean)
    clean = KEY_VALUE_SECRET.sub(
        lambda match: f"{match.group(1)}{match.group(2)}{REDACTED}",
        clean,
    )
    clean = DATABASE_URL.sub("[REDACTED_DATABASE_URL]", clean)
    return clean[:limit]


def safe_request_id(value: str | None) -> str:
    clean = _trim(value, 64)
    return clean if clean and REQUEST_ID.fullmatch(clean) else str(uuid4())


def _safe_value(value, depth: int = 0):
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _redact_text(value, MAX_CONTEXT_STRING)
    if depth >= MAX_CONTEXT_DEPTH:
        return None
    if isinstance(value, (list, tuple)):
        return [
            item for item in (
                _safe_value(entry, depth + 1)
                for entry in value[:MAX_CONTEXT_ARRAY]
            )
            if item is not None
        ]
    if isinstance(value, dict):
        output = {}
        for raw_key, item in list(value.items())[:MAX_CONTEXT_ENTRIES]:
            key = _trim(str(raw_key), 100)
            if not key or (
                key != "query_fields" and UNSAFE_CONTAINER_KEY.search(key)
            ):
                continue
            if SENSITIVE_KEY.search(key):
                output[key] = REDACTED
                continue
            safe = _safe_value(item, depth + 1)
            if safe is not None:
                output[key] = safe
        return output
    return None


def _safe_context(value: dict | None) -> dict | None:
    if not value:
        return None
    safe = _safe_value(value)
    if not isinstance(safe, dict):
        return None
    serialized = json.dumps(safe, ensure_ascii=True, separators=(",", ":"))
    if len(serialized.encode("utf-8")) <= MAX_CONTEXT_BYTES:
        return safe
    kind = safe.get("kind")
    return {
        **({"kind": kind[:100]} if isinstance(kind, str) else {}),
        "context_truncated": True,
        "original_size": len(serialized.encode("utf-8")),
    }


def _code_path(filename: str | None) -> str | None:
    """Return a bounded path an engineer can search from the repository root."""
    if not filename:
        return None
    normalized = filename.replace("\\", "/").split("?", 1)[0].split("#", 1)[0]
    if normalized.startswith(("backend/", "frontend/")):
        return _trim(normalized, 500)
    for marker, prefix in (
        ("/backend/app/", "backend/app/"),
        ("/frontend/", "frontend/"),
        ("/app/", "backend/app/"),
        ("/src/", "frontend/src/"),
        ("/assets/", "frontend/dist/assets/"),
    ):
        if marker in normalized:
            return _trim(f"{prefix}{normalized.split(marker, 1)[1]}", 500)
    return _trim(Path(normalized).name, 500)


def _exception_location(
    request: Request,
    exc: Exception,
) -> tuple[str | None, str | None, int | None, int | None]:
    frames = traceback.extract_tb(exc.__traceback__) if exc.__traceback__ else []
    app_frames = [
        frame for frame in frames
        if "/app/" in frame.filename.replace("\\", "/")
        and not frame.filename.replace("\\", "/").endswith("/admin/app_logs.py")
    ]
    if app_frames:
        frame = app_frames[-1]
        column = getattr(frame, "colno", None)
        return _code_path(frame.filename), _trim(frame.name, 200), frame.lineno, column

    endpoint = request.scope.get("endpoint")
    if endpoint:
        try:
            filename = inspect.getsourcefile(endpoint)
            _lines, line = inspect.getsourcelines(endpoint)
            return (
                _code_path(filename),
                _trim(getattr(endpoint, "__name__", None), 200),
                line,
                None,
            )
        except (OSError, TypeError):
            return None, _trim(getattr(endpoint, "__name__", None), 200), None, None
    return None, None, None, None


def _route_name(request: Request) -> str | None:
    route = request.scope.get("route")
    return _trim(getattr(route, "path", None) or request.url.path, 500)


def _safe_url(value: str | None, limit: int = 1_000) -> str | None:
    """Keep scheme/host/path when appropriate, never query or fragment values."""
    if not value:
        return None
    parsed = urlsplit(value)
    if parsed.scheme and parsed.netloc:
        return _trim(f"{parsed.scheme}://{parsed.netloc}{parsed.path}", limit)
    return _trim(parsed.path or value.split("?", 1)[0].split("#", 1)[0], limit)


def _safe_endpoint(value: str | None) -> str | None:
    parsed = urlsplit(value or "")
    return _trim(parsed.path or (value or "").split("?", 1)[0], 500)


def _safe_stack(exc: Exception, message: str) -> str | None:
    """Format frames only: never traceback locals, request bodies, or validation input."""
    frames = traceback.extract_tb(exc.__traceback__) if exc.__traceback__ else []
    formatted = "".join(traceback.format_list(frames))
    label = type(exc).__name__
    safe_message = (
        "Request validation failed"
        if isinstance(exc, RequestValidationError)
        else (_redact_text(message, MAX_MESSAGE) or "Request failed")
    )
    return _redact_text(f"{formatted}{label}: {safe_message}", MAX_STACK)


def _backend_values(
    request: Request,
    exc: Exception,
    status_code: int,
    message: str,
) -> dict:
    source_file, function_name, line_number, column_number = _exception_location(
        request, exc,
    )
    query_names = sorted({
        clean for clean in (
            _trim(name, 100) for name in request.query_params.keys()
        )
        if clean
    })[:50]
    return {
        "request_id": safe_request_id(getattr(request.state, "request_id", None)),
        "source": "BACKEND",
        "level": "ERROR" if status_code >= 500 else "WARNING",
        "message": _redact_text(message, MAX_MESSAGE) or "Request failed",
        "error_type": _trim(type(exc).__name__, 200),
        "status_code": status_code,
        "http_method": _trim(request.method.upper(), 10),
        "endpoint": _route_name(request),
        "page_url": _safe_url(request.headers.get("referer")),
        "source_file": source_file,
        "function_name": function_name,
        "line_number": line_number,
        "column_number": column_number,
        "stack_trace": _safe_stack(exc, message),
        "actor_id": getattr(request.state, "actor_id", None),
        "actor_name": _trim(getattr(request.state, "actor_name", None), 200),
        "ip_address": _trim(request.client.host, 45) if request.client else None,
        # Never persist request headers. Request/correlation ID is the one explicit,
        # bounded exception and is stored in its dedicated field above.
        "user_agent": None,
        "context_data": _safe_context({
            "route_name": getattr(request.scope.get("route"), "name", None),
            "query_fields": query_names,
        }),
    }


async def capture_backend_error(
    request: Request,
    exc: Exception,
    status_code: int,
    message: str,
) -> None:
    """Write through an independent session and never alter the original response."""
    values = _backend_values(request, exc, status_code, message)
    try:
        async with SessionLocal() as db:
            db.add(AppLog(**values))
            await db.commit()
    except Exception:
        # Standard logging only. Calling the application reporter here would recurse.
        log.exception("Could not persist application error %s", values["request_id"])


def _frontend_values(data: FrontendErrorIn, request: Request, user) -> dict:
    request_id = safe_request_id(
        data.request_id or getattr(request.state, "request_id", None),
    )
    return {
        "request_id": request_id,
        "source": "FRONTEND",
        "level": (
            "ERROR"
            if (data.status_code or 0) >= 500 or data.status_code is None
            else "WARNING"
        ),
        "message": _redact_text(data.message, MAX_MESSAGE) or "Browser error",
        "error_type": _trim(data.error_type, 200),
        "status_code": data.status_code,
        "http_method": _trim(data.http_method.upper(), 10) if data.http_method else None,
        "endpoint": _safe_endpoint(data.endpoint),
        "page_url": _safe_url(data.page_url),
        "source_file": _code_path(data.source_file),
        "function_name": _trim(data.function_name, 200),
        "line_number": data.line_number,
        "column_number": data.column_number,
        "stack_trace": _redact_text(data.stack_trace, MAX_STACK),
        "actor_id": user.id,
        "actor_name": _trim(getattr(user, "full_name", None), 200),
        "ip_address": _trim(request.client.host, 45) if request.client else None,
        "user_agent": None,
        "context_data": _safe_context(data.context),
    }


async def capture_frontend_error(
    db: AsyncSession,
    data: FrontendErrorIn,
    request: Request,
    user,
) -> dict:
    values = _frontend_values(data, request, user)
    try:
        db.add(AppLog(**values))
        await db.commit()
        return {"logged": True, "request_id": values["request_id"]}
    except Exception:
        try:
            await db.rollback()
        except Exception:
            pass
        log.exception(
            "Could not persist frontend application error %s",
            values["request_id"],
        )
        return {"logged": False, "request_id": values["request_id"]}


def _contains(column, value: str | None):
    clean = _trim(value, 200)
    return column.ilike(f"%{clean}%") if clean else None


async def list_app_logs(
    db: AsyncSession,
    params: PageParams,
    source: str | None = None,
    level: str | None = None,
    status_code: int | None = None,
    search: str | None = None,
    endpoint: str | None = None,
    source_file: str | None = None,
    function_name: str | None = None,
    message: str | None = None,
    request_id: str | None = None,
) -> dict:
    stmt = select(AppLog)
    if source:
        stmt = stmt.where(AppLog.source == (_trim(source.upper(), 20) or ""))
    if level:
        stmt = stmt.where(AppLog.level == (_trim(level.upper(), 20) or ""))
    if status_code is not None:
        stmt = stmt.where(AppLog.status_code == status_code)
    for column, value in (
        (AppLog.endpoint, endpoint),
        (AppLog.source_file, source_file),
        (AppLog.function_name, function_name),
        (AppLog.message, message),
        (AppLog.request_id, request_id),
    ):
        condition = _contains(column, value)
        if condition is not None:
            stmt = stmt.where(condition)
    clean_search = _trim(search, 200)
    if clean_search:
        like = f"%{clean_search}%"
        stmt = stmt.where(or_(
            AppLog.message.ilike(like),
            AppLog.error_type.ilike(like),
            AppLog.endpoint.ilike(like),
            AppLog.source_file.ilike(like),
            AppLog.function_name.ilike(like),
            AppLog.request_id.ilike(like),
        ))
    return await paginate(
        db, stmt.order_by(AppLog.created_at.desc(), AppLog.id.desc()), params,
    )
