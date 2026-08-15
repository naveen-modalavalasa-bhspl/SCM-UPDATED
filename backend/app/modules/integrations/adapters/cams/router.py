"""B-CAMS routes. No logic here (rule 2) — every route is a feed plus `reads.page`.

Two prefixes, one router:

  * `/api/ext/v1/cams/**` — the 14 read feeds and the 5 write endpoints. API key, no
    session, no employee.
  * `/api/apis/cams/**` — the SCM side: rotate the shared secret, see what arrived.
    JWT + `require_permission`, like every other console route.

The write paths are registered twice, at `/…/cams/consumption` and at
`/…/cams/cams/consumption`, so the integration works whether B-CAMS is configured with
`/api/ext/v1` as its base (their §4 paths are `/cams/…`) or with `/api/ext/v1/cams`
(their §1 paths are bare). Two lines of aliasing beats a support call on cutover day.

Scopes: a key issued for this integration should carry either no scopes (meaning all of
its application's endpoints) or the scope `cams`.
"""
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.core.exceptions import NotFoundError
from app.core.pagination import PageParams
from app.modules.integrations.adapters.cams import ingest, reads
from app.modules.integrations.adapters.cams.enums import SIGNATURE_HEADER
from app.modules.integrations.adapters.cams.schemas import (
    AckIn, ConsumptionIn, ReceiptOut, SecretOut, StockBalanceIn, StockTransferIn,
    WastageIn,
)
from app.modules.integrations.security import Caller, require_api_key
from app.platform.rbac import permissions as perms

# The shared secret is a credential, so rotating it is the key permission, not the
# generic console one. Reading what arrived is plain visibility.
VIEW = perms.INTEGRATION_VIEW
CONSOLE = perms.INTEGRATION_KEYS_MANAGE
SCOPE = "cams"

feeds = APIRouter(prefix="/api/ext/v1/cams", tags=["b-cams"])
console = APIRouter(prefix="/api/apis/cams", tags=["b-cams-console"])


async def cams_caller(caller: Caller = Depends(require_api_key)) -> Caller:
    """An authenticated key that is allowed to speak to this integration."""
    caller.require_scope(SCOPE)
    return caller


# --------------------------------------------------------------------------- #
# Read feeds — §1
# --------------------------------------------------------------------------- #

@feeds.get("/_ping")
async def ping(caller: Caller = Depends(cams_caller)):
    """The first call a new consumer makes, to prove the key is wired up."""
    return {"ok": True, "client": caller.client_code, "integration": SCOPE}


@feeds.get("/items")
async def items(request: Request, item_type: str = "", is_active: str = "",
                updated_since: str = "", db: AsyncSession = Depends(get_db),
                caller: Caller = Depends(cams_caller)):
    stmt, mapper = reads.items(item_type, reads.flag(is_active), updated_since)
    return await reads.page(db, stmt, mapper, request.query_params)


@feeds.get("/item-categories")
async def item_categories(request: Request, is_active: str = "", parent_id: str = "",
                          db: AsyncSession = Depends(get_db),
                          caller: Caller = Depends(cams_caller)):
    stmt, mapper = reads.item_categories(reads.flag(is_active), parent_id)
    return await reads.page(db, stmt, mapper, request.query_params)


@feeds.get("/uom")
async def uom(request: Request, is_active: str = "",
              db: AsyncSession = Depends(get_db), caller: Caller = Depends(cams_caller)):
    stmt, mapper = reads.uoms(reads.flag(is_active))
    return await reads.page(db, stmt, mapper, request.query_params)


@feeds.get("/warehouses")
async def warehouses(request: Request, is_active: str = "", tier: str = "",
                     db: AsyncSession = Depends(get_db),
                     caller: Caller = Depends(cams_caller)):
    stmt, mapper = reads.warehouses(reads.flag(is_active), tier)
    return await reads.page(db, stmt, mapper, request.query_params)


@feeds.get("/batches")
async def batches(request: Request, item_id: str = "", updated_since: str = "",
                  db: AsyncSession = Depends(get_db), caller: Caller = Depends(cams_caller)):
    stmt, mapper = reads.batches(item_id, updated_since)
    return await reads.page(db, stmt, mapper, request.query_params)


@feeds.get("/stock-balance")
async def stock_balance(request: Request, warehouse_id: str = "", item_id: str = "",
                        updated_since: str = "", db: AsyncSession = Depends(get_db),
                        caller: Caller = Depends(cams_caller)):
    stmt, mapper = reads.stock_balance(warehouse_id, item_id, updated_since)
    return await reads.page(db, stmt, mapper, request.query_params)


@feeds.get("/material-issues")
async def material_issues(request: Request, destination_warehouse_id: str = "",
                          status: str = "", warehouse_id: str = "",
                          updated_since: str = "", db: AsyncSession = Depends(get_db),
                          caller: Caller = Depends(cams_caller)):
    stmt, mapper = reads.material_issues(destination_warehouse_id, status,
                                         warehouse_id, updated_since)
    return await reads.page(db, stmt, mapper, request.query_params)


@feeds.get("/material-issue-items")
async def material_issue_items(request: Request, issue_id: str = "",
                               db: AsyncSession = Depends(get_db),
                               caller: Caller = Depends(cams_caller)):
    stmt, mapper = reads.material_issue_items(issue_id)
    return await reads.page(db, stmt, mapper, request.query_params)


@feeds.get("/user-warehouses")
async def user_warehouses(request: Request, warehouse_id: str = "", is_active: str = "",
                          db: AsyncSession = Depends(get_db),
                          caller: Caller = Depends(cams_caller)):
    stmt, mapper = reads.user_warehouses(warehouse_id, reads.flag(is_active))
    return await reads.page(db, stmt, mapper, request.query_params)


@feeds.get("/users")
async def users(request: Request, is_active: str = "", employee_code: str = "",
                db: AsyncSession = Depends(get_db), caller: Caller = Depends(cams_caller)):
    stmt, mapper = reads.users(reads.flag(is_active), employee_code)
    return await reads.page(db, stmt, mapper, request.query_params)


@feeds.get("/indents")
async def indents(request: Request, warehouse_id: str = "", status: str = "",
                  updated_since: str = "", db: AsyncSession = Depends(get_db),
                  caller: Caller = Depends(cams_caller)):
    stmt, mapper = reads.indents(warehouse_id, status, updated_since)
    return await reads.page(db, stmt, mapper, request.query_params)


@feeds.get("/indent-items")
async def indent_items(request: Request, indent_id: str = "",
                       db: AsyncSession = Depends(get_db),
                       caller: Caller = Depends(cams_caller)):
    stmt, mapper = reads.indent_items(indent_id)
    return await reads.page(db, stmt, mapper, request.query_params)


@feeds.get("/vehicles")
async def vehicles(request: Request, warehouse_id: str = "",
                   db: AsyncSession = Depends(get_db), caller: Caller = Depends(cams_caller)):
    stmt, mapper = reads.vehicles(warehouse_id)
    return await reads.page(db, stmt, mapper, request.query_params)


@feeds.get("/serial-numbers")
async def serial_numbers(request: Request, consumable_code: str = "", item_id: str = "",
                         warehouse_id: str = "", updated_since: str = "",
                         db: AsyncSession = Depends(get_db),
                         caller: Caller = Depends(cams_caller)):
    stmt, mapper = reads.serial_numbers(consumable_code, item_id, warehouse_id,
                                        updated_since)
    return await reads.page(db, stmt, mapper, request.query_params)


# --------------------------------------------------------------------------- #
# Write endpoints — §4
# --------------------------------------------------------------------------- #
# Each is the same four steps in `ingest.accept`; only the schema and what counts as a
# row differ. Registered through a table so the two path aliases cannot fall out of
# step with each other.

WRITES = (
    ("material-issue-ack", AckIn, lambda p: len(p.items)),
    ("consumption", ConsumptionIn, lambda p: len(p.records)),
    ("stock-balance", StockBalanceIn,
     lambda p: sum(len(f.items) for f in p.facilities)),
    ("stock-transfer", StockTransferIn, lambda p: len(p.items)),
    ("wastage", WastageIn, lambda p: len(p.records)),
)


def _register(path: str, model, count) -> None:
    async def handler(request: Request, db: AsyncSession = Depends(get_db),
                      caller: Caller = Depends(cams_caller)):
        return await ingest.accept(
            db, await request.body(), request.headers.get(SIGNATURE_HEADER), model,
            client_code=caller.client_code, count=count)

    handler.__name__ = f"cams_{path.replace('-', '_')}"
    for route in (f"/{path}", f"/cams/{path}"):
        feeds.post(route)(handler)


for _path, _model, _count in WRITES:
    _register(_path, _model, _count)


# --------------------------------------------------------------------------- #
# Console — the SCM side
# --------------------------------------------------------------------------- #

@console.post("/secret", response_model=SecretOut, status_code=201)
async def rotate_secret(db: AsyncSession = Depends(get_db),
                        user=Depends(require_permission(CONSOLE))):
    """Mint the shared secret B-CAMS signs its writes with. Shown once."""
    return await ingest.rotate_secret(db, user)


@console.get("/events")
async def events(params: PageParams = Depends(), event: str = Query(""),
                 db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(VIEW))):
    return await ingest.receipts(db, params, event or None)


@console.get("/events/{event_id}", response_model=ReceiptOut)
async def event_detail(event_id: str, db: AsyncSession = Depends(get_db),
                       user=Depends(require_permission(VIEW))):
    doc = await ingest.receipt(db, event_id)
    if doc is None:
        raise NotFoundError(f"No B-CAMS event {event_id}")
    return doc


router = APIRouter()
router.include_router(feeds)
router.include_router(console)
