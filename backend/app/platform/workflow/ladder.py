"""Project-wise approval ladders.

A ladder is an ordered list of RANKS — COO, SPH, REGIONAL MANAGER, DISTRICT MANAGER,
OE, MMU PILOT — each switched on or off, for one project and one document type. It is
not a list of people and not a list of positions.

That distinction is the whole design. The live mirror holds 3,729 positions but only
18 ranks: five Regional Manager posts across five regions share one rank. So:

  * naming a rank never creates the "which of the five Regional Managers?" problem — we
    walk up the raiser's own parent_position_id chain and stop at the first ancestor
    whose rank is switched on, which is by construction *his* Regional Manager;
  * a raiser can never route below himself, because we only ever walk upward;
  * ranks are shared across projects while positions are not, so a brand new project's
    ladder can be auto-built from the ranks its own people already hold.

The rank is `hcm_positions.role_id` — HCM's org role, which describes what someone IS.
It is emphatically not `rbac_roles`, which decides what they may DO.

Two things about the live mirror shaped this, both checked against it rather than the
seed:

  * `hcm_position_levels` is too coarse to be the rank. It has seven bands, and COO and
    SPH share Level-3, so a level-keyed rung could not tell the two apart.
  * `hcm_positions.project_id` is empty. HCM carries the project on the EMPLOYEE, so a
    document's project is read from the person raising it, and a project's ranks are
    the ranks its people hold.

Resolution (see resolve_chain):

    raiser's position -> parent -> parent -> ... -> top
                          ^ keep the ones whose rank is ON, skip the rest

A rung that resolves to nobody is skipped too, so a vacant seat cannot strand a
document. Reaching the top with nothing collected means the raiser IS the top — the
document is self-approved, recorded explicitly.
"""
import logging
import os

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only

from app.platform.hcm.models import (
    HcmDepartment, HcmEmployee, HcmPosition, HcmPositionAssignment,
)
from app.platform.workflow.conditions import stage_applies
from app.platform.workflow.models import Stage, StageCondition, Workflow
from app.shared.enums import ApprovalMode, ApproverType, DocType

logger = logging.getLogger(__name__)

# Which module owns each document type. Drives the grouping in the Approvals Config
# screen; it is presentation, not routing.
#
# WH_ISSUE, not ISSUE: the warehouse module submits every material issue under
# WH_ISSUE (modules/warehouse/service.py). DocType.ISSUE is the older value and
# nothing starts a workflow with it, so a ladder saved against ISSUE was written,
# never read, and the document fell through to the reporting-line fallback.
MODULE_BY_DOC_TYPE: dict[str, str] = {
    DocType.INDENT.value: "Indents",
    DocType.MONTHLY_INDENT.value: "Indents",
    DocType.ALLOCATION.value: "Inventory",
    DocType.OWN_STOCK_ALLOCATION.value: "Inventory",
    DocType.OWN_STOCK_ISSUE.value: "Warehouse",
    DocType.FORWARD_ISSUE.value: "Warehouse",
    DocType.MR.value: "Inventory",
    DocType.STOCK_TRANSFER.value: "Inventory",
    DocType.STOCK_TRANSFER_REQUEST.value: "Inventory",
    DocType.STOCK_MOVEMENT_ORDER.value: "Inventory",
    DocType.STOCK_ADJUSTMENT.value: "Inventory",
    DocType.STOCK_EDIT.value: "Inventory",
    DocType.STOCK_RETURN.value: "Returns",
    DocType.STOCK_RETURN_RECEIPT.value: "Returns",
    DocType.STOCK_RETURN_LOGISTICS.value: "Returns",
    DocType.WH_ISSUE.value: "Warehouse",
    DocType.GRN.value: "Warehouse",
    # Both really are submitted to the engine by modules/warehouse/service.py, and both
    # were missing here — so they never appeared on the config screen and always fell
    # through to the reporting line, however the admin configured the rest.
    DocType.DISPATCH.value: "Warehouse",
    # The outward quality check that stands between a posted material issue and
    # the consignment raised against it.
    DocType.QC_OUTWARD.value: "Warehouse",
    # Filed under Returns, not Warehouse. The table is `pro_returns` and the service
    # that runs it is the warehouse's, but the admin configuring "who signs a return"
    # looks under Returns and found only the two stock-return rows there — so a
    # purchase return silently kept whatever the reporting line gave it.
    DocType.PURCHASE_RETURN.value: "Returns",
    DocType.REQUISITION.value: "Procurement",
    DocType.CONSOLIDATION.value: "Procurement",
    DocType.RFQ.value: "Procurement",
    DocType.PO.value: "Procurement",
    DocType.TRANSPORT_REQUEST.value: "Logistics",
    DocType.CARRIER_AWARD.value: "Logistics",
    DocType.VENDOR_PAYMENT.value: "Accounts",
}

DOC_TYPE_LABEL: dict[str, str] = {
    DocType.INDENT.value: "Indent",
    DocType.MONTHLY_INDENT.value: "Monthly Indent",
    DocType.ALLOCATION.value: "Stock Allocation",
    DocType.OWN_STOCK_ALLOCATION.value: "Stock Allocation (from your own point)",
    DocType.OWN_STOCK_ISSUE.value: "Material Issue (from your own point)",
    DocType.FORWARD_ISSUE.value: "Material Issue (forwarding a consignment onward)",
    DocType.MR.value: "Material Request",
    # Only ever raised for a transfer that crosses a project boundary — a
    # same-project transfer never starts a workflow, so this ladder stays quiet.
    DocType.STOCK_TRANSFER.value: "Stock Transfer Order (STO)",
    DocType.STOCK_TRANSFER_REQUEST.value: "Stock Transfer Request (STR)",
    DocType.STOCK_MOVEMENT_ORDER.value: "Stock Movement (bin to bin)",
    DocType.STOCK_ADJUSTMENT.value: "Stock Audit (physical count correction)",
    DocType.STOCK_EDIT.value: "Stock Correction (batch / expiry / serial / IMEI)",
    DocType.VENDOR_PAYMENT.value: "Vendor Payment (against a PO payment milestone)",
    DocType.STOCK_RETURN.value: "Indent Return",
    DocType.STOCK_RETURN_RECEIPT.value: "Decision Desk",
    DocType.STOCK_RETURN_LOGISTICS.value: "Return Logistics",
    DocType.WH_ISSUE.value: "Material Issue",
    DocType.GRN.value: "Goods Receipt",
    # The outward leg: transport is arranged and the consignment leaves the warehouse.
    # This is where Logistics signs.
    DocType.DISPATCH.value: "Dispatch",
    DocType.QC_OUTWARD.value: "Outward QC",
    DocType.PURCHASE_RETURN.value: "Purchase Return (sending material back to a vendor)",
    DocType.REQUISITION.value: "Purchase Requisition",
    DocType.CONSOLIDATION.value: "Consolidated Purchase Sheet",
    DocType.RFQ.value: "Request for Quotation",
    DocType.PO.value: "Purchase Order",
    DocType.TRANSPORT_REQUEST.value: "Shipment (the outward transport leg)",
    # Only reached on a mode that actually hires somebody — see logistics.enums.
    DocType.CARRIER_AWARD.value: "Carrier Award (choosing the transport provider)",
}

# The order the modules are listed in on the config screen.
MODULE_ORDER = ["Indents", "Inventory", "Warehouse", "Returns", "Procurement",
                "Logistics", "Accounts"]

# Document types nothing OPENS an instance for any more. They keep their label and
# their module — an instance raised before the retirement still has to render with a
# name, and `engine` reads DOC_TYPE_LABEL for the stage name on a self-approved row —
# but Approvals Config no longer OFFERS them, and `ladder_config_validate` refuses a
# chain saved against one. Same reasoning as the ISSUE note above: a ladder the engine
# never looks up is configuration that is written, never read, and silently ignored.
#
#   STOCK_RETURN_LOGISTICS — the return's second signature. `_open_logistics_approval`
#       was retired on 2026-09-10 (`modules/returns/service.py`): the transport leg is
#       raised at the hand-over, the load may leave without it, the shelf is debited at
#       the gate and the far end signs on the Sign-off screen — so the rung asked
#       somebody to approve a journey that had already been approved, arranged and
#       sometimes finished. Its READ side is deliberately still standing for a return
#       that was already sitting on the rung; nothing new opens one, so there is nothing
#       left for a chain to govern.
RETIRED_DOC_TYPES = frozenset({DocType.STOCK_RETURN_LOGISTICS.value})

# Document types whose DEFAULT approver is the raiser's own post, not somebody above
# it. These are the events where authority comes from holding the thing rather than
# from rank: the person who owns a stocking point decides what leaves it, and every
# point under him is his too. A climb would ask his manager about a shelf his manager
# does not hold. An admin can still configure a real ladder for these on the Approvals
# Config screen — this is only what happens when nobody has.
SELF_OWNED_DOC_TYPES = frozenset({
    DocType.OWN_STOCK_ALLOCATION.value,
    DocType.OWN_STOCK_ISSUE.value,
    # A bin-to-bin movement never leaves the warehouse, so authority over it comes from
    # HOLDING the warehouse rather than from rank — the same rule as the two above.
    # This is what makes "the warehouse manager approves his own movements" the
    # behaviour out of the box, without a person being named anywhere in code: an admin
    # can still configure a real ladder for it on Approvals Config, and a project that
    # wants nobody to sign sets NO_APPROVAL there.
    DocType.STOCK_MOVEMENT_ORDER.value,
    # Forwarding is not a decision, but the default must never be "nobody looks at it":
    # it lands in the forwarder's own queue as a one-click task until an admin sets
    # NO_APPROVAL on the Approvals Config row.
    DocType.FORWARD_ISSUE.value,
})

LADDER_CODE_PREFIX = "LADDER"
# A hand-built ladder: an ordered list of POSTS with no climbing, for the documents
# whose approvers are not above the raiser at all (see custom_ladder.py). Told apart by
# the workflow code, so a plain POSITION workflow from the Workflows screen is never
# mistaken for one.
CUSTOM_CODE_PREFIX = "CUSTOM"
# Guards against a cycle in HCM's position tree, which would otherwise hang the walk.
MAX_CLIMB = 20

#: How many positions a rank may be spread across before it stops being resolvable as
#: a CENTRAL function (see `_add_offline_rungs`).
#:
#: The live mirror splits cleanly in two. A central desk holds one seat, or a handful:
#: SCM HEAD, CPO, DIRECTOR, LOGISTICS and INVENTORY MANAGER hold exactly one each, the
#: QC desks, P O and INDENT TEAM three. A FIELD rank is a rank the org has one of per
#: branch: Regional Manager 4, District Manager 27, OE 72, DEO and Driver 948 apiece,
#: Store Keeper 2001. Resolving a field rank company-wide would put a document in front
#: of two thousand storekeepers, so it is refused and said out loud instead.
#:
#: A rung the admin scoped to named positions is NOT held to this: naming the seats IS
#: the answer to "which of them", however many were named.
MAX_OFFLINE_RANK_POSITIONS = 3
APPROVER_SCOPE_FIELD = "__approver_positions_configured"
APPROVER_POSITION_FIELD = "__approver_position_id"

# ---- self-approval policy ----------------------------------------------------
#
# Who may approve a document raised by someone who also sits on the ladder. It is a
# property of the LADDER, not of a role or a person, so a project where one person
# wears three hats (Inventory, Warehouse) can let them approve while a project with a
# real segregation-of-duties rule keeps them out. Both live on the ladder's first rung
# as marker conditions, the same trick `selected_position_ids` already uses, so no
# table changes and no migration.
POLICY_FIELD = "__self_approval_policy"
FALLBACK_POSITION_FIELD = "__fallback_position_id"
# The raiser is dropped from every rung; nobody approves their own document. Default,
# and what the system did before the policy existed.
POLICY_INDEPENDENT = "INDEPENDENT"
# The raiser stays on the ladder and gets the approval task. This is the honest setting
# for Inventory and Warehouse, where the same twelve people hold every post.
POLICY_CREATOR_ALLOWED = "CREATOR_ALLOWED"
# Nobody approves it at all: the document is born approved, with a wf_actions row saying
# so. Unticking every rung does NOT mean this — an empty ladder falls through to the
# reporting line and then the admin safety net (engine._start_ladder), which is right for
# a misconfiguration and wrong for a deliberate "this step needs no signature". The
# forwarding leg of WH -> MDP -> LIP is the case this exists for.
POLICY_NONE = "NO_APPROVAL"
POLICIES = (POLICY_INDEPENDENT, POLICY_CREATOR_ALLOWED, POLICY_NONE)
# Marker rows, not real conditions: never evaluated, never shown to an admin.
INTERNAL_FIELDS = {APPROVER_SCOPE_FIELD, APPROVER_POSITION_FIELD,
                   POLICY_FIELD, FALLBACK_POSITION_FIELD}


def ladder_code(project_id: int | None, doc_type: str) -> str:
    return f"{LADDER_CODE_PREFIX}-{doc_type}-{project_id or 'ALL'}"


def is_ladder(stages: list[Stage]) -> bool:
    """A workflow is a ladder when its stages name ranks rather than positions."""
    return any(s.position_role_id is not None for s in stages)


#: Opt-in (WORKFLOW_SKIP_STAGES_BELOW_RAISER=1): a raiser who holds a rank in a ladder
#: does not wait on the rungs at or below it — the document goes to the next rung up.
SKIP_STAGES_BELOW_RAISER = os.getenv(
    "WORKFLOW_SKIP_STAGES_BELOW_RAISER", "0").strip().lower() in ("1", "true", "yes")


def is_custom_ladder(wf: Workflow) -> bool:
    """A hand-built ladder: its stages name posts, and nothing is climbed."""
    return (wf.code or "").startswith(f"{CUSTOM_CODE_PREFIX}-")


# ---------------- discovery: what an admin may configure ----------------

async def list_projects(db: AsyncSession) -> list[dict]:
    """Projects that have people, so a ladder can be built for them.

    Read off employees, not positions: HCM leaves hcm_positions.project_id empty.
    """
    rows = (await db.execute(
        select(HcmEmployee.project_id, HcmEmployee.project_name,
               func.count(HcmEmployee.id).label("headcount"))
        .where(HcmEmployee.project_id.isnot(None), HcmEmployee.is_active.is_(True))
        .group_by(HcmEmployee.project_id, HcmEmployee.project_name)
        .order_by(func.count(HcmEmployee.id).desc())
    )).all()
    projects = [{"id": r.project_id, "name": r.project_name or f"Project {r.project_id}",
                 "headcount": r.headcount} for r in rows]

    # SCM's own staff — the inventory manager, the warehouse manager — serve every
    # project and HCM therefore tags them with none, so they produce no row above and
    # had nowhere to be laddered from. The company-wide ladder already exists as the
    # fallback every project falls back TO (`ladder_code(None, doc_type)`); this only
    # makes it selectable. `id: None` is what resolve/save already treat as company-wide,
    # so nothing downstream changes.
    unassigned = (await db.execute(
        select(func.count(HcmEmployee.id))
        .where(HcmEmployee.project_id.is_(None), HcmEmployee.is_active.is_(True))
    )).scalar() or 0
    projects.append({"id": None, "name": "Company-wide (no project)",
                     "headcount": unassigned})
    return projects


def configurable_doc_types() -> list[str]:
    """The document types the engine actually reads a workflow for.

    `DOC_TYPE_LABEL` is already that list — a type is on it precisely because some
    module submits it to the engine. Exposing this as a function rather than letting
    callers iterate `DocType` is what stops a picker offering ISSUE or QUOTATION,
    against which a workflow can be saved and never read.

    Minus `RETIRED_DOC_TYPES`, which are on the label map for display only: the engine
    once read them and no longer opens one, so offering them is the same trap.
    """
    return [code for code in DOC_TYPE_LABEL if code not in RETIRED_DOC_TYPES]


async def list_doc_types() -> list[dict]:
    """What Approvals Config lists: one row per configurable type, retired ones gone."""
    return [{
        "code": code,
        "label": DOC_TYPE_LABEL.get(code, code.title()),
        "module": MODULE_BY_DOC_TYPE.get(code, "Other"),
    } for code in configurable_doc_types()]


def _held_position_ids(project_id: int):
    """Sub-select: the positions this project's people actually sit in."""
    return (select(HcmPositionAssignment.position_id)
            .join(HcmEmployee, HcmEmployee.id == HcmPositionAssignment.employee_id)
            .where(HcmPositionAssignment.is_active.is_(True),
                   HcmEmployee.is_active.is_(True),
                   HcmEmployee.project_id == project_id))


async def _project_position_rows(db: AsyncSession, project_id: int | None) -> list:
    """The positions held by this project's people — id, parent and rank, nothing else.

    A column select rather than mapped objects. A live project holds ~3,400 posts, and
    building that many ORM instances (each with `raw`, HCM's whole payload as JSON)
    cost more than the query did.
    """
    stmt = select(HcmPosition.id, HcmPosition.parent_position_id,
                  HcmPosition.role_id, HcmPosition.role_name,
                  HcmPosition.job_name, HcmPosition.name).where(
        HcmPosition.is_active.is_(True))
    if project_id is not None:
        stmt = stmt.where(HcmPosition.id.in_(_held_position_ids(project_id)))
    return list((await db.execute(stmt)).all())


async def project_position_ids(db: AsyncSession, project_id: int | None,
                               role_ids: set[int] | None = None) -> dict[int, list[int]]:
    """rank -> the position ids under it. Two columns, so it stays cheap even when the
    answer is every post in the project."""
    if role_ids is not None and not role_ids:
        return {}
    stmt = select(HcmPosition.role_id, HcmPosition.id).where(
        HcmPosition.is_active.is_(True), HcmPosition.role_id.isnot(None))
    if role_ids is not None:
        stmt = stmt.where(HcmPosition.role_id.in_(list(role_ids)))
    if project_id is not None:
        stmt = stmt.where(HcmPosition.id.in_(_held_position_ids(project_id)))
    out: dict[int, list[int]] = {}
    for role_id, position_id in (await db.execute(stmt)).all():
        out.setdefault(role_id, []).append(position_id)
    return out


async def project_rank_summary(db: AsyncSession,
                               project_id: int | None) -> dict[int, dict]:
    """rank -> name, how many posts sit under it, how many people fill it.

    Counted in MySQL. The config screen only ever shows these numbers, and counting
    3,400 rows there beats dragging them across a WAN to count them in Python.
    """
    stmt = (select(
        HcmPosition.role_id,
        func.min(func.coalesce(HcmPosition.role_name, HcmPosition.job_name,
                               HcmPosition.name)).label("role_name"),
        func.count(func.distinct(HcmPosition.id)).label("position_count"),
        func.count(func.distinct(HcmPositionAssignment.employee_id))
            .label("holder_count"),
    ).select_from(HcmPosition)
     .where(HcmPosition.is_active.is_(True), HcmPosition.role_id.isnot(None))
     .group_by(HcmPosition.role_id))
    if project_id is not None:
        # Inner: a rank exists for this project only through the posts its own people
        # hold, which is the same set _project_position_rows walks.
        stmt = (stmt
                .join(HcmPositionAssignment,
                      HcmPositionAssignment.position_id == HcmPosition.id)
                .join(HcmEmployee,
                      HcmEmployee.id == HcmPositionAssignment.employee_id)
                .where(HcmPositionAssignment.is_active.is_(True),
                       HcmEmployee.is_active.is_(True),
                       HcmEmployee.project_id == project_id))
    else:
        # Company-wide: every active post counts, filled or not.
        stmt = (stmt
                .join(HcmPositionAssignment,
                      (HcmPositionAssignment.position_id == HcmPosition.id)
                      & (HcmPositionAssignment.is_active.is_(True)), isouter=True)
                .join(HcmEmployee,
                      (HcmEmployee.id == HcmPositionAssignment.employee_id)
                      & (HcmEmployee.is_active.is_(True)), isouter=True))
    return {row.role_id: {"role_id": row.role_id, "role_name": row.role_name,
                          "position_count": row.position_count,
                          "holder_count": row.holder_count}
            for row in (await db.execute(stmt)).all()}


def _chunks(values: list[int], size: int = 1000) -> list[list[int]]:
    """A live project holds ~3,400 posts; one IN () of that width is asking for
    trouble with max_allowed_packet, and a handful of round trips costs nothing."""
    return [values[start:start + size] for start in range(0, len(values), size)]


async def _parent_map(db: AsyncSession, positions: list) -> dict[int, int | None]:
    """position -> parent, for the project's posts and every ancestor above them.

    Loaded a generation at a time. The tree is about ten deep whatever the project's
    size, so this is ten queries, not one per post.
    """
    parent_of: dict[int, int | None] = {p.id: p.parent_position_id for p in positions}
    frontier = {p for p in parent_of.values() if p is not None and p not in parent_of}
    while frontier:
        found: dict[int, int | None] = {}
        for chunk in _chunks(list(frontier)):
            rows = (await db.execute(
                select(HcmPosition.id, HcmPosition.parent_position_id)
                .where(HcmPosition.id.in_(chunk))
            )).all()
            found.update({row[0]: row[1] for row in rows})
        # A parent HCM no longer has is a top: the walk stops there rather than looping.
        parent_of.update({position_id: found.get(position_id) for position_id in frontier})
        frontier = {p for p in found.values() if p is not None and p not in parent_of}
    return parent_of


async def _depths(db: AsyncSession, positions: list) -> dict[int, int]:
    """How far each position sits below the top of HCM's tree.

    Depth is the only honest rank order available: level_order puts COO and SPH on the
    same band, and role_id is an identifier, not a sequence. Parents outside the
    project's own positions are still walked, so a gap in the middle does not flatten
    everything below it.
    """
    parent_of = await _parent_map(db, positions)
    depths: dict[int, int] = {}

    def depth_of(position_id: int) -> None:
        # Climb to the first ancestor whose depth is already known (or to the top),
        # then count back down the path. Iterative, so a deep tree cannot blow the
        # stack and each position is measured once.
        path: list[int] = []
        seen: set[int] = set()
        current = position_id
        while True:
            if current in depths:
                depth = depths[current]
                break
            parent = parent_of.get(current)
            if parent is None or current in seen:
                depths[current] = depth = 0
                break
            seen.add(current)
            path.append(current)
            current = parent
        for node in reversed(path):
            depth += 1
            depths[node] = depth

    for position in positions:
        depth_of(position.id)
    return depths


async def _roles_of(db: AsyncSession,
                    position_ids: set[int]) -> dict[int, int | None]:
    """position -> rank, for ACTIVE posts only.

    resolve_chain refuses an inactive ancestor (`parent.is_active`) but keeps climbing
    past it, so an inactive post is walked through and never collected. Leaving it out
    of this map reproduces exactly that.
    """
    out: dict[int, int | None] = {}
    for chunk in _chunks(list(position_ids)):
        rows = (await db.execute(
            select(HcmPosition.id, HcmPosition.role_id)
            .where(HcmPosition.id.in_(chunk), HcmPosition.is_active.is_(True))
        )).all()
        out.update({row[0]: row[1] for row in rows})
    return out


async def reachable_positions(db: AsyncSession,
                              project_id: int | None) -> dict[int, set[int]]:
    """rank -> the posts at it a real climb actually passes through.

    The same walk resolve_chain does at submit time, run from every post a raiser in
    this scope could be sitting in instead of from one document's raiser: start at the
    post, follow `parent_position_id` upward, stop at MAX_CLIMB or on a cycle. A rank no
    walk ever passes through can be switched on all day and will never approve anything.

    That is not a hypothetical. The live mirror holds 3,733 active posts, of which 41
    are islands — no parent AND no children — and only 8 of its 18 ranks lie on anybody's
    reporting line at all.
    """
    rows = await _project_position_rows(db, project_id)
    if not rows:
        return {}
    parent_of = await _parent_map(db, rows)
    role_of = await _roles_of(db, set(parent_of))

    reached: dict[int, set[int]] = {}
    for row in rows:
        seen = {row.id}
        current = row.id
        for _hop in range(MAX_CLIMB):
            parent = parent_of.get(current)
            if parent is None or parent in seen:
                break
            seen.add(parent)
            role_id = role_of.get(parent)
            if role_id is not None:
                reached.setdefault(role_id, set()).add(parent)
            current = parent
    return reached


async def unreachable_rung_warnings(db: AsyncSession, project_id: int | None,
                                    rungs: list) -> list[str]:
    """One line per switched-on rung that will actually fail to find an approver.

    Saving must still succeed: an administrator setting a ladder up before HCM data
    lands has to be able to save it. A rung no reporting line climbs through is NOT
    by itself a problem — `_add_offline_rungs` resolves exactly that case company-wide
    at submit time, which is how a central desk (SCM Head, Inventory Manager, ...) is
    meant to be reached from a field project with nobody of that rank in its own tree.
    This used to warn "cannot approve anything" about every one of those, which is
    wrong for the common case and left an admin unable to tell a genuinely broken rung
    from one that works by the company-wide path instead of the climb. It now runs the
    SAME check `_add_offline_rungs` runs (`offline_rung_resolution`) and only warns
    where that check also fails — nobody holds the rank, too many positions to pick
    one unambiguously, or the position exists but nobody is assigned to it today.
    """
    live = [rung for rung in rungs
            if getattr(rung, "is_enabled", False) or getattr(rung, "conditions", None)]
    if not live:
        return []
    reached = await reachable_positions(db, project_id)

    warnings: list[str] = []
    for rung in live:
        candidates = reached.get(rung.position_role_id, set())
        narrowed = getattr(rung, "selected_position_ids", None)
        if narrowed is not None:
            candidates = candidates & set(narrowed)
        if candidates:
            continue
        # Not on anyone's reporting line in this scope — but that is exactly the
        # shape `_add_offline_rungs` exists to rescue. Check it before alarming.
        status, posts, _holders = await offline_rung_resolution(
            db, rung.position_role_id, narrowed)
        if status == "ok":
            continue
        if status == "ambiguous":
            warnings.append(
                f"{rung.name}: not in anyone's reporting line here, and held by "
                f"{len(posts)} positions company-wide — too many to resolve "
                "automatically, so this rung will be skipped. Scope it to named "
                "positions on Approvals Config."
            )
        elif status == "no_holder":
            warnings.append(
                f"{rung.name}: not in anyone's reporting line here, and nobody is "
                f"currently assigned to the {len(posts)} position(s) at this rank — "
                "this rung will be skipped until someone is."
            )
        else:  # no_position
            warnings.append(
                f"{rung.name}: no active position holds this rank at all — "
                "this rung will be skipped and cannot approve anything."
            )
    return warnings


async def project_ranks(db: AsyncSession, project_id: int | None) -> list[dict]:
    """The ranks this project's people hold, highest first — names and counts.

    The POSITIONS behind a rank are deliberately not here. A live project holds ~3,400
    of them and the screen shows at most one rank's worth at a time, so shipping every
    one on every read was 1.3 MB of payload to draw seventeen toggles. rank_positions()
    fetches a rank's posts when the admin actually opens it.
    """
    rows = await _project_position_rows(db, project_id)
    if not rows:
        return []
    depths = await _depths(db, rows)
    holders_of = await _rank_holders(db, project_id)

    by_role: dict[int, dict] = {}
    for row in rows:
        if row.role_id is None:
            continue
        entry = by_role.setdefault(row.role_id, {
            "role_id": row.role_id,
            "role_name": row.role_name or row.job_name or row.name,
            "depths": {},
            "position_count": 0,
        })
        depth = depths.get(row.id, 0)
        entry["depths"][depth] = entry["depths"].get(depth, 0) + 1
        entry["position_count"] += 1

    out = []
    for entry in by_role.values():
        # The most common depth, not the shallowest. HCM's tree has orphans — one
        # District Manager post with no parent sits at depth 0, and taking the minimum
        # would hoist the whole rank up next to the COO. The bulk of a rank's posts
        # hang at its real height, so the mode is the honest answer. Ties go to the
        # shallower depth.
        counts = entry.pop("depths")
        holders = holders_of.get(entry["role_id"], [])
        out.append({
            **entry,
            "depth": min(counts, key=lambda d: (-counts[d], d)),
            "holders": holders[:8],
            "holder_count": len(holders),
        })
    return sorted(out, key=lambda r: (r["depth"], r["role_name"]))


async def company_ranks(db: AsyncSession, project_id: int | None) -> list[dict]:
    """Ranks whose people sit OUTSIDE this project — the shared chairs.

    HCM has now created the posts the SCM flow always needed: SCM HEAD, INDENT TEAM,
    P O, CPO, DIRECTOR, LOGISTICS, QC. Every one of them is seated from the SUPPLY
    CHAIN MANAGEMENT and H O projects, so `project_ranks` — which lists the ranks of
    the SELECTED project's own people — never showed them to an admin configuring
    104-MMU, and the only way to name those chairs was a locally-invented post.

    They are returned separately, and never merged into the climbable list, because
    they resolve differently: a rank on the raiser's own line is climbed to, and one
    off it is read straight off its holders (ApproverType.ROLE_ANY). Presenting them
    as the same thing is what would put a rung on a chain that can never resolve.
    """
    mine = {rank["role_id"] for rank in await project_ranks(db, project_id)}
    holders_of = await _rank_holders(db, None)
    rows = (await db.execute(
        select(HcmPosition.role_id,
               func.min(func.coalesce(HcmPosition.role_name, HcmPosition.job_name,
                                      HcmPosition.name)).label("role_name"),
               func.count(func.distinct(HcmPosition.id)).label("position_count"))
        .where(HcmPosition.is_active.is_(True), HcmPosition.role_id.isnot(None))
        .group_by(HcmPosition.role_id)
    )).all()

    out = []
    for role_id, role_name, position_count in rows:
        if role_id in mine:
            continue
        holders = holders_of.get(role_id, [])
        # A rank nobody fills is not a chair anybody can be sent to. Offering it would
        # put a rung on the chain that is skipped at submit time, silently.
        if not holders:
            continue
        out.append({
            "role_id": role_id,
            "role_name": role_name or f"Rank {role_id}",
            "position_count": position_count,
            "holders": holders[:8],
            "holder_count": len(holders),
        })
    return sorted(out, key=lambda r: r["role_name"])


async def rank_any_holders(db: AsyncSession, role_id: int,
                           exclude_employee_id: int | None = None) -> list[dict]:
    """Everyone holding a rank, company-wide. The ROLE_ANY rung's approvers.

    Deliberately unfiltered by project: the point of these chairs is that one SCM Head
    signs for every project. Inactive people and vacant posts drop out, so a rung with
    nobody left in it is skipped rather than stranding the document.
    """
    people = (await _rank_holders(db, None)).get(role_id, [])
    return [person for person in people if person["id"] != exclude_employee_id]


async def positions_of_rank(db: AsyncSession, role_id: int) -> list[int]:
    """The live positions that carry a rank.

    FIXED 2026-08-20 — a ROLE_ANY rung recorded `allowed_position_ids: []`, which the
    engine reads as "no hat restriction". For a LOCAL POST that is right (the seat is
    the person), but for a RANK it is not: a rank IS a position attribute, and someone
    can hold three positions of which only one carries it.

    WITHOUT this, a person who is both the Inventory Manager and the SCM Head approves
    the SCM Head rung while still wearing the Inventory Manager hat — the Approve button
    never goes away between the two rungs, no switch is ever demanded, and `wf_actions`
    records "APPROVED · INVENTORY MANAGER" against the SCM HEAD stage. The audit trail
    then states something that did not happen.
    """
    return list((await db.scalars(
        select(HcmPosition.id).where(
            HcmPosition.role_id == role_id,
            HcmPosition.is_active.is_(True),
        )
    )).all())


async def _rank_holders(db: AsyncSession,
                        project_id: int | None) -> dict[int, list[dict]]:
    """rank -> the people who fill it, deduplicated (someone can hold two posts at one).

    Keyed by rank rather than by position: the screen names holders per rung, and
    grouping in the database's projection instead of building 3,400 per-position
    entries is the difference between a big read and a small one.
    """
    stmt = (select(HcmPosition.role_id, HcmEmployee.id, HcmEmployee.full_name,
                   HcmEmployee.emp_code)
            .join(HcmPositionAssignment,
                  HcmPositionAssignment.position_id == HcmPosition.id)
            .join(HcmEmployee, HcmEmployee.id == HcmPositionAssignment.employee_id)
            .where(HcmPosition.is_active.is_(True),
                   HcmPosition.role_id.isnot(None),
                   HcmPositionAssignment.is_active.is_(True),
                   HcmEmployee.is_active.is_(True)))
    if project_id is not None:
        # This project's people only: an assignment made from another project must not
        # show up under a rung here.
        stmt = stmt.where(HcmEmployee.project_id == project_id)
    people: dict[int, dict[int, dict]] = {}
    for role_id, employee_id, full_name, emp_code in (await db.execute(stmt)).all():
        people.setdefault(role_id, {}).setdefault(
            employee_id, {"id": employee_id, "name": full_name, "code": emp_code})
    return {role_id: list(found.values()) for role_id, found in people.items()}


async def rank_positions(db: AsyncSession, project_id: int | None,
                         role_id: int) -> list[dict]:
    """Every post at ONE rank, with its department and who fills it.

    Read only when an admin opens a rank's advanced panel. Doing this for all seventeen
    ranks up front is what made the config screen take seconds to appear.
    """
    stmt = select(HcmPosition.id, HcmPosition.name, HcmPosition.department_id).where(
        HcmPosition.is_active.is_(True), HcmPosition.role_id == role_id)
    if project_id is not None:
        stmt = stmt.where(HcmPosition.id.in_(_held_position_ids(project_id)))
    rows = list((await db.execute(stmt)).all())
    if not rows:
        return []

    holders_of, assignment_of = await _position_people(
        db, [row.id for row in rows], project_id)
    # Each post's department, resolved for all of them before any is named, so the
    # names cost one query instead of a lookup per post.
    department_of = {
        row.id: (
            assignment_of.get(row.id, (None, None))[0]
            or row.department_id
            or getattr(assignment_of.get(row.id, (None, None))[1],
                       "department_id", None)
        )
        for row in rows
    }
    department_names = await _department_names(
        db, {d for d in department_of.values() if d is not None})

    out = []
    for row in rows:
        employee = assignment_of.get(row.id, (None, None))[1]
        department_id = department_of[row.id]
        department_name = None
        if employee and employee.department_id == department_id:
            department_name = employee.department_name
        if department_name is None and department_id is not None:
            department_name = department_names.get(department_id)
        out.append({
            "id": row.id,
            "name": row.name,
            "department_id": department_id,
            "department_name": department_name or "No department",
            "holders": [{"id": holder.id, "name": holder.full_name,
                         "code": holder.emp_code}
                        for holder in holders_of.get(row.id, [])[:8]],
        })
    return sorted(out, key=lambda row: (row["department_name"], row["name"]))


def _dedupe(employees) -> list[HcmEmployee]:
    """One row per person, first sighting wins — someone can hold two posts at a rank."""
    out: dict[int, HcmEmployee] = {}
    for employee in employees:
        out.setdefault(employee.id, employee)
    return list(out.values())


async def _position_people(
    db: AsyncSession, position_ids: list[int], project_id: int | None,
) -> tuple[dict[int, list[HcmEmployee]], dict[int, tuple[int | None, HcmEmployee]]]:
    """Every active assignment on these posts, in one sweep instead of per post.

    The config screen asks the same two questions of all 3,400 posts a live project
    holds — who fills this, and which department is it in — and asking them one post at
    a time cost ten thousand round trips to a remote MySQL, which is why the screen
    took a minute and a half to open.

    Returns holders (this project's people only: an assignment made from another
    project must not show up under a rung) and, separately, the first active assignment
    whoever holds it, which is what the department is read from. That split is
    deliberate — it is the one the per-post queries had.
    """
    holders: dict[int, list[HcmEmployee]] = {}
    first: dict[int, tuple[int | None, HcmEmployee]] = {}
    for chunk in _chunks(position_ids):
        rows = (await db.execute(
            select(HcmPositionAssignment.position_id,
                   HcmPositionAssignment.department_id,
                   HcmEmployee)
            .options(load_only(
                HcmEmployee.full_name, HcmEmployee.emp_code, HcmEmployee.project_id,
                HcmEmployee.department_id, HcmEmployee.department_name,
            ))
            .join(HcmEmployee, HcmEmployee.id == HcmPositionAssignment.employee_id)
            .where(HcmPositionAssignment.position_id.in_(chunk),
                   HcmPositionAssignment.is_active.is_(True),
                   HcmEmployee.is_active.is_(True))
            .order_by(HcmPositionAssignment.id)
        )).all()
        for position_id, department_id, employee in rows:
            first.setdefault(position_id, (department_id, employee))
            if project_id is None or employee.project_id == project_id:
                holders.setdefault(position_id, []).append(employee)
    return {pid: _dedupe(people) for pid, people in holders.items()}, first


async def _department_names(db: AsyncSession,
                            department_ids: set[int]) -> dict[int, str]:
    if not department_ids:
        return {}
    rows = (await db.execute(
        select(HcmDepartment.id, HcmDepartment.name)
        .where(HcmDepartment.id.in_(department_ids))
    )).all()
    return {row[0]: row[1] for row in rows}


# ---------------- loading a saved ladder ----------------

async def active_ladder(db: AsyncSession, project_id: int | None,
                        doc_type: str,
                        raiser_role_id: int | None = None,
                        ) -> tuple[Workflow, list[Stage]] | None:
    """The newest active ladder for EXACTLY this scope, or nothing.

    `raiser_role_id` narrows the scope by ONE more thing: the rank that raised the
    document. Passing None means the chain everybody shares — which is every chain
    saved before per-rank chains existed, so the default argument is the old behaviour
    exactly.

    Scans the scope's active workflows instead of judging only the top row. More than
    one workflow can be active for a doc type — a seeded WF-*, a policy saved on the
    Workflows screen — and any of them can sort above the configured ladder. Judging
    only the top row let such a row hide the ladder completely, which silently handed
    routing back to the reporting-line fallback: the toggles in Settings > Approvals
    Config were saved and then ignored.
    """
    stmt = select(Workflow).where(
        Workflow.doc_type == doc_type, Workflow.is_active.is_(True))
    stmt = (stmt.where(Workflow.project_id == project_id) if project_id is not None
            else stmt.where(Workflow.project_id.is_(None)))
    stmt = (stmt.where(Workflow.raiser_role_id == raiser_role_id)
            if raiser_role_id is not None
            else stmt.where(Workflow.raiser_role_id.is_(None)))
    rows = (await db.execute(
        stmt.order_by(Workflow.version.desc(), Workflow.id.desc()))).scalars().all()
    for wf in rows:
        stages = list((await db.execute(
            select(Stage).where(Stage.workflow_id == wf.id).order_by(Stage.sequence)
        )).scalars().all())
        # A hand-built ladder counts too. Its stages carry a post rather than a rank, so
        # is_ladder() cannot see it, and without this the engine would fall back to
        # climbing — which for Inventory and Warehouse reaches nobody.
        if is_custom_ladder(wf) or is_ladder(stages):
            return wf, stages
    return None


async def role_of_position(db: AsyncSession,
                           position_id: int | None) -> int | None:
    """The RANK a post sits at, or None — the key a per-raiser chain is chosen by.

    None for a raiser with no post, an unknown post, or a post HCM left rankless. All
    three mean the same thing to the lookup: use the chain everybody shares.
    """
    if position_id is None:
        return None
    position = await db.get(HcmPosition, position_id)
    return position.role_id if position is not None else None


async def find_ladder(db: AsyncSession, project_id: int | None,
                      doc_type: str,
                      raiser_role_id: int | None = None,
                      ) -> tuple[Workflow, list[Stage]] | None:
    """This project's ladder, else the company-wide one, else nothing.

    Nothing means the caller keeps its existing behaviour — the configured workflow if
    there is one, otherwise the reporting-line fallback. A project is never blocked by
    having no ladder yet.

    Narrowest wins, and the project beats the rank: this project's chain for this rank,
    then this project's chain for everybody, then the same two company-wide. A project
    that has deliberately configured one chain for all its raisers must not be overruled
    by a company-wide rank chain nobody in that project asked for.
    """
    for candidate in ([project_id, None] if project_id is not None else [None]):
        for rank in ([raiser_role_id, None] if raiser_role_id is not None else [None]):
            found = await active_ladder(db, candidate, doc_type, rank)
            if found is not None:
                return found
    return None


async def _enabled_role_scopes(db: AsyncSession, stages: list[Stage],
                               context: dict) -> dict[int, set[int] | None]:
    """Which rungs apply to this document.

    A rung with conditions is governed entirely by them; a rung without conditions is
    governed by its toggle. One rule covers both jobs — gating an enabled rung, and
    force-including a disabled one ("over five lakh, always include the COO").
    """
    # Every stage's conditions in ONE query rather than one per stage. The live INDENT
    # ladder has 24 stages, and against a remote database 24 round trips cost ~700ms
    # on a table holding a handful of rows. Same rows, same grouping, same decisions —
    # only the number of trips changes.
    stored_by_stage: dict[int, list[StageCondition]] = {}
    stage_ids = [s.id for s in stages if s.id is not None and s.position_role_id is not None]
    if stage_ids:
        for condition in (await db.execute(
            select(StageCondition).where(StageCondition.stage_id.in_(stage_ids))
        )).scalars().all():
            stored_by_stage.setdefault(condition.stage_id, []).append(condition)

    enabled: dict[int, set[int] | None] = {}
    for stage in stages:
        if stage.position_role_id is None:
            continue
        if stage.id is not None:
            stored = stored_by_stage.get(stage.id, [])
            configured = any(
                condition.field_name == APPROVER_SCOPE_FIELD
                for condition in stored
            )
            selected_positions = {
                int(condition.field_value)
                for condition in stored
                if condition.field_name == APPROVER_POSITION_FIELD
            }
            conditions = [
                condition for condition in stored
                if condition.field_name not in INTERNAL_FIELDS
            ]
        else:
            configured = getattr(stage, "selected_position_ids", None) is not None
            selected_positions = set(
                getattr(stage, "selected_position_ids", None) or []
            )
            conditions = getattr(stage, "conditions", [])
        applies = stage_applies(conditions, context) if conditions else stage.is_enabled
        if applies:
            enabled[stage.position_role_id] = (
                selected_positions if configured else None
            )
    return enabled


# ---------------- the self-approval policy ----------------

async def read_policy(db: AsyncSession,
                      stages: list[Stage]) -> tuple[str, int | None]:
    """(policy, fallback position) for a ladder, read off its first rung's markers.

    A ladder saved before the policy existed has no marker at all, and must keep
    behaving exactly as it did — so the default is INDEPENDENT.
    """
    policy, fallback_position_id = POLICY_INDEPENDENT, None
    for stage in stages:
        if stage.id is None:
            # A draft from the config screen: the values are on the object itself.
            policy = getattr(stage, "self_approval_policy", None) or policy
            raw = getattr(stage, "fallback_position_id", None)
            fallback_position_id = fallback_position_id or (int(raw) if raw else None)
            continue
        rows = (await db.execute(
            select(StageCondition).where(
                StageCondition.stage_id == stage.id,
                StageCondition.field_name.in_([POLICY_FIELD,
                                               FALLBACK_POSITION_FIELD]),
            )
        )).scalars().all()
        for row in rows:
            if row.field_name == POLICY_FIELD and row.field_value in POLICIES:
                policy = row.field_value
            elif row.field_name == FALLBACK_POSITION_FIELD and row.field_value:
                fallback_position_id = int(row.field_value)
        if rows:
            # The markers live on the first rung; later rungs never carry them.
            break
    return policy, fallback_position_id


def dedupe_chain(chain: list[dict]) -> list[dict]:
    """Collapse rungs that resolve to people an earlier rung already reached.

    Two posts held by the same employee are ONE approver, not two: leaving both in
    would ask that person to approve the same document twice, which no ladder ever
    means. Resequenced so the engine's `sequence` walk stays contiguous.

    Collapsing merges the dropped rung's POST into the surviving one
    (`allowed_position_ids`) instead of discarding it. The ladder authorised both
    posts; dropping one meant the holder could only act while wearing whichever hat
    happened to sit higher in the config, and the document still showed in his queue
    under the other one — visible but not actionable.
    """
    out: list[dict] = []
    seen: set[int] = set()
    for link in chain:
        approvers = set(link.get("approver_ids") or [])
        if approvers and approvers <= seen:
            for kept in out:
                if approvers <= set(kept.get("approver_ids") or []):
                    _merge_position(kept, link.get("position_id"))
                    break
            logger.info("Ladder rung %r collapsed: %s already approve at an earlier "
                        "rung", link.get("role_name"), link.get("approver_names"))
            continue
        seen |= approvers
        merged = {**link, "sequence": len(out) + 1}
        merged["allowed_position_ids"] = allowed_position_ids(link)
        out.append(merged)
    return out


def allowed_position_ids(link: dict) -> list[int]:
    """The posts a holder may act under on this rung.

    Falls back to the rung's own post so chains frozen before `allowed_position_ids`
    existed keep working — an in-flight document must not change who can sign it.
    """
    allowed = link.get("allowed_position_ids")
    if allowed:
        return [int(value) for value in allowed]
    position_id = link.get("position_id")
    return [int(position_id)] if position_id is not None else []


def _merge_position(link: dict, position_id: int | None) -> None:
    if position_id is None:
        return
    allowed = allowed_position_ids(link)
    if position_id not in allowed:
        allowed.append(int(position_id))
    link["allowed_position_ids"] = allowed


async def fallback_chain(db: AsyncSession, fallback_position_id: int | None,
                         exclude_employee_id: int | None) -> list[dict]:
    """The one-rung chain for a ladder's configured fallback post, or nothing.

    Reached when a ladder demands an independent approver and every rung resolved to
    the raiser himself. Somebody outside his own line has to sign it, and this is the
    post the project nominated for exactly that.
    """
    if not fallback_position_id:
        return []
    position = await db.get(HcmPosition, fallback_position_id)
    if position is None or not position.is_active:
        return []
    holders = await _position_holders(db, position.id, exclude_employee_id)
    if not holders:
        return []
    return [{
        "sequence": 1,
        "position_id": position.id,
        "position_name": position.name,
        "role_id": position.role_id,
        "role_name": f"{position.role_name or position.name} (independent approver)",
        "approver_ids": [h.id for h in holders],
        "approver_names": [h.full_name for h in holders],
    }]


# ---------------- resolution ----------------

async def resolve_chain(db: AsyncSession, stages: list[Stage],
                        requester_position_id: int | None,
                        requester_id: int | None,
                        context: dict | None = None,
                        policy: str = POLICY_INDEPENDENT,
                        allow_offline: bool = True) -> list[dict]:
    """Walk up from the raiser and keep the ancestors whose rank is switched on.

    Returns the frozen chain: one entry per approval stage, in order. Empty means the
    raiser sits at the top of the ladder and there is nobody above to approve.

    Under CREATOR_ALLOWED the raiser is NOT dropped from the rungs he holds. That
    matters where one person wears two hats — Siva holds both Inventory Manager and
    the Assistant Manager post above it, so dropping him emptied the whole ladder.
    """
    if requester_position_id is None:
        return []
    enabled = await _enabled_role_scopes(db, stages, context or {})
    if not enabled:
        return []
    exclude_id = None if policy == POLICY_CREATOR_ALLOWED else requester_id

    chain: list[dict] = []
    matched: set[int] = set()
    seen: set[int] = {requester_position_id}
    position = await db.get(HcmPosition, requester_position_id)
    hops = 0

    while position is not None and position.parent_position_id and hops < MAX_CLIMB:
        hops += 1
        parent_id = position.parent_position_id
        if parent_id in seen:
            break
        seen.add(parent_id)
        parent = await db.get(HcmPosition, parent_id)
        if parent is None:
            break
        position_scope = enabled.get(parent.role_id)
        role_enabled = parent.role_id in enabled
        position_enabled = position_scope is None or parent.id in position_scope
        if role_enabled and position_enabled and parent.is_active:
            holders = await _position_holders(db, parent.id, exclude_id)
            # A rung nobody fills is skipped rather than held: a vacant seat must not
            # strand the document. Delegation covers the named-stand-in case.
            if holders:
                matched.add(parent.role_id)
                chain.append({
                    "sequence": len(chain) + 1,
                    "position_id": parent.id,
                    "position_name": parent.name,
                    "role_id": parent.role_id,
                    "role_name": parent.role_name or parent.job_name or parent.name,
                    "approver_ids": [h.id for h in holders],
                    "approver_names": [h.full_name for h in holders],
                })
        position = parent

    # A configured rank the raiser does not REPORT THROUGH was being dropped in
    # silence, which is the one outcome rule 8 forbids: a ladder of OE -> SCM HEAD
    # resolved to OE alone, so the document was fully approved the moment the OE
    # signed, and nothing anywhere said a rung had gone missing. SCM HEAD is a root
    # position — it sits outside every branch's reporting line by design, and no
    # amount of climbing from a field post will ever reach it.
    missing = [role_id for role_id in enabled if role_id not in matched]
    if missing and allow_offline:
        chain = await _add_offline_rungs(
            db, chain, missing, enabled, stages, exclude_id,
            requester_position_id=requester_position_id)
    return dedupe_chain(chain)


async def offline_rung_resolution(
    db: AsyncSession, role_id: int, scope: set[int] | None,
    exclude_id: int | None = None,
) -> tuple[str, list, list]:
    """What rank `role_id` resolves to when no reporting line climbs through it.

    The one test both `_add_offline_rungs` (at submit time) and
    `unreachable_rung_warnings` (at save time) must agree on — they used to each
    guess independently, which is how the save-time check came to warn "cannot
    approve anything" about ranks that resolve fine at submit time: it only knew
    how to climb, never about this company-wide rescue.

    Returns `(status, posts, approvers)`:
    - `"ok"`: unambiguous — `posts` and `approvers` (HcmEmployee) are the real answer.
    - `"no_position"`: no active position holds this rank at all.
    - `"ambiguous"`: too many positions to resolve company-wide (`posts` only).
    - `"no_holder"`: the position(s) exist but nobody is currently assigned
      (`posts` only).
    """
    stmt = select(HcmPosition).where(HcmPosition.role_id == role_id,
                                     HcmPosition.is_active.is_(True))
    if scope:
        stmt = stmt.where(HcmPosition.id.in_(scope))
    posts = list((await db.execute(stmt)).scalars().all())
    if not posts:
        return "no_position", [], []
    if scope is None and len(posts) > MAX_OFFLINE_RANK_POSITIONS:
        return "ambiguous", posts, []
    approvers: list = []
    seen: set[int] = set()
    for post in posts:
        for holder in await _position_holders(db, post.id, exclude_id):
            if holder.id in seen:
                continue
            seen.add(holder.id)
            approvers.append(holder)
    if not approvers:
        return "no_holder", posts, []
    return "ok", posts, approvers


async def _add_offline_rungs(db: AsyncSession, chain: list[dict],
                             missing: list[int],
                             enabled: dict[int, set[int] | None],
                             stages: list[Stage],
                             exclude_id: int | None,
                             requester_position_id: int | None = None) -> list[dict]:
    """Resolve the configured ranks the climb never met, off the whole org.

    A central function is not anybody's ancestor. The climb answers "who above ME holds
    this rank", which is the right question for a reporting rank and unanswerable for a
    company-wide desk, so a rung naming one resolved to nobody and vanished.

    Only where the answer is UNAMBIGUOUS. One seat, or the handful a desk is staffed
    with, is a real answer; every Store Keeper in the company is not, and offering a
    document to two thousand people is worse than the bug. An ambiguous rung is left
    out exactly as before — but logged at ERROR, because the whole defect was that
    nothing said anything.

    Ordering comes from the LADDER once a rung is added this way: the climb orders by
    the org tree, which cannot place a rank that is not in it. Chains that need no
    offline rung are untouched, so no working ladder re-orders.
    """
    order = {stage.position_role_id: stage.sequence for stage in stages
             if stage.position_role_id is not None}

    requester_pos = await db.get(HcmPosition, requester_position_id) if requester_position_id else None
    raiser_stage_seq = min(
        (s.sequence for s in stages if s.position_role_id == requester_pos.role_id),
        default=None,
    ) if requester_pos and requester_pos.role_id else None

    min_matched_seq = min(
        (order[link["role_id"]] for link in chain if link.get("role_id") in order),
        default=None,
    )

    added: list[dict] = []
    for role_id in missing:
        role_seq = order.get(role_id)
        if raiser_stage_seq is not None and role_seq is not None and role_seq <= raiser_stage_seq:
            logger.info("Skipping offline rung %s: at or below raiser's stage in ladder", role_id)
            continue
        if min_matched_seq is not None and role_seq is not None and role_seq < min_matched_seq:
            logger.info("Skipping offline rung %s: sequence is below climbed rungs", role_id)
            continue

        scope = enabled.get(role_id)
        status, posts, holders = await offline_rung_resolution(
            db, role_id, scope, exclude_id)
        if status == "no_position":
            logger.error(
                "Ladder rung for rank %s resolves to no active position; the rung is "
                "not in the chain and nobody will be asked to sign it.", role_id)
            continue
        if status == "ambiguous":
            logger.error(
                "Ladder rung for rank %s is not in the raiser's reporting line and is "
                "held by %d positions, too many to resolve company-wide. The rung is "
                "NOT in the chain. Scope it to named positions on Approvals Config, "
                "or configure a rank the raiser reports through.",
                role_id, len(posts))
            continue
        if status == "no_holder":
            logger.error(
                "Ladder rung for rank %s resolves to %d position(s) that nobody "
                "fills; the rung is not in the chain.", role_id, len(posts))
            continue
        if requester_pos and any(p.parent_position_id == requester_pos.id for p in posts):
            logger.info("Skipping offline rung %s: position is subordinate to raiser", role_id)
            continue
        first = posts[0]
        added.append({
            "position_id": first.id,
            "position_name": first.name,
            "role_id": role_id,
            "role_name": first.role_name or first.job_name or first.name,
            "approver_ids": [h.id for h in holders],
            "approver_names": [h.full_name for h in holders],
            "allowed_position_ids": [p.id for p in posts],
        })
        logger.warning(
            "Ladder rung for rank %s (%s) is not in the raiser's reporting line; "
            "resolved company-wide to %d approver(s) across %d position(s).",
            role_id, first.role_name or first.name, len(holders), len(posts))
    if not added:
        return chain
    merged = chain + added
    merged.sort(key=lambda link: order.get(link["role_id"], len(order) + 1))
    for sequence, link in enumerate(merged, start=1):
        link["sequence"] = sequence
    return merged


async def own_post_chain(db: AsyncSession, requester_position_id: int | None,
                         requester_id: int | None) -> list[dict]:
    """A one-rung chain on the raiser's OWN post.

    The default for SELF_OWNED_DOC_TYPES. The raiser is deliberately NOT excluded —
    he is the point owner, and being the one who raised it is exactly why he is the
    right approver. Returns a real rung rather than nothing, so the document lands in
    his approval queue as a task he has to look at, instead of being auto-approved
    behind his back.
    """
    if requester_position_id is None:
        return []
    post = await db.get(HcmPosition, requester_position_id)
    if post is None or not post.is_active:
        return []
    holders = await _position_holders(db, post.id, exclude_employee_id=None)
    if not holders and requester_id is not None:
        # The post exists but HCM has nobody sitting in it. The person who just raised
        # the document is demonstrably in it, so trust that over the mirror.
        employee = await db.get(HcmEmployee, requester_id)
        holders = [employee] if employee is not None else []
    if not holders:
        return []
    return [{
        "sequence": 1,
        "position_id": post.id,
        "position_name": post.name,
        "role_id": post.role_id,
        "role_name": post.role_name or post.job_name or post.name,
        "approver_ids": [h.id for h in holders],
        "approver_names": [h.full_name for h in holders],
        "allowed_position_ids": [post.id],
    }]


async def _position_holders(db: AsyncSession, position_id: int,
                            exclude_employee_id: int | None) -> list[HcmEmployee]:
    emp_ids = [e for e in (await db.execute(
        select(HcmPositionAssignment.employee_id).where(
            HcmPositionAssignment.position_id == position_id,
            HcmPositionAssignment.is_active.is_(True),
        )
    )).scalars().all() if e is not None and e != exclude_employee_id]
    if not emp_ids:
        return []
    return list((await db.execute(
        select(HcmEmployee).where(
            HcmEmployee.id.in_(emp_ids), HcmEmployee.is_active.is_(True))
    )).scalars().unique().all())


async def project_for(db: AsyncSession, position_id: int | None,
                      user) -> tuple[int | None, str | None]:
    """Which project's ladder governs a document.

    The post the raiser is acting under wins, so someone holding two posts routes down
    the right ladder. HCM leaves that field empty today, so in practice this falls
    through to the raiser's own project.
    """
    if position_id is not None:
        position = await db.get(HcmPosition, position_id)
        if position is not None and position.project_id is not None:
            return position.project_id, position.project_name
    return getattr(user, "project_id", None), getattr(user, "project_name", None)


# ---------------- building and saving ----------------

def build_stages(ranks: list[dict],
                 enabled_role_ids: set[int] | None = None) -> list[dict]:
    """Turn a list of ranks into ladder rungs, everything on unless told otherwise.

    `selected_position_ids` is None — the rung is the whole RANK until an admin
    deliberately narrows it. It used to be pre-filled with the rank's posts that this
    project's own people hold, which silently made every rung a pinned list; the climb
    then dropped any ancestor outside it, and one of the five live Regional Managers is
    exactly that (his holder is on no project in the mirror).
    """
    return [{
        "sequence": index + 1,
        "name": rank["role_name"],
        "position_role_id": rank["role_id"],
        "is_enabled": (enabled_role_ids is None
                       or rank["role_id"] in enabled_role_ids),
        "position_count": rank.get("position_count", 0),
        "holder_count": rank.get("holder_count", 0),
        "is_dead": not rank.get("holder_count"),
        "selected_position_ids": None,
        "conditions": [],
    } for index, rank in enumerate(ranks)]


async def autobuild(db: AsyncSession, project_id: int | None, doc_type: str) -> dict:
    """A draft ladder for a project that has none — every rank it uses, all on.

    Not saved. The admin switches off what they do not want and presses Save, which is
    what turns it into version 1.
    """
    ranks = await project_ranks(db, project_id)
    return {
        "workflow_id": None,
        "version": 0,
        "project_id": project_id,
        "doc_type": doc_type,
        "module": MODULE_BY_DOC_TYPE.get(doc_type, "Other"),
        "is_new": True,
        "stages": build_stages(ranks),
    }


def new_workflow(project_id: int | None, project_name: str | None, doc_type: str,
                 version: int) -> Workflow:
    return Workflow(
        code=ladder_code(project_id, doc_type),
        name=f"{DOC_TYPE_LABEL.get(doc_type, doc_type)} approval"
             f"{f' — {project_name}' if project_name else ''}",
        doc_type=doc_type,
        project_id=project_id,
        project_name=project_name,
        module=MODULE_BY_DOC_TYPE.get(doc_type, "Other"),
        version=version,
        is_active=True,
    )


def new_stage(workflow_id: int, sequence: int, name: str, role_id: int,
              is_enabled: bool) -> Stage:
    return Stage(
        workflow_id=workflow_id,
        sequence=sequence,
        name=name,
        # A rung is resolved by climbing the raiser's reporting line, so POSITION would
        # be a lie — the position is not known until a document is raised.
        approver_type=ApproverType.REPORTING_MANAGER.value,
        position_role_id=role_id,
        is_enabled=is_enabled,
        approval_mode=ApprovalMode.ANY_ONE.value,
    )
