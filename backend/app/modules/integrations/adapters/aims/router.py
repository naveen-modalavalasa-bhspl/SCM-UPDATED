"""AIMS console routes, under `/api/apis/aims` (JWT + require_permission, like every
other console route). There are no `/api/ext/v1/aims` feeds: AIMS reads SCM through the
ordinary console-built endpoints with its own API key, which the Pull tab shows.

Who may do what (the same split B-CAMS uses):
  * see the push log, the pull log and the settings      -> integration.view
  * resend events                                         -> integration.manage
  * change the target URL / switch on or off, mint secret -> integration.keys.manage

Configuration is not a document and has no approval ladder (the convention stated in
`platform_links.py`); the sensitive actions are gated by `integration.keys.manage` and
every change records who made it.
"""
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.core.exceptions import NotFoundError
from app.core.pagination import PageParams
from app.modules.integrations import security
from app.modules.integrations.adapters.aims import outbox
from app.modules.inventory import hooks as inventory_hooks
from app.platform.rbac import permissions as perms

VIEW = perms.INTEGRATION_VIEW
MANAGE = perms.INTEGRATION_MANAGE
KEYS = perms.INTEGRATION_KEYS_MANAGE

# Observe stock arriving. Registered once, at import (adapters are imported once, by
# `adapters.discover()`); `on_stock_in` is a no-op until the push is switched on.
if outbox.on_stock_in not in inventory_hooks.ON_STOCK_IN:
    inventory_hooks.ON_STOCK_IN.append(outbox.on_stock_in)

console = APIRouter(prefix="/api/apis/aims", tags=["aims-console"])


class ConfigIn(BaseModel):
    url: str = Field(default="", max_length=500)
    enabled: bool = False
    client_code: str = Field(default="", max_length=30)


@console.get("/status")
async def status(db: AsyncSession = Depends(get_db), user=Depends(require_permission(VIEW))):
    return await outbox.summary(db)


@console.get("/events")
async def events(params: PageParams = Depends(), status: str = Query(""),
                 db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(VIEW))):
    return await outbox.events(db, status=status or None, page=params.page, size=params.size)


@console.get("/events/{event_id}")
async def event_detail(event_id: str, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(VIEW))):
    doc = await outbox.event(db, event_id)
    if doc is None:
        raise NotFoundError(f"No AIMS event {event_id}")
    return doc


@console.post("/events/{event_id}/retry")
async def retry(event_id: str, db: AsyncSession = Depends(get_db),
                user=Depends(require_permission(MANAGE))):
    row = await outbox.retry(db, event_id)
    if row is None:
        raise NotFoundError(f"No AIMS event {event_id}")
    return row


@console.post("/deliver")
async def deliver_pending(db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(MANAGE))):
    """Send every pending or failed event now, instead of waiting for the next one."""
    return await outbox.deliver_with(db)


@console.put("/config")
async def save_config(body: ConfigIn, db: AsyncSession = Depends(get_db),
                      user=Depends(require_permission(KEYS))):
    return await outbox.save_config(db, user, url=body.url, enabled=body.enabled,
                                    client_code=body.client_code)


@console.post("/test")
async def test_connection(db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(MANAGE))):
    return await outbox.test_connection(db)


@console.post("/secret")
async def rotate_secret(db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(KEYS))):
    return await outbox.rotate_secret(db, user)


@console.get("/pulls")
async def pulls(params: PageParams = Depends(), db: AsyncSession = Depends(get_db),
                user=Depends(require_permission(VIEW))):
    """What AIMS read from SCM with its API key (the application code set in settings).

    From the console's in-memory call log: it covers this server process since its
    last restart, which the screen says out loud rather than implying a full history.
    """
    code = (await outbox.config(db)).get("client_code") or ""
    entries = security.calls_for(code) if code else []
    window = entries[params.offset:params.offset + params.size]
    return {"items": window, "total": len(entries), "page": params.page,
            "size": params.size, "client_code": code, "since_restart": True}


router = APIRouter()
router.include_router(console)
