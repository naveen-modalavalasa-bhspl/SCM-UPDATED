"""FastAPI entrypoint. One error shape, CORS, /health, module routers, and the
HCM periodic-sync scheduler (started from the stored schedule)."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.exceptions import AppException, app_exception_handler

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

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    # Set CORS_ALLOW_PRIVATE_NETWORK=true to let other machines on the LAN use the
    # app. None when the flag is off, which leaves the explicit list as the only rule.
    allow_origin_regex=settings.cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_exception_handler(AppException, app_exception_handler)


@app.get("/health", tags=["health"])
async def health():
    return {"status": "ok"}


def _include_routers() -> None:
    """Register routers that exist. Wrapped so the skeleton boots before the
    later stages add their modules."""
    from importlib import import_module

    router_paths = [
        "app.platform.auth.router",
        "app.platform.hcm.router",
        "app.platform.rbac.router",
        "app.platform.workflow.router",
        "app.platform.rules.router",
        "app.platform.admin.router",
        "app.modules.indents.router",
        "app.modules.procurement.router",
        "app.modules.logistics.router",
        "app.modules.inventory.router",
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
