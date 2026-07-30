"""FastAPI entrypoint. One error shape, CORS, /health, module routers, and the
HCM periodic-sync scheduler (started from the stored schedule)."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.config import settings
from app.core.exceptions import (
    AppException, app_exception_handler, http_exception_handler,
    request_validation_exception_handler, unhandled_exception_handler,
)
from app.platform.admin.app_logs import capture_backend_error, safe_request_id

log = logging.getLogger("app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.platform.hcm import scheduler
    from app.platform.settings.service import get_hcm_schedule
    from app.core.database import SessionLocal

    scheduler.start()
    try:
        async with SessionLocal() as db:
            enabled, interval = await get_hcm_schedule(db)
        scheduler.configure(enabled, interval)
    except Exception as exc:  # don't block startup if settings/DB not ready
        log.warning("HCM scheduler not configured at startup: %s", exc)
    yield
    scheduler.shutdown()


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
        "app.platform.rbac.router",
        "app.platform.workflow.router",
        "app.platform.rules.router",
        "app.platform.admin.router",
        "app.modules.home.router",
        "app.modules.indents.router",
        "app.modules.procurement.router",
        "app.modules.inventory.router",
        "app.modules.logistics.router",
        "app.modules.warehouse.router",
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


_include_routers()
