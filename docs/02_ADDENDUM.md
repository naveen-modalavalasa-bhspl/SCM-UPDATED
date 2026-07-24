# SCM ERP — Addendum: Configurability + Claude Code Instructions

Read this **after** `SCM_ERP_BUILD_GUIDE.md`. It adds a platform layer and tells you exactly what to say to Claude Code.

---

# PART A — WHAT TO MAKE CONFIGURABLE (AND WHAT NOT TO)

## Build these as config-driven — worth it

| Thing | Why |
|---|---|
| **Permissions (RBAC)** | Requirements change weekly. Hardcoded role checks = code change every time. |
| **Positions + hierarchy** | Org structure changes. Approval routing depends on it. |
| **Approval workflows** | The #1 thing clients change their mind about. Must be data, not code. |
| **Menu / pages visibility** | Falls out of RBAC for free. |
| **Document numbering formats** | Cheap to make configurable. |
| **Master data** | Items, vendors, UOM, departments — already CRUD screens. |
| **System settings** | Toggles, limits, email on/off. One key-value table. |

## Do NOT build these — they will sink you

| Thing | Why not |
|---|---|
| **Custom/dynamic fields on documents** | Sounds great, costs weeks, breaks every query and report. |
| **Drag-and-drop form builder** | This is a product in itself, not a feature. |
| **Plugin folders / dynamic module loading** | Adds indirection nobody on your team will debug under pressure. |
| **Configurable business rules engine** | "Let admin write conditions in the UI" → you've built a bad programming language. |
| **Configurable DB schema** | Never. |

**The distinction to hold onto:** make *decisions* configurable (who approves, in what order, who can see what). Keep *structure* in code (what a PO is, what fields it has).

Configurable code is not a thing. Clean code that's easy to change is. Those are different, and the guide already covers the second one.

---

# PART B — THE PLATFORM LAYER

Add a fourth top-level folder. **You own all of it — same rule as core and shared.**

```
backend/app/
├── core/          (unchanged — plumbing)
├── shared/        (unchanged — master data nouns)
├── platform/      ← NEW
│   ├── rbac/
│   │   ├── models.py
│   │   ├── schemas.py
│   │   ├── service.py
│   │   ├── permissions.py     # the master list of permission codes
│   │   ├── router.py          # admin CRUD for roles/permissions
│   │   └── tests/
│   ├── positions/
│   │   ├── models.py
│   │   ├── schemas.py
│   │   ├── service.py
│   │   ├── router.py
│   │   └── tests/
│   ├── workflow/
│   │   ├── models.py
│   │   ├── schemas.py
│   │   ├── engine.py          # the actual approval engine
│   │   ├── resolver.py        # works out WHO approves a given stage
│   │   ├── service.py
│   │   ├── router.py          # admin CRUD for workflow design
│   │   └── tests/
│   └── settings/
│       ├── models.py
│       ├── service.py
│       └── router.py
└── modules/       (unchanged — indents, procurement, logistics)
```

Import direction: `modules → platform → shared → core`. Never backwards.

---

# PART C — ROLES vs POSITIONS (get this right or nothing works)

These are two different things and mixing them is the classic ERP mistake.

| | **Role** | **Position** |
|---|---|---|
| Answers | "What can this user *do*?" | "Where does this user *sit*?" |
| Example | `PROCUREMENT_EXEC`, `ADMIN` | Store Manager, Dept Head – Mechanical, Plant Head |
| Used for | Permissions, menus, buttons | Approval routing, hierarchy |
| Shape | Flat bundle of permissions | Tree with levels |

A user has **roles** (one or many) and **positions** (usually one, possibly per-department).

Approval flows route to **positions**, not roles. "The PO goes to the Plant Head" — that's a position. "This user can create POs" — that's a role.

## Schema

```sql
-- POSITIONS
positions(id, code, name, level, parent_position_id, is_active)
    -- level: 1=highest. Used for "escalate up one level".
    -- parent_position_id: builds the reporting tree.

user_positions(id, user_id, position_id, department_id,
               is_primary, valid_from, valid_to, is_active)
    -- department_id nullable: some positions are org-wide (Plant Head),
    -- some are per-department (Dept Head - Mechanical).
    -- valid_from/to lets you handle "acting in charge while X is on leave".

-- RBAC
permissions(id, code, module, resource, action, description)
    -- code example: "indent.approve", "po.create", "stock.view"
    -- SEEDED FROM CODE. Never created by admin in the UI.

roles(id, code, name, description, is_system, is_active)
    -- is_system=true roles cannot be deleted (ADMIN)

role_permissions(role_id, permission_id)
user_roles(user_id, role_id)

-- PAGES / MENU
pages(id, code, path, name, icon, module, parent_id, sort_order,
      required_permission_code, is_active)
    -- Menu is derived: show pages whose required_permission the user holds.
    -- No separate role_pages table. One mechanism, not two.
```

## The permission code convention

`<resource>.<action>` — that's it.

```
indent.view      indent.create    indent.edit     indent.delete
indent.submit    indent.approve   indent.reject
po.view          po.create        po.edit         po.approve
po.send_vendor
grn.view         grn.create       grn.qc
stock.view       stock.adjust
issue.view       issue.create     issue.issue
master.item.manage    master.vendor.manage
admin.roles.manage    admin.workflow.manage    admin.users.manage
```

`platform/rbac/permissions.py` holds this list as constants. The seed script inserts them. **Admins assign permissions to roles; admins never invent new permission codes** — those only exist if code checks them.

## How enforcement works

**Backend — the only real security.** Every endpoint:

```python
@router.post("/{indent_id}/approve")
async def approve(indent_id: int, ...,
                  user=Depends(require_permission("indent.approve"))):
    ...
```

**Frontend — UX only.** `/api/auth/me` returns the user's flat permission list. Then:

```tsx
<Can do="indent.approve">
  <Button onClick={approve}>Approve</Button>
</Can>
```

**Say this to your team out loud:** hiding a button is not security. If an endpoint has no `require_permission`, it is public to every logged-in user. Every endpoint gets one. No exceptions.

---

# PART D — THE APPROVAL WORKFLOW ENGINE

This is the highest-value part of the whole system. Build it once, all three modules use it.

## Schema

```sql
approval_workflows(id, code, name, doc_type, is_active,
                   effective_from, effective_to, created_at)
    -- doc_type: INDENT | PO | GRN | ISSUE
    -- Only one active workflow per doc_type at a time (enforce it).

approval_stages(id, workflow_id, sequence, name,
                approver_type, position_id, role_id, user_id,
                approval_mode, is_optional, sla_hours, can_edit_document)
    -- sequence: 1, 2, 3... order of approval
    -- approver_type:
    --     POSITION            -> position_id
    --     ROLE                -> role_id
    --     SPECIFIC_USER       -> user_id
    --     DEPT_HEAD           -> head of the requester's department
    --     REPORTING_MANAGER   -> parent position of the requester
    -- approval_mode: ANY_ONE | ALL | MAJORITY

approval_stage_conditions(id, stage_id, field, operator, value, logic)
    -- Skip or include a stage based on the document.
    -- field: total_amount | department_id | item_category | quantity
    -- operator: GT | GTE | LT | LTE | EQ | IN
    -- Example: PO stage 3 (Plant Head) only if total_amount GT 500000

approval_instances(id, doc_type, doc_id, workflow_id,
                   current_stage_sequence, status,
                   started_by, started_at, completed_at)
    -- status: IN_PROGRESS | APPROVED | REJECTED | CANCELLED

approval_actions(id, instance_id, stage_sequence, actor_user_id,
                 actor_position_id, action, comments, acted_at)
    -- action: SUBMITTED | APPROVED | REJECTED | RETURNED | DELEGATED
    -- This is your audit trail. Never delete a row from it.

approval_delegations(id, from_user_id, to_user_id,
                     valid_from, valid_to, reason, is_active)
    -- Handles leave/absence. Optional for v1 but cheap to add.
```

## The engine API — only 5 functions

`platform/workflow/engine.py` exposes exactly these. Modules never touch the tables directly.

```python
async def start(db, doc_type: str, doc_id: int, context: dict, user) -> ApprovalInstance:
    """Pick the active workflow, evaluate conditions, create instance at stage 1.
       context = {"total_amount": 250000, "department_id": 3, ...}"""

async def act(db, doc_type: str, doc_id: int, action: str,
              user, comments: str = "") -> ApprovalInstance:
    """APPROVE / REJECT / RETURN. Validates the user is a valid approver
       for the current stage. Advances or closes the instance."""

async def current_approvers(db, doc_type: str, doc_id: int) -> list[User]:
    """Who is this document sitting with right now."""

async def pending_for_user(db, user) -> list[dict]:
    """Everything waiting on this user, across all doc types.
       Powers the 'My Approvals' inbox screen."""

async def history(db, doc_type: str, doc_id: int) -> list[ApprovalAction]:
    """Full audit trail for the document detail page."""
```

## How a module uses it

`modules/indents/service.py` becomes:

```python
from app.platform.workflow import engine
from app.shared.enums import IndentStatus


async def submit_indent(db, indent_id: int, user):
    indent = await get_indent(db, indent_id)
    if indent.status != IndentStatus.DRAFT:
        raise ValidationError(f"Cannot submit an indent in {indent.status} status")

    await engine.start(
        db, doc_type="INDENT", doc_id=indent.id,
        context={
            "department_id": indent.department_id,
            "total_quantity": sum(i.quantity for i in indent.items),
        },
        user=user,
    )
    indent.status = IndentStatus.PENDING_APPROVAL
    await db.commit()
    return indent


async def act_on_indent(db, indent_id: int, action: str, comments: str, user):
    indent = await get_indent(db, indent_id)
    instance = await engine.act(db, "INDENT", indent.id, action, user, comments)

    # Engine owns the approval chain. Module owns the document status.
    if instance.status == "APPROVED":
        indent.status = IndentStatus.APPROVED
    elif instance.status == "REJECTED":
        indent.status = IndentStatus.REJECTED
    # still IN_PROGRESS -> document stays PENDING_APPROVAL

    await db.commit()
    return indent
```

**That's the payoff.** The approval chain can go from 1 stage to 5 stages, route by amount, route by department — and this module code never changes. Procurement and logistics use the same two functions.

## Resolver — the tricky bit

`platform/workflow/resolver.py` answers: *given a stage and a document, which actual users can approve?*

```python
async def resolve_approvers(db, stage, instance, doc_context) -> list[User]:
    if stage.approver_type == "POSITION":
        # users holding this position, optionally scoped to the doc's department
        ...
    elif stage.approver_type == "ROLE":
        ...
    elif stage.approver_type == "SPECIFIC_USER":
        ...
    elif stage.approver_type == "DEPT_HEAD":
        # head of the requester's department
        ...
    elif stage.approver_type == "REPORTING_MANAGER":
        # walk up parent_position_id from the requester's position
        ...
    # then expand through active delegations
```

Write tests for this function specifically. It is where bugs will hide.

## Rules for the engine

1. **Never delete `approval_actions` rows.** It's the audit trail; auditors will ask.
2. **A running instance keeps its original workflow.** If admin edits the workflow mid-flight, in-progress documents continue on the old definition. Version workflows; don't mutate them.
3. **The engine owns the chain; the module owns the document status.** Don't blur this.
4. **Fail loudly.** If no active workflow exists for a doc_type, raise an error at submit time — don't silently auto-approve.
5. **One active workflow per doc_type.** Enforce with a partial unique index.

---

# PART E — ADMIN SCREENS (frontend)

```
src/modules/admin/
├── users/          list, create, assign roles + positions
├── roles/          list, create, permission matrix (checkbox grid)
├── positions/      tree view, create, set parent
├── workflows/      list per doc_type, stage builder
├── settings/       key-value editor
└── pages/          menu config (optional)
```

The workflow builder is the hard screen. **For v1, build it as a simple ordered list, not drag-and-drop:**

```
Workflow: PO Approval          Doc type: PO      [Active ✓]

Stage 1  | Dept Head        | DEPT_HEAD    | Any one | SLA 24h  | [edit][x]
Stage 2  | Procurement Head | POSITION: 12 | Any one | SLA 24h  | [edit][x]
Stage 3  | Plant Head       | POSITION: 3  | All     | SLA 48h  | [edit][x]
         └ Condition: total_amount > 500000

                                              [+ Add stage]  [Save]
```

Up/down arrows to reorder. That's enough. Drag-and-drop is a day you don't have.

The permission matrix is a checkbox grid: permissions down the left grouped by module, roles across the top. One save button.

---

# PART F — REVISED TIMELINE (the honest version)

The platform layer is roughly 2–3 extra days of **your** time, because you own all of it.

## Recommended: split it

**Week 1 — engine yes, admin UI no**

Build the platform tables and engine. Seed the actual workflows, roles and permissions through `seed.py`. Modules call the engine from day one. No admin screens.

You get: correct architecture, working system, config changes possible by editing the seed script and re-running it.

**Week 2 — admin screens**

Roles/permissions matrix, positions tree, workflow builder, users. These are pure CRUD on tables that already exist — additive, low risk.

**Why this split and not the reverse:** retrofitting a workflow engine into hardcoded approvals means rewriting all three modules. Adding an admin UI on top of an existing engine means adding screens. One is a rewrite, the other is a feature.

## Revised Day 0 for you

- [ ] Everything in the original guide's Day 0
- [ ] `platform/rbac/` — models, permissions list, `require_permission()`
- [ ] `platform/positions/` — models, resolver helpers
- [ ] `platform/workflow/` — models, engine, resolver
- [ ] Seed: permissions, 5 roles, position tree, one workflow per doc_type
- [ ] `/api/auth/me` returns roles + positions + flat permission list + menu

That is a long Day 0. Give it a day and a half if you can.

## What to say to your management

> "Redevelopment with configurable roles, permissions and approval workflows is a two-week scope, not one. In week one I'll deliver the working end-to-end flow with roles and approval routing configured by us. In week two, the admin screens so you can change them yourselves without a developer. If it must be one week, we drop the admin screens and I configure changes for you on request."

Say this on Day 0, in writing. Not on Day 6.

---

# PART G — WHAT TO TELL CLAUDE CODE

## Step 1 — put a `CLAUDE.md` at the repo root

Claude Code reads this file automatically in every session. This matters more than any prompt you write. Create `CLAUDE.md`:

```markdown
# SCM ERP — Project Rules

Stack: FastAPI (async) + PostgreSQL + SQLAlchemy 2.0 async + Alembic +
React 18 + Vite + TypeScript + TanStack Query + axios.

Full architecture: see docs/SCM_ERP_BUILD_GUIDE.md and docs/ADDENDUM.md.
Read both before making structural changes.

## Non-negotiable rules

1. Every module has exactly these files, same names:
   models.py, schemas.py, service.py, router.py, tests/
2. ALL business logic lives in service.py. Routers are 3-5 lines and only
   call a service function. Never put an `if` in a router.
3. Never use a raw status string. Always the enum from app/shared/enums.py.
4. Import direction is one-way:
   modules -> platform -> shared -> core
   Never the reverse. Modules may import earlier modules in the chain
   (logistics -> procurement -> indents), never later ones.
5. Every endpoint has Depends(require_permission("<code>")).
   No endpoint is left unprotected.
6. Stock changes ONLY through platform stock service move_stock().
   Never assign stock.quantity directly anywhere else.
7. Approvals go ONLY through app/platform/workflow/engine.py.
   Never write approval logic inside a module.
8. Every state change follows: load -> validate current status ->
   change -> write audit row -> commit.
9. Async everywhere. Never call a blocking library inside an async route.
10. Every new service function gets a test in the module's tests/ folder.

## Conventions

- Errors: raise AppException subclasses from app/core/exceptions.py.
  Never return raw HTTPException from a service.
- Lists: always paginated. Response shape {items, total, page, size}.
- Permission codes: <resource>.<action>, defined in
  app/platform/rbac/permissions.py. Never invent one inline.
- DB: every foreign key gets an index. Use selectinload() for
  relationships to avoid N+1.
- Frontend: each module has api.ts, types.ts, pages/, components/.
  All HTTP through src/shared/api/client.ts. Never call axios directly.

## Before you finish any task

- Run pytest. All tests must pass.
- Run `npm run build`. It must compile.
- Do not create files outside the structure in the guide.
```

## Step 2 — put the guides in the repo

```
docs/SCM_ERP_BUILD_GUIDE.md
docs/ADDENDUM.md
```

Then Claude Code can read them itself instead of you re-pasting.

## Step 3 — work in sessions, one scoped task each

Do **not** say "build the whole ERP." You'll get 8000 lines you don't understand and can't debug at 11 PM on Day 6.

Here are the sessions in order. Run each, review the output, commit, then move on.

---

### Session 1 — skeleton

```
Read docs/SCM_ERP_BUILD_GUIDE.md and docs/ADDENDUM.md fully before writing code.

Create the backend project skeleton only:
- Folder structure exactly as in Part 3 of the guide, plus the platform/
  folders from Part B of the addendum
- app/core/: config.py, database.py, security.py, dependencies.py,
  exceptions.py, pagination.py
- app/shared/enums.py with every enum from Part 6 of the guide
- requirements.txt, .env.example, alembic initialised
- app/main.py that starts and serves /health

Do not create any models or modules yet. Stop after this and show me the
file tree.
```

---

### Session 2 — all models + migration

```
Create all SQLAlchemy models. Use the exact table and column names from
Part 5 of the guide and Part C and D of the addendum.

- app/shared/models/: user, department, item, uom, item_category, vendor,
  stock, stock_movements
- app/platform/rbac/models.py: permissions, roles, role_permissions,
  user_roles, pages
- app/platform/positions/models.py: positions, user_positions
- app/platform/workflow/models.py: approval_workflows, approval_stages,
  approval_stage_conditions, approval_instances, approval_actions,
  approval_delegations
- app/modules/indents/models.py, procurement/models.py, logistics/models.py

Rules: index every foreign key. Use timezone-aware timestamps.
Then generate one Alembic migration and show me the SQL it produces.
```

---

### Session 3 — auth + RBAC

```
Implement authentication and the RBAC layer.

- app/platform/rbac/permissions.py: all permission codes from Part C of
  the addendum as module-level constants plus an ALL_PERMISSIONS list
- app/platform/rbac/service.py: get_user_permissions(user) returning a
  flat set of codes, and get_user_menu(user)
- app/core/dependencies.py: get_current_user, require_permission(code)
- Login endpoint returning a JWT
- GET /api/auth/me returning user, roles, positions, permissions[], menu[]
- Tests: a user without a permission gets 403; with it, 200

Show me the tests passing before moving on.
```

---

### Session 4 — the workflow engine

```
Implement the approval engine at app/platform/workflow/.

Follow Part D of the addendum exactly.
- engine.py exposing only: start, act, current_approvers,
  pending_for_user, history
- resolver.py implementing all five approver_types:
  POSITION, ROLE, SPECIFIC_USER, DEPT_HEAD, REPORTING_MANAGER
- Condition evaluation for stage skipping (GT, GTE, LT, LTE, EQ, IN)
- approval_mode handling: ANY_ONE, ALL, MAJORITY
- A running instance keeps its original workflow definition even if the
  workflow is edited later

Write thorough tests for resolver.py in particular, including:
a 3-stage flow, a conditional stage that is skipped, a rejection at
stage 2, and an ALL-mode stage with two approvers.

This is the most important component in the system. Take the time to get
it right and show me the tests.
```

---

### Session 5 — seed script

```
Write scripts/seed.py. Idempotent — safe to run repeatedly.

Create: all permissions from permissions.py; roles ADMIN, REQUESTER,
APPROVER, PROCUREMENT, STORE with sensible permission sets; a position
tree (Plant Head > Dept Head > Executive); 6 users, one per role;
4 departments; 8 UOMs; 20 items; 5 vendors; and one active approval
workflow per doc_type (INDENT, PO, GRN, ISSUE) with 2-3 stages each,
including one amount-conditional stage on PO.

Print a table of the created logins at the end.
```

---

### Session 6 — the indents module (the reference module)

```
Implement app/modules/indents/ completely: models are done, so write
schemas.py, service.py, router.py, tests/.

Endpoints exactly as listed in Part 10 of the guide.
Submit and approve go through the workflow engine — see the code sample
in Part D of the addendum. Do not write any approval logic in this module.

Every endpoint gets require_permission. Every service function gets a test.

This module is the reference the rest of the team will copy, so make it
exemplary: clear names, docstrings on service functions, no cleverness.
```

---

### Session 7 — walking skeleton

```
Implement just enough of procurement and logistics for the full chain to
work end to end. Skip validation polish, skip extra endpoints.

- procurement: create_po_from_indent, submit, approve (via engine)
- logistics: create_grn_from_po, qc_pass -> move_stock

Then write tests/e2e/test_full_flow.py:
create indent -> submit -> approve -> create PO -> approve ->
create GRN -> QC pass -> assert stock increased by the accepted quantity.

Make that test pass. Report anything in the architecture that got in the way.
```

---

### Session 8 onward — frontend, then hand modules to your devs

```
Create the frontend skeleton: Vite + TS + react-router + TanStack Query,
src/shared/api/client.ts with the interceptors from Part 11 of the guide,
auth context, login page, app layout with a sidebar driven by the menu[]
from /api/auth/me, and a <Can do="permission.code"> component.

Then the three indents pages: ListPage, FormPage, DetailPage.
This is the reference the team copies.
```

---

## Step 4 — habits that keep Claude Code useful

**Commit after every session.** Small commits mean you can throw away one bad session instead of a day.

**Read the diff.** You are the lead. If you can't explain a file to your team, don't merge it. Ask "explain what this file does and why" before accepting anything you don't follow.

**Make it run the tests, not just claim success.** End prompts with "run pytest and show me the output."

**When something's wrong, be specific.** "The approve endpoint doesn't check whether the user is a valid approver for the current stage" beats "fix the approvals."

**Don't let it touch three areas at once.** One session, one concern.

**Re-anchor it when it drifts:** "Re-read CLAUDE.md and docs/ADDENDUM.md Part D, then fix this to match."

**Your devs get their own sessions.** Give each of them CLAUDE.md plus their module's endpoint list, and tell them to point Claude Code at the indents module as the pattern to copy.

---

# PART H — REVISED RULES SHEET

Replaces Part 16 of the main guide. Print this one.

1. Every module has the same 5 files with the same names.
2. All business logic in `service.py`. Routers are 3–5 lines.
3. No raw status strings. Always the enum.
4. Only the lead edits `core/`, `shared/`, `platform/`.
5. Imports go one way: modules → platform → shared → core.
6. Every endpoint has `require_permission(...)`. No exceptions.
7. Hiding a button is not security. The backend check is.
8. Stock changes only through `move_stock()`.
9. Approvals only through the workflow engine. Never inside a module.
10. Every state change: load → check status → change → audit row → commit.
11. Never delete an `approval_actions` row.
12. Merge to main every day.
13. Every fixed bug gets a failing test first.
14. Red build = no merge.
