"""Application-log safety, correlation, RBAC, filtering, and failure isolation."""
from datetime import datetime, timedelta, timezone
import inspect
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.exceptions import RequestValidationError
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from starlette.requests import Request

from app.core.database import Base
from app.core.exceptions import (
    ConflictError, PermissionError_, app_exception_handler, data_error_handler,
    integrity_error_handler, request_validation_exception_handler,
    unhandled_exception_handler,
)
from app.main import app
from app.platform.admin import app_logs
from app.platform.admin.schemas import FrontendErrorIn
from app.platform.rbac import permissions as perms
from app.platform.settings.models import AppLog


def _request(
    path: str = "/api/example",
    query: str = "",
    headers: list[tuple[bytes, bytes]] | None = None,
) -> Request:
    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": query.encode(),
        "headers": headers or [],
        "client": ("127.0.0.1", 1234),
        "server": ("test", 80),
        "app": SimpleNamespace(state=SimpleNamespace(error_reporter=AsyncMock())),
        "route": SimpleNamespace(path="/api/example", name="example"),
    }
    request = Request(scope)
    request.state.request_id = "request-123"
    request.state.actor_id = 7
    request.state.actor_name = "Admin User"
    return request


def _raise_at_known_line():
    expected_line = inspect.currentframe().f_lineno + 1
    raise RuntimeError(f"location:{expected_line}")


def test_repository_source_path_and_traceback_location_are_exact():
    assert app_logs._code_path(r"C:\repo\backend\app\modules\indents\service.py") == (
        "backend/app/modules/indents/service.py"
    )
    try:
        _raise_at_known_line()
    except RuntimeError as exc:
        expected_line = int(str(exc).split(":")[1])
        source, function, line, column = app_logs._exception_location(_request(), exc)

    assert source == "backend/app/platform/admin/tests/test_app_logs.py"
    assert function == "_raise_at_known_line"
    assert line == expected_line
    assert column is None or column >= 0


def test_safe_url_and_context_never_keep_query_values_or_secrets():
    assert app_logs._safe_url(
        "https://erp.example/inventory?token=secret&project=42#tab",
    ) == "https://erp.example/inventory"
    safe = app_logs._safe_context({
        "kind": "api",
        "nested": {
            "password": "do-not-store",
            "api_key": "do-not-store",
            "attempt": 2,
        },
        "request_body": {"email": "person@example.com"},
        "query": {"project": "42"},
    })
    serialized = json.dumps(safe)
    assert "do-not-store" not in serialized
    assert "person@example.com" not in serialized
    assert '"project": "42"' not in serialized
    assert safe["nested"]["password"] == "[REDACTED]"
    assert safe["nested"]["attempt"] == 2


def test_context_is_bounded_and_table_is_registered_in_metadata():
    context = {"kind": "large"}
    context.update({
        f"diagnostic_{index}": "x" * app_logs.MAX_CONTEXT_STRING
        for index in range(20)
    })
    safe = app_logs._safe_context(context)
    assert safe["kind"] == "large"
    assert safe["context_truncated"] is True
    assert safe["original_size"] > app_logs.MAX_CONTEXT_BYTES
    assert "sys_app_logs" in Base.metadata.tables


@pytest.mark.asyncio
async def test_warning_and_error_handlers_keep_the_normal_response_shape():
    warning_request = _request()
    warning = ConflictError("Already exists")
    warning_response = await app_exception_handler(warning_request, warning)
    assert warning_response.status_code == 409
    assert json.loads(warning_response.body) == {
        "success": False,
        "error": "Already exists",
        "error_code": "CONFLICT",
        "title": "Already done",
        "detail": "Already exists",
        "field": None,
    }
    reported = warning_request.app.state.error_reporter.await_args.args
    assert reported[2:] == (409, "Already exists")

    error_request = _request()
    error_response = await unhandled_exception_handler(
        error_request, RuntimeError("database_url=mysql://secret"),
    )
    assert error_response.status_code == 500
    body = json.loads(error_response.body)
    # Nothing derived from the exception reaches the browser — the connection string
    # in it is in the log and nowhere else.
    assert body["success"] is False
    assert body["error"] == "Internal server error"
    assert body["error_code"] == "SERVER_ERROR"
    assert "secret" not in json.dumps(body)
    assert "mysql" not in json.dumps(body).lower()
    reported = error_request.app.state.error_reporter.await_args.args
    assert reported[2:] == (500, "Internal server error")


def test_backend_values_use_warning_error_levels_and_query_names_only():
    request = _request(query="project=42&token=secret")
    warning = app_logs._backend_values(
        request, PermissionError_("Denied"), 403, "Denied",
    )
    error = app_logs._backend_values(
        request, RuntimeError("Broken"), 500, "Internal server error",
    )
    assert warning["level"] == "WARNING"
    assert error["level"] == "ERROR"
    assert warning["context_data"]["query_fields"] == ["project", "token"]
    assert "42" not in json.dumps(warning["context_data"])
    assert "secret" not in json.dumps(warning["context_data"])


@pytest.mark.asyncio
async def test_request_id_is_returned_and_exposed_through_cors():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(
            "/health",
            headers={"Origin": "http://localhost:5173", "X-Request-ID": "shared-123"},
        )
    assert response.status_code == 200
    assert response.headers["x-request-id"] == "shared-123"
    assert "X-Request-ID" in response.headers.get("access-control-expose-headers", "")


@pytest.mark.asyncio
async def test_backend_logger_database_failure_is_swallowed(monkeypatch):
    class BrokenSession:
        async def __aenter__(self):
            raise RuntimeError("database unavailable")

        async def __aexit__(self, *_args):
            return False

    monkeypatch.setattr(app_logs, "SessionLocal", BrokenSession)
    await app_logs.capture_backend_error(
        _request(), RuntimeError("original failure"), 500, "Internal server error",
    )


@pytest.mark.asyncio
async def test_frontend_logger_database_failure_does_not_recurse():
    db = SimpleNamespace(
        add=lambda _row: None,
        commit=AsyncMock(side_effect=RuntimeError("database unavailable")),
        rollback=AsyncMock(),
    )
    result = await app_logs.capture_frontend_error(
        db,
        FrontendErrorIn(message="Browser failed", request_id="shared-123"),
        _request(),
        SimpleNamespace(id=3, full_name="Browser User"),
    )
    assert result == {"logged": False, "request_id": "shared-123"}
    db.rollback.assert_awaited_once()


@pytest.mark.asyncio
async def test_frontend_reporting_requires_auth_and_listing_requires_audit_permission(
    client, make_user, login,
):
    assert (await client.post(
        "/api/admin/app-logs/client-errors", json={"message": "Browser failed"},
    )).status_code == 401

    await make_user(permissions=[])
    headers = await login()
    assert (await client.get("/api/admin/app-logs", headers=headers)).status_code == 403


@pytest.mark.asyncio
async def test_frontend_and_backend_can_share_request_id_and_secrets_are_not_persisted(
    client, make_user, login, db,
):
    await make_user(permissions=[perms.ADMIN_AUDIT_VIEW])
    headers = await login()
    response = await client.post(
        "/api/admin/app-logs/client-errors",
        headers=headers,
        json={
            "message": "Failed token=top-secret",
            "endpoint": "/api/items?project=42&token=top-secret",
            "page_url": "http://localhost:5173/inventory?project=42",
            "request_id": "shared-frontend-backend",
            "context": {
                "nested": {"password": "top-secret", "attempt": 1},
                "form": {"email": "person@example.com"},
            },
        },
    )
    assert response.status_code == 202
    assert response.json()["request_id"] == "shared-frontend-backend"

    row = (await db.execute(
        select(AppLog).where(AppLog.request_id == "shared-frontend-backend")
    )).scalar_one()
    serialized = json.dumps({
        "message": row.message,
        "endpoint": row.endpoint,
        "page_url": row.page_url,
        "context": row.context_data,
    })
    assert "top-secret" not in serialized
    assert "person@example.com" not in serialized
    assert row.endpoint == "/api/items"
    assert row.page_url == "http://localhost:5173/inventory"


@pytest.mark.asyncio
async def test_admin_can_filter_search_and_paginate_newest_first(
    client, make_user, login, db,
):
    await make_user(permissions=[perms.ADMIN_AUDIT_VIEW])
    headers = await login()
    now = datetime.now(timezone.utc)
    db.add_all([
        AppLog(
            request_id="older-id", source="BACKEND", level="WARNING",
            message="Old conflict", error_type="ConflictError", status_code=409,
            http_method="POST", endpoint="/api/indents", source_file="backend/app/old.py",
            function_name="create_indent", created_at=now - timedelta(minutes=2),
        ),
        AppLog(
            request_id="newer-id", source="FRONTEND", level="ERROR",
            message="New browser failure", error_type="TypeError", status_code=500,
            http_method="GET", endpoint="/api/stock", source_file="frontend/src/App.tsx",
            function_name="loadStock", created_at=now,
        ),
    ])
    await db.commit()

    newest = await client.get(
        "/api/admin/app-logs?page=1&size=1", headers=headers,
    )
    assert newest.status_code == 200
    assert newest.json()["total"] == 2
    assert newest.json()["items"][0]["request_id"] == "newer-id"

    filters = {
        "source": "FRONTEND",
        "level": "ERROR",
        "status_code": "500",
        "endpoint": "stock",
        "source_file": "App.tsx",
        "function_name": "loadStock",
        "message": "browser",
        "request_id": "newer-id",
        "search": "TypeError",
    }
    for name, value in filters.items():
        response = await client.get(
            "/api/admin/app-logs", headers=headers, params={name: value},
        )
        assert response.status_code == 200, (name, response.text)
        assert [item["request_id"] for item in response.json()["items"]] == ["newer-id"]


# --------------------------------------------------------------------------- #
# The user-facing half of the envelope                                         #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_validation_errors_name_the_field_in_a_sentence():
    """"body.required_by: Field required" is a stack trace with the stack removed."""
    exc = RequestValidationError([
        {"type": "missing", "loc": ("body", "required_by"), "msg": "Field required"},
    ])
    body = json.loads((await request_validation_exception_handler(_request(), exc)).body)
    assert body["error"] == "required_by is required."
    assert body["field"] == "required_by"
    assert body["error_code"] == "VALIDATION_ERROR"

    rows = RequestValidationError([
        {"type": "greater_than", "loc": ("body", "items", 0, "qty"),
         "msg": "Input should be greater than 0"},
    ])
    row_body = json.loads(
        (await request_validation_exception_handler(_request(), rows)).body)
    # Which line, not just which column: "qty must be larger" on a ten-line indent
    # is not an answer.
    assert "row 1" in row_body["error"]

    both = RequestValidationError([
        {"type": "missing", "loc": ("body", "username"), "msg": "Field required"},
        {"type": "missing", "loc": ("body", "password"), "msg": "Field required"},
    ])
    both_body = json.loads(
        (await request_validation_exception_handler(_request(), both)).body)
    assert both_body["error"] == "These details are required: username, password."


@pytest.mark.asyncio
async def test_a_custom_validator_keeps_its_own_sentence():
    exc = RequestValidationError([
        {"type": "value_error", "loc": ("query", "date_from"),
         "msg": "date_from must be the same as or earlier than date_to"},
    ])
    body = json.loads((await request_validation_exception_handler(_request(), exc)).body)
    assert body["error"] == "date_from must be the same as or earlier than date_to."


@pytest.mark.asyncio
async def test_driver_errors_keep_the_column_and_drop_the_sql():
    too_long = SimpleNamespace(
        orig="(1406, \"Data too long for column 'vendor_name' at row 1\")")
    body = json.loads((await data_error_handler(_request(), too_long)).body)
    assert body["error"] == "vendor_name is too long for this field. Shorten it and save again."
    assert body["field"] == "vendor_name"
    for leaked in ("1406", "at row 1", "Data too long"):
        assert leaked not in json.dumps(body)


@pytest.mark.asyncio
async def test_a_duplicate_says_what_already_exists_instead_of_500():
    duplicate = SimpleNamespace(
        orig="(1062, \"Duplicate entry 'GRN-0007' for key 'wh_grn.uq_wh_grn_no'\")")
    response = await integrity_error_handler(_request(), duplicate)
    body = json.loads(response.body)
    assert response.status_code == 409
    assert body["error_code"] == "DUPLICATE"
    assert "GRN-0007" in body["error"]
    # The index name is ours, not the storekeeper's.
    assert "uq_wh_grn_no" not in json.dumps(body)


@pytest.mark.asyncio
async def test_a_missing_permission_reads_as_an_answer():
    response = await app_exception_handler(
        _request(), PermissionError_(f"Missing permission: {perms.INDENT_APPROVE}"),
    )
    body = json.loads(response.body)
    assert response.status_code == 403
    assert body["error_code"] == "PERMISSION_DENIED"
    assert body["error"].startswith("You don't have permission to perform this action.")
    # Still names the code: an administrator has to know what to grant.
    assert perms.INDENT_APPROVE in body["error"]
