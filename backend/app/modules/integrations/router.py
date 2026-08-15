"""API console endpoints. No logic here (rule 2).

Two routers under one `router` object, because `main.py` includes one attribute per
module and the two halves are one feature:

  * `/api/apis/**` — the console. JWT + `require_permission`, like every other
    endpoint in the system.
  * `/api/ext/v1/**` — what an outside application calls. An API key, no session, no
    employee, and no route that writes to a business table.

Three permission codes, declared in `platform/rbac/permissions.py` (rule 6):

  * `integration.view`    — see connected applications, their endpoints and usage
  * `integration.manage`  — register an application and compose its endpoints
  * `integration.keys.manage` — issue and revoke keys

Split three ways rather than riding on `admin.settings.manage`, because handing an
outside system a key that reads the database is not the same decision as editing the
company address — and that code also unscopes every stock list. All three are
fail-closed: Admin on first start, nobody else, until a job profile grants them.
"""
from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.core.pagination import PageParams
from app.modules.integrations import adapters, introspect, service
from app.modules.integrations.schemas import (
    CallLogOut, ClientOut, ClientWrite, ColumnOut, EndpointOut, EndpointWrite,
    ExtEndpointOut, ExtPage, KeyIssuedOut, KeyOut, KeyWrite, PreviewOut, TableOut,
    UsageOut,
)
from app.modules.integrations.security import Caller, require_api_key
from app.platform.rbac import permissions as perms

VIEW = perms.INTEGRATION_VIEW
CONSOLE = perms.INTEGRATION_MANAGE
KEYS = perms.INTEGRATION_KEYS_MANAGE

console = APIRouter(prefix="/api/apis", tags=["api-console"])
external = APIRouter(prefix="/api/ext/v1", tags=["external-api"])


# --------------------------------------------------------------------------- #
# Source picker
# --------------------------------------------------------------------------- #

@console.get("/tables", response_model=list[TableOut])
async def tables(db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(CONSOLE))):
    return await introspect.tables(db)


@console.get("/tables/{table}/columns", response_model=list[ColumnOut])
async def table_columns(table: str, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(CONSOLE))):
    return await introspect.columns(db, table)


@console.post("/schema/refresh")
async def refresh_schema(user=Depends(require_permission(CONSOLE))):
    """Re-read the database after a migration, without restarting the server."""
    introspect.reset_cache()
    return {"success": True}


@console.get("/adapters")
async def list_adapters(user=Depends(require_permission(VIEW))):
    """The hand-written integrations this deployment carries.

    An adapter serves shapes the endpoint builder cannot compose. The list is whatever
    is installed under `integrations/adapters/`, so a new system appears here by being
    dropped in — the console has no idea which ones exist until it asks.
    """
    return [{"key": a.key, "name": a.name, "description": a.description,
             "scope": a.key, "base_path": f"/api/ext/v1/{a.key}"}
            for a in adapters.catalogue()]


# --------------------------------------------------------------------------- #
# Clients
# --------------------------------------------------------------------------- #

@console.get("/clients")
async def list_clients(params: PageParams = Depends(), search: str = "",
                       db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(VIEW))):
    return await service.list_clients(db, params, search=search or None)


@console.post("/clients", response_model=ClientOut, status_code=201)
async def create_client(body: ClientWrite, db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(CONSOLE))):
    return await service.create_client(db, body, user)


@console.get("/clients/{code}", response_model=ClientOut)
async def get_client(code: str, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(VIEW))):
    return await service.get_client(db, code)


@console.put("/clients/{code}", response_model=ClientOut)
async def update_client(code: str, body: ClientWrite,
                        db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(CONSOLE))):
    return await service.update_client(db, code, body)


# --------------------------------------------------------------------------- #
# Keys
# --------------------------------------------------------------------------- #

@console.get("/clients/{code}/keys", response_model=list[KeyOut])
async def list_keys(code: str, db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(VIEW))):
    return await service.list_keys(db, code)


@console.post("/clients/{code}/keys", response_model=KeyIssuedOut, status_code=201)
async def issue_key(code: str, body: KeyWrite, db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(KEYS))):
    """The only response in the system that carries a raw key. Shown once."""
    return await service.issue_key(db, code, body, user)


@console.post("/keys/{prefix}/revoke", response_model=KeyOut)
async def revoke_key(prefix: str, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(KEYS))):
    return await service.revoke_key(db, prefix, user)


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #

@console.get("/clients/{code}/endpoints", response_model=list[EndpointOut])
async def list_endpoints(code: str, db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(VIEW))):
    return await service.list_endpoints(db, code)


@console.post("/clients/{code}/endpoints/preview", response_model=PreviewOut)
async def preview(code: str, body: EndpointWrite, db: AsyncSession = Depends(get_db),
                  user=Depends(require_permission(CONSOLE))):
    """The SQL and the first rows, before anything is saved."""
    return await service.preview(db, code, body)


@console.post("/clients/{code}/endpoints", response_model=EndpointOut, status_code=201)
async def create_endpoint(code: str, body: EndpointWrite,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(CONSOLE))):
    return await service.save_endpoint(db, code, body, user)


@console.put("/clients/{code}/endpoints/{slug}", response_model=EndpointOut)
async def update_endpoint(code: str, slug: str, body: EndpointWrite,
                          db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(CONSOLE))):
    return await service.save_endpoint(db, code, body, user, replacing=slug)


@console.delete("/endpoints/{slug}", response_model=EndpointOut)
async def delete_endpoint(slug: str, db: AsyncSession = Depends(get_db),
                          user=Depends(require_permission(CONSOLE))):
    return await service.delete_endpoint(db, slug)


# --------------------------------------------------------------------------- #
# Usage
# --------------------------------------------------------------------------- #

@console.get("/clients/{code}/logs")
async def call_logs(code: str, params: PageParams = Depends(),
                    errors_only: bool = False, db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(VIEW))):
    return await service.call_logs(db, code, params, errors_only=errors_only)


@console.get("/clients/{code}/usage", response_model=UsageOut)
async def usage(code: str, db: AsyncSession = Depends(get_db),
                user=Depends(require_permission(VIEW))):
    return await service.usage(db, code)


# --------------------------------------------------------------------------- #
# External — what an outside application calls
# --------------------------------------------------------------------------- #
# Literal paths are declared before `/{slug}`, or "_endpoints" is read as a slug.

@external.get("/_ping")
async def ping(caller: Caller = Depends(require_api_key)):
    """What this key is. The first call a new consumer makes to prove it is wired up."""
    return {"client": caller.client_code, "name": caller.client.get("name"),
            "scopes": caller.scopes}


@external.get("/_endpoints", response_model=list[ExtEndpointOut])
async def endpoints(db: AsyncSession = Depends(get_db),
                    caller: Caller = Depends(require_api_key)):
    return await service.visible_endpoints(db, caller)


@external.get("/{slug}", response_model=ExtPage)
async def read(slug: str, request: Request, db: AsyncSession = Depends(get_db),
               caller: Caller = Depends(require_api_key)):
    return await service.serve_logged(
        db, slug, caller, dict(request.query_params),
        ip=request.client.host if request.client else None)


router = APIRouter()
# Adapters BEFORE `external`: that router ends in `/{slug}`, which would otherwise
# swallow every one-segment path under /api/ext/v1 — including each adapter's own
# prefix. Whatever `adapters.discover()` finds is mounted; no system is named here.
for _adapter_router in adapters.routers():
    router.include_router(_adapter_router)
router.include_router(console)
router.include_router(external)
