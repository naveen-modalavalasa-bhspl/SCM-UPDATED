# SCM ERP

Supply-chain ERP: **Indent → Purchase Order → GRN → Stock → Issue**, with a
config-driven approval engine, RBAC, and an HCM mirror for people/org data.

FastAPI (async) + SQLAlchemy 2.0 + MySQL · React 18 + Vite + TypeScript + Tailwind.

See **[CLAUDE.md](CLAUDE.md)** for architecture, the non-negotiable rules, and the
deviations from the spec docs in `docs/`.

## Quick start

**Backend** (`backend/`)
```bash
py -3.11 -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
cp .env.example .env            # set DATABASE_URL=mysql+aiomysql://root:<pw>@127.0.0.1:3306/scm_erp
# MySQL must be running; create the DB once:  CREATE DATABASE scm_erp;
.venv/Scripts/python -m alembic upgrade head
.venv/Scripts/python -m scripts.seed
.venv/Scripts/python -m uvicorn app.main:app --reload
.venv/Scripts/python -m pytest         # 29 tests
```
API at http://localhost:8000 · docs at http://localhost:8000/docs

**Frontend** (`frontend/`)
```bash
npm install
npm run dev        # http://localhost:5173
```

Demo logins (password `password123`): `requester`, `approver`, `procurement`,
`store`, `planthead`, `admin`.

## What works end to end
`tests/e2e/test_full_flow.py`: indent → submit → approve → PO → approve →
send-to-vendor → GRN → QC pass → **stock increases**. Green = the system works.

## Repository layout
```
backend/   FastAPI app (core, shared, platform/{hcm,rbac,workflow,auth,settings}, modules)
frontend/  Vite + React (shared client/auth/layout/components, modules/indents)
docs/      the three spec docs + docs/hcm-samples/ (real HCM payloads)
```
