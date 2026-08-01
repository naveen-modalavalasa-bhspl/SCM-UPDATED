"""One error shape for the whole system: {"success": false, "error": "..."}."""
import logging

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("app.exceptions")


class AppException(Exception):
    status_code = 400

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


class NotFoundError(AppException):
    status_code = 404


class ValidationError(AppException):
    status_code = 422


class AuthenticationError(AppException):
    status_code = 401


class PermissionError_(AppException):
    status_code = 403


class ConflictError(AppException):
    status_code = 409


async def _report(request: Request, exc: Exception, status_code: int, message: str) -> None:
    reporter = getattr(request.app.state, "error_reporter", None)
    if reporter is None:
        return
    try:
        await reporter(request, exc, status_code, message)
    except Exception:
        # Error reporting must never replace the application's real error.
        log.exception("Application error reporter failed")


async def app_exception_handler(request: Request, exc: AppException):
    await _report(request, exc, exc.status_code, exc.message)
    return JSONResponse(
        status_code=exc.status_code,
        content={"success": False, "error": exc.message},
    )


def _request_validation_message(exc: RequestValidationError) -> str:
    messages = []
    for issue in exc.errors():
        location = ".".join(
            str(part) for part in issue.get("loc", ()) if part != "body"
        )
        prefix = f"{location}: " if location else ""
        messages.append(f"{prefix}{issue.get('msg', 'Invalid request')}")
    return "; ".join(messages) or "Invalid request"


async def request_validation_exception_handler(
    request: Request, exc: RequestValidationError,
):
    message = _request_validation_message(exc)
    await _report(request, exc, 422, message)
    return JSONResponse(
        status_code=422,
        content={"success": False, "error": message},
    )


async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    message = exc.detail if isinstance(exc.detail, str) else "Request failed"
    await _report(request, exc, exc.status_code, message)
    return JSONResponse(
        status_code=exc.status_code,
        content={"success": False, "error": message},
        headers=exc.headers,
    )


async def unhandled_exception_handler(request: Request, exc: Exception):
    await _report(request, exc, 500, "Internal server error")
    return JSONResponse(
        status_code=500,
        content={"success": False, "error": "Internal server error"},
    )
