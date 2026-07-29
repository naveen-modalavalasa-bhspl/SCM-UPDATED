# SCM ERP: Fresher Developer Guide

## 1. What is this project?

This project is a Supply Chain Management (SCM) ERP application.

It manages the movement of a material request from the time a user asks for an
item until the item is purchased, received, stored, and issued.

The simplified business flow is:

```text
User creates Indent
        ↓
Indent is approved
        ↓
Inventory checks available stock
        ↓
 ┌─────────────────────┴─────────────────────┐
 │ Stock is available                       │ Stock is not available
 ↓                                          ↓
Reserve and issue stock                     Create Material Request
                                            ↓
                                            Create Purchase Order
                                            ↓
                                            Send PO to vendor
                                            ↓
                                            Receive goods and create GRN
                                            ↓
                                            Quality check
                                            ↓
                                            Add accepted goods to stock
                                            ↓
                                            Issue the material
```

An **Indent** is an internal request for one or more materials.

Example: A project employee needs 20 boxes of gloves. The employee creates an
indent. After approval, Inventory checks whether the gloves are already in stock.
If there is insufficient stock, Procurement buys the shortfall from a vendor.

---

## 2. Technology stack

The project contains two applications:

- `frontend/` is the website displayed in the browser.
- `backend/` contains the API, business rules, authentication, and database access.

### Frontend

| Technology | Purpose |
|---|---|
| React 18 | Builds the user interface from reusable components. |
| TypeScript | Adds type checking to JavaScript. |
| Vite | Runs the frontend development server and creates production builds. |
| React Router | Connects browser URLs to pages. |
| TanStack Query | Fetches, caches, and refreshes API data. |
| Axios | Sends HTTP requests to the backend. |
| HeroUI | Main reusable UI component library. |
| Tailwind CSS 4 | Provides utility CSS classes for styling. |
| Ant Design | Used by parts of the Warehouse UI. |
| React Hook Form | Helps manage form values and validation. |
| Zod | Defines and validates data structures. |
| Recharts | Creates charts. |
| Vitest | Runs frontend unit and component tests. |
| Testing Library | Tests React screens from the user's point of view. |

### Backend

| Technology | Purpose |
|---|---|
| Python 3.11 | Backend programming language. |
| FastAPI | Creates REST API endpoints. |
| Uvicorn | Runs the FastAPI development server. |
| SQLAlchemy 2 | Maps Python objects to database tables and runs queries. |
| Alembic | Creates and updates the database schema through migrations. |
| MySQL 8 | Stores application data. |
| Pydantic | Validates API request and response data. |
| JWT | Authenticates a user using a signed access token. |
| HTTPX | Calls external HTTP services such as HCM. |
| APScheduler | Runs scheduled HCM synchronization. |
| Pytest | Runs backend tests. |

### Main development URLs

| Service | Default URL |
|---|---|
| Frontend | `http://localhost:5173` |
| Backend API | `http://localhost:8000` |
| API documentation | `http://localhost:8000/docs` |
| Backend health check | `http://localhost:8000/health` |

During development, Vite forwards frontend requests beginning with `/api` to the
backend on port `8000`.

---

## 3. Common file types

### `.tsx`

A `.tsx` file is a **TypeScript file that can contain JSX**.

JSX is the HTML-like syntax used to describe a React screen:

```tsx
type WelcomeProps = {
  name: string;
};

export function Welcome({ name }: WelcomeProps) {
  return <h1>Welcome, {name}</h1>;
}
```

Use `.tsx` when a file returns or contains React UI.

Examples in this project:

- `App.tsx` defines the application routes.
- `LoginPage.tsx` defines the login screen.
- `StatusPill.tsx` defines a reusable status component.

### `.ts`

A `.ts` file contains TypeScript but normally does not contain React JSX.

It is used for:

- API functions
- Types and interfaces
- Constants
- Date or number formatting
- Other helper functions

Examples:

- `api.ts` sends requests to the backend.
- `types.ts` describes the shape of data.
- `dateTime.ts` contains date and time helpers.

### `.py`

A `.py` file contains Python code. All backend application code is written in
Python.

Examples:

- `router.py` defines API URLs.
- `service.py` contains business logic.
- `models.py` defines database tables.
- `schemas.py` validates API input and output.

### `.css`

Contains styles and design variables. The main frontend stylesheet is
`frontend/src/index.css`.

### `.json`

Stores structured configuration or data.

Important examples:

- `package.json` lists frontend dependencies and npm commands.
- `tsconfig.json` contains TypeScript compiler rules.

### `.ini`

Contains tool configuration. For example, `pytest.ini` configures backend tests
and `alembic.ini` configures migrations.

### `.env`

Contains environment-specific values such as the database URL, secret key, CORS
origins, and HCM connection details.

Do not commit real passwords, API keys, or production secrets.

### `.mako`

`alembic/script.py.mako` is the template Alembic uses when it creates a new
database migration file.

### `.md`

A Markdown documentation file, such as `README.md` or this guide.

### `.test.ts` and `.test.tsx`

Frontend test files. A `.test.tsx` file normally tests a React component, while a
`.test.ts` file normally tests TypeScript logic or API functions.

---

## 4. High-level folder structure

```text
scm-erp/
├── frontend/
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── index.css
│   │   ├── pages/
│   │   ├── shared/
│   │   └── modules/
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
│
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── core/
│   │   ├── shared/
│   │   ├── platform/
│   │   └── modules/
│   ├── alembic/
│   ├── scripts/
│   ├── tests/
│   └── requirements.txt
│
└── docs/
```

### Important frontend files

| Path | Purpose |
|---|---|
| `frontend/src/main.tsx` | Browser entry point. It starts React and renders `App`. |
| `frontend/src/App.tsx` | Adds global providers, protects routes, and maps URLs to pages. |
| `frontend/src/index.css` | Global styles and design tokens. |
| `frontend/src/pages/` | Top-level pages such as Login and Home Dashboard. |
| `frontend/src/shared/api/client.ts` | Shared Axios client. Adds the JWT token and handles common API errors. |
| `frontend/src/shared/auth/AuthContext.tsx` | Stores the logged-in user and provides login, logout, position switching, and permission checks. |
| `frontend/src/shared/components/` | Reusable UI components used by different modules. |
| `frontend/src/shared/layout/` | Main navigation and page layout. |
| `frontend/src/modules/` | Business feature modules. |

### Important backend folders

| Path | Purpose |
|---|---|
| `backend/app/main.py` | Starts FastAPI, configures CORS, adds the health endpoint, and registers routers. |
| `backend/app/core/` | Low-level configuration, database connection, security, dependencies, exceptions, and pagination. |
| `backend/app/shared/` | Shared enums, master models, warehouse/bin models, and numbering helpers. |
| `backend/app/platform/` | Cross-module features such as auth, RBAC, workflow, rules, HCM, settings, and admin. |
| `backend/app/modules/` | SCM business modules: Indents, Inventory, Procurement, and Logistics. |
| `backend/alembic/versions/` | Database migration history. |
| `backend/scripts/` | Data seeding and one-time setup scripts. |
| `backend/tests/e2e/` | End-to-end tests that join multiple modules together. |

---

## 5. Standard module structure

A backend business module normally has:

```text
module/
├── models.py
├── schemas.py
├── service.py
├── router.py
└── tests/
```

### `models.py`

Defines SQLAlchemy database models.

Example: the Indents module has `Indent` and `IndentItem`. These classes map to
database tables.

### `schemas.py`

Defines Pydantic request and response objects.

It answers questions such as:

- What fields must the frontend send?
- Which fields are optional?
- What shape will the API return?

### `service.py`

Contains business logic.

Examples:

- Validate that an indent can be submitted.
- Create a PO from an approved indent.
- Increase stock after a GRN passes QC.

This is normally the most important backend file when understanding a feature.

### `router.py`

Defines the HTTP method and URL, checks permissions, obtains a database session,
and calls the service.

Example:

```text
POST /api/indents/{id}/submit
```

The router should remain thin. Business decisions belong in `service.py`.

### `tests/`

Tests the module's behavior and prevents old features from breaking.

A frontend module normally has:

```text
module/
├── api.ts
├── types.ts
├── pages/
├── components/
└── tests/
```

### `api.ts`

Contains functions that call backend endpoints.

### `types.ts`

Contains TypeScript interfaces and union types that match API data.

### `pages/`

Contains complete screens connected to browser routes.

### `components/`

Contains smaller reusable parts used by the module's pages.

---

## 6. How one request travels through the application

Example: a user opens the Indent list.

```text
Browser URL: /indents
        ↓
App.tsx renders IndentListPage
        ↓
The page calls a function from modules/indents/api.ts
        ↓
Shared Axios client adds: Authorization: Bearer <token>
        ↓
GET /api/indents reaches backend/modules/indents/router.py
        ↓
require_permission("indent.view") checks access
        ↓
router.py calls indents/service.py
        ↓
service.py creates a SQLAlchemy query
        ↓
MySQL returns rows
        ↓
Pydantic validates the API response
        ↓
TanStack Query caches the result
        ↓
React displays the list
```

When a request fails:

- A `401` response removes the saved token and sends the user to `/login`.
- Other backend errors are converted to a readable JavaScript `Error`.
- The page should display that message to the user.

---

## 7. Business modules and their flows

## 7.1 Home / Dashboard

**Purpose:** Gives a logged-in user a summary of work requiring attention.

Main frontend files:

- `frontend/src/pages/DashboardPage.tsx`
- `frontend/src/modules/home/api.ts`
- `frontend/src/modules/home/types.ts`

Main backend files:

- `backend/app/platform/home/router.py`
- `backend/app/platform/home/service.py`

Flow:

```text
User logs in
  → frontend calls /api/home/summary
  → backend builds KPIs and attention items
  → dashboard displays the summary
```

---

## 7.2 Authentication

**Purpose:** Logs a user in, loads their identity and permissions, and supports
employees who have more than one active position.

Important endpoints:

- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/switch-position`

Flow:

```text
User submits username and password
  → backend validates credentials
  → backend returns a JWT access token
  → frontend saves the token in localStorage
  → frontend calls /api/auth/me
  → backend returns employee, position, permissions, and menu
  → protected application pages are displayed
```

The frontend permission check controls visibility, but the backend permission
dependency provides the real security.

---

## 7.3 HCM integration

**Purpose:** Mirrors employee and organization data from the external Human
Capital Management system.

It includes:

- Employees
- Offices and facilities
- Departments and sections
- Positions and position levels
- Position assignments and reporting relationships
- Scheduled and manual synchronization

Flow:

```text
Manual request or scheduler starts sync
  → HCM client calls the external HCM API
  → mapper converts external fields to SCM fields
  → sync service inserts or updates hcm_* tables
  → auth, approvals, and RBAC use the mirrored data
  → sync result is recorded in the log
```

SCM does not treat employee identity as ordinary local master data. HCM is the
source of truth for people and organizational structure.

---

## 7.4 Masters

**Purpose:** Stores reusable reference data used by transactions.

The Masters module includes:

- Items
- Item categories, classes, and subclasses
- General names and dosage forms
- Brands and manufacturers
- Units of measure and conversions
- HSN tax codes
- Packaging and item packaging
- Item components or kits
- Attributes, specifications, features, and category tags
- Vendors
- Warehouses and bins
- Projects
- Item groups
- Bills of material (BOMs)

Main frontend folder:

- `frontend/src/modules/masters/`

Main backend folder:

- `backend/app/shared/masters/`

Flow:

```text
Authorized admin opens Masters
  → selects a master type
  → searches, creates, or edits a record
  → generic masters router selects the correct master definition
  → backend validates uniqueness and relationships
  → mst_* record is saved
  → transaction forms can use the new master record
```

Important note: Projects are read-only in the Masters API because HCM owns them.

---

## 7.5 Indents

**Purpose:** Allows an employee or project to request materials.

Main data:

- Indent header
- One or more indent item lines
- Requester, department, facility, and project snapshot
- Required date and priority
- Status
- Current approver
- Workflow journey and history

Frontend screens include:

- List
- Create/edit form
- Detail
- Dashboard and board
- Approvals
- My Decisions and Team Queue
- Acknowledgments
- Journey/history
- Reports and notifications

Flow:

```text
Requester creates a DRAFT indent
  → adds item, quantity, required date, and purpose
  → submits the indent
  → workflow engine finds the approval chain
  → one or more approvers approve or reject
  → after final approval, rules check how it should be fulfilled
  → Inventory prepares an allocation proposal
```

Possible outcomes:

- Enough stock: reserve stock for later issue.
- Partial stock: reserve available stock and create a shortfall.
- No stock: create a Material Request for Procurement.

Tables use the `ind_` prefix.

---

## 7.6 Inventory

**Purpose:** Maintains the reliable quantity and history of stock.

The Inventory module includes:

- Stock balances
- Stock movement ledger
- Reservations
- Allocation decisions
- Material Requests
- Direct stock transfers
- Stock Transfer Orders (STOs)
- Stock adjustments
- Cycle counts
- Replenishment suggestions
- Item availability
- Stock ageing
- Stock valuation
- Near-expiry alerts

### Stock balance

Shows how much of an item is stored in a warehouse, project, bin, or batch.

Important quantities:

- `total_qty`: physical stock.
- `reserved_qty`: stock promised to approved demand.
- `available_qty`: stock not currently reserved.

### Stock ledger

An append-only history of physical stock changes. It answers:

- What changed?
- Was stock received or issued?
- Which document caused the movement?
- When did it happen?

All physical stock changes should go through
`inventory.service.move_stock()`, which updates the balance and writes a ledger
row together.

### Allocation

Allocation is the decision about how an approved indent will be fulfilled.

```text
Approved indent
  → system calculates available stock by item and warehouse
  → Inventory user reviews the proposal
  → chooses stock quantity and procurement quantity
  → allocation is approved when required
  → available stock becomes reserved stock
  → shortage becomes a Material Request
```

Reserving stock is not a physical movement. It does not change `total_qty` and
does not create a stock-ledger row.

### Material Request

A Material Request (MR) represents a shortage that needs purchasing.

```text
Allocation finds a shortfall
  → MR is created
  → MR follows approval
  → approved MR becomes input for Procurement
```

### Stock Transfer Order

```text
Create STO between warehouses
  → approve STO
  → dispatch from source warehouse
  → receive at destination warehouse
  → stock and ledger are updated
```

### Cycle count

```text
Create a count for a warehouse
  → employee records actual quantities
  → system compares actual and recorded stock
  → post the count
  → approved differences update stock through adjustments
```

Tables mainly use the `stk_` and `inv_` prefixes.

---

## 7.7 Procurement

**Purpose:** Purchases material that cannot be fulfilled from existing stock.

The currently implemented backend mainly covers Purchase Orders.

Main data:

- Purchase Order header
- PO item lines
- Vendor
- Prices, tax, and totals
- Indent reference
- Approval status

Flow:

```text
Approved demand has a procurement requirement
  → Procurement selects an approved indent
  → creates PO from the indent
  → chooses vendor and confirms commercial values
  → submits PO
  → workflow engine manages PO approvals
  → approved PO is sent to the vendor
  → PO becomes available for GRN creation
```

Current endpoints support:

- Listing POs
- Creating a PO from an indent
- Viewing a PO
- Submitting
- Approving or rejecting
- Sending to vendor
- Listing POs open for GRN

The full business plan also includes RFQ, vendor quotation comparison, and vendor
selection. A fresher should not assume those steps are fully implemented merely
because they appear in the business design.

Tables use the `pro_` prefix.

---

## 7.8 Logistics: GRN and material issue

**Purpose:** Handles the currently implemented receiving and issuing operations.

### GRN

GRN means **Goods Receipt Note**. It records material received from a vendor
against a Purchase Order.

```text
PO is approved and sent to vendor
  → store employee creates GRN from PO
  → received quantities are recorded
  → quality inspection passes or fails
  → QC pass calls Inventory stock movement
  → accepted quantity increases stock
  → QC failure does not add rejected stock
```

### Material issue

```text
Create issue document for requested material
  → validate stock
  → post the issue
  → Inventory decreases physical stock
  → stock ledger records the outward movement
```

Backend tables use the `lgs_` prefix.

---

## 7.9 Warehouse UI

**Purpose:** Represents a larger warehouse operating flow.

The frontend contains screens for:

- Warehouse dashboard
- Material inward and GRN
- Quality inspection
- Putaway
- Picklists
- Material issues
- Dispatch
- Purchase returns
- Outward labelling
- Delivery acknowledgment
- Stock segregation
- Reports and notifications
- Warehouse and bin/floor-plan masters

Intended inward flow:

```text
Gate entry / Material inward
  → GRN
  → Quality inspection
  → Putaway into bin
  → Inventory stock becomes available
```

Intended outward flow:

```text
Approved demand
  → Picklist
  → Pick from bins
  → Material issue
  → Outward QC and labels
  → Pack and dispatch
  → Delivery acknowledgment
```

### Current development warning

The frontend calls endpoints under `/api/warehouse`, but
`backend/app/main.py` currently does not register a corresponding Warehouse
router. The existing backend provides the smaller Logistics GRN/Issue flow and
Inventory stock flow.

Therefore, treat the larger Warehouse UI as **work in progress** until its API
contract and router are implemented and connected. Check the latest branch and
team status before changing this module.

---

## 7.10 RBAC

RBAC means **Role-Based Access Control**.

**Purpose:** Controls what a user can see and do.

It includes:

- Users
- Roles
- Permissions
- User groups
- Group members
- Page access
- Feature access
- Reporting hierarchy
- Permission-holder lookup
- “View as” reporting views

Flow:

```text
Admin assigns roles/groups
  → roles contain permissions
  → login loads the user's effective permissions
  → menu is built from allowed pages
  → frontend hides unavailable actions
  → backend checks permission again for every protected API
```

Tables use the `rbac_` prefix.

---

## 7.11 Workflow

**Purpose:** Decides **who must approve a document and in what order**.

It supports:

- Workflow definitions
- Ordered stages
- Stage conditions
- Workflow instances
- Pending approvals
- Approval history
- Delegations
- Return actions
- Fallback approval routing

Examples:

- Indent approval
- Allocation approval
- Material Request approval
- Purchase Order approval

Flow:

```text
Document is submitted
  → matching active workflow is selected
  → applicable stages are calculated
  → approvers are resolved from employees/positions/groups
  → pending task is created
  → approver acts
  → next stage starts or document becomes approved/rejected
```

If configuration cannot resolve a usable workflow, the fallback mechanism should
prevent the document from becoming permanently stuck and should log the event.

Tables use the `wf_` prefix.

---

## 7.12 Rules

**Purpose:** Makes automatic routing decisions that do not require a person to
click Approve.

Examples:

- Send an indent to Inventory, Warehouse, or Procurement.
- Split fulfillment between stock and procurement.
- Choose a warehouse type such as LIP or MDP.
- Decide a default path when no configured rule matches.
- Simulate a rule and check configuration conflicts.

The easy difference is:

- A person must approve something: use **Workflow**.
- The system makes an immediate automatic decision: use **Rules**.

Tables use the `rule_` prefix.

---

## 7.13 Admin and Settings

**Purpose:** Provides system-wide configuration and operational tools.

Admin screens include:

- User access
- User groups and roles
- Rules
- Workflows
- Policies
- Audit log
- Document numbering
- Notification rules
- Fallback log
- HCM schedule

Settings include:

- Company settings
- Regional settings
- Numbering settings
- Notifications
- HCM synchronization
- Fallback behavior

Document numbering generates identifiers such as indent, PO, MR, and GRN
numbers. Audit logs record important state changes.

Tables mainly use the `sys_` prefix.

---

## 8. End-to-end implemented flow

The backend end-to-end test demonstrates this compact implemented flow:

```text
Create Indent
  → Submit Indent
  → Approve Indent
  → Create Purchase Order from Indent
  → Submit and approve PO
  → Send PO to vendor
  → Create GRN from PO
  → Pass GRN quality check
  → Inventory stock increases
```

The test is in:

```text
backend/tests/e2e/test_full_flow.py
```

This test is a useful first place to study how several modules work together.

---

## 9. Database naming conventions

Table prefixes show which area owns the data:

| Prefix | Area |
|---|---|
| `hcm_` | Employees and organization mirror |
| `mst_` | Master data |
| `ind_` | Indents |
| `inv_` | Inventory decisions and Material Requests |
| `stk_` | Stock balances, movements, reservations, STOs, and counts |
| `pro_` | Procurement |
| `lgs_` | Implemented Logistics GRN and Issue documents |
| `rbac_` | Roles, permissions, groups, and pages |
| `wf_` | Approval workflow |
| `rule_` | Automatic rules |
| `sys_` | Settings, numbering, audit, credentials, and logs |
| `whs_` | Warehouse structures used by Warehouse-oriented work |

Migrations in `backend/alembic/versions/` describe how the database schema
changed over time.

---

## 10. Important development rules

1. Read `README.md`, `CLAUDE.md`, and `docs/04_SCM_BUSINESS_FLOW.md` before making
   structural changes.
2. Keep backend routers small. Put business logic in `service.py`.
3. Use shared status enums instead of writing status strings in many places.
4. Protect backend endpoints with the correct permission.
5. Never update stock balance directly from Procurement, Indents, or Logistics.
   Use the Inventory stock movement service.
6. Every physical stock change must have a stock-ledger record.
7. Use the Workflow engine for approvals.
8. Use the Rules engine for automatic routing.
9. Use `@/shared/api/client` for frontend API calls.
10. Reuse shared frontend components before creating another version.
11. Add tests in the module that owns the behavior.
12. Never edit an old Alembic migration that may already be applied. Add a new
    migration.
13. Do not commit `.env`, passwords, tokens, or API keys.
14. Do not assume every design-document feature is already implemented. Confirm it
    in routes, services, models, tests, and the running API.

---

## 11. How to study an unfamiliar feature

Use this order:

1. Find the URL in `frontend/src/App.tsx`.
2. Open the page component rendered for that URL.
3. Find the API function imported by that page.
4. Note the backend URL and HTTP method used by the API function.
5. Find the matching decorator in backend `router.py`.
6. Open the service function called by the router.
7. Read the related request/response classes in `schemas.py`.
8. Read the table definitions in `models.py`.
9. Read the module tests to see expected behavior and edge cases.
10. Run the feature and inspect its request in browser developer tools.

This gives the complete chain:

```text
Route → Page → API function → Backend router → Service → Model → Database
```

Useful search examples:

```powershell
rg "submit_indent" frontend backend
rg "/api/indents" frontend backend
rg "class MaterialRequest" backend
rg "indent.approve" backend frontend
```

---

## 12. Running the project

The complete setup instructions are in the root `README.md`. The short version
is:

### Backend

```powershell
cd backend
py -3.11 -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
copy .env.example .env
```

Set the required values in `.env`, create the MySQL database, and then run:

```powershell
.venv/Scripts/python -m alembic upgrade head
.venv/Scripts/python -m scripts.seed
.venv/Scripts/python -m uvicorn app.main:app --reload --reload-dir app
```

### Frontend

In a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

---

## 13. Tests and checks

### Backend

```powershell
cd backend
.venv/Scripts/python -m pytest
```

Run one module while developing:

```powershell
.venv/Scripts/python -m pytest app/modules/inventory
```

Database-backed tests require a valid `TEST_DATABASE_URL`.

### Frontend

```powershell
cd frontend
npm test
npm run build
```

`npm run build` performs TypeScript checks and then creates the Vite production
bundle.

---

## 14. Suggested first-week learning plan

### Day 1

- Run the frontend and backend.
- Log in.
- Open browser developer tools and watch API requests.
- Read `main.tsx`, `App.tsx`, and the shared Axios client.

### Day 2

- Follow the Indent list from page to database.
- Read one frontend test and one backend test.
- Create an indent through the UI.

### Day 3

- Study authentication, permissions, and the `/api/auth/me` response.
- Approve an indent using another demo account.
- Follow the Workflow engine calls.

### Day 4

- Study stock balance, ledger, and reservations.
- Understand why reservation is not a physical stock movement.
- Follow `move_stock()` and its tests.

### Day 5

- Read the end-to-end test.
- Follow PO creation, GRN, QC, and the stock increase.
- Make a very small tested change with a senior developer's review.

---

## 15. Glossary

| Term | Meaning |
|---|---|
| API | A set of URLs through which the frontend communicates with the backend. |
| Indent | An internal material request. |
| Allocation | Decision about how much demand comes from stock and how much requires procurement. |
| Reservation | Available stock promised to a specific demand without physically moving it. |
| MR | Material Request created for a stock shortfall. |
| RFQ | Request for Quotation sent to vendors. |
| PO | Purchase Order sent to a selected vendor. |
| GRN | Goods Receipt Note for received materials. |
| QC | Quality Check or Quality Inspection. |
| STO | Stock Transfer Order between warehouses. |
| SMO | Stock Movement Order, part of the broader planned warehouse flow. |
| Putaway | Moving accepted received goods into their storage bins. |
| Picklist | Instructions telling warehouse staff what to collect and from where. |
| Dispatch | Sending packed goods to their destination. |
| HCM | Human Capital Management system, the source of employee and organization data. |
| RBAC | Role-Based Access Control. |
| JWT | Signed token used to authenticate API requests. |
| ORM | Object-Relational Mapper; SQLAlchemy maps Python classes to database tables. |
| Migration | A versioned database schema change managed by Alembic. |
| Schema | In API code, a Pydantic request/response type; it can also mean database structure. |
| Component | Reusable React UI function. |
| Hook | React function such as `useState` or `useQuery` that adds state or behavior. |
| Query cache | Stored server data managed by TanStack Query to reduce unnecessary requests. |

---

## 16. Recommended reading order

1. This guide
2. Root `README.md`
3. `frontend/src/App.tsx`
4. `backend/app/main.py`
5. `backend/tests/e2e/test_full_flow.py`
6. `docs/04_SCM_BUSINESS_FLOW.md`
7. `CLAUDE.md`
8. The module files for the feature assigned to you

