"""One error shape for the whole system: {"success": false, "error": "..."}."""
from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


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


async def app_exception_handler(request: Request, exc: AppException):
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
    return JSONResponse(
        status_code=422,
        content={"success": False, "error": _request_validation_message(exc)},
    )


async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    message = exc.detail if isinstance(exc.detail, str) else "Request failed"
    return JSONResponse(
        status_code=exc.status_code,
        content={"success": False, "error": message},
        headers=exc.headers,
    )
