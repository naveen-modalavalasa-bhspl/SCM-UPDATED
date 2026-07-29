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
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.hcm.models import (
    HcmEmployee, HcmPosition, HcmPositionAssignment,
)
from app.platform.workflow.conditions import stage_applies
from app.platform.workflow.models import Stage, StageCondition, Workflow
from app.shared.enums import ApprovalMode, ApproverType, DocType

# Which module owns each document type. Drives the grouping in the Approvals Config
# screen; it is presentation, not routing.
MODULE_BY_DOC_TYPE: dict[str, str] = {
    DocType.INDENT.value: "Indents",
    DocType.ALLOCATION.value: "Inventory",
    DocType.MR.value: "Inventory",
    DocType.ISSUE.value: "Warehouse",
    DocType.GRN.value: "Warehouse",
    DocType.PO.value: "Procurement",
}

DOC_TYPE_LABEL: dict[str, str] = {
    DocType.INDENT.value: "Indent",
    DocType.ALLOCATION.value: "Stock Allocation",
    DocType.MR.value: "Material Request",
    DocType.ISSUE.value: "Material Issue",
    DocType.GRN.value: "Goods Receipt",
    DocType.PO.value: "Purchase Order",
}

# The order the modules are listed in on the config screen.
MODULE_ORDER = ["Indents", "Inventory", "Warehouse", "Procurement"]

LADDER_CODE_PREFIX = "LADDER"
# Guards against a cycle in HCM's position tree, which would otherwise hang the walk.
MAX_CLIMB = 20


def ladder_code(project_id: int | None, doc_type: str) -> str:
    return f"{LADDER_CODE_PREFIX}-{doc_type}-{project_id or 'ALL'}"


def is_ladder(stages: list[Stage]) -> bool:
    """A workflow is a ladder when its stages name ranks rather than positions."""
    return any(s.position_role_id is not None for s in stages)


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
    return [{"id": r.project_id, "name": r.project_name or f"Project {r.project_id}",
             "headcount": r.headcount} for r in rows]


async def list_doc_types() -> list[dict]:
    return [{
        "code": code,
        "label": DOC_TYPE_LABEL.get(code, code.title()),
        "module": MODULE_BY_DOC_TYPE.get(code, "Other"),
    } for code in DOC_TYPE_LABEL]


async def _project_positions(db: AsyncSession,
                             project_id: int | None) -> list[HcmPosition]:
    """The positions actually held by this project's people."""
    stmt = select(HcmPosition).where(HcmPosition.is_active.is_(True))
    if project_id is not None:
        stmt = stmt.where(HcmPosition.id.in_(
            select(HcmPositionAssignment.position_id)
            .join(HcmEmployee, HcmEmployee.id == HcmPositionAssignment.employee_id)
            .where(HcmPositionAssignment.is_active.is_(True),
                   HcmEmployee.is_active.is_(True),
                   HcmEmployee.project_id == project_id)
        ))
    return list((await db.execute(stmt)).scalars().all())


async def _depths(db: AsyncSession, positions: list[HcmPosition]) -> dict[int, int]:
    """How far each position sits below the top of HCM's tree.

    Depth is the only honest rank order available: level_order puts COO and SPH on the
    same band, and role_id is an identifier, not a sequence. Parents outside the
    project's own positions are still walked, so a gap in the middle does not flatten
    everything below it.
    """
    known = {p.id: p for p in positions}
    depths: dict[int, int] = {}

    async def depth_of(position_id: int, seen: set[int]) -> int:
        if position_id in depths:
            return depths[position_id]
        position = known.get(position_id) or await db.get(HcmPosition, position_id)
        if position is None or not position.parent_position_id or position_id in seen:
            depths[position_id] = 0
            return 0
        seen.add(position_id)
        value = await depth_of(position.parent_position_id, seen) + 1
        depths[position_id] = value
        return value

    for position in positions:
        await depth_of(position.id, set())
    return depths


async def project_ranks(db: AsyncSession, project_id: int | None) -> list[dict]:
    """The ranks this project's people hold, highest first.

    Each carries the real holders, so the config screen can show who is behind a rung
    and flag one that nobody fills — the dead-rung check for when an HCM sync removes
    the last position at a rank.
    """
    positions = await _project_positions(db, project_id)
    if not positions:
        return []
    depths = await _depths(db, positions)

    by_role: dict[int, dict] = {}
    for position in positions:
        if position.role_id is None:
            continue
        entry = by_role.setdefault(position.role_id, {
            "role_id": position.role_id,
            "role_name": position.role_name or position.job_name or position.name,
            "depths": [],
            "position_ids": [],
        })
        entry["depths"].append(depths.get(position.id, 0))
        entry["position_ids"].append(position.id)

    for entry in by_role.values():
        # The most common depth, not the shallowest. HCM's tree has orphans — one
        # District Manager post with no parent sits at depth 0, and taking the minimum
        # would hoist the whole rank up next to the COO. The bulk of a rank's posts
        # hang at its real height, so the mode is the honest answer. Ties go to the
        # shallower depth.
        counts: dict[int, int] = {}
        for depth in entry["depths"]:
            counts[depth] = counts.get(depth, 0) + 1
        entry["depth"] = min(counts, key=lambda d: (-counts[d], d))
        del entry["depths"]

    ranks = sorted(by_role.values(), key=lambda r: (r["depth"], r["role_name"]))
    out = []
    for rank in ranks:
        holders = await _holders_of(db, rank["position_ids"], project_id)
        out.append({
            "role_id": rank["role_id"],
            "role_name": rank["role_name"],
            "depth": rank["depth"],
            "position_count": len(rank["position_ids"]),
            "holders": [{"id": h.id, "name": h.full_name, "code": h.emp_code}
                        for h in holders[:8]],
            "holder_count": len(holders),
        })
    return out


async def _holders_of(db: AsyncSession, position_ids: list[int],
                      project_id: int | None) -> list[HcmEmployee]:
    if not position_ids:
        return []
    stmt = (select(HcmEmployee)
            .join(HcmPositionAssignment,
                  HcmPositionAssignment.employee_id == HcmEmployee.id)
            .where(HcmPositionAssignment.position_id.in_(position_ids),
                   HcmPositionAssignment.is_active.is_(True),
                   HcmEmployee.is_active.is_(True)))
    if project_id is not None:
        stmt = stmt.where(HcmEmployee.project_id == project_id)
    return list((await db.execute(stmt)).scalars().unique().all())


# ---------------- loading a saved ladder ----------------

async def find_ladder(db: AsyncSession, project_id: int | None,
                      doc_type: str) -> tuple[Workflow, list[Stage]] | None:
    """This project's ladder, else the company-wide one, else nothing.

    Nothing means the caller keeps its existing behaviour — the configured workflow if
    there is one, otherwise the reporting-line fallback. A project is never blocked by
    having no ladder yet.
    """
    for candidate in ([project_id, None] if project_id is not None else [None]):
        stmt = select(Workflow).where(
            Workflow.doc_type == doc_type, Workflow.is_active.is_(True))
        stmt = (stmt.where(Workflow.project_id == candidate) if candidate is not None
                else stmt.where(Workflow.project_id.is_(None)))
        wf = (await db.execute(stmt.order_by(Workflow.version.desc(), Workflow.id.desc()))
              ).scalars().first()
        if wf is None:
            continue
        stages = list((await db.execute(
            select(Stage).where(Stage.workflow_id == wf.id).order_by(Stage.sequence)
        )).scalars().all())
        if is_ladder(stages):
            return wf, stages
    return None


async def _enabled_role_ids(db: AsyncSession, stages: list[Stage],
                            context: dict) -> set[int]:
    """Which rungs apply to this document.

    A rung with conditions is governed entirely by them; a rung without conditions is
    governed by its toggle. One rule covers both jobs — gating an enabled rung, and
    force-including a disabled one ("over five lakh, always include the COO").
    """
    enabled: set[int] = set()
    for stage in stages:
        if stage.position_role_id is None:
            continue
        conditions = list((await db.execute(
            select(StageCondition).where(StageCondition.stage_id == stage.id)
        )).scalars().all()) if stage.id is not None else []
        applies = stage_applies(conditions, context) if conditions else stage.is_enabled
        if applies:
            enabled.add(stage.position_role_id)
    return enabled


# ---------------- resolution ----------------

async def resolve_chain(db: AsyncSession, stages: list[Stage],
                        requester_position_id: int | None,
                        requester_id: int | None,
                        context: dict | None = None) -> list[dict]:
    """Walk up from the raiser and keep the ancestors whose rank is switched on.

    Returns the frozen chain: one entry per approval stage, in order. Empty means the
    raiser sits at the top of the ladder and there is nobody above to approve.
    """
    if requester_position_id is None:
        return []
    enabled = await _enabled_role_ids(db, stages, context or {})
    if not enabled:
        return []

    chain: list[dict] = []
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
        if parent.role_id in enabled and parent.is_active:
            holders = await _position_holders(db, parent.id, requester_id)
            # A rung nobody fills is skipped rather than held: a vacant seat must not
            # strand the document. Delegation covers the named-stand-in case.
            if holders:
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
    return chain


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

def build_stages(ranks: list[dict], enabled_role_ids: set[int] | None = None) -> list[dict]:
    """Turn a list of ranks into ladder rungs, everything on unless told otherwise."""
    return [{
        "sequence": index + 1,
        "name": rank["role_name"],
        "position_role_id": rank["role_id"],
        "is_enabled": (enabled_role_ids is None
                       or rank["role_id"] in enabled_role_ids),
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
        "ranks": ranks,
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
