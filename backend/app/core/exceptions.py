"""One error shape for the whole system.

Every failure — ours, FastAPI's, Starlette's, the driver's — leaves through here and
comes out as the same envelope:

    {
      "success": false,
      "error":      "Only the requester can edit this indent.",   # legacy key, kept
      "error_code": "PERMISSION_DENIED",
      "title":      "You don't have permission",
      "detail":     "Only the requester can edit this indent.",
      "field":      null
    }

`error` is the original contract and carries the same sentence as `detail`, so every
screen, test and integration reading `data.error` is unaffected. The three new keys
are additive: a short title to head a notification, a stable machine code, and the
form field to pin the message to when there is one.

The single place the two diverge is an unhandled 500, where `error` keeps the literal
"Internal server error" the existing readers and log assertions expect and `detail`
carries the sentence a person reads.

Two rules the handlers below exist to keep:

1. **The reason reaches the user.** A business rule that refuses a write already
   explains itself ("Only the requester can edit this indent") and that sentence is
   what the screen shows. Nothing here replaces it with an HTTP status.
2. **Implementation detail never does.** SQL text, driver codes, constraint names,
   file paths and stack traces are logged, never returned. A 500 says the same safe
   sentence whatever went wrong behind it.
"""
import logging
import re

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("app.exceptions")


class AppException(Exception):
    """A failure the caller can be told about, verbatim.

    Subclasses carry the status, the machine code and the short title; the message is
    the sentence the user reads, so raise sites keep writing plain English.
    """

    status_code = 400
    error_code = "REQUEST_FAILED"
    title = "Could not complete that"

    def __init__(
        self,
        message: str,
        *,
        field: str | None = None,
        code: str | None = None,
        title: str | None = None,
    ):
        self.message = message
        #: The form field this belongs against, when it belongs against one.
        self.field = field
        if code:
            self.error_code = code
        if title:
            self.title = title
        super().__init__(message)


class NotFoundError(AppException):
    status_code = 404
    error_code = "NOT_FOUND"
    title = "Not found"


class ValidationError(AppException):
    status_code = 422
    error_code = "VALIDATION_ERROR"
    title = "Check the details entered"


class AuthenticationError(AppException):
    status_code = 401
    error_code = "AUTHENTICATION_FAILED"
    # A 401 is answered by one of two headings, and only one of them is decided here.
    # A REJECTED sign-in keeps this title, because that is the screen it lands on. A
    # request made with an expired token is retitled by the client ("Signed out"),
    # which knows the difference; see shared/api/errors.ts.
    title = "Sign-in failed"


class PermissionError_(AppException):
    status_code = 403
    error_code = "PERMISSION_DENIED"
    title = "You don't have permission"

    def __init__(self, message: str, **kwargs):
        # "Missing permission: indent.approve" is how four call sites phrase a 403,
        # and it reads as a system fault rather than an answer. The permission code
        # is still named — an administrator needs it to grant the thing — but the
        # sentence now says what happened and what to do about it.
        match = re.fullmatch(r"Missing permission:\s*(\S+)", message.strip())
        if match:
            message = (
                "You don't have permission to perform this action. "
                f'Ask an administrator for the "{match.group(1)}" permission '
                "if you need it."
            )
        super().__init__(message, **kwargs)


class ConflictError(AppException):
    status_code = 409
    error_code = "CONFLICT"
    title = "Already done"


def _envelope(
    message: str,
    *,
    code: str,
    title: str,
    field: str | None = None,
) -> dict:
    """The one body every handler returns. `error` stays for the older readers."""
    return {
        "success": False,
        "error": message,
        "error_code": code,
        "title": title,
        "detail": message,
        "field": field,
    }


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
        content=_envelope(
            exc.message,
            code=getattr(exc, "error_code", "REQUEST_FAILED"),
            title=getattr(exc, "title", "Could not complete that"),
            field=getattr(exc, "field", None),
        ),
    )


# --------------------------------------------------------------------------- #
# Request validation                                                           #
# --------------------------------------------------------------------------- #

#: Pydantic's wording, in the words of somebody filling in a form. Anything not
#: listed keeps pydantic's own message, which is usually a readable sentence.
_ISSUE_PHRASES: dict[str, str] = {
    "missing": "is required",
    "missing_argument": "is required",
    "string_too_short": "is too short",
    "string_too_long": "is longer than this field allows",
    "string_pattern_mismatch": "is not in the format this field expects",
    "int_parsing": "must be a whole number",
    "int_type": "must be a whole number",
    "float_parsing": "must be a number",
    "decimal_parsing": "must be a number",
    "bool_parsing": "must be Yes or No",
    "date_parsing": "must be a valid date",
    "date_from_datetime_parsing": "must be a valid date",
    "datetime_parsing": "must be a valid date and time",
    "greater_than": "must be larger than the minimum allowed",
    "greater_than_equal": "must not be smaller than the minimum allowed",
    "less_than": "must be smaller than the maximum allowed",
    "less_than_equal": "must not be larger than the maximum allowed",
    "enum": "is not one of the accepted values",
    "list_type": "must be a list of values",
    "json_invalid": "could not be read — the request body is not valid JSON",
}


def _field_path(loc) -> str:
    """`("body", "items", 0, "qty")` -> `items.0.qty`. The wrapper names go."""
    parts = [str(part) for part in loc if part not in ("body", "query", "path", "header")]
    return ".".join(parts)


def _field_label(path: str) -> str:
    """`items.0.qty` -> `qty (row 1)`.

    The raw column name is kept, not prettified into "Qty": it is what the field is
    called on the screen's own payload and in the API docs, and it is the only thing
    that lets somebody match the sentence to the box they have to fix. The row number
    is added because "qty is required" on a ten-line indent is not an answer.
    """
    if not path:
        return "This request"
    parts = path.split(".")
    rows = [int(part) + 1 for part in parts if part.isdigit()]
    names = [part for part in parts if not part.isdigit()]
    label = names[-1] if names else path
    return f"{label} (row {rows[-1]})" if rows else label


def _issue_sentence(issue: dict) -> str:
    path = _field_path(issue.get("loc", ()))
    label = _field_label(path)
    phrase = _ISSUE_PHRASES.get(issue.get("type", ""))
    if phrase:
        return f"{label} {phrase}."
    message = str(issue.get("msg", "is not valid")).strip()
    # Pydantic stamps its own kind on a custom validator's message. "Value error,"
    # is a category name from a library the user has never heard of.
    for noise in ("Value error, ", "Assertion failed, "):
        if message.startswith(noise):
            message = message[len(noise):]
    message = message.strip().rstrip(".")
    # A custom validator writes a whole sentence, and rule 1 up top says it survives
    # untouched — including the field it already names for itself.
    if path and path.split(".")[-1] in message:
        return f"{message}."
    if message[:1].isupper() and " " in message:
        return f"{message}."
    return f"{label}: {message}."


def _request_validation_message(exc: RequestValidationError) -> tuple[str, str | None]:
    """The sentence to show, and the field to pin it to when there is one."""
    issues = exc.errors() or []
    if not issues:
        return "Some of the details sent with this request were not valid.", None

    missing = [i for i in issues if i.get("type") in ("missing", "missing_argument")]
    if len(issues) > 1 and len(missing) == len(issues):
        labels = ", ".join(_field_label(_field_path(i.get("loc", ()))) for i in missing[:6])
        return f"These details are required: {labels}.", _field_path(missing[0].get("loc", ())) or None

    sentences = list(dict.fromkeys(_issue_sentence(issue) for issue in issues[:3]))
    text = " ".join(sentences)
    more = len(issues) - len(issues[:3])
    if more > 0:
        text += f" ({more} more field(s) need attention.)"
    return text, _field_path(issues[0].get("loc", ())) or None


async def request_validation_exception_handler(
    request: Request, exc: RequestValidationError,
):
    message, field = _request_validation_message(exc)
    await _report(request, exc, 422, message)
    return JSONResponse(
        status_code=422,
        content=_envelope(
            message,
            code="VALIDATION_ERROR",
            title="Check the details entered",
            field=field,
        ),
    )


# --------------------------------------------------------------------------- #
# Framework and driver failures                                                #
# --------------------------------------------------------------------------- #

#: Starlette's stock details, which are HTTP vocabulary rather than English.
_HTTP_REWRITES: dict[str, tuple[str, str, str]] = {
    "not found": (
        "NOT_FOUND", "Not found",
        "We could not find what you asked for. It may have been removed or renamed.",
    ),
    "method not allowed": (
        "METHOD_NOT_ALLOWED", "Not available here",
        "That action is not available on this screen.",
    ),
    "not authenticated": (
        "AUTHENTICATION_FAILED", "Sign in to continue",
        "Please sign in again to continue — your session is no longer valid.",
    ),
    "forbidden": (
        "PERMISSION_DENIED", "You don't have permission",
        "You don't have permission to perform this action.",
    ),
    "internal server error": (
        "SERVER_ERROR", "Something went wrong on our side",
        "We couldn't complete this request due to a server problem. Please try again.",
    ),
}


def _status_defaults(status_code: int) -> tuple[str, str, str]:
    if status_code >= 500:
        return _HTTP_REWRITES["internal server error"]
    if status_code == 401:
        return _HTTP_REWRITES["not authenticated"]
    if status_code == 403:
        return _HTTP_REWRITES["forbidden"]
    if status_code == 404:
        return _HTTP_REWRITES["not found"]
    if status_code == 405:
        return _HTTP_REWRITES["method not allowed"]
    if status_code == 408:
        return ("REQUEST_TIMEOUT", "That took too long",
                "The request timed out before it finished. Please try again.")
    if status_code == 413:
        return ("PAYLOAD_TOO_LARGE", "File is too large",
                "The file you attached is larger than this screen accepts.")
    if status_code == 429:
        return ("TOO_MANY_REQUESTS", "Too many attempts",
                "Too many requests were sent in a row. Wait a moment and try again.")
    return ("REQUEST_FAILED", "Could not complete that",
            "We couldn't complete this request. Check the details and try again.")


async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    detail = exc.detail if isinstance(exc.detail, str) else ""
    code, title, message = _status_defaults(exc.status_code)
    rewrite = _HTTP_REWRITES.get(detail.strip().lower())
    if rewrite:
        # Starlette's own one-or-two-word detail. Say it in a sentence instead.
        code, title, message = rewrite
    elif detail and exc.status_code < 500:
        # Somebody raised HTTPException with a real explanation — that wins.
        message = detail
    await _report(request, exc, exc.status_code, message)
    return JSONResponse(
        status_code=exc.status_code,
        content=_envelope(message, code=code, title=title),
        headers=exc.headers,
    )


#: MySQL names the column it rejected, and that is the only part worth repeating.
#: The error number, the statement and the driver's prose are logged and dropped.
_COLUMN_RE = re.compile(r"column ['\"`]([^'\"`]+)['\"`]", re.I)
_DUPLICATE_RE = re.compile(r"Duplicate entry ['\"]([^'\"]*)['\"]", re.I)


def _column_name(text: str) -> str | None:
    match = _COLUMN_RE.search(text)
    return match.group(1) if match else None


async def data_error_handler(request: Request, exc: Exception):
    """MySQL rejecting a value for its column — too long (1406), out of range (1264).

    That is bad input, not a server fault, so it answers 422 in the same shape every
    other validation error uses. Screens were showing "Internal server error" for a
    field one character over its limit, which reads as a bug in the app rather than
    something the person typing can fix.

    Only the COLUMN NAME is carried out. Everything the driver wraps around it — the
    error number, the statement, "at row 1" — is implementation detail and goes to
    the log, not to the browser.
    """
    raw = str(getattr(exc, "orig", exc))
    column = _column_name(raw)
    subject = _field_label(column) if column else "One of the values you entered"
    lowered = raw.lower()
    if "too long" in lowered or "1406" in lowered:
        message = f"{subject} is too long for this field. Shorten it and save again."
    elif "out of range" in lowered or "1264" in lowered:
        message = (
            f"{subject} is outside the range this field accepts. "
            "Correct it and save again."
        )
    else:
        message = f"{subject} is not valid for this field. Correct it and save again."
    log.warning("Database rejected a value: %s", raw)
    await _report(request, exc, 422, message)
    return JSONResponse(
        status_code=422,
        content=_envelope(
            message,
            code="INVALID_VALUE",
            title="Check the details entered",
            field=column,
        ),
    )


async def integrity_error_handler(request: Request, exc: Exception):
    """A constraint refused the write: a duplicate, a missing value, a linked row.

    All three are the caller's to fix and all three used to answer 500 "Internal
    server error", which tells a storekeeper nothing about the second receipt they
    just booked against a number already used. Constraint and index names are
    internal so they stay in the log; the duplicated VALUE is the part the user
    recognises, and it is the only part repeated back.
    """
    raw = str(getattr(exc, "orig", exc))
    lowered = raw.lower()
    duplicate = _DUPLICATE_RE.search(raw)
    status, code, title = 409, "DUPLICATE", "Already exists"
    if duplicate:
        message = (
            f'"{duplicate.group(1)[:80]}" has already been recorded. '
            "Open the existing record, or change this value and save again."
        )
    elif "cannot be null" in lowered or "1048" in lowered:
        column = _column_name(raw)
        subject = _field_label(column) if column else "A required value"
        status, code, title = 422, "VALIDATION_ERROR", "Check the details entered"
        message = f"{subject} is required. Fill it in and save again."
    elif "foreign key" in lowered:
        code, title = "LINKED_RECORD", "Linked to other records"
        message = (
            "This record is linked to others, so it cannot be saved as it is. "
            "Check the linked records and try again."
        )
    else:
        message = (
            "This record clashes with one that already exists. "
            "Check the details and try again."
        )
    log.warning("Database rejected a write: %s", raw)
    await _report(request, exc, status, message)
    return JSONResponse(
        status_code=status,
        content=_envelope(message, code=code, title=title),
    )


async def operational_error_handler(request: Request, exc: Exception):
    """Database driver/connection failure or timeout: lock wait, disconnect, server gone."""
    raw = str(getattr(exc, "orig", exc))
    lowered = raw.lower()
    if "lock wait timeout" in lowered or "1205" in lowered or "deadlock" in lowered or "1213" in lowered:
        status, code, title = 409, "LOCK_TIMEOUT", "Record temporarily locked"
        message = (
            "This record is currently being updated by another operation or user. "
            "Please wait a moment and try again."
        )
    elif "can't connect" in lowered or "connection refused" in lowered or "2003" in lowered or "2006" in lowered or "lost connection" in lowered:
        status, code, title = 503, "DATABASE_UNAVAILABLE", "Database server unavailable"
        message = (
            "Unable to connect to the database server. Please verify network connectivity "
            "or contact system administration if the database is restarting."
        )
    elif "statement timeout" in lowered or "query timeout" in lowered:
        status, code, title = 504, "DATABASE_TIMEOUT", "Database query timed out"
        message = (
            "The database query took too long to complete. Please try narrowing your search "
            "or filter criteria and retry."
        )
    else:
        status, code, title = 500, "DATABASE_ERROR", "Database operation error"
        message = (
            "A database operation could not be completed. Please retry, or contact system "
            "administration if the problem persists."
        )
    log.error("Database operational error: %s", raw)
    await _report(request, exc, status, message)
    return JSONResponse(
        status_code=status,
        content=_envelope(message, code=code, title=title),
    )


async def unhandled_exception_handler(request: Request, exc: Exception):
    # `error` is fixed on purpose, and `detail` is the sentence a screen shows.
    # Whatever went wrong is in the log with its traceback; anything derived from
    # the exception itself risks carrying a connection string, a query or a path
    # out to the browser.
    request_id = getattr(request.state, "request_id", None)
    ref = f" (Ref: {request_id})" if request_id else ""
    user_detail = (
        f"We couldn't complete this request due to an unexpected server issue{ref}. "
        "Please try again in a moment, or contact support with this reference if it persists."
    )
    await _report(request, exc, 500, "Internal server error")
    return JSONResponse(
        status_code=500,
        content=_envelope(
            "Internal server error",
            code="SERVER_ERROR",
            title="Something went wrong on our side",
        ) | {
            "detail": user_detail,
        },
    )

