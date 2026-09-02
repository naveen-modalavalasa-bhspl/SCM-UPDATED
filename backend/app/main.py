"""FastAPI entrypoint. One error shape, CORS, /health, module routers, and the
HCM periodic-sync scheduler (started from the stored schedule)."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.config import settings
from sqlalchemy.exc import DataError, IntegrityError

from app.core.exceptions import (
    AppException, app_exception_handler, data_error_handler, http_exception_handler,
    integrity_error_handler, request_validation_exception_handler,
    unhandled_exception_handler,
)
from app.platform.admin.app_logs import capture_backend_error, safe_request_id

log = logging.getLogger("app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.platform.hcm import scheduler
    from app.platform.settings.service import get_hcm_schedule
    from app.platform.workflow import scheduler as approval_scheduler
    from app.core.database import SessionLocal

    scheduler.start()
    try:
        async with SessionLocal() as db:
            enabled, interval = await get_hcm_schedule(db)
        scheduler.configure(enabled, interval)
    except Exception as exc:  # don't block startup if settings/DB not ready
        log.warning("HCM scheduler not configured at startup: %s", exc)

    # Overdue-approval chasing. Its own scheduler so a slow HCM sync cannot delay it,
    # and so turning one off leaves the other alone. Ships disabled: it writes
    # notifications to real people, and that is an administrator's decision to make.
    approval_scheduler.start()
    try:
        from app.platform.workflow import reminders

        async with SessionLocal() as db:
            config = await reminders.get_config(db)
        approval_scheduler.configure(config["enabled"], config["interval_minutes"])
    except Exception as exc:
        log.warning("Approval reminder scheduler not configured at startup: %s", exc)

    # Register screens added since the last deploy. Additive only — it never drops a
    # page — so unlike scripts.seed this is safe to run against the live database.
    try:
        from app.platform.rbac.page_registry import sync_pages, sync_permission_labels

        # Permissions FIRST, pages second. `sync_pages` will create a missing page
        # permission itself, but it grants that row to Admin and nobody else — it has
        # no notion of a screen carved out of one already live. `sync_permission_labels`
        # does (perms.INHERITS_GRANTS_FROM), so letting it insert the catalogued page
        # codes first is what lets Acknowledgements land with the desk that already
        # holds Tracking instead of appearing only for an administrator. Pages then
        # find the row already there and only link it.
        async with SessionLocal() as db:
            relabelled = await sync_permission_labels(db)
            result = await sync_pages(db)
        if result["added"] or result["updated"]:
            log.info("rbac_pages synced: %s", result)
        if relabelled:
            log.info("rbac_permissions relabelled: %s", relabelled)
    except Exception as exc:
        log.warning("Page registry sync skipped: %s", exc)
    yield
    scheduler.shutdown()
    approval_scheduler.shutdown()


app = FastAPI(title="SCM ERP", version="0.1.0", lifespan=lifespan)
app.state.error_reporter = capture_backend_error


@app.middleware("http")
async def request_identity(request, call_next):
    """Give browser and server errors the same searchable correlation id."""
    request.state.request_id = safe_request_id(request.headers.get("x-request-id"))
    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id
    return response

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    # Set CORS_ALLOW_PRIVATE_NETWORK=true to let other machines on the LAN use the
    # app. None when the flag is off, which leaves the explicit list as the only rule.
    allow_origin_regex=settings.cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID"],
)

app.add_exception_handler(AppException, app_exception_handler)
app.add_exception_handler(RequestValidationError, request_validation_exception_handler)
app.add_exception_handler(StarletteHTTPException, http_exception_handler)
# Ahead of the catch-all: a value the column cannot hold is the caller's problem, and
# answering 500 hid which field it was on every screen that writes a short column.
app.add_exception_handler(DataError, data_error_handler)
# Same reasoning: a duplicate number, a missing required column or a row something
# else still points at is the caller's to fix, and answering 500 said nothing about
# which. The constraint name never leaves the log — see integrity_error_handler.
app.add_exception_handler(IntegrityError, integrity_error_handler)
app.add_exception_handler(Exception, unhandled_exception_handler)


@app.get("/health", tags=["health"])
async def health():
    return {"status": "ok"}


@app.get("/health/ready", tags=["health"])
async def readiness():
    """Deployment readiness: the process is useful only when MySQL answers."""
    from fastapi import HTTPException
    from sqlalchemy import text

    from app.core.database import engine

    try:
        async with engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
    except Exception as exc:
        log.warning("Readiness check failed: %s", exc)
        raise HTTPException(status_code=503, detail="database unavailable") from exc
    return {"status": "ready"}


def _include_routers() -> None:
    """Register routers that exist. Wrapped so the skeleton boots before the
    later stages add their modules."""
    from importlib import import_module

    router_paths = [
        "app.platform.auth.router",
        "app.platform.hcm.router",
        "app.platform.settings.router",
        "app.platform.mail.router",
        "app.platform.notifications.router",
        "app.platform.rbac.router",
        "app.platform.workflow.router",
        "app.platform.rules.router",
        "app.platform.admin.router",
        "app.modules.home.router",
        # Alerts is copy only — no tables, no module imports — so it sits first.
        "app.modules.alerts.router",
        "app.modules.indents.router",
        "app.modules.procurement.router",
        "app.modules.inventory.router",
        "app.modules.logistics.router",
        "app.modules.warehouse.router",
        # After warehouse: a return reuses inv_sto and reads pro_returns, so it sits
        # at the end of the module chain (rule 5) and nothing imports it back.
        "app.modules.returns.router",
        # The API console. Reads every module's tables and is read by none, so it
        # registers late, beside reports.
        "app.modules.integrations.router",
        # Last in the chain: approvals presents tasks from every other module, so it
        # imports them all and nothing imports it back.
        "app.modules.approvals.router",
        # Reports reads every module's tables and is read-only, so it also imports
        # them all and nothing imports it back.
        "app.modules.reports.router",
        "app.shared.masters.router",
    ]
    for path in router_paths:
        try:
            module = import_module(path)
        except ModuleNotFoundError:
            continue
        router = getattr(module, "router", None)
        if router is not None:
            app.include_router(router)
        # A module may expose a second router when its routes belong under two
        # prefixes with two different guards — `platform.mail` serves /api/mail behind
        # `require_permission` and the /api/auth reset pair with no guard at all, and
        # they cannot share one object. Looked up by name so nothing else changes.
        extra = getattr(module, "auth_router", None)
        if extra is not None:
            app.include_router(extra)


_include_routers()
