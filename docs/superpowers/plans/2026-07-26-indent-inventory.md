# Indent + Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An approved indent is checked against stock line by line, reserves what is available (nearest-expiry first), raises a Material Request for the shortfall, and never stalls when workflow or rules configuration is missing.

**Architecture:** `inventory` becomes the base module and owns `stk_balance`, `stk_ledger` and `move_stock()`, plus new `inv_reservations` and `inv_material_requests` tables. `indents` imports `inventory` and calls `allocate_for_indent()` after approval, having first asked `platform/rules` where the document should go. A new `platform/workflow/fallback.py` supplies a hardcoded reporting-manager ladder whenever configuration fails to produce an approver.

**Tech Stack:** FastAPI (async), SQLAlchemy 2.0 async, Alembic, MySQL 8, pytest/pytest-asyncio, React 18 + Vite + TypeScript + TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-26-indent-inventory-design.md`
**Business flow:** `docs/04_SCM_BUSINESS_FLOW.md`

## Global Constraints

- Import chain is `inventory → indents → procurement → logistics → warehouse`. Later modules import earlier ones, never the reverse (CLAUDE.md rule 5).
- `inventory` imports **nothing** from `app.modules.*`.
- All business logic lives in `service.py`. Routers are 3–5 lines with no `if` (rule 2).
- Never a raw status string — always the enum from `app/shared/enums.py` (rule 3).
- Every endpoint carries `Depends(require_permission("<code>"))`. Permission codes live only in `app/platform/rbac/permissions.py` (rule 6).
- Physical stock changes go only through `inventory.service.move_stock()`. Reservation-column changes go only through `inventory.allocation`. No other code assigns to `stk_balance` columns (rule 7, as restated in spec §5).
- Approvals only through `platform/workflow/engine.py` (rule 8).
- `stk_ledger` is append-only. Never delete a `wf_actions` row (rules 7, 9).
- Async everywhere. `hcm_*` tables are read-only outside `platform/hcm/sync.py` (rule 10).
- Lists paginate as `{items, total, page, size}`; errors raise `AppException` subclasses (rule 11).
- Frontend HTTP goes through `src/shared/api/client.ts`. Every list screen uses `<ResponsiveList>`. UX gating with `<Can do="code">` (rule 12).
- No hardcoded config or secrets (rule 13).
- Menu entries are added to `PAGE_TREE` in `backend/scripts/seed.py` **only** — `seed_foundation.py` imports it.
- Run from `backend/`: `.venv/Scripts/python -m pytest`. Run from `frontend/`: `npm test`, `npm run build`. Both must pass before any task is complete.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `backend/app/modules/inventory/models.py` | `Stock`, `StockMovement` (moved from logistics), `Reservation`, `MaterialRequest`, `MaterialRequestItem` |
| `backend/app/modules/inventory/availability.py` | Read-only: what is on hand for an item, across candidate warehouses, in pick order |
| `backend/app/modules/inventory/allocation.py` | Reserve / release / consume against `stk_balance`; FEFO and FIFO |
| `backend/app/modules/inventory/tests/test_allocation.py` | Reservation and pick-order behaviour |
| `backend/app/modules/inventory/tests/test_material_requests.py` | MR lifecycle |
| `backend/app/platform/workflow/fallback.py` | The reporting-manager ladder |
| `backend/app/platform/workflow/tests/test_fallback.py` | Both fallback triggers plus the no-position case |
| `backend/alembic/versions/*_inventory_reservations_and_mr.py` | New tables, new columns |
| `frontend/src/modules/inventory/pages/FulfillmentQueuePage.tsx` | Approved indents awaiting allocation |
| `frontend/src/modules/inventory/pages/MaterialRequestsPage.tsx` | MR list |
| `frontend/src/modules/inventory/pages/MaterialRequestDetailPage.tsx` | MR detail + approval |
| `frontend/src/modules/admin/pages/FallbackLogPage.tsx` | Recent fallback activations |

**Modified**

| File | Change |
|---|---|
| `backend/app/modules/inventory/service.py` | From a 14-line stub to the module's logic |
| `backend/app/modules/inventory/{schemas,router,enums}.py` | Real contents |
| `backend/app/modules/logistics/models.py` | `Stock`/`StockMovement` removed; re-exported for compatibility during the move |
| `backend/app/modules/logistics/service.py` | `move_stock`/`transfer_stock` removed; delegates to `inventory` |
| `backend/app/modules/indents/service.py` | Fires `INDENT_APPROVED`, calls `inventory.allocate_for_indent` |
| `backend/app/modules/indents/models.py` | `IndentItem` gains `allocated_qty`, `status` |
| `backend/app/platform/workflow/engine.py` | Fallback hooks at both trigger points |
| `backend/app/shared/enums.py` | New values (see Task 2) |
| `backend/app/platform/rbac/permissions.py` | New permission codes |
| `backend/scripts/seed.py` | `PAGE_TREE` entries, rule events, LIP/MDP demo warehouses |
| `frontend/src/modules/inventory/api.ts` | Mock arrays deleted; real HTTP |
| `frontend/src/App.tsx` | Routes for the new screens |

---

## Phase 1 — Move stock into inventory

Pure refactor. No behaviour change. The existing 80 tests are the proof.

### Task 1: Relocate the stock tables and mutation point

**Files:**
- Modify: `backend/app/modules/inventory/models.py` (replace the placeholder docstring)
- Modify: `backend/app/modules/logistics/models.py:127-193` (remove `Stock`, `StockMovement`, keep `NO_BIN`/`NO_BATCH`/`NO_PROJECT` re-exported)
- Modify: `backend/app/modules/inventory/service.py` (replace the stub)
- Modify: `backend/app/modules/logistics/service.py:33-152` (remove the stock functions)
- Test: existing `backend/app/modules/logistics/tests/test_logistics.py` must stay green

**Interfaces:**
- Produces: `inventory.models.Stock`, `inventory.models.StockMovement`, `inventory.models.NO_BIN`, `NO_BATCH`, `NO_PROJECT`
- Produces: `inventory.service.move_stock(db, item_id, qty, direction, ref_type, ref_id, ref_no, user, *, warehouse_id=None, facility_id=None, bin_id=NO_BIN, batch_id=NO_BATCH, project_id=NO_PROJECT) -> Stock`
- Produces: `inventory.service.transfer_stock(...)`, `inventory.service.list_stock(...)`, `inventory.service.list_movements(...)`, `inventory.service.default_warehouse_for_facility(db, facility_id) -> Warehouse`

- [ ] **Step 1: Run the suite and record the baseline**

Run: `cd backend && .venv/Scripts/python -m pytest -q`
Expected: `80 passed, 117 skipped`. Write the number down — it must not change in this phase.

- [ ] **Step 2: Move the model classes**

Cut `NO_BIN`, `NO_BATCH`, `NO_PROJECT`, `class Stock` and `class StockMovement` (plus their two `Index(...)` calls) from `app/modules/logistics/models.py` into `app/modules/inventory/models.py`, verbatim, with the imports they need. Keep the module docstring accurate:

```python
"""inv_ and stk_ tables — Inventory owns stock.

stk_balance and stk_ledger are the DB team's tables; only the columns the app reads
or writes are mapped. Inventory is the base module: it imports nothing from
app.modules, so every later module can call move_stock().
"""
```

- [ ] **Step 3: Re-export from logistics so nothing breaks yet**

At the top of `app/modules/logistics/models.py`, after the existing imports:

```python
# Stock moved to modules/inventory (it is the base module and owns stk_*).
# Re-exported so existing logistics imports keep working; callers migrate in Step 5.
from app.modules.inventory.models import (  # noqa: F401
    NO_BATCH, NO_BIN, NO_PROJECT, Stock, StockMovement,
)
```

- [ ] **Step 4: Move the service functions**

Move `default_warehouse_for_facility`, `move_stock`, `transfer_stock`, `list_stock`, `list_movements` and the `_d` helper from `app/modules/logistics/service.py` into `app/modules/inventory/service.py`, verbatim. Replace `app/modules/inventory/service.py`'s stub docstring with:

```python
"""Inventory business logic. The base module — imports nothing from app.modules.

Stock is mutated ONLY through move_stock(); reservation columns only through
allocation.py. No other code assigns to stk_balance.
"""
```

Delete the now-empty `get_overview` and its schema use.

- [ ] **Step 5: Point logistics at inventory**

In `app/modules/logistics/service.py`, replace the removed functions with an import:

```python
from app.modules.inventory import service as inventory_service
from app.modules.inventory.models import (
    NO_BATCH, NO_BIN, NO_PROJECT, Stock, StockMovement,
)
```

Change every internal call of `move_stock(...)` to `inventory_service.move_stock(...)`. Grep to be sure none are missed:

Run: `cd backend && grep -rn "move_stock\|transfer_stock" app --include=*.py`
Expected: definitions only in `app/modules/inventory/service.py`; every other hit is a qualified `inventory_service.` call or a test.

- [ ] **Step 6: Move the stock and movement routes**

Move `stock_router` and `issue_router`'s stock-reading endpoints out of `app/modules/logistics/router.py` into `app/modules/inventory/router.py`. `/api/stock` and `/api/stock/movements` become inventory's. GRN and Issues stay in logistics. Keep the same paths — the frontend must not notice.

`app/modules/inventory/router.py`:

```python
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_permission
from app.core.pagination import Page, PageParams, page_params
from app.modules.inventory import service
from app.modules.inventory.schemas import MovementRow, StockRow
from app.platform.rbac import permissions as perms

router = APIRouter(tags=["inventory"])

stock_router = APIRouter(prefix="/api/stock")


@stock_router.get("", response_model=Page[StockRow])
async def list_stock(params: PageParams = Depends(page_params),
                     item_id: int | None = None, warehouse_id: int | None = None,
                     db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.list_stock(db, params, item_id, warehouse_id)


@stock_router.get("/movements", response_model=Page[MovementRow])
async def list_movements(params: PageParams = Depends(page_params),
                         item_id: int | None = None,
                         db: AsyncSession = Depends(get_db),
                         user=Depends(require_permission(perms.STOCK_VIEW))):
    return await service.list_movements(db, params, item_id)


router.include_router(stock_router)
```

Move `StockRow` and `MovementRow` from `logistics/schemas.py` to `inventory/schemas.py`.

- [ ] **Step 7: Register inventory before logistics**

In `app/main.py`, move `"app.modules.inventory.router"` above `"app.modules.logistics.router"` in `router_paths`. `all_models.py` already lists inventory first — no change needed there.

- [ ] **Step 8: Run the suite**

Run: `cd backend && .venv/Scripts/python -m pytest -q`
Expected: the same count as Step 1. A different number means the move changed behaviour — stop and find out why before continuing.

- [ ] **Step 9: Confirm the API surface is unchanged**

Run: `cd backend && .venv/Scripts/python -c "from app.main import app; print(sorted(r.path for r in app.routes if r.path.startswith('/api')))"`
Expected: `/api/stock` and `/api/stock/movements` present exactly once.

- [ ] **Step 10: Commit**

```bash
git add backend/app/modules/inventory backend/app/modules/logistics backend/app/main.py
git commit -m "refactor: inventory owns stk_balance, stk_ledger and move_stock

Inventory becomes the base module so indents can call it directly when the
fork lands. Pure move: no behaviour change, same endpoints, same test count."
```

### Task 2: Drop the compatibility re-export

**Files:**
- Modify: `backend/app/modules/logistics/models.py` (remove the Step 3 re-export)
- Modify: any file still importing `Stock` from logistics

- [ ] **Step 1: Find remaining importers**

Run: `cd backend && grep -rn "from app.modules.logistics.models import" app --include=*.py`

- [ ] **Step 2: Repoint each to `app.modules.inventory.models`**

Only `Stock`, `StockMovement`, `NO_BIN`, `NO_BATCH`, `NO_PROJECT` move. `GRN`, `GRNItem`, `Issue`, `IssueItem` stay in logistics.

- [ ] **Step 3: Delete the re-export block from `logistics/models.py`**

- [ ] **Step 4: Run the suite**

Run: `cd backend && .venv/Scripts/python -m pytest -q`
Expected: same count as Task 1 Step 1.

- [ ] **Step 5: Commit**

```bash
git add backend/app
git commit -m "refactor: drop the logistics stock re-export shim"
```

---

## Phase 2 — Enums, permissions, tables

### Task 3: Extend the enums

**Files:**
- Modify: `backend/app/shared/enums.py`

**Interfaces:**
- Produces: `MRStatus`, `ReservationStatus`, `PickStrategy`, `IndentItemStatus`; extended `WarehouseType`, `BinType`, `DocType`, `RefType`, `IndentStatus`

- [ ] **Step 1: Extend the existing enums**

`WarehouseType` gains LIP and MDP — both hold stock, both are fulfilment sources:

```python
class WarehouseType(str, Enum):
    """whs_warehouses.warehouse_type. The live column defaults to MAIN.

    LIP (Local Inventory Point) and MDP (Material Distribution Point) are stocking
    points like any other; they differ only in who they serve. Flow doc §1.
    """
    MAIN = "MAIN"
    LIP = "LIP"
    MDP = "MDP"
    TRANSIT = "TRANSIT"
    QUARANTINE = "QUARANTINE"
    SCRAP = "SCRAP"


class BinType(str, Enum):
    """whs_bins.bin_type. Bins nest through parent_id, so the whole
    Warehouse → Floor → Line → Rack → Bin → Lot hierarchy of flow doc §1 is this one
    table at different levels. COLD_ROOM marks temperature-controlled storage."""
    FLOOR = "FLOOR"
    LINE = "LINE"
    ZONE = "ZONE"
    RACK = "RACK"
    SHELF = "SHELF"
    BIN = "BIN"
    LOT = "LOT"
    COLD_ROOM = "COLD_ROOM"
    STORAGE = "STORAGE"
    STAGING = "STAGING"
```

`DocType` gains `MR = "MR"`. `RefType` gains `RESERVATION = "RESERVATION"`. `IndentStatus` gains:

```python
    ALLOCATED = "ALLOCATED"                   # every line reserved from stock
    PARTIALLY_FULFILLED = "PARTIALLY_FULFILLED"
    PENDING_PROCUREMENT = "PENDING_PROCUREMENT"
```

- [ ] **Step 2: Add the new enums**

```python
class ReservationStatus(str, Enum):
    ACTIVE = "ACTIVE"
    RELEASED = "RELEASED"
    CONSUMED = "CONSUMED"


class MRStatus(str, Enum):
    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    ORDERED = "ORDERED"
    CANCELLED = "CANCELLED"


class PickStrategy(str, Enum):
    """FEFO for anything with a batch or expiry — picking the nearest expiry first is
    the point of tracking expiry at all. FIFO otherwise."""
    FEFO = "FEFO"
    FIFO = "FIFO"


class IndentItemStatus(str, Enum):
    PENDING = "PENDING"
    ALLOCATED = "ALLOCATED"
    SHORT = "SHORT"
    ISSUED = "ISSUED"
```

- [ ] **Step 3: Verify nothing broke**

Run: `cd backend && .venv/Scripts/python -m pytest -q`
Expected: unchanged count.

- [ ] **Step 4: Commit**

```bash
git add backend/app/shared/enums.py
git commit -m "feat: enums for reservations, material requests and LIP/MDP"
```

### Task 4: Add the permission codes

**Files:**
- Modify: `backend/app/platform/rbac/permissions.py`

**Interfaces:**
- Produces: `MR_VIEW`, `MR_CREATE`, `MR_APPROVE`, `MR_REJECT`, `STOCK_RESERVE`, `STOCK_TRANSFER`

- [ ] **Step 1: Add the constants and their `Perm` rows**

```python
STOCK_RESERVE = "stock.reserve"
STOCK_TRANSFER = "stock.transfer"
MR_VIEW = "mr.view"
MR_CREATE = "mr.create"
MR_APPROVE = "mr.approve"
MR_REJECT = "mr.reject"
```

And in `ALL_PERMISSIONS`:

```python
    Perm(STOCK_RESERVE, "inventory", "stock", "reserve", "Reserve stock for a document"),
    Perm(STOCK_TRANSFER, "inventory", "stock", "transfer", "Transfer stock between warehouses"),
    Perm(MR_VIEW, "inventory", "material_request", "view", "View material requests"),
    Perm(MR_CREATE, "inventory", "material_request", "create", "Create material requests"),
    Perm(MR_APPROVE, "inventory", "material_request", "approve", "Approve material requests"),
    Perm(MR_REJECT, "inventory", "material_request", "reject", "Reject material requests"),
```

Change the `module` of `STOCK_VIEW` and `STOCK_ADJUST` from `"logistics"` to `"inventory"` to match the move.

- [ ] **Step 2: Grant them in the seed**

In `backend/scripts/seed.py` `ROLE_PERMS`, add `P.MR_VIEW` and `P.STOCK_RESERVE` to STORE and PROCUREMENT; add `P.MR_APPROVE`, `P.MR_REJECT` to PROCUREMENT. ADMIN already gets `P.ALL_CODES`.

- [ ] **Step 3: Reseed and check `/api/auth/me` still resolves**

Run: `cd backend && .venv/Scripts/python -m scripts.seed_foundation`
Expected: seeds without error.

- [ ] **Step 4: Run the suite and commit**

Run: `cd backend && .venv/Scripts/python -m pytest -q`

```bash
git add backend/app/platform/rbac/permissions.py backend/scripts/seed.py
git commit -m "feat: permissions for reservations and material requests"
```

### Task 5: The new tables

**Files:**
- Modify: `backend/app/modules/inventory/models.py`
- Modify: `backend/app/modules/indents/models.py` (two columns on `IndentItem`)
- Create: `backend/alembic/versions/<rev>_inventory_reservations_and_mr.py`

**Interfaces:**
- Produces: `Reservation`, `MaterialRequest`, `MaterialRequestItem`
- Produces: `IndentItem.allocated_quantity`, `IndentItem.status`

- [ ] **Step 1: Add `Reservation` to `inventory/models.py`**

```python
class Reservation(Base):
    """One row per promised quantity.

    Exists so stk_balance.reserved_qty is explainable: a reserved quantity with no
    matching ACTIVE reservation is a bug the system can detect. Released and consumed
    rows are kept, never deleted — "who held this stock in March" must stay answerable.
    """
    __tablename__ = "inv_reservations"
    id = pk()
    stock_id = Column(ForeignKey("stk_balance.id", ondelete="CASCADE"),
                      index=True, nullable=False)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    warehouse_id = Column(BigInteger, index=True, nullable=False)
    bin_id = Column(BigInteger, nullable=False, default=NO_BIN)
    batch_id = Column(BigInteger, nullable=False, default=NO_BATCH)
    project_id = Column(BigInteger, nullable=False, default=NO_PROJECT)
    quantity = Column(Numeric(16, 3), nullable=False)
    ref_type = Column(String(30), nullable=False)     # RefType
    ref_id = Column(BigInteger, nullable=False)
    ref_no = Column(String(50), nullable=True)
    ref_line_id = Column(BigInteger, index=True, nullable=True)   # ind_indent_items.id
    status = Column(String(20), nullable=False, index=True,
                    default=ReservationStatus.ACTIVE.value)
    created_by_id = soft_fk()
    created_by_name = Column(String(200), nullable=True)
    created_at = created_at_col()
    released_at = Column(DateTime(timezone=True), nullable=True)


Index("ix_inv_reservations_ref", Reservation.ref_type, Reservation.ref_id)
Index("ix_inv_reservations_active", Reservation.status, Reservation.item_id)
```

- [ ] **Step 2: Add `MaterialRequest` and `MaterialRequestItem`**

```python
class MaterialRequest(Base):
    """The bridge from a short indent to procurement. Flow doc §4.2 raises it at
    inventory level; §5.1 has procurement approve it."""
    __tablename__ = "inv_material_requests"
    id = pk()
    mr_no = Column(String(30), unique=True, nullable=False)
    mr_date = Column(Date, nullable=True)
    indent_id = Column(BigInteger, index=True, nullable=True)
    indent_no = Column(String(30), nullable=True)
    requested_by_id = soft_fk()
    requested_by_name = Column(String(200), nullable=True)
    department_id = soft_fk()
    department_name = Column(String(200), nullable=True)
    facility_id = soft_fk()
    project_id = soft_fk()
    project_name = Column(String(200), nullable=True)
    status = Column(String(30), nullable=False, index=True)
    priority = Column(String(20), nullable=False, default=Priority.NORMAL.value)
    required_by = Column(Date, nullable=True)
    remarks = Column(Text, nullable=True)
    current_approver_name = Column(String(200), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    created_at = created_at_col()
    updated_at = updated_at_col()

    items = relationship("MaterialRequestItem", back_populates="mr",
                         cascade="all, delete-orphan", lazy="selectin")


class MaterialRequestItem(Base):
    __tablename__ = "inv_material_request_items"
    id = pk()
    mr_id = Column(ForeignKey("inv_material_requests.id", ondelete="CASCADE"),
                   index=True, nullable=False)
    line_no = Column(Integer, nullable=False, default=1)
    item_id = Column(ForeignKey("mst_items.id"), index=True, nullable=False)
    item_code = Column(String(50), nullable=True)
    item_name = Column(String(300), nullable=True)
    uom_code = Column(String(20), nullable=True)
    quantity = Column(Numeric(16, 3), nullable=False)
    ordered_quantity = Column(Numeric(16, 3), nullable=False, default=0)
    project_id = Column(BigInteger, nullable=False, default=NO_PROJECT)
    indent_item_id = Column(BigInteger, index=True, nullable=True)
    remarks = Column(String(500), nullable=True)

    mr = relationship("MaterialRequest", back_populates="items")
```

- [ ] **Step 3: Add the two `IndentItem` columns**

In `backend/app/modules/indents/models.py`, on `IndentItem`, after `received_quantity`:

```python
    allocated_quantity = Column("allocated_qty", Numeric(16, 3), nullable=False, default=0)
    status = Column(String(20), nullable=False, default=IndentItemStatus.PENDING.value)
```

Import `IndentItemStatus` from `app.shared.enums`.

- [ ] **Step 4: Generate the migration**

Run: `cd backend && .venv/Scripts/python -m alembic revision --autogenerate -m "inventory reservations and material requests"`

- [ ] **Step 5: Read the generated migration before applying it**

Open the new file under `backend/alembic/versions/`. It must create only `inv_reservations`, `inv_material_requests`, `inv_material_request_items` and add two columns to `ind_indent_items`. Autogenerate compares `Base.metadata` against the live schema, which has 83 tables and more columns than the ORM maps — **delete any `op.drop_table`, `op.drop_column` or `op.alter_column` it produces for tables this plan does not touch.** Those are the ORM's blind spots, not real drift.

- [ ] **Step 6: Apply it**

Run: `cd backend && .venv/Scripts/python -m alembic upgrade head`

- [ ] **Step 7: Verify the tables exist with the right shape**

Run:
```bash
cd backend && .venv/Scripts/python -c "
import asyncio
from sqlalchemy import text
from app.core.database import engine
async def m():
    async with engine.connect() as c:
        for t in ('inv_reservations','inv_material_requests','inv_material_request_items'):
            rows = (await c.execute(text(f'DESCRIBE {t}'))).fetchall()
            print(t, [r[0] for r in rows])
asyncio.run(m())"
```
Expected: all three tables print their columns.

- [ ] **Step 8: Run the suite and commit**

Run: `cd backend && .venv/Scripts/python -m pytest -q`

```bash
git add backend/app backend/alembic
git commit -m "feat: inv_reservations and inv_material_requests tables"
```

---

## Phase 3 — Availability and allocation

### Task 6: Availability lookup

**Files:**
- Create: `backend/app/modules/inventory/availability.py`
- Test: `backend/app/modules/inventory/tests/test_allocation.py`

**Interfaces:**
- Produces: `availability.candidate_stock(db, item_id, project_id, warehouse_types, strategy) -> list[Stock]` — stock rows with `available_qty > 0`, ordered by pick strategy
- Produces: `availability.available_for(db, item_id, project_id, warehouse_types) -> Decimal` — total available
- Produces: `availability.pick_strategy_for(item) -> str` — FEFO when the item is batch-tracked or the stock carries an expiry, else FIFO

- [ ] **Step 1: Write the failing test for FEFO ordering**

```python
@pytest.mark.asyncio
async def test_fefo_orders_by_nearest_expiry(db, warehouse, item_batched):
    """A batch expiring sooner must be picked before one expiring later, even if the
    later batch was received first. This is the whole reason expiry is tracked."""
    await _stock(db, item_batched, warehouse, batch_id=1,
                 expiry=date(2027, 1, 1), qty=50)
    await _stock(db, item_batched, warehouse, batch_id=2,
                 expiry=date(2026, 9, 1), qty=30)

    rows = await availability.candidate_stock(
        db, item_batched.id, NO_PROJECT, None, PickStrategy.FEFO.value)

    assert [r.batch_id for r in rows] == [2, 1]
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd backend && .venv/Scripts/python -m pytest app/modules/inventory/tests/test_allocation.py::test_fefo_orders_by_nearest_expiry -v`
Expected: FAIL — `ModuleNotFoundError: app.modules.inventory.availability`

- [ ] **Step 3: Implement `availability.py`**

```python
"""Read-only stock lookup. Answers "what can we pick, and in what order".

Separated from allocation.py because ordering is where the business rule lives (FEFO
for anything perishable) and it must be testable without writing anything.
"""
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.inventory.models import NO_PROJECT, Stock
from app.shared.enums import PickStrategy


def pick_strategy_for(item) -> str:
    """FEFO when the item carries batches or expiry, FIFO otherwise."""
    if getattr(item, "is_batch_tracked", False):
        return PickStrategy.FEFO.value
    return PickStrategy.FIFO.value


def _order_by(strategy: str):
    if strategy == PickStrategy.FEFO.value:
        # NULL expiry sorts last: an undated batch should not jump ahead of one with a
        # known, near expiry.
        return (Stock.expiry_date.is_(None), Stock.expiry_date.asc(), Stock.id.asc())
    return (Stock.id.asc(),)


async def candidate_stock(db: AsyncSession, item_id: int,
                          project_id: int = NO_PROJECT,
                          warehouse_types: list[str] | None = None,
                          strategy: str = PickStrategy.FIFO.value) -> list[Stock]:
    stmt = select(Stock).where(Stock.item_id == item_id,
                               Stock.available_qty > 0)
    if project_id is not None:
        stmt = stmt.where(Stock.project_id == project_id)
    if warehouse_types:
        stmt = stmt.where(Stock.warehouse_id.in_(
            select(Warehouse.id).where(Warehouse.warehouse_type.in_(warehouse_types),
                                       Warehouse.is_active.is_(True))))
    stmt = stmt.order_by(*_order_by(strategy)).with_for_update()
    return list((await db.execute(stmt)).scalars().all())


async def available_for(db: AsyncSession, item_id: int,
                        project_id: int = NO_PROJECT,
                        warehouse_types: list[str] | None = None) -> Decimal:
    rows = await candidate_stock(db, item_id, project_id, warehouse_types)
    return sum((r.available_qty or Decimal("0") for r in rows), Decimal("0"))
```

Import `Warehouse` from `app.shared.models.warehouse`.

- [ ] **Step 4: Run the test**

Run: `cd backend && .venv/Scripts/python -m pytest app/modules/inventory/tests/test_allocation.py -v`
Expected: PASS

- [ ] **Step 5: Add the FIFO test and make it pass**

```python
@pytest.mark.asyncio
async def test_fifo_when_item_is_not_batch_tracked(db, warehouse, item_plain):
    await _stock(db, item_plain, warehouse, qty=10)
    await _stock(db, item_plain, warehouse, bin_id=2, qty=20)
    rows = await availability.candidate_stock(
        db, item_plain.id, NO_PROJECT, None, PickStrategy.FIFO.value)
    assert [r.bin_id for r in rows] == [NO_BIN, 2]
```

- [ ] **Step 6: Commit**

```bash
git add backend/app/modules/inventory
git commit -m "feat: availability lookup with FEFO and FIFO pick order"
```

### Task 7: Reserve, release, consume

**Files:**
- Create: `backend/app/modules/inventory/allocation.py`
- Test: `backend/app/modules/inventory/tests/test_allocation.py`

**Interfaces:**
- Produces: `allocation.reserve(db, item_id, qty, ref_type, ref_id, ref_no, user, *, project_id, warehouse_types, ref_line_id, item) -> tuple[Decimal, Decimal]` returning `(reserved, shortfall)`
- Produces: `allocation.release(db, ref_type, ref_id, *, ref_line_id=None) -> Decimal` returning the quantity returned to `available_qty`
- Produces: `allocation.consume(db, ref_type, ref_id, *, ref_line_id=None) -> Decimal`

- [ ] **Step 1: Write the failing test — two indents cannot reserve the same unit**

```python
@pytest.mark.asyncio
async def test_second_reservation_sees_reduced_availability(db, warehouse, item_plain, user):
    """The money path. If this breaks, two departments are both told the stock is
    theirs and one of them finds out at the loading bay."""
    await _stock(db, item_plain, warehouse, qty=100)

    reserved_a, short_a = await allocation.reserve(
        db, item_plain.id, Decimal("80"), RefType.RESERVATION.value, 1, "IND-1",
        user, item=item_plain)
    reserved_b, short_b = await allocation.reserve(
        db, item_plain.id, Decimal("50"), RefType.RESERVATION.value, 2, "IND-2",
        user, item=item_plain)

    assert (reserved_a, short_a) == (Decimal("80"), Decimal("0"))
    assert (reserved_b, short_b) == (Decimal("20"), Decimal("30"))

    stock = await _reload(db, item_plain, warehouse)
    assert stock.available_qty == Decimal("0")
    assert stock.reserved_qty == Decimal("100")
    assert stock.total_qty == Decimal("100")   # nothing physically moved
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd backend && .venv/Scripts/python -m pytest app/modules/inventory/tests/test_allocation.py::test_second_reservation_sees_reduced_availability -v`
Expected: FAIL — `ModuleNotFoundError: app.modules.inventory.allocation`

- [ ] **Step 3: Implement `allocation.py`**

```python
"""Reservation: the only code that moves quantity between available_qty and
reserved_qty.

Reserving is NOT a stock movement. Nothing has physically moved, so total_qty is
untouched and no stk_ledger row is written; the ledger row appears when the issue
posts. That is why this does not go through move_stock().
"""
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.modules.inventory import availability
from app.modules.inventory.models import NO_PROJECT, Reservation, Stock
from app.shared.enums import ReservationStatus
from app.shared.models.base import utcnow

ZERO = Decimal("0")


def _d(value) -> Decimal:
    return Decimal(str(value))


async def reserve(db: AsyncSession, item_id: int, qty, ref_type: str, ref_id: int,
                  ref_no: str, user, *, project_id: int = NO_PROJECT,
                  warehouse_types: list[str] | None = None,
                  ref_line_id: int | None = None, item=None) -> tuple[Decimal, Decimal]:
    """Reserve up to `qty`. Returns (reserved, shortfall).

    A partial reservation is a normal outcome, not an error: an indent for 100 when 60
    are on hand should reserve 60 and let the caller raise an MR for 40.
    """
    qty = _d(qty)
    if qty <= ZERO:
        raise ValidationError("Reservation quantity must be positive")

    strategy = availability.pick_strategy_for(item) if item is not None else None
    rows = await availability.candidate_stock(
        db, item_id, project_id, warehouse_types,
        strategy or availability.PickStrategy.FIFO.value)

    remaining, reserved_total = qty, ZERO
    for stock in rows:
        if remaining <= ZERO:
            break
        take = min(remaining, stock.available_qty or ZERO)
        if take <= ZERO:
            continue
        stock.available_qty = (stock.available_qty or ZERO) - take
        stock.reserved_qty = (stock.reserved_qty or ZERO) + take
        # total_qty is unchanged on purpose: reserving moves nothing.
        db.add(Reservation(
            stock_id=stock.id, item_id=item_id, warehouse_id=stock.warehouse_id,
            bin_id=stock.bin_id, batch_id=stock.batch_id, project_id=stock.project_id,
            quantity=take, ref_type=ref_type, ref_id=ref_id, ref_no=ref_no,
            ref_line_id=ref_line_id, status=ReservationStatus.ACTIVE.value,
            created_by_id=getattr(user, "id", None),
            created_by_name=getattr(user, "full_name", None),
        ))
        remaining -= take
        reserved_total += take

    await db.flush()
    return reserved_total, remaining


async def _active(db: AsyncSession, ref_type: str, ref_id: int,
                  ref_line_id: int | None) -> list[Reservation]:
    stmt = select(Reservation).where(
        Reservation.ref_type == ref_type, Reservation.ref_id == ref_id,
        Reservation.status == ReservationStatus.ACTIVE.value)
    if ref_line_id is not None:
        stmt = stmt.where(Reservation.ref_line_id == ref_line_id)
    return list((await db.execute(stmt.with_for_update())).scalars().all())


async def release(db: AsyncSession, ref_type: str, ref_id: int,
                  ref_line_id: int | None = None) -> Decimal:
    """Give reserved stock back. Called when a document is rejected or cancelled."""
    returned = ZERO
    for res in await _active(db, ref_type, ref_id, ref_line_id):
        stock = await db.get(Stock, res.stock_id, with_for_update=True)
        if stock is not None:
            stock.reserved_qty = (stock.reserved_qty or ZERO) - res.quantity
            stock.available_qty = (stock.available_qty or ZERO) + res.quantity
        res.status = ReservationStatus.RELEASED.value
        res.released_at = utcnow()
        returned += res.quantity
    await db.flush()
    return returned


async def consume(db: AsyncSession, ref_type: str, ref_id: int,
                  ref_line_id: int | None = None) -> Decimal:
    """Mark reservations used. The caller posts the matching move_stock() OUT, which
    is what writes the ledger row and reduces total_qty."""
    used = ZERO
    for res in await _active(db, ref_type, ref_id, ref_line_id):
        stock = await db.get(Stock, res.stock_id, with_for_update=True)
        if stock is not None:
            stock.reserved_qty = (stock.reserved_qty or ZERO) - res.quantity
        res.status = ReservationStatus.CONSUMED.value
        res.released_at = utcnow()
        used += res.quantity
    await db.flush()
    return used
```

- [ ] **Step 4: Run the test**

Run: `cd backend && .venv/Scripts/python -m pytest app/modules/inventory/tests/test_allocation.py -v`
Expected: PASS

- [ ] **Step 5: Write the release round-trip test**

```python
@pytest.mark.asyncio
async def test_release_restores_exact_pre_allocation_availability(db, warehouse, item_plain, user):
    await _stock(db, item_plain, warehouse, qty=100)
    before = (await _reload(db, item_plain, warehouse)).available_qty

    await allocation.reserve(db, item_plain.id, Decimal("42"),
                             RefType.RESERVATION.value, 7, "IND-7", user,
                             item=item_plain)
    returned = await allocation.release(db, RefType.RESERVATION.value, 7)

    stock = await _reload(db, item_plain, warehouse)
    assert returned == Decimal("42")
    assert stock.available_qty == before
    assert stock.reserved_qty == Decimal("0")
```

- [ ] **Step 6: Run it, then run the whole suite**

Run: `cd backend && .venv/Scripts/python -m pytest -q`
Expected: previous count + the new tests, all passing.

- [ ] **Step 7: Commit**

```bash
git add backend/app/modules/inventory
git commit -m "feat: stock reservation with reserve, release and consume"
```

---

## Phase 4 — Material Request

### Task 8: MR creation and lifecycle

**Files:**
- Modify: `backend/app/modules/inventory/service.py`
- Modify: `backend/app/modules/inventory/schemas.py`
- Modify: `backend/app/modules/inventory/router.py`
- Test: `backend/app/modules/inventory/tests/test_material_requests.py`

**Interfaces:**
- Produces: `service.create_mr_from_shortfall(db, indent_id, indent_no, shortfalls, user, ctx) -> MaterialRequest` where `shortfalls` is `list[dict]` with keys `item_id, item_code, item_name, uom_code, quantity, project_id, indent_item_id`
- Produces: `service.list_mrs(db, params, status=None)`, `service.get_mr(db, mr_id)`, `service.submit_mr(db, mr_id, user)`, `service.act_on_mr(db, mr_id, action, user, comments)`

- [ ] **Step 1: Write the failing test**

```python
@pytest.mark.asyncio
async def test_mr_carries_every_shortfall_line(db, user):
    mr = await service.create_mr_from_shortfall(
        db, indent_id=5, indent_no="IND-5",
        shortfalls=[
            {"item_id": 1, "item_code": "A", "item_name": "Valve", "uom_code": "PCS",
             "quantity": Decimal("5"), "project_id": NO_PROJECT, "indent_item_id": 11},
            {"item_id": 2, "item_code": "B", "item_name": "Cable", "uom_code": "MTR",
             "quantity": Decimal("50"), "project_id": NO_PROJECT, "indent_item_id": 12},
        ],
        user=user, ctx={"department_id": None})

    assert mr.mr_no.startswith("MR")
    assert mr.status == MRStatus.PENDING_APPROVAL.value
    assert [i.quantity for i in mr.items] == [Decimal("5"), Decimal("50")]
    assert mr.indent_no == "IND-5"
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd backend && .venv/Scripts/python -m pytest app/modules/inventory/tests/test_material_requests.py -v`
Expected: FAIL — `AttributeError: create_mr_from_shortfall`

- [ ] **Step 3: Register the MR document series**

In `backend/scripts/seed.py`, add a `sys_doc_series` row for `DocType.MR` with prefix `MR` so `next_number(db, DocType.MR.value)` works. Follow the existing INDENT/PO rows exactly.

- [ ] **Step 4: Implement `create_mr_from_shortfall`**

Follow the shape of `indents.service.create_indent`: allocate the number with `next_number`, build the header, build items with `line_no` starting at 1, `db.add`, `await db.flush()`, then start the approval workflow with `engine.start(db, DocType.MR.value, mr.id, ctx, user)` and set the status to `MRStatus.PENDING_APPROVAL.value`.

- [ ] **Step 5: Run the test**

Run: `cd backend && .venv/Scripts/python -m pytest app/modules/inventory/tests/test_material_requests.py -v`
Expected: PASS

- [ ] **Step 6: Add list/get/act endpoints**

```python
mr_router = APIRouter(prefix="/api/material-requests")


@mr_router.get("", response_model=Page[MRListRow])
async def list_mrs(params: PageParams = Depends(page_params), status: str | None = None,
                   db: AsyncSession = Depends(get_db),
                   user=Depends(require_permission(perms.MR_VIEW))):
    return await service.list_mrs(db, params, status)


@mr_router.get("/{mr_id}", response_model=MROut)
async def get_mr(mr_id: int, db: AsyncSession = Depends(get_db),
                 user=Depends(require_permission(perms.MR_VIEW))):
    return await service.get_mr(db, mr_id)


@mr_router.post("/{mr_id}/approve", response_model=MROut)
async def approve_mr(mr_id: int, body: ActionIn, db: AsyncSession = Depends(get_db),
                     user=Depends(require_permission(perms.MR_APPROVE))):
    return await service.act_on_mr(db, mr_id, ApprovalAction.APPROVED.value, user,
                                   body.comments)


@mr_router.post("/{mr_id}/reject", response_model=MROut)
async def reject_mr(mr_id: int, body: ActionIn, db: AsyncSession = Depends(get_db),
                    user=Depends(require_permission(perms.MR_REJECT))):
    return await service.act_on_mr(db, mr_id, ApprovalAction.REJECTED.value, user,
                                   body.comments)


router.include_router(mr_router)
```

- [ ] **Step 7: Test that rejecting an MR releases the indent's reservations**

```python
@pytest.mark.asyncio
async def test_rejecting_an_mr_leaves_allocated_lines_reserved(
        db, warehouse, item_plain, item_batched, user):
    """Rejecting the procurement half must not disturb the half already reserved from
    stock — those lines are still going to be issued."""
    await _stock(db, item_plain, warehouse, qty=30)
    result = await service.allocate_for_indent(db, 20, "IND-20", [
        {"indent_item_id": 1, "item_id": item_plain.id, "item_code": "A",
         "item_name": "Cement", "uom_code": "BAG", "quantity": Decimal("30"),
         "project_id": NO_PROJECT},
        {"indent_item_id": 2, "item_id": item_batched.id, "item_code": "B",
         "item_name": "Valve", "uom_code": "PCS", "quantity": Decimal("5"),
         "project_id": NO_PROJECT},
    ], user)

    await service.act_on_mr(db, result.mr_id, ApprovalAction.REJECTED.value,
                            user, "no budget")

    stock = await _reload(db, item_plain, warehouse)
    assert stock.reserved_qty == Decimal("30")
```

- [ ] **Step 8: Run the suite and commit**

Run: `cd backend && .venv/Scripts/python -m pytest -q`

```bash
git add backend/app/modules/inventory backend/scripts/seed.py
git commit -m "feat: material request document with approval"
```

---

## Phase 5 — The fork

### Task 9: `allocate_for_indent`

**Files:**
- Modify: `backend/app/modules/inventory/service.py`
- Test: `backend/app/modules/inventory/tests/test_allocation.py`

**Interfaces:**
- Produces: `service.allocate_for_indent(db, indent_id, indent_no, lines, user, *, warehouse_types=None, ctx=None) -> AllocationResult` with fields `allocated: list[dict]`, `shortfalls: list[dict]`, `mr_id: int | None`, `outcome: str` (an `IndentStatus` value)
- `lines` is `list[dict]` with keys `indent_item_id, item_id, item_code, item_name, uom_code, quantity, project_id`

- [ ] **Step 1: Write the failing test for the partial case**

```python
@pytest.mark.asyncio
async def test_partial_indent_reserves_what_it_can_and_raises_one_mr(
        db, warehouse, item_plain, item_batched, user):
    await _stock(db, item_plain, warehouse, qty=100)      # line 1 fully available
    # item_batched has no stock at all -> line 2 is entirely short

    result = await service.allocate_for_indent(
        db, indent_id=9, indent_no="IND-9", user=user,
        lines=[
            {"indent_item_id": 1, "item_id": item_plain.id, "item_code": "A",
             "item_name": "Cement", "uom_code": "BAG", "quantity": Decimal("40"),
             "project_id": NO_PROJECT},
            {"indent_item_id": 2, "item_id": item_batched.id, "item_code": "B",
             "item_name": "Valve", "uom_code": "PCS", "quantity": Decimal("5"),
             "project_id": NO_PROJECT},
        ])

    assert result.outcome == IndentStatus.PARTIALLY_FULFILLED.value
    assert result.mr_id is not None
    assert len(result.shortfalls) == 1
    assert result.shortfalls[0]["quantity"] == Decimal("5")
    stock = await _reload(db, item_plain, warehouse)
    assert stock.reserved_qty == Decimal("40")
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd backend && .venv/Scripts/python -m pytest app/modules/inventory/tests/test_allocation.py::test_partial_indent_reserves_what_it_can_and_raises_one_mr -v`
Expected: FAIL — `AttributeError: allocate_for_indent`

- [ ] **Step 3: Implement it**

```python
@dataclass
class AllocationResult:
    allocated: list[dict]
    shortfalls: list[dict]
    mr_id: int | None
    outcome: str


async def allocate_for_indent(db, indent_id: int, indent_no: str, lines: list[dict],
                              user, *, warehouse_types: list[str] | None = None,
                              ctx: dict | None = None) -> AllocationResult:
    """Reserve what is on hand, collect what is not, raise one MR for the remainder.

    Takes plain dicts rather than the Indent ORM object: inventory is the base module
    and must not learn the shape of an indent.
    """
    allocated, shortfalls = [], []

    for line in lines:
        item = await db.get(Item, line["item_id"])
        reserved, short = await allocation.reserve(
            db, line["item_id"], line["quantity"], RefType.RESERVATION.value,
            indent_id, indent_no, user,
            project_id=line.get("project_id") or NO_PROJECT,
            warehouse_types=warehouse_types,
            ref_line_id=line.get("indent_item_id"), item=item)

        if reserved > 0:
            allocated.append({**line, "quantity": reserved})
        if short > 0:
            shortfalls.append({**line, "quantity": short})

    mr = None
    if shortfalls:
        mr = await create_mr_from_shortfall(db, indent_id, indent_no, shortfalls,
                                            user, ctx or {})

    if not shortfalls:
        outcome = IndentStatus.ALLOCATED.value
    elif allocated:
        outcome = IndentStatus.PARTIALLY_FULFILLED.value
    else:
        outcome = IndentStatus.PENDING_PROCUREMENT.value

    return AllocationResult(allocated=allocated, shortfalls=shortfalls,
                            mr_id=mr.id if mr else None, outcome=outcome)
```

- [ ] **Step 4: Run the test, then add the all-available and nothing-available cases**

```python
@pytest.mark.asyncio
async def test_fully_available_indent_raises_no_mr(db, warehouse, item_plain, user):
    await _stock(db, item_plain, warehouse, qty=100)
    result = await service.allocate_for_indent(db, 10, "IND-10", [
        {"indent_item_id": 1, "item_id": item_plain.id, "item_code": "A",
         "item_name": "Cement", "uom_code": "BAG", "quantity": Decimal("10"),
         "project_id": NO_PROJECT}], user)
    assert result.outcome == IndentStatus.ALLOCATED.value
    assert result.mr_id is None


@pytest.mark.asyncio
async def test_nothing_available_goes_straight_to_procurement(db, item_plain, user):
    result = await service.allocate_for_indent(db, 11, "IND-11", [
        {"indent_item_id": 1, "item_id": item_plain.id, "item_code": "A",
         "item_name": "Cement", "uom_code": "BAG", "quantity": Decimal("10"),
         "project_id": NO_PROJECT}], user)
    assert result.outcome == IndentStatus.PENDING_PROCUREMENT.value
    assert result.mr_id is not None
```

- [ ] **Step 5: Run the suite and commit**

Run: `cd backend && .venv/Scripts/python -m pytest -q`

```bash
git add backend/app/modules/inventory
git commit -m "feat: allocate an approved indent, per line, MR for the shortfall"
```

### Task 10: Wire the fork into indent approval

**Files:**
- Modify: `backend/app/modules/indents/service.py:235-276` (`act_on_indent`)
- Modify: `backend/scripts/seed.py` (rule events)
- Test: `backend/app/modules/indents/tests/test_indents.py`

**Interfaces:**
- Consumes: `inventory.service.allocate_for_indent`, `platform.rules.evaluator.fire`

- [ ] **Step 1: Seed the rule events**

In `backend/scripts/seed.py`, add `rule_events` rows so the admin GUI can offer the field list:

```python
RULE_EVENTS = [
    ("INDENT_APPROVED", "Indent approved", "indents",
     "Fires when an indent clears its approval chain",
     {"indent_id": "number", "department_id": "number", "project_id": "number",
      "total_qty": "number", "priority": "text"}),
    ("INDENT_SHORT", "Indent short of stock", "inventory",
     "Fires when an approved indent could not be fully reserved",
     {"indent_id": "number", "short_lines": "number"}),
    ("MR_RAISED", "Material request raised", "inventory",
     "Fires when a shortfall becomes a material request",
     {"mr_id": "number", "indent_id": "number"}),
]
```

- [ ] **Step 2: Write the failing test**

```python
@pytest.mark.asyncio
async def test_approving_an_indent_reserves_available_stock(
        db, client, approver_token, seeded_indent, stocked_item):
    """The §3 fork. Before this, approval ended at APPROVED and nothing happened."""
    r = await client.post(f"/api/indents/{seeded_indent.id}/approve",
                          json={"comments": ""},
                          headers={"Authorization": f"Bearer {approver_token}"})
    assert r.status_code == 200
    assert r.json()["status"] == IndentStatus.ALLOCATED.value

    stock = await _reload(db, stocked_item)
    assert stock.reserved_qty > 0
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd backend && .venv/Scripts/python -m pytest app/modules/indents/tests/test_indents.py -k reserves_available_stock -v`
Expected: FAIL — status is `APPROVED`, `reserved_qty` is 0.

- [ ] **Step 4: Implement the hook in `act_on_indent`**

After the existing approval logic sets `IndentStatus.APPROVED`, and only when the workflow instance has completed:

```python
    if instance.status == InstanceStatus.COMPLETED.value and \
            action == ApprovalAction.APPROVED.value:
        ctx = {"indent_id": indent.id, "department_id": indent.department_id,
               "project_id": indent.project_id, "total_qty": indent.total_qty,
               "priority": indent.priority}
        actions = await rules.fire(db, "INDENT_APPROVED", ctx,
                                   doc_type=DocType.INDENT.value, doc_id=indent.id)
        warehouse_types = _fulfillment_warehouse_types(actions)

        result = await inventory_service.allocate_for_indent(
            db, indent.id, indent.indent_no, _lines_for_allocation(indent), user,
            warehouse_types=warehouse_types, ctx=ctx)

        for line in indent.items:
            allocated = next((a for a in result.allocated
                              if a["indent_item_id"] == line.id), None)
            line.allocated_quantity = allocated["quantity"] if allocated else 0
            line.status = (IndentItemStatus.ALLOCATED.value if allocated
                           else IndentItemStatus.SHORT.value)
        indent.status = result.outcome
```

And the two helpers. `_fulfillment_warehouse_types` reads `ROUTE_FULFILLMENT` action params and **falls back to the default when no rule matched** — spec §6:

```python
def _fulfillment_warehouse_types(actions) -> list[str] | None:
    """Which warehouse types may fulfil. None means "any".

    A routing event that matches no rule must not strand the document: we take the
    default path and the no-match row in rule_executions records that we did.
    """
    routes = rules.actions_of_type(actions, RuleActionType.ROUTE_FULFILLMENT.value)
    for action in routes:
        types = (action.params or {}).get("warehouse_types")
        if types:
            return list(types)
    return None
```

- [ ] **Step 5: Run the test**

Run: `cd backend && .venv/Scripts/python -m pytest app/modules/indents/tests/test_indents.py -v`
Expected: PASS

- [ ] **Step 6: Test that rejection releases reservations**

```python
@pytest.mark.asyncio
async def test_rejecting_an_allocated_indent_returns_the_stock(db, allocated_indent, user):
    before = (await _reload(db, allocated_indent.items[0])).available_qty
    await service.act_on_indent(db, allocated_indent.id,
                                ApprovalAction.REJECTED.value, user, "no budget")
    assert (await _reload(db, allocated_indent.items[0])).available_qty == before
```

Implement by calling `allocation.release(db, RefType.RESERVATION.value, indent.id)` on the rejection path.

- [ ] **Step 7: Run the suite and commit**

Run: `cd backend && .venv/Scripts/python -m pytest -q`

```bash
git add backend/app backend/scripts/seed.py
git commit -m "feat: approved indents check stock, reserve, and raise an MR for the rest"
```

---

## Phase 6 — Fallback

### Task 11: The reporting-manager ladder

**Files:**
- Create: `backend/app/platform/workflow/fallback.py`
- Create: `backend/app/platform/workflow/tests/test_fallback.py`
- Modify: `backend/app/platform/workflow/engine.py`

**Interfaces:**
- Produces: `fallback.ladder_approvers(db, requester_id, requester_position_id, levels=3) -> list[HcmEmployee]`
- Produces: `fallback.record(db, instance, reason, approvers)` — writes the `wf_actions` FALLBACK row and the audit entry
- Produces: `fallback.MAX_LEVELS = 3`

- [ ] **Step 1: Write the failing test**

```python
@pytest.mark.asyncio
async def test_ladder_walks_three_levels_and_stops_at_the_top(db, position_tree):
    """junior -> supervisor -> manager -> head, and no further."""
    approvers = await fallback.ladder_approvers(
        db, requester_id=position_tree.junior_emp_id,
        requester_position_id=position_tree.junior_position_id)
    assert [a.id for a in approvers] == [
        position_tree.supervisor_emp_id,
        position_tree.manager_emp_id,
        position_tree.head_emp_id,
    ]
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd backend && .venv/Scripts/python -m pytest app/platform/workflow/tests/test_fallback.py -v`
Expected: FAIL — `ModuleNotFoundError: app.platform.workflow.fallback`

- [ ] **Step 3: Implement `fallback.py`**

```python
"""The hardcoded approval ladder.

Both engines are configuration-driven, so a missing or misconfigured row could strand
a document forever. This is the floor underneath them: requester -> reporting manager
-> their manager, three levels, defined in CODE not in the database. A
database-driven fallback would share the failure mode it exists to protect against.

Every activation is recorded twice — a wf_actions row and a warning-level audit entry
— because a fallback that fires silently is a misconfiguration nobody ever fixes.
"""
from app.platform.hcm import service as hcm_service
from app.platform.hcm.models import HcmEmployee
from app.platform.rbac.models import Role, UserRole
from app.shared.enums import AuditAction, UserRole as RoleCode

MAX_LEVELS = 3


async def ladder_approvers(db, requester_id: int | None,
                           requester_position_id: int | None,
                           levels: int = MAX_LEVELS) -> list[HcmEmployee]:
    """Walk up hcm_positions.parent_position_id, collecting holders at each level."""
    if requester_id is None or requester_position_id is None:
        return []

    approvers: list[HcmEmployee] = []
    seen: set[int] = {requester_id}
    position_id = requester_position_id

    for _ in range(levels):
        position = await hcm_service.get_position(db, position_id)
        if not position or not position.parent_position_id:
            break
        holders = await hcm_service.get_position_holders(db, position.parent_position_id)
        for holder in holders:
            if holder.id not in seen and holder.is_active:
                approvers.append(holder)
                seen.add(holder.id)
        position_id = position.parent_position_id

    return approvers


async def admin_approvers(db) -> list[HcmEmployee]:
    """The terminal safety net. A document is never left with zero approvers."""
    stmt = (select(HcmEmployee)
            .join(UserRole, UserRole.employee_id == HcmEmployee.id)
            .join(Role, Role.id == UserRole.role_id)
            .where(Role.code == RoleCode.ADMIN.value, HcmEmployee.is_active.is_(True)))
    return list((await db.execute(stmt)).scalars().all())


async def resolve(db, requester_id, requester_position_id) -> tuple[list, str]:
    """Returns (approvers, reason). Reason names which floor caught the document."""
    approvers = await ladder_approvers(db, requester_id, requester_position_id)
    if approvers:
        return approvers, "REPORTING_LADDER"
    return await admin_approvers(db), "ADMIN_SAFETY_NET"
```

- [ ] **Step 4: Run the test**

Run: `cd backend && .venv/Scripts/python -m pytest app/platform/workflow/tests/test_fallback.py -v`
Expected: PASS

- [ ] **Step 5: Test the no-position case falls through to ADMIN**

```python
@pytest.mark.asyncio
async def test_requester_with_no_position_routes_to_admin(db, admin_employee):
    approvers, reason = await fallback.resolve(db, requester_id=999, requester_position_id=None)
    assert reason == "ADMIN_SAFETY_NET"
    assert admin_employee.id in [a.id for a in approvers]
```

- [ ] **Step 6: Commit**

```bash
git add backend/app/platform/workflow
git commit -m "feat: hardcoded reporting-manager ladder for approval fallback"
```

### Task 12: Hook the ladder into the engine

**Files:**
- Modify: `backend/app/platform/workflow/engine.py` (`start`, `_materialize_pending`)
- Test: `backend/app/platform/workflow/tests/test_fallback.py`

**Interfaces:**
- Consumes: `fallback.resolve`, `fallback.record`

- [ ] **Step 1: Write the failing test for the missing-workflow trigger**

```python
@pytest.mark.asyncio
async def test_document_with_no_configured_workflow_uses_the_ladder(db, user, position_tree):
    """Before this, engine.start raised and the document could not be submitted."""
    instance = await engine.start(db, DocType.MR.value, 1,
                                  {"requester_position_id": position_tree.junior_position_id},
                                  user)
    assert instance.status == InstanceStatus.IN_PROGRESS.value
    approvers = await engine.current_approvers(db, DocType.MR.value, 1)
    assert position_tree.supervisor_emp_id in [a.id for a in approvers]
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd backend && .venv/Scripts/python -m pytest app/platform/workflow/tests/test_fallback.py -k no_configured_workflow -v`
Expected: FAIL — `NotFoundError` from `_active_workflow`.

- [ ] **Step 3: Implement the two hooks**

In `_active_workflow`, return `None` rather than raising. In `start`, when it returns `None`, build a synthetic single-stage instance whose approvers come from `fallback.resolve`, and call `fallback.record(db, instance, "NO_WORKFLOW", approvers)`.

In `_materialize_pending`, when `resolve_approvers` returns `[]` for a stage, substitute `fallback.resolve` for **that stage only** and call `fallback.record(db, instance, "EMPTY_STAGE", approvers)`. The rest of the configured chain continues untouched.

- [ ] **Step 4: Run the test**

Run: `cd backend && .venv/Scripts/python -m pytest app/platform/workflow/tests/test_fallback.py -v`
Expected: PASS

- [ ] **Step 5: Test the empty-stage trigger keeps the rest of the chain**

```python
@pytest.mark.asyncio
async def test_empty_stage_is_substituted_and_later_stages_survive(db, user, wf_three_stages):
    """Stage 2's position is vacant. Stage 2 falls back; stage 3 is still the
    configured approver, not the ladder."""
    await engine.start(db, DocType.INDENT.value, 3,
                       {"requester_position_id": wf_three_stages.junior_position_id}, user)
    await engine.act(db, DocType.INDENT.value, 3, ApprovalAction.APPROVED.value,
                     wf_three_stages.stage1_user, "")

    stage2 = await engine.current_approvers(db, DocType.INDENT.value, 3)
    assert wf_three_stages.supervisor_emp_id in [a.id for a in stage2]

    await engine.act(db, DocType.INDENT.value, 3, ApprovalAction.APPROVED.value,
                     wf_three_stages.supervisor_user, "")

    stage3 = await engine.current_approvers(db, DocType.INDENT.value, 3)
    assert [a.id for a in stage3] == [wf_three_stages.stage3_employee_id]
```

- [ ] **Step 6: Test that both records are written**

```python
@pytest.mark.asyncio
async def test_every_fallback_writes_an_action_row_and_an_audit_entry(db, user, position_tree):
    await engine.start(db, DocType.MR.value, 2,
                       {"requester_position_id": position_tree.junior_position_id}, user)
    actions = (await db.execute(select(Action).where(Action.action == "FALLBACK"))).scalars().all()
    audits = (await db.execute(select(AuditLog).where(AuditLog.entity_type == "wf_instances"))).scalars().all()
    assert len(actions) == 1
    assert len(audits) == 1
```

- [ ] **Step 7: Run the full suite and commit**

Run: `cd backend && .venv/Scripts/python -m pytest -q`
Expected: every earlier test still passing.

```bash
git add backend/app/platform/workflow
git commit -m "feat: approval falls back to the manager ladder when config fails"
```

---

## Phase 7 — Frontend

### Task 13: Real data in the inventory screens

**Files:**
- Modify: `frontend/src/modules/inventory/api.ts` (delete every mock array)
- Modify: `frontend/src/modules/inventory/types.ts`
- Modify: `frontend/src/modules/inventory/tests/api.test.ts`

**Interfaces:**
- Produces: `listStock`, `listMovements`, `createTransfer`, `listMaterialRequests`, `getMaterialRequest`, `approveMaterialRequest`, `listFulfillmentQueue`

- [ ] **Step 1: Rewrite `api.ts` against the real endpoints**

Delete `seedInventoryMockData` and every `let mock*` binding. Every call goes through `@/shared/api/client`:

```typescript
import { api } from "@/shared/api/client";
import type { Page } from "@/shared/api/types";
import type { StockBalanceItem, StockLedgerItem, MaterialRequest } from "./types";

export const listStock = (params: StockBalanceFilter) =>
  api.get<Page<StockBalanceItem>>("/api/stock", { params }).then((r) => r.data);

export const listMovements = (params: StockLedgerFilter) =>
  api.get<Page<StockLedgerItem>>("/api/stock/movements", { params }).then((r) => r.data);

export const listMaterialRequests = (params: { page?: number; status?: string }) =>
  api.get<Page<MaterialRequest>>("/api/material-requests", { params }).then((r) => r.data);
```

- [ ] **Step 2: Update the tests to mock HTTP, not the module**

The existing tests call `seedInventoryMockData()`. Replace with `vi.mock("@/shared/api/client")` returning fixture payloads shaped like the backend's `{items, total, page, size}`.

- [ ] **Step 3: Run the frontend tests**

Run: `cd frontend && npm test`
Expected: PASS

- [ ] **Step 4: Build**

Run: `cd frontend && npm run build`
Expected: compiles with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/modules/inventory
git commit -m "feat: inventory screens run on real data, mock store deleted"
```

### Task 14: Fulfilment queue, MR screens, fallback log

**Files:**
- Create: `frontend/src/modules/inventory/pages/FulfillmentQueuePage.tsx`
- Create: `frontend/src/modules/inventory/pages/MaterialRequestsPage.tsx`
- Create: `frontend/src/modules/inventory/pages/MaterialRequestDetailPage.tsx`
- Create: `frontend/src/modules/admin/pages/FallbackLogPage.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `backend/scripts/seed.py` (`PAGE_TREE`)

- [ ] **Step 1: Build the three inventory screens**

Each uses `<PageHeader>`, `<ResponsiveList>`, `<StatusPill>` and `<Can>` from `@/shared/components`. No module restyles a primitive (rule 12). The fulfilment queue lists approved indents with per-line availability; MR list and detail mirror the existing indent List/Detail pages in `frontend/src/modules/indents/pages/`.

- [ ] **Step 2: Add the routes**

In `frontend/src/App.tsx`:

```tsx
<Route path="inventory/fulfillment" element={<FulfillmentQueuePage />} />
<Route path="inventory/material-requests" element={<MaterialRequestsPage />} />
<Route path="inventory/material-requests/:id" element={<MaterialRequestDetailPage />} />
<Route path="admin/fallback-log" element={<FallbackLogPage />} />
```

- [ ] **Step 3: Add the menu entries**

In `backend/scripts/seed.py` `PAGE_TREE`, under `grp_inventory`:

```python
    ("inv_fulfillment", "/inventory/fulfillment", "Fulfilment Queue", "check-circle",
     P.STOCK_RESERVE, 51, "grp_inventory"),
    ("inv_mr", "/inventory/material-requests", "Material Requests", "file-text",
     P.MR_VIEW, 56, "grp_inventory"),
```

And under `grp_settings`:

```python
    ("admin_fallback", "/admin/fallback-log", "Fallback Log", "shield",
     P.ADMIN_AUDIT_VIEW, 99, "grp_settings"),
```

- [ ] **Step 4: Reseed and confirm the rail**

Run: `cd backend && .venv/Scripts/python -m scripts.seed_foundation`
Then check the pages exist:
```bash
cd backend && .venv/Scripts/python -c "
import asyncio
from sqlalchemy import select
from app.core.database import SessionLocal
from app.platform.rbac.models import Page
async def m():
    async with SessionLocal() as db:
        for r in (await db.execute(select(Page).order_by(Page.sort_order))).scalars():
            print(r.sort_order, r.code, r.path)
asyncio.run(m())"
```
Expected: the three new codes appear under their groups.

- [ ] **Step 5: Build and test**

Run: `cd frontend && npm test && npm run build`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add frontend backend/scripts/seed.py
git commit -m "feat: fulfilment queue, material request screens, fallback log"
```

---

## Final verification

- [ ] **Backend suite**

Run: `cd backend && .venv/Scripts/python -m pytest -q`
Expected: every test passes, including the six from spec §8.

- [ ] **Frontend**

Run: `cd frontend && npm test && npm run build`
Expected: both pass.

- [ ] **End-to-end by hand**

Start the backend and frontend. Log in as `requester`, raise an indent with one stocked item and one unstocked item, approve it as `approver`, then confirm: the indent reads PARTIALLY_FULFILLED, `stk_balance.reserved_qty` moved for the stocked line, one MR exists for the short line, and `stk_balance.total_qty` did not change.

- [ ] **Update the docs**

Add the inventory module and its endpoints to `CLAUDE.md`'s architecture block, and move the resolved items out of the "Deviations" list.
