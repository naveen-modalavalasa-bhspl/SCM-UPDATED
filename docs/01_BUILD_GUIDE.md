# SCM ERP — Complete Build Guide

**Stack:** FastAPI + PostgreSQL + React (Vite + TypeScript)
**Team:** You (lead) + 3 developers
**Read this top to bottom. Do not skip sections.**

---

# PART 1 — THE BUSINESS FLOW

Before any code, understand what the system does. This is the chain:

```
1. INDENT        Department needs material. Raises a request.
                 Status: DRAFT → SUBMITTED → APPROVED / REJECTED

2. PURCHASE      Procurement sees approved indents.
   ORDER (PO)    Picks a vendor, creates a PO.
                 Status: DRAFT → SUBMITTED → APPROVED → SENT_TO_VENDOR

3. GRN           Material arrives at gate. Logistics records what came.
   (Goods        Quantity checked against PO.
   Receipt)      Status: DRAFT → RECEIVED → QC_PASSED / QC_FAILED

4. STOCK         GRN passing QC increases stock.

5. ISSUE /       Stock is issued to the department that raised the indent,
   DISPATCH      or dispatched out. Stock decreases.
                 Status: DRAFT → ISSUED
```

**The golden rule of the flow:** each document points *backwards* to the one before it.

- PO row stores `indent_id`
- GRN row stores `po_id`
- Issue row stores `grn_id` (or `indent_id`)

Never the other way round. An indent does not store its PO id.
This one rule prevents 80% of ERP spaghetti.

---

# PART 2 — WHO OWNS WHAT

| Person | Module | Backend folder | Frontend folder |
|---|---|---|---|
| **You** | core + shared + integration | `core/`, `shared/` | `src/shared/` |
| Dev A | Indents | `modules/indents/` | `src/modules/indents/` |
| Dev B | Procurement (PO) | `modules/procurement/` | `src/modules/procurement/` |
| Dev C | Logistics (GRN, Stock, Issue) | `modules/logistics/` | `src/modules/logistics/` |

**Hard rule:** nobody except you edits `core/` or `shared/`.
If Dev B needs a new field on the vendor table, Dev B messages you. You do it. You tell everyone.

---

# PART 3 — FOLDER STRUCTURE (create this exactly)

```
scm-erp/
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── core/
│   │   │   ├── config.py
│   │   │   ├── database.py
│   │   │   ├── security.py
│   │   │   ├── dependencies.py
│   │   │   ├── exceptions.py
│   │   │   └── pagination.py
│   │   ├── shared/
│   │   │   ├── enums.py
│   │   │   ├── models/
│   │   │   │   ├── __init__.py
│   │   │   │   ├── user.py
│   │   │   │   ├── item.py
│   │   │   │   ├── vendor.py
│   │   │   │   ├── department.py
│   │   │   │   └── stock.py
│   │   │   ├── schemas.py
│   │   │   └── numbering.py
│   │   └── modules/
│   │       ├── indents/
│   │       │   ├── models.py
│   │       │   ├── schemas.py
│   │       │   ├── service.py
│   │       │   ├── router.py
│   │       │   └── tests/test_indents.py
│   │       ├── procurement/      (same 5 files)
│   │       └── logistics/        (same 5 files)
│   ├── alembic/
│   ├── scripts/seed.py
│   ├── tests/e2e/test_full_flow.py
│   ├── requirements.txt
│   └── .env.example
│
├── frontend/
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── shared/
│   │   │   ├── api/client.ts
│   │   │   ├── auth/
│   │   │   ├── components/
│   │   │   ├── layout/
│   │   │   └── types.ts
│   │   └── modules/
│   │       ├── indents/
│   │       │   ├── api.ts
│   │       │   ├── types.ts
│   │       │   ├── pages/
│   │       │   └── components/
│   │       ├── procurement/   (same structure)
│   │       └── logistics/     (same structure)
│   ├── package.json
│   └── vite.config.ts
│
├── dumps/
├── docs/
└── README.md
```

**Every module has the same 5 backend files with the same names.** This is non-negotiable. It is what makes the codebase readable.

---

# PART 4 — WHAT EACH FILE DOES

## Backend — core/

| File | Contains | Never contains |
|---|---|---|
| `config.py` | Reads `.env` — DB URL, secret key, CORS origins | Any business rule |
| `database.py` | DB engine, session, `get_db()`, `Base` class | Any table definition |
| `security.py` | Password hashing, JWT encode/decode | User table logic |
| `dependencies.py` | `get_current_user()`, `require_role()` | Business logic |
| `exceptions.py` | `AppException`, `NotFoundError`, `ValidationError` + handler | — |
| `pagination.py` | `page`, `size` params + standard response wrapper | — |

## Backend — shared/

| File | Contains |
|---|---|
| `enums.py` | ALL status values in the entire system |
| `models/user.py` | `users`, `roles` tables |
| `models/item.py` | `items`, `item_categories`, `uom` tables |
| `models/vendor.py` | `vendors` table |
| `models/department.py` | `departments` table |
| `models/stock.py` | `stock`, `stock_movements` tables |
| `schemas.py` | `UserOut`, `ItemOut`, `VendorOut` — read shapes reused everywhere |
| `numbering.py` | Generates `IND/2026/0001`, `PO/2026/0001`, `GRN/2026/0001` |

## Backend — each module (identical in all three)

| File | Contains | Rule |
|---|---|---|
| `models.py` | That module's DB tables only | |
| `schemas.py` | Pydantic in/out shapes | |
| `service.py` | **ALL business logic** | Functions take `db` + data, return objects |
| `router.py` | FastAPI endpoints | Max ~5 lines per endpoint. Calls service. |
| `tests/` | Tests for this module | |

**If you see an `if` statement in `router.py`, it belongs in `service.py`.**

## Frontend — each module

| File | Contains |
|---|---|
| `api.ts` | Functions that call the backend for this module |
| `types.ts` | TypeScript types matching backend schemas |
| `pages/` | Full screens (ListPage, CreatePage, DetailPage) |
| `components/` | Small pieces used only by this module |

---

# PART 5 — DATABASE SCHEMA (copy this)

## Shared tables

```sql
users(id, username, email, password_hash, full_name, role,
      department_id, is_active, created_at)

departments(id, code, name, is_active)

uom(id, code, name)                       -- NOS, KG, LTR, MTR

item_categories(id, code, name)

items(id, code, name, description, category_id, uom_id,
      reorder_level, is_active, created_at)

vendors(id, code, name, contact_person, phone, email, address,
        gstin, is_active, created_at)

stock(id, item_id, quantity, updated_at)  -- one row per item

stock_movements(id, item_id, quantity, direction,       -- IN / OUT
                ref_type, ref_id, created_by, created_at)
```

## Indents module (Dev A)

```sql
indents(id, indent_no, department_id, requested_by, required_date,
        status, remarks, created_at, updated_at)

indent_items(id, indent_id, item_id, quantity, uom_id,
             approved_quantity, remarks)

indent_approvals(id, indent_id, action, acted_by, comments, acted_at)
```

## Procurement module (Dev B)

```sql
purchase_orders(id, po_no, indent_id, vendor_id, po_date,
                expected_date, status, total_amount,
                created_by, created_at, updated_at)

po_items(id, po_id, item_id, quantity, uom_id, rate, amount,
         received_quantity)

po_approvals(id, po_id, action, acted_by, comments, acted_at)
```

## Logistics module (Dev C)

```sql
grn(id, grn_no, po_id, vendor_id, received_date, status,
    vehicle_no, invoice_no, created_by, created_at)

grn_items(id, grn_id, item_id, ordered_quantity, received_quantity,
          accepted_quantity, rejected_quantity, remarks)

issues(id, issue_no, indent_id, department_id, issue_date,
       status, issued_by, created_at)

issue_items(id, issue_id, item_id, quantity)
```

**Freeze this before anyone writes code.** Changes after Day 1 go through you only.

---

# PART 6 — THE ENUMS FILE (write this first, literally first)

`app/shared/enums.py`

```python
from enum import Enum


class IndentStatus(str, Enum):
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    PARTIALLY_ORDERED = "PARTIALLY_ORDERED"
    ORDERED = "ORDERED"
    CLOSED = "CLOSED"


class POStatus(str, Enum):
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    SENT_TO_VENDOR = "SENT_TO_VENDOR"
    PARTIALLY_RECEIVED = "PARTIALLY_RECEIVED"
    RECEIVED = "RECEIVED"
    CLOSED = "CLOSED"
    CANCELLED = "CANCELLED"


class GRNStatus(str, Enum):
    DRAFT = "DRAFT"
    RECEIVED = "RECEIVED"
    QC_PASSED = "QC_PASSED"
    QC_FAILED = "QC_FAILED"
    CLOSED = "CLOSED"


class IssueStatus(str, Enum):
    DRAFT = "DRAFT"
    ISSUED = "ISSUED"
    CANCELLED = "CANCELLED"


class ApprovalAction(str, Enum):
    SUBMITTED = "SUBMITTED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class StockDirection(str, Enum):
    IN = "IN"
    OUT = "OUT"


class UserRole(str, Enum):
    ADMIN = "ADMIN"
    REQUESTER = "REQUESTER"
    APPROVER = "APPROVER"
    PROCUREMENT = "PROCUREMENT"
    STORE = "STORE"
```

**Nobody ever types a status as a raw string anywhere in the codebase.**
Always `IndentStatus.APPROVED`. This alone kills a whole class of bugs.

---

# PART 7 — CORE FILES (copy these, they work)

## `app/core/config.py`

```python
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DATABASE_URL: str
    SECRET_KEY: str
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480
    CORS_ORIGINS: str = "http://localhost:5173"

    class Config:
        env_file = ".env"


settings = Settings()
```

## `app/core/database.py`

```python
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
from app.core.config import settings


class Base(DeclarativeBase):
    pass


engine = create_async_engine(
    settings.DATABASE_URL,
    pool_size=20,          # for 1k+ concurrent users
    max_overflow=10,
    pool_pre_ping=True,
    echo=False,
)

SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db():
    async with SessionLocal() as session:
        yield session
```

## `app/core/exceptions.py`

```python
from fastapi import Request
from fastapi.responses import JSONResponse


class AppException(Exception):
    status_code = 400
    def __init__(self, message: str):
        self.message = message


class NotFoundError(AppException):
    status_code = 404


class ValidationError(AppException):
    status_code = 422


class PermissionError_(AppException):
    status_code = 403


async def app_exception_handler(request: Request, exc: AppException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"success": False, "error": exc.message},
    )
```

Register in `main.py`:
```python
app.add_exception_handler(AppException, app_exception_handler)
```

Now every error in the whole system comes out as `{"success": false, "error": "..."}`.
Frontend handles exactly one error shape.

## `app/core/dependencies.py`

```python
from fastapi import Depends
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.core.database import get_db
from app.core.security import decode_token
from app.core.exceptions import PermissionError_
from app.shared.models.user import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    payload = decode_token(token)
    result = await db.execute(select(User).where(User.id == int(payload["sub"])))
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        raise PermissionError_("Invalid user")
    return user


def require_role(*roles: str):
    async def checker(user: User = Depends(get_current_user)):
        if user.role not in roles:
            raise PermissionError_("Not allowed")
        return user
    return checker
```

Devs now write:
```python
user = Depends(get_current_user)                    # any logged-in user
user = Depends(require_role("APPROVER", "ADMIN"))   # only these roles
```
and never think about auth again.

## `app/shared/numbering.py`

```python
from datetime import datetime
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

PREFIXES = {"indent": "IND", "po": "PO", "grn": "GRN", "issue": "ISS"}


async def next_number(db: AsyncSession, doc_type: str) -> str:
    year = datetime.now().year
    prefix = PREFIXES[doc_type]
    # sequence table: doc_numbers(doc_type, year, last_no)
    row = await db.execute(
        text("""
            INSERT INTO doc_numbers (doc_type, year, last_no)
            VALUES (:t, :y, 1)
            ON CONFLICT (doc_type, year)
            DO UPDATE SET last_no = doc_numbers.last_no + 1
            RETURNING last_no
        """),
        {"t": doc_type, "y": year},
    )
    n = row.scalar_one()
    return f"{prefix}/{year}/{n:04d}"
```

Do it in the database like this, not in Python. Two users clicking Save at the same time will not get the same number.

---

# PART 8 — THE EXAMPLE MODULE (your team copies this shape)

## `modules/indents/service.py`

```python
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.shared.enums import IndentStatus, ApprovalAction
from app.shared.numbering import next_number
from app.core.exceptions import NotFoundError, ValidationError
from app.modules.indents.models import Indent, IndentItem, IndentApproval
from app.modules.indents.schemas import IndentCreate


async def create_indent(db: AsyncSession, data: IndentCreate, user) -> Indent:
    if not data.items:
        raise ValidationError("Indent must have at least one item")

    indent = Indent(
        indent_no=await next_number(db, "indent"),
        department_id=user.department_id,
        requested_by=user.id,
        required_date=data.required_date,
        status=IndentStatus.DRAFT,
        remarks=data.remarks,
    )
    db.add(indent)
    await db.flush()

    for line in data.items:
        db.add(IndentItem(
            indent_id=indent.id,
            item_id=line.item_id,
            quantity=line.quantity,
            uom_id=line.uom_id,
        ))

    await db.commit()
    await db.refresh(indent)
    return indent


async def get_indent(db: AsyncSession, indent_id: int) -> Indent:
    result = await db.execute(select(Indent).where(Indent.id == indent_id))
    indent = result.scalar_one_or_none()
    if not indent:
        raise NotFoundError(f"Indent {indent_id} not found")
    return indent


async def submit_indent(db: AsyncSession, indent_id: int, user) -> Indent:
    indent = await get_indent(db, indent_id)
    if indent.status != IndentStatus.DRAFT:
        raise ValidationError(f"Cannot submit an indent in {indent.status} status")

    indent.status = IndentStatus.SUBMITTED
    db.add(IndentApproval(
        indent_id=indent.id,
        action=ApprovalAction.SUBMITTED,
        acted_by=user.id,
    ))
    await db.commit()
    return indent


async def approve_indent(db: AsyncSession, indent_id: int, comments: str, user) -> Indent:
    indent = await get_indent(db, indent_id)
    if indent.status != IndentStatus.SUBMITTED:
        raise ValidationError(f"Cannot approve an indent in {indent.status} status")

    indent.status = IndentStatus.APPROVED
    db.add(IndentApproval(
        indent_id=indent.id,
        action=ApprovalAction.APPROVED,
        acted_by=user.id,
        comments=comments,
    ))
    await db.commit()
    return indent
```

Notice the pattern in every state-changing function:
1. Load the record (404 if missing)
2. Check current status is legal (422 if not)
3. Change status + write an approval/audit row
4. Commit

**Every module follows this pattern for every action.** Tell your devs this explicitly.

## `modules/indents/router.py`

```python
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_db
from app.core.dependencies import get_current_user, require_role
from app.modules.indents import service
from app.modules.indents.schemas import IndentCreate, IndentOut

router = APIRouter(prefix="/api/indents", tags=["indents"])


@router.post("", response_model=IndentOut)
async def create(data: IndentCreate, db: AsyncSession = Depends(get_db),
                 user=Depends(get_current_user)):
    return await service.create_indent(db, data, user)


@router.get("/{indent_id}", response_model=IndentOut)
async def get_one(indent_id: int, db: AsyncSession = Depends(get_db),
                  user=Depends(get_current_user)):
    return await service.get_indent(db, indent_id)


@router.post("/{indent_id}/submit", response_model=IndentOut)
async def submit(indent_id: int, db: AsyncSession = Depends(get_db),
                 user=Depends(get_current_user)):
    return await service.submit_indent(db, indent_id, user)


@router.post("/{indent_id}/approve", response_model=IndentOut)
async def approve(indent_id: int, comments: str = "",
                  db: AsyncSession = Depends(get_db),
                  user=Depends(require_role("APPROVER", "ADMIN"))):
    return await service.approve_indent(db, indent_id, comments, user)
```

That is what a router looks like. No logic. Ever.

---

# PART 9 — HOW MODULES TALK TO EACH OTHER

The chain is **one-directional**. A module may import the module *before* it. Never after.

```
indents  ←  procurement  ←  logistics
```

- `procurement/service.py` may `from app.modules.indents import service as indent_service`
- `indents/service.py` may NOT import procurement
- `logistics/service.py` may import procurement

### The three handoff functions

Write these three and the whole flow is connected.

**1. Indent → PO** — lives in `procurement/service.py`

```python
async def create_po_from_indent(db, indent_id: int, vendor_id: int, lines, user):
    indent = await indent_service.get_indent(db, indent_id)
    if indent.status != IndentStatus.APPROVED:
        raise ValidationError("Only approved indents can be converted to PO")

    po = PurchaseOrder(
        po_no=await next_number(db, "po"),
        indent_id=indent.id,
        vendor_id=vendor_id,
        status=POStatus.DRAFT,
        created_by=user.id,
    )
    db.add(po)
    await db.flush()
    # add po_items from lines...

    indent.status = IndentStatus.ORDERED
    await db.commit()
    return po
```

**2. PO → GRN** — lives in `logistics/service.py`

```python
async def create_grn_from_po(db, po_id: int, lines, user):
    po = await po_service.get_po(db, po_id)
    if po.status not in (POStatus.SENT_TO_VENDOR, POStatus.PARTIALLY_RECEIVED):
        raise ValidationError("PO is not open for receipt")

    grn = GRN(grn_no=await next_number(db, "grn"), po_id=po.id,
              vendor_id=po.vendor_id, status=GRNStatus.RECEIVED,
              created_by=user.id)
    db.add(grn)
    await db.flush()
    # add grn_items, update po_items.received_quantity
    # if all received -> po.status = RECEIVED else PARTIALLY_RECEIVED
    await db.commit()
    return grn
```

**3. GRN QC pass → Stock** — lives in `logistics/service.py`

```python
async def pass_qc(db, grn_id: int, user):
    grn = await get_grn(db, grn_id)
    if grn.status != GRNStatus.RECEIVED:
        raise ValidationError(f"Cannot QC a GRN in {grn.status} status")

    grn.status = GRNStatus.QC_PASSED
    for line in grn.items:
        await stock_service.move_stock(
            db, item_id=line.item_id, qty=line.accepted_quantity,
            direction=StockDirection.IN, ref_type="GRN", ref_id=grn.id,
            user_id=user.id,
        )
    await db.commit()
    return grn
```

**Stock is only ever changed through `move_stock()`.** Never `stock.quantity = x` anywhere else. One function, one place, always writes a `stock_movements` row so you can trace every change.

---

# PART 10 — API ENDPOINT LIST (give this to your devs)

### Auth (you)
```
POST   /api/auth/login
GET    /api/auth/me
```

### Masters (you)
```
GET    /api/items          ?search=&page=&size=
POST   /api/items
GET    /api/vendors        ?search=&page=&size=
POST   /api/vendors
GET    /api/departments
GET    /api/uom
```

### Indents (Dev A)
```
GET    /api/indents            ?status=&department_id=&page=&size=
POST   /api/indents
GET    /api/indents/{id}
PUT    /api/indents/{id}
POST   /api/indents/{id}/submit
POST   /api/indents/{id}/approve
POST   /api/indents/{id}/reject
GET    /api/indents/approved-pending-po       # for procurement screen
```

### Procurement (Dev B)
```
GET    /api/pos                ?status=&vendor_id=&page=&size=
POST   /api/pos/from-indent/{indent_id}
GET    /api/pos/{id}
PUT    /api/pos/{id}
POST   /api/pos/{id}/submit
POST   /api/pos/{id}/approve
POST   /api/pos/{id}/reject
POST   /api/pos/{id}/send-to-vendor
GET    /api/pos/open-for-grn                  # for logistics screen
```

### Logistics (Dev C)
```
GET    /api/grn                ?status=&po_id=&page=&size=
POST   /api/grn/from-po/{po_id}
GET    /api/grn/{id}
POST   /api/grn/{id}/qc-pass
POST   /api/grn/{id}/qc-fail

GET    /api/stock              ?item_id=&low_stock=
GET    /api/stock/movements    ?item_id=&from=&to=

GET    /api/issues
POST   /api/issues
POST   /api/issues/{id}/issue
```

**Standard list response for every list endpoint:**
```json
{ "items": [...], "total": 120, "page": 1, "size": 20 }
```

---

# PART 11 — FRONTEND

## Every module has 3 pages

```
pages/
├── ListPage.tsx      table + filters + "New" button
├── FormPage.tsx      create / edit
└── DetailPage.tsx    read-only view + action buttons (Submit/Approve/etc.)
```

Three modules × 3 pages = 9 pages. That's the whole app plus masters.

## `src/shared/api/client.ts`

```typescript
import axios from "axios";

export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem("token");
      window.location.href = "/login";
    }
    return Promise.reject(new Error(error.response?.data?.error ?? "Something went wrong"));
  }
);
```

Because the backend has one error shape, this interceptor handles errors for the entire app. Devs just show `error.message`.

## `src/modules/indents/api.ts`

```typescript
import { api } from "@/shared/api/client";
import type { Indent, IndentCreate, Paginated } from "./types";

export const indentApi = {
  list: (params) => api.get<Paginated<Indent>>("/api/indents", { params }).then(r => r.data),
  get: (id: number) => api.get<Indent>(`/api/indents/${id}`).then(r => r.data),
  create: (data: IndentCreate) => api.post<Indent>("/api/indents", data).then(r => r.data),
  submit: (id: number) => api.post<Indent>(`/api/indents/${id}/submit`).then(r => r.data),
  approve: (id: number, comments: string) =>
    api.post<Indent>(`/api/indents/${id}/approve`, null, { params: { comments } }).then(r => r.data),
};
```

Same file, same shape, in all three modules.

## Libraries — use exactly these, no debates

| Need | Use |
|---|---|
| Build | Vite + TypeScript |
| Routing | react-router-dom |
| Server data | @tanstack/react-query |
| Forms | react-hook-form + zod |
| HTTP | axios |
| UI | **one** library — HeroUI or MUI |
| Tables | TanStack Table (or the UI lib's table) |

On HeroUI: it's fine, but it needs Tailwind configured. If nobody on your team has used it, use whatever they already know. **Animations are the last priority.** A week is not enough time to learn a new UI library and ship an ERP.

---

# PART 12 — TESTING (this is why you're rewriting)

## Structure

```
modules/indents/tests/test_indents.py     ← unit: one module's rules
tests/e2e/test_full_flow.py               ← the whole chain
tests/regression/test_old_bugs.py         ← every bug from the old system
```

## The rule that stops bugs repeating

For every bug reported in the old system:
1. Write a test that **fails** because of the bug
2. Then fix the code
3. Test now passes
4. It runs on every push forever

Name them after the ticket: `test_bug_142_negative_grn_quantity()`.

## Example module test

```python
import pytest
from app.shared.enums import IndentStatus
from app.core.exceptions import ValidationError
from app.modules.indents import service


@pytest.mark.asyncio
async def test_cannot_approve_draft_indent(db, requester, approver):
    indent = await service.create_indent(db, sample_indent_data(), requester)
    with pytest.raises(ValidationError):
        await service.approve_indent(db, indent.id, "", approver)


@pytest.mark.asyncio
async def test_submit_then_approve(db, requester, approver):
    indent = await service.create_indent(db, sample_indent_data(), requester)
    await service.submit_indent(db, indent.id, requester)
    result = await service.approve_indent(db, indent.id, "ok", approver)
    assert result.status == IndentStatus.APPROVED
```

## The one E2E test that matters

```python
@pytest.mark.asyncio
async def test_indent_to_stock_full_flow(client, users):
    # 1. create indent
    # 2. submit + approve
    # 3. create PO from indent, submit, approve, send to vendor
    # 4. create GRN from PO
    # 5. QC pass
    # 6. assert stock increased by the accepted quantity
```

If this test is green, your system works. Write it on Day 2 even if it fails; make it pass by Day 3.

## CI — `.github/workflows/ci.yml`

Runs `pytest` and `npm run build` on every push.
**Red build = nobody merges.** No exceptions, including you.

---

# PART 13 — GIT RULES

```
main            always deployable
feature/<name>  short-lived, max 1 day
```

Rules:
1. Branch name = `feature/indent-approval`
2. **Merge to main every single day.** No exceptions.
3. Pull from main every morning before starting.
4. PR needs your review. You read every line that touches `core/` or `shared/`.
5. Never commit `.env`, `node_modules`, `__pycache__`.

`CODEOWNERS`:
```
/backend/app/core/     @you
/backend/app/shared/   @you
/frontend/src/shared/  @you
```

Day-6 integration is how one-week projects die. Daily merges are the whole defence.

---

# PART 14 — YOUR DAY-BY-DAY PLAN

## Day 0 (you alone — do not let anyone start before this)

- [ ] Create repo, folder structure
- [ ] Write `enums.py` completely
- [ ] Write all shared models + all module models
- [ ] Alembic migration, run it
- [ ] `core/` files: config, database, security, dependencies, exceptions, pagination
- [ ] `numbering.py`
- [ ] Auth: login endpoint + `get_current_user`
- [ ] **One complete example module** (indents create + get + submit) with its test passing
- [ ] `seed.py` — creates users, departments, UOM, 20 items, 5 vendors
- [ ] Frontend skeleton: Vite, router, layout, api client, login page, one working list page
- [ ] CI running
- [ ] Push to main

## Day 1 morning — handover meeting (1 hour)

Walk them through, in this order:
1. The business flow (Part 1)
2. The folder structure and the 5-file rule
3. The example module — line by line
4. The rules: no logic in routers, no raw status strings, don't touch core/shared, merge daily
5. Their module + endpoint list

Then everyone runs the project locally and confirms it works before lunch.

## Day 1 afternoon – Day 2 — WALKING SKELETON

Goal by end of Day 2: **the ugliest possible version of the full chain works.**
Create indent → approve → PO → GRN → stock increases. No styling. No validation. No edge cases.

Do not let anyone polish their module before this works. This is the single most important instruction in this document. It surfaces every integration problem on Day 2 instead of Day 6.

## Day 3–4 — Build out

Each dev fills in their module properly: all endpoints, all pages, validation, error handling, tests.
You: masters screens, review PRs, unblock, keep main green.
Daily standup 15 min: what I did / what I'm doing / what's blocking me.

## Day 5 — Old bugs + polish

- Regression tests for the old system's bug list
- UI cleanup, loading states, empty states
- Role permissions checked on every endpoint

## Day 6 — Integration + hardening

- Feature freeze at 11 AM
- Full flow with realistic data volumes
- Add DB indexes: every foreign key, every column you filter by (`status`, `created_at`, `indent_no`, `po_no`)
- Fix slow queries — look for N+1 (use `selectinload` on relationships)
- All four of you test each other's modules

## Day 7 — Deploy

- Deploy backend + frontend
- Run migrations on real DB, load master data
- Smoke test the full flow in production
- README: how to run, how to add a module, how to deploy

---

# PART 15 — HANDLING 1000+ CONCURRENT USERS

Do these, they're cheap:

1. **Async everywhere.** `async def` routes, async SQLAlchemy, asyncpg driver. Never call a blocking library inside an async route — it freezes the whole worker.
2. **Connection pool:** `pool_size=20, max_overflow=10` per worker.
3. **Run multiple workers:** `gunicorn -k uvicorn.workers.UvicornWorker -w 4` behind nginx. Start with `4 × CPU cores`.
4. **Index every foreign key and every filter column.** Postgres does not do this automatically for FKs.
5. **Paginate every list endpoint.** Default size 20, max 100. Never `SELECT *` without a limit.
6. **Fix N+1 queries** with `selectinload()` when loading indents-with-items.

Do NOT do now: caching layers, message queues, microservices, read replicas. You don't need them and you don't have time.

---

# PART 16 — THE RULES, ON ONE PAGE

Print this. Stick it above your desks.

1. Every module has the same 5 files with the same names.
2. All business logic in `service.py`. Routers are 3–5 lines.
3. No raw status strings anywhere. Always the enum.
4. Only the lead edits `core/` and `shared/`.
5. Modules import backwards only: logistics → procurement → indents.
6. Stock changes only through `move_stock()`.
7. Every state change: load → check status → change → audit row → commit.
8. Merge to main every day.
9. Every fixed bug gets a test first.
10. Red build = no merge.

---

# PART 17 — HONEST WARNING

A full SCM ERP with parity to an existing system, in under a week, with 4 people, is very tight. Two things to do about it:

**Ask for scope in writing.** Get the list of what "redevelopment" must include. If it's "everything the old one did plus reports plus data migration," say clearly what fits in a week and what doesn't. Better to negotiate on Day 0 than apologise on Day 7.

**Ship the spine first.** If Day 7 arrives and the walking skeleton (Part 14, Day 2) is solid with three working modules, you have a system. If instead you have three beautiful half-modules that have never talked to each other, you have nothing. Prioritise accordingly, every single day.
