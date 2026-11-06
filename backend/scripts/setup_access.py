"""Job-profile access and approval ladders for the 104-MMU rollout. Idempotent.

    .venv/Scripts/python -m scripts.setup_access            # apply
    .venv/Scripts/python -m scripts.setup_access --show     # print, change nothing

Doing this in the GUI is seven Job Profile screens and three ladders, and it has to be
redone on every database. Everything below goes through the same service calls the
screens do — `profiles.set_profile_access` and `ladder_config.save_ladder` — so the
validation, the audit rows and the ladder versioning are identical. Straight SQL would
skip all three, which is why this is a script and not a .sql file.

Re-running is safe: profile access is replaced wholesale, and a ladder writes version
N+1 and retires N, so the live chain always reads the latest.

WHAT IT SETS
  Access — which screens a job sees, and whose rows.
    Store Keeper   Home, Indents, Inventory, Warehouse        SELF     (own documents)
    OE / DM / RM / SPH
                   Home, Approvals, Inventory, Warehouse      SUBTREE  (own line)
    WSK / WM       Home, Approvals, Inventory, Warehouse      ALL      (everything)

  Ladders — who signs what.
    Indent            Store Keeper raises -> OE -> District Manager
    Stock Allocation  the Inventory Manager (WSK) raises and approves his own
    Material Issue    the Warehouse Manager (WM) raises and approves his own

  The last two use CREATOR_ALLOWED: one person holds the post, so an INDEPENDENT
  ladder would resolve to nobody and the document would never move.
"""
import argparse
import asyncio
import sys

from sqlalchemy import select

from app.core.database import SessionLocal, engine
from app.platform.hcm.models import HcmEmployee
from app.platform.rbac import profiles
from app.platform.rbac.models import Page
from app.platform.workflow import custom_ladder, ladder, ladder_config
from app.platform.workflow.schemas import (CustomLadderIn, CustomLadderStepIn,
                                           LadderIn, LadderRungIn)
from app.shared.enums import DocType, ScopeRung

# --------------------------------------------------------------------------- #
#  Page bundles — a group and everything under it, by code.
# --------------------------------------------------------------------------- #
HOME = ["home"]
INDENTS = ["grp_indents", "ind_dashboard", "ind_list", "ind_deliveries",
           "ind_reports", "ind_notifications"]
# `approval_team` dropped with the Team Queue screen.
APPROVALS = ["approvals", "approval_waiting", "approval_decisions"]
INVENTORY = ["grp_inventory", "inv_overview", "inv_balance", "inv_ledger",
             "inv_replenishment", "inv_transfers", "inv_fulfilment_desk",
             "inv_stocking_points", "inv_mr",
             "inv_labels"]
WAREHOUSE = ["grp_warehouse", "wh_dashboard", "wh_inward", "wh_grn", "wh_qc",
             "wh_qc_outward", "wh_putaway", "wh_segregation", "wh_stock_movements", "wh_picklist",
             "wh_issues", "wh_material_returns", "wh_consignments", "wh_dispatch",
             "wh_ack", "wh_notifications", "wh_reports", "wh_masters"]

# --------------------------------------------------------------------------- #
#  What each job may DO. A profile REPLACES every other grant the person has
#  (rbac/service.py: "the profile replaces EVERYTHING, including personal
#  rbac_user_roles"), so a profile with pages and no feature permissions leaves
#  somebody who can open Goods Receipt and not raise one.
# --------------------------------------------------------------------------- #
VIEW_ONLY = ["stock.view", "report.view", "warehouse.report.view"]

# Raises the indent, receives against it, acknowledges what arrives.
SK_PERMS = VIEW_ONLY + [
    "indent.view", "indent.create", "indent.edit", "indent.submit",
    "indent.acknowledge", "indent.view.fulfilment",
    "mr.view", "mr.create",
    "receipt.view", "grn.view", "inspection.view", "putaway.view",
    "issue.view", "dispatch.view", "dispatch.acknowledge",
    "allocation.view", "picking.view",
]

# Signs things. Reads the whole line under them, changes none of it.
APPROVER_PERMS = VIEW_ONLY + [
    "indent.view", "indent.approve", "indent.reject", "indent.view.fulfilment",
    "mr.view", "mr.approve", "mr.reject",
    "allocation.view", "allocation.approve", "allocation.reject",
    "receipt.view", "grn.view", "inspection.view", "putaway.view",
    "issue.view", "dispatch.view", "picking.view", "stock.view.subtree",
]

# Runs the warehouse: books goods in, inspects, puts away, issues, dispatches.
WAREHOUSE_PERMS = VIEW_ONLY + [
    "stock.view.all", "stock.adjust", "stock.transfer", "stock.reserve",
    "stock.valuation.view", "stock.points.manage",
    "receipt.view", "receipt.create", "receipt.post",
    "grn.view", "grn.create", "grn.qc",
    "inspection.view", "inspection.execute",
    "putaway.view", "putaway.execute",
    "picking.view", "picking.pick",
    "issue.view", "issue.create", "issue.submit", "issue.issue", "issue.forward",
    "dispatch.view", "dispatch.create", "dispatch.gate_out",
    "dispatch.acknowledge", "dispatch.approve",
    "allocation.view", "allocation.create", "allocation.submit",
    "allocation.approve", "allocation.approve_reserve", "allocation.reject",
    "mr.view", "mr.approve", "mr.reject",
    "indent.view", "indent.view.fulfilment",
    "master.location.manage",
]

# (profile key, display name, pages, permissions, scope)
PROFILES = [
    ("22:STORE KEEPER", "Store Keeper",
     HOME + INDENTS + INVENTORY + WAREHOUSE, SK_PERMS, ScopeRung.SELF.value),
    ("22:OE", "OE",
     HOME + APPROVALS + INVENTORY + WAREHOUSE, APPROVER_PERMS,
     ScopeRung.SUBTREE.value),
    ("22:DISTRICT MANAGER", "District Manager",
     HOME + APPROVALS + INVENTORY + WAREHOUSE, APPROVER_PERMS,
     ScopeRung.SUBTREE.value),
    ("22:REGIONAL MANAGER", "Regional Manager",
     HOME + APPROVALS + INVENTORY + WAREHOUSE, APPROVER_PERMS,
     ScopeRung.SUBTREE.value),
    ("22:SPH", "SPH",
     HOME + APPROVALS + INVENTORY + WAREHOUSE, APPROVER_PERMS,
     ScopeRung.SUBTREE.value),
    ("0:WSK", "Warehouse Store Keeper",
     HOME + APPROVALS + INVENTORY + WAREHOUSE, WAREHOUSE_PERMS,
     ScopeRung.ALL.value),
    ("0:WM", "Warehouse Manager",
     HOME + APPROVALS + INVENTORY + WAREHOUSE, WAREHOUSE_PERMS,
     ScopeRung.ALL.value),
]

# HCM role ids — `hcm_positions.role_id`, which is what a ladder rung IS. Read off the
# mirror rather than hardcoded by name: HCM re-keys these on a cutover.
ROLE_OE = "OE"
ROLE_DM = "DISTRICT MANAGER"
ROLE_MANAGER = "MANAGER"          # the Warehouse Manager's post
ROLE_SUPERVISOR = "SUPERVISIOR"   # the Inventory Manager's post (HCM's spelling)

MMU_PROJECT = 22


async def _role_ids(db) -> dict[str, int]:
    """{role_name: role_id} from the position mirror."""
    from app.platform.hcm.models import HcmPosition
    rows = (await db.execute(
        select(HcmPosition.role_name, HcmPosition.role_id)
        .where(HcmPosition.role_id.isnot(None)).distinct()
    )).all()
    return {(name or "").strip().upper(): rid for name, rid in rows}


async def _own_post(db, role_name: str):
    """The single warehouse-side post holding this HCM role.

    Looked up by role name, not by id: HCM re-keys every position on a cutover, so an
    id written into this file would quietly point at somebody else after the next one.
    """
    from app.platform.hcm.models import HcmPosition
    posts = (await db.execute(
        select(HcmPosition).where(HcmPosition.is_active.is_(True))
    )).scalars().all()
    matches = [p for p in posts
               if (p.role_name or "").strip().upper() == role_name
               and not p.project_id]
    if not matches:
        raise SystemExit(f"No unassigned-project position holds the {role_name!r} "
                         "role — sync HCM before running this.")
    if len(matches) > 1:
        raise SystemExit(
            f"{len(matches)} positions hold {role_name!r}: "
            + ", ".join(f"{p.id} {p.name}" for p in matches)
            + ". Pin the one you mean in this script.")
    return matches[0]


async def _actor(db):
    """The admin login, so the audit rows name somebody real."""
    return await db.get(HcmEmployee, 900001)


async def show(db) -> None:
    codes = {p.code for p in (await db.execute(select(Page))).scalars().all()}
    print("pages in this database:", len(codes))
    for key, name, pages, perms, scope in PROFILES:
        missing = sorted(set(pages) - codes)
        print(f"  {key:22} {scope:8} {len(pages):3} pages {len(perms):3} permissions"
              + (f"  MISSING: {', '.join(missing)}" if missing else ""))
    roles = await _role_ids(db)
    print("\nHCM role ids:", {k: roles.get(k) for k in
                              (ROLE_OE, ROLE_DM, ROLE_MANAGER, ROLE_SUPERVISOR)})


async def apply_profiles(db, actor) -> None:
    known = {p.code for p in (await db.execute(select(Page))).scalars().all()}
    for key, name, pages, perms, scope in PROFILES:
        wanted = [c for c in pages if c in known]
        skipped = sorted(set(pages) - known)
        await profiles.set_profile_access(
            db, key, wanted, sorted(set(perms)), scope, name, actor,
        )
        print(f"  {key:22} {scope:8} {len(wanted):3} pages "
              f"{len(set(perms)):3} permissions"
              + (f"   (not in this database: {', '.join(skipped)})" if skipped else ""))


async def apply_ladders(db, actor) -> None:
    roles = await _role_ids(db)

    def rung(role_name: str) -> LadderRungIn:
        role_id = roles.get(role_name)
        if role_id is None:
            raise SystemExit(f"No HCM role named {role_name!r} in hcm_positions — "
                             "sync HCM before running this.")
        return LadderRungIn(position_role_id=role_id, name=role_name.title(),
                            is_enabled=True)

    # Store Keeper raises an indent; it climbs his own line to the OE, then the
    # District Manager. INDEPENDENT: neither of them raised it.
    plan = LadderIn(project_id=MMU_PROJECT, doc_type=DocType.INDENT.value,
                    rungs=[rung(ROLE_OE), rung(ROLE_DM)],
                    self_approval_policy=ladder.POLICY_INDEPENDENT)
    saved = await ladder_config.save_ladder(db, plan, actor)
    print(f"  {plan.doc_type:12} project {MMU_PROJECT:<6} "
          f"{' -> '.join(r.name for r in plan.rungs):34} "
          f"{plan.self_approval_policy} (v{saved.get('version', '?')})")

    # Allocation and material issue are signed by the person who raised them — one
    # Inventory Manager, one Warehouse Manager, nobody above either of them holds the
    # stock. A RANK ladder cannot express that: `role_chain` starts the climb at the
    # raiser's PARENT, so a rung on the raiser's own rank is never reached (the save
    # warns "no reporting line climbs through it"). A CUSTOM ladder is the tool — it
    # names POSTS in order and does not climb at all.
    for doc_type, role_name, label in (
        (DocType.ALLOCATION.value, ROLE_SUPERVISOR, "Inventory Manager"),
        (DocType.WH_ISSUE.value, ROLE_MANAGER, "Warehouse Manager"),
    ):
        post = await _own_post(db, role_name)
        body = CustomLadderIn(
            project_id=None, doc_type=doc_type,
            steps=[CustomLadderStepIn(position_id=post.id, name=post.name)],
            self_approval_policy=ladder.POLICY_CREATOR_ALLOWED,
        )
        saved = await custom_ladder.save_custom(db, body, actor)
        print(f"  {doc_type:12} company-wide  {label + ' (' + post.name + ')':34} "
              f"{body.self_approval_policy} (v{saved.get('version', '?')})")


async def main(only_show: bool) -> None:
    async with SessionLocal() as db:
        if only_show:
            await show(db)
        else:
            actor = await _actor(db)
            print("\n--- job profile access ---")
            await apply_profiles(db, actor)
            print("\n--- approval ladders ---")
            await apply_ladders(db, actor)
            print("\nDone. Users see the change on their next /api/auth/me.")
    await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--show", action="store_true",
                        help="print what would be set and change nothing")
    args = parser.parse_args()
    try:
        asyncio.run(main(args.show))
    except Exception as exc:               # noqa: BLE001 — one line, then the trace
        print(f"\nsetup_access stopped: {exc}", file=sys.stderr)
        raise
