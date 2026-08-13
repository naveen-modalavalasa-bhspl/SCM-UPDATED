"""Bring an empty database up to a usable application, in one command. Idempotent.

    .venv/Scripts/python -m scripts.bootstrap

What it does, in order:

  1. Creates every table the models declare, then stamps Alembic at head.
     `alembic upgrade head` cannot build an empty database: 46 tables -- stock, the
     warehouse inbound/outbound documents, the masters chain, sys_doc_series,
     sys_local_credentials -- were created by `create_all` or by hand and no migration
     ever creates them, and twelve later migrations then ALTER those tables. Replaying
     that history from empty stops on the first of them. The models are the source of
     truth for a NEW database; migrations stay in charge of databases that already
     exist, which is what they were written against.
  2. Seeds permission and role rows (the codes in platform/rbac/permissions.py). This
     is configuration, not demo data -- no employees and no mock hcm_* rows are
     written, so a later HCM sync owns identity by itself.
  3. Creates the local `admin` login, so somebody can sign in and start that sync.
  4. Upserts the menu and the module provisioning (warehouse, reports, approvals
     config, workflow UI, employee portal). Nothing is deleted.

It does NOT write masters, demo users or workflow definitions. Masters are entered or
imported afterwards; approval ladders are configured per project in
Settings > Approvals Config once HCM has been synced.

Safe to re-run: every step upserts. Existing databases are left alone except for rows
that are genuinely missing (step 1 uses checkfirst, so no existing table is touched).
"""
import asyncio
import sys

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import inspect, text

from app.core.config import settings
from app.core.database import Base, SessionLocal, engine
import app.main  # noqa: F401  -- imports every model so create_all sees them

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


def _rule(title: str) -> None:
    print(f"\n=== {title} " + "=" * max(0, 60 - len(title)))


async def create_schema() -> None:
    """Create missing tables and stamp Alembic head on a database that has no history."""
    async with engine.begin() as conn:
        before = set(await conn.run_sync(lambda c: inspect(c).get_table_names()))
        await conn.run_sync(Base.metadata.create_all)          # checkfirst by default
        after = set(await conn.run_sync(lambda c: inspect(c).get_table_names()))
        stamped = await conn.run_sync(
            lambda c: "alembic_version" in inspect(c).get_table_names()
            and c.execute(text("SELECT version_num FROM alembic_version")).first()
        )
    print(f"tables: {len(before)} before, {len(after)} after "
          f"(+{len(after - before) - (1 if 'alembic_version' in after - before else 0)})")
    if stamped:
        print(f"alembic already stamped at {stamped[0]} — left alone")
        return

    # Written directly rather than through `alembic.command.stamp`: env.py drives the
    # async engine with its own asyncio.run(), which cannot start inside this one.
    head = ScriptDirectory.from_config(Config("alembic.ini")).get_current_head()
    async with engine.begin() as conn:
        await conn.execute(text(
            "CREATE TABLE IF NOT EXISTS alembic_version "
            "(version_num VARCHAR(32) NOT NULL, "
            " CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))"
        ))
        await conn.execute(text("INSERT INTO alembic_version VALUES (:v)"),
                           {"v": head})
    print(f"alembic stamped at head ({head})")


async def seed_rbac() -> None:
    async with SessionLocal() as db:
        await seed_permissions(db)
        roles = await seed_roles(db)
        await db.commit()
    print(f"permissions and {len(roles)} roles in place")


# Menu pages runs LAST on purpose. Each module provisioner carries its own copy of the
# rows it cares about, at its own sort orders, and the warehouse one still numbers two
# screens 45 and two 46. PAGE_TREE is the one ordered list, so it upserts on top and
# settles the menu.
STEPS = [
    ("Schema", create_schema),
    ("Permissions and roles", seed_rbac),
    ("Admin login", create_admin_login.main),
    ("Warehouse", provision_warehouse.provision),
    ("Reports", provision_reports.provision),
    ("Approvals config", provision_approvals_config.provision),
    ("Workflow UI", provision_workflow_ui.provision),
    ("Employee portal", provision_employee_portal.provision),
    ("Menu pages", provision_pages.provision),
]


async def bootstrap() -> None:
    print(f"bootstrapping {settings.DATABASE_URL.rsplit('/', 1)[-1]}")
    for title, step in STEPS:
        _rule(title)
        await step()
    _rule("Done")
    print("Log in as 'admin', run the HCM sync from Settings, then load the masters.")
    await engine.dispose()


if __name__ == "__main__":
    try:
        asyncio.run(bootstrap())
    except Exception as exc:                      # one line, then the traceback
        print(f"\nbootstrap stopped: {exc}", file=sys.stderr)
        raise
