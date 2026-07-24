"""One error shape for the whole system: {"success": false, "error": "..."}."""
from fastapi import Request
from fastapi.responses import JSONResponse


class AppException(Exception):
    status_code = 400

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


class NotFoundError(AppException):
    status_code = 404


class ValidationError(AppException):
    status_code = 422


class PermissionError_(AppException):
    status_code = 403


class ConflictError(AppException):
    status_code = 409


async def app_exception_handler(request: Request, exc: AppException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"success": False, "error": exc.message},
    )
