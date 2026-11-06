"""Bring ANY database -- empty, half-built or months behind -- up to this checkout, in
one command. Idempotent; run it after every pull.

    .venv/Scripts/python -m scripts.bootstrap
    .venv/Scripts/python -m scripts.bootstrap --reset-admin-password

What it does, in order:

  1. SCHEMA.
     - Empty database: every table from the models, then Alembic is stamped at head.
       `alembic upgrade head` cannot build an empty database: 46 tables were created by
       `create_all` or by hand and no migration creates them, and later migrations
       ALTER them, so replaying history from empty stops on the first of them.
     - Existing database with history: `alembic upgrade heads`, so data migrations and
       backfills run. If a migration fails, the schema is reconciled (below) and the
       upgrade is tried once more -- most failures are a migration expecting a table or
       column a hand-built database never had.
     - Existing database with NO history: reconciled, then stamped.
     - ALWAYS, last: every table, column and index the models declare that the
       database lacks is added. Additive only -- nothing is dropped, altered or
       re-typed. This is what makes "Unknown column" after a deploy impossible: it no
       longer matters whether a migration ran, was skipped, or was stamped past.
  2. PERMISSIONS AND ROLES -- the catalogue in platform/rbac/permissions.py, plus the
     grants new codes inherit (perms.INHERITS_GRANTS_FROM).
  3. MODULES -- warehouse, reports, approvals config, workflow UI, employee portal.
  4. MENU -- PAGE_TREE, then the page registry (the same sync the server runs at
     start-up), which also re-parks the retired screens.
  5. ADMIN -- LAST, so it is topped up to every permission the steps above created.
     Every active page's gate is made to exist and granted to Admin, so there is no
     screen the administrator cannot see. The password is only set when the login has
     none (or with --reset-admin-password): a redeploy never resets it.
  6. VERIFY -- re-reads the database and fails (exit 1) if any table, column or index
     is still missing, Alembic is not at head, or any active page is hidden from admin.

It does NOT write masters, demo users or workflow definitions. Log in as `admin`, run
the HCM sync from Settings, then load the masters.

A step that fails does not hide the others: every step runs, the problems are listed
at the end, and the exit code says whether the deploy is sound.
"""
import asyncio
import subprocess
import sys
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import inspect, select, text

from app.core.config import settings
from app.core.database import Base, SessionLocal, engine
import app.main  # noqa: F401  -- imports every model so create_all sees them

from app.platform.rbac.models import Page, Permission, Role, RolePermission
from app.platform.rbac.page_registry import (
    ADMIN_ROLE_CODE, retire_permissions, sync_pages, sync_permission_labels,
)
from app.platform.rbac.permissions import PAGE_RESOURCE, page_view_code
from scripts import (
    create_admin_login,
    provision_approvals_config,
    provision_employee_portal,
    provision_pages,
    provision_reports,
    provision_warehouse,
    provision_workflow_ui,
)
from scripts.seed import seed_permissions, seed_roles
from scripts.sync_schema import _apply, _apply_indexes, _missing, _missing_indexes

BACKEND = Path(__file__).resolve().parent.parent
PROBLEMS: list[str] = []
RESET_ADMIN_PASSWORD = "--reset-admin-password" in sys.argv


def _rule(title: str) -> None:
    print(f"\n=== {title} " + "=" * max(0, 60 - len(title)))


def _heads() -> set[str]:
    return set(ScriptDirectory.from_config(
        Config(str(BACKEND / "alembic.ini"))).get_heads())


def _alembic(*args: str) -> tuple[bool, str]:
    """Alembic in its own process: env.py runs its own asyncio loop, which cannot start
    inside this one."""
    proc = subprocess.run([sys.executable, "-m", "alembic", *args], cwd=BACKEND,
                          capture_output=True, text=True)
    output = (proc.stdout + proc.stderr).strip()
    return proc.returncode == 0, output


def _last_line(output: str) -> str:
    lines = [line for line in output.splitlines() if line.strip()]
    return lines[-1][:300] if lines else "(no output)"


async def _stamped() -> set[str]:
    async with engine.connect() as conn:
        tables = set(await conn.run_sync(lambda c: inspect(c).get_table_names()))
        if "alembic_version" not in tables:
            return set()
        rows = (await conn.execute(text("SELECT version_num FROM alembic_version"))).all()
    return {row[0] for row in rows}


async def _table_count() -> int:
    async with engine.connect() as conn:
        names = await conn.run_sync(lambda c: inspect(c).get_table_names())
    return len([n for n in names if n != "alembic_version"])


async def reconcile() -> None:
    """Every missing table, column and index the models declare. Additive only."""
    async with engine.begin() as conn:
        tables, columns = await conn.run_sync(_missing)
        if tables or columns:
            for table in tables:
                print(f"  + table   {table.name}")
            for table, col in columns:
                print(f"  + column  {table.name}.{col.name}  {col.type}")
            await conn.run_sync(_apply, tables, columns)
        indexes = await conn.run_sync(_missing_indexes)
        failed = await conn.run_sync(_apply_indexes, indexes) if indexes else []
    built = len(indexes) - len(failed)
    print(f"  reconciled: +{len(tables)} table(s), +{len(columns)} column(s), "
          f"+{built} index(es)")
    for line in failed:
        # A UNIQUE index over rows that already break it: the data needs a decision,
        # which a deploy script must not make. Listed, not fatal.
        print(f"  ! index not built  {line}")


async def schema() -> None:
    heads = _heads()
    stamped = await _stamped()
    tables = await _table_count()
    print(f"database {settings.DATABASE_URL.rsplit('/', 1)[-1]}: {tables} tables, "
          f"alembic at {sorted(stamped) or 'nothing'}, code head {sorted(heads)}")

    if tables == 0 or not stamped:
        # No history to replay: the models ARE the schema. Build, then stamp.
        await reconcile()
        ok, out = _alembic("stamp", "heads", "--purge")
        if not ok:
            raise RuntimeError(f"alembic stamp failed: {_last_line(out)}")
        print(f"  stamped at {sorted(heads)}")
        return

    if stamped != heads:
        ok, out = _alembic("upgrade", "heads")
        if ok:
            print(f"  migrated to {sorted(heads)}")
        else:
            print(f"  upgrade stopped: {_last_line(out)}")
            print("  reconciling the schema to the models, then retrying once")
            await reconcile()
            ok, out = _alembic("upgrade", "heads")
            if ok:
                print(f"  migrated to {sorted(heads)} on the retry")
            else:
                PROBLEMS.append(
                    "alembic upgrade failed twice -- the schema has been reconciled to "
                    "the models, but the data steps of the failing migration did not "
                    f"run: {_last_line(out)}")
                print(f"  ! upgrade failed again:\n{out[-2000:]}")
    else:
        print("  alembic already at head")
    # Always: a database stamped past migrations that never ran is the usual way a
    # column goes missing, and Alembic cannot see that.
    await reconcile()


async def permissions_and_roles() -> None:
    async with SessionLocal() as db:
        await seed_permissions(db)
        roles = await seed_roles(db)
        await db.commit()
    async with SessionLocal() as db:
        changed = await sync_permission_labels(db)
        retired = await retire_permissions(db)
    for line in retired:
        print(f"  {line}")
    changed += retired
    print(f"  permissions in place, {len(roles)} roles, {len(changed)} catalogue change(s)")


async def menu() -> None:
    await provision_pages.provision()
    async with SessionLocal() as db:
        result = await sync_pages(db)
    print(f"  page registry: +{len(result['added'])} added, "
          f"{len(result['updated'])} refreshed, {len(result['retired'])} re-parked")


async def _admin_gates(db) -> set[str]:
    """The permission every active page is gated on, exactly as `get_user_menu` reads
    it: the page's own `page.<code>.view` when it exists, else `required_permission`."""
    pages = (await db.execute(select(Page).where(Page.is_active.is_(True)))).scalars().all()
    defined = set((await db.execute(
        select(Permission.code).where(Permission.code.like(f"{PAGE_RESOURCE}.%"))
    )).scalars().all())
    gates = set()
    for page in pages:
        own = page_view_code(page.code)
        gate = own if own in defined else page.required_permission
        if gate:
            gates.add(gate)
    return gates


async def admin() -> None:
    # A page gated on a code nobody defined is hidden from everyone, admin included.
    # Define it, so the grant below can reach it.
    async with SessionLocal() as db:
        gates = await _admin_gates(db)
        known = set((await db.execute(select(Permission.code))).scalars().all())
        for code in sorted(gates - known):
            module, _, rest = code.partition(".")
            resource, _, action = rest.rpartition(".")
            db.add(Permission(code=code, module=module or "admin",
                              resource=resource or module, action=action or "view",
                              description=f"Gate for a menu page ({code})"))
            print(f"  + permission {code} (a page was gated on it, nothing defined it)")
        await db.commit()
    # Tops ADMIN up to every permission row, then the login itself.
    await create_admin_login.main(reset_password=RESET_ADMIN_PASSWORD)


async def verify() -> None:
    async with engine.connect() as conn:
        tables, columns = await conn.run_sync(_missing)
        indexes = await conn.run_sync(_missing_indexes)
    if tables or columns:
        PROBLEMS.append(f"schema still short of the models: {len(tables)} table(s) "
                        f"{[t.name for t in tables][:10]}, {len(columns)} column(s) "
                        f"{[f'{t.name}.{c.name}' for t, c in columns][:10]}")
    stamped, heads = await _stamped(), _heads()
    if stamped != heads:
        PROBLEMS.append(f"alembic at {sorted(stamped)}, code head is {sorted(heads)}")

    async with SessionLocal() as db:
        role = (await db.execute(
            select(Role).where(Role.code == ADMIN_ROLE_CODE))).scalars().first()
        held = set((await db.execute(
            select(Permission.code).join(RolePermission,
                                         RolePermission.permission_id == Permission.id)
            .where(RolePermission.role_id == role.id)
        )).scalars().all()) if role else set()
        total = (await db.execute(select(Permission.code))).scalars().all()
        hidden = sorted((await _admin_gates(db)) - held)
        active_pages = len((await db.execute(
            select(Page.id).where(Page.is_active.is_(True)))).all())
    if hidden:
        PROBLEMS.append(f"admin cannot see pages gated on: {hidden}")
    if len(held) < len(total):
        PROBLEMS.append(f"admin holds {len(held)} of {len(total)} permissions")
    print(f"  missing tables {len(tables)}, columns {len(columns)}, "
          f"indexes {len(indexes)} (unbuildable, see above)")
    print(f"  alembic {sorted(stamped)}  |  admin {len(held)}/{len(total)} permissions, "
          f"{active_pages} active pages, {len(hidden)} hidden from admin")


STEPS = [
    ("Schema", schema),
    ("Permissions and roles", permissions_and_roles),
    ("Warehouse", provision_warehouse.provision),
    ("Reports", provision_reports.provision),
    ("Approvals config", provision_approvals_config.provision),
    ("Workflow UI", provision_workflow_ui.provision),
    ("Employee portal", provision_employee_portal.provision),
    ("Menu pages", menu),
    ("Admin login", admin),
    ("Verify", verify),
]


async def bootstrap() -> int:
    print(f"bootstrapping {settings.DATABASE_URL.rsplit('/', 1)[-1]}")
    for title, step in STEPS:
        _rule(title)
        try:
            await step()
        except Exception as exc:                  # noqa: BLE001 -- listed at the end
            PROBLEMS.append(f"{title}: {type(exc).__name__}: {exc}")
            print(f"  ! {title} failed: {type(exc).__name__}: {exc}")
            if title == "Schema":
                break                             # nothing after it can be trusted
    await engine.dispose()

    _rule("Result")
    if PROBLEMS:
        print("NOT READY -- fix these and re-run (it is safe to re-run):")
        for problem in PROBLEMS:
            print(f"  - {problem}")
        return 1
    print("READY. Log in as 'admin', run the HCM sync from Settings, then load the masters.")
    print("Restart the backend so it drops cached permissions.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(bootstrap()))
