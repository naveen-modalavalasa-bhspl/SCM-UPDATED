"""Project-wise approval ladders.

The tree under test is the real one from the business:

    COO (601)
      SPH (602)
        Regional Manager (603)          Regional Manager 2 (613)
          District Manager (604)          District Manager 2 (614)
            OE (605)                        OE 2 (615)
              MMU Pilot (606)                 MMU Pilot 2 (616)

Both branches sit in project 500 and share the same six RANKS, which is the whole
point: a rung names a rank (hcm_positions.role_id), and the holder is found by
climbing the raiser's own line, so branch 1's pilot can never land on branch 2's
Regional Manager.
"""
import pytest

from sqlalchemy import select

from app.core.exceptions import PermissionError_, ValidationError
from app.platform.hcm.models import (
    HcmEmployee, HcmPosition, HcmPositionAssignment,
)
from app.platform.workflow import engine, ladder, ladder_config
from app.platform.workflow.models import Action, Instance, Pending, Workflow
from app.platform.workflow.schemas import LadderCopyIn, LadderIn
from app.shared.enums import ApprovalAction, ConditionOperator, InstanceStatus
from app.shared.models.base import utcnow

PROJECT = 500
PROJECT_NAME = "104-MMU-AP-Pulicherla"
# role_id -> rank name. Ranks are shared across branches; positions are not.
RANKS = [(1, "COO"), (2, "SPH"), (3, "Regional Manager"),
         (4, "District Manager"), (5, "OE"), (6, "MMU Pilot")]
RANK_NAME = dict(RANKS)
# position id -> (name, role_id, parent)
BRANCH_1 = [(601, "COO", 1, None), (602, "SPH", 2, 601), (603, "RM", 3, 602),
            (604, "DM", 4, 603), (605, "OE", 5, 604), (606, "Pilot", 6, 605)]
BRANCH_2 = [(613, "RM-2", 3, 602), (614, "DM-2", 4, 613),
            (615, "OE-2", 5, 614), (616, "Pilot-2", 6, 615)]


async def _org(db, with_second_branch: bool = False):
    """Positions and one holder each. Returns {position_id: employee}.

    The project sits on the EMPLOYEE, matching the live mirror, where
    hcm_positions.project_id is empty on all 3,729 rows.
    """
    positions = BRANCH_1 + (BRANCH_2 if with_second_branch else [])
    for position_id, name, role_id, parent in positions:
        db.add(HcmPosition(id=position_id, name=name, role_id=role_id,
                           role_name=RANK_NAME[role_id], parent_position_id=parent,
                           is_active=True, synced_at=utcnow()))
    await db.flush()

    holders = {}
    for position_id, name, _role, _parent in positions:
        employee = HcmEmployee(id=position_id, full_name=name, emp_code=f"E{position_id}",
                               project_id=PROJECT, project_name=PROJECT_NAME,
                               is_active=True, synced_at=utcnow())
        db.add(employee)
        await db.flush()
        db.add(HcmPositionAssignment(id=position_id, employee_id=employee.id,
                                     position_id=position_id, is_active=True,
                                     is_primary=True, synced_at=utcnow()))
        employee.active_position_id = position_id
        holders[position_id] = employee
    await db.flush()
    return holders


def _rungs(*, off: set[str] = frozenset()) -> list[dict]:
    return [{"position_role_id": role_id, "name": name,
             "is_enabled": name not in off, "conditions": []}
            for role_id, name in RANKS]


async def _save(db, user, off: set[str] = frozenset(), doc_type: str = "INDENT"):
    return await ladder_config.save_ladder(db, LadderIn(
        project_id=PROJECT, doc_type=doc_type, rungs=_rungs(off=off)), user)


def _chain_ranks(instance: Instance) -> list[str]:
    return [link["role_name"] for link in (instance.resolved_chain or [])]


# ---------------- resolution ----------------

async def test_every_rung_on_climbs_the_whole_tree(db):
    holders = await _org(db)
    await _save(db, holders[601])

    instance = await engine.start(db, "INDENT", 1,
                                  {"requester_position_id": 606}, holders[606])

    assert _chain_ranks(instance) == [
        "OE", "District Manager", "Regional Manager", "SPH", "COO"]


async def test_switching_off_oe_and_dm_sends_the_pilot_straight_to_the_rm(db):
    """The business case: two rungs come off, and an indent raised at the bottom
    goes to the Regional Manager first."""
    holders = await _org(db)
    await _save(db, holders[601], off={"OE", "District Manager"})

    instance = await engine.start(db, "INDENT", 1,
                                  {"requester_position_id": 606}, holders[606])

    assert _chain_ranks(instance) == ["Regional Manager", "SPH", "COO"]


async def test_a_raiser_never_routes_below_himself(db):
    """The District Manager raising the same indent gets the same chain — the OE is
    below him and is never asked, whether or not that rung is switched on."""
    holders = await _org(db)
    await _save(db, holders[601])

    instance = await engine.start(db, "INDENT", 1,
                                  {"requester_position_id": 604}, holders[604])

    assert _chain_ranks(instance) == ["Regional Manager", "SPH", "COO"]


async def test_the_top_of_the_ladder_self_approves(db):
    holders = await _org(db)
    await _save(db, holders[601])

    instance = await engine.start(db, "INDENT", 1,
                                  {"requester_position_id": 601}, holders[601])

    assert instance.status == InstanceStatus.APPROVED.value
    actions = await engine.history(db, "INDENT", 1)
    approved = [a for a in actions if a.action == ApprovalAction.APPROVED.value]
    assert len(approved) == 1
    assert approved[0].actor_id == holders[601].id
    assert approved[0].comments == engine.SELF_APPROVED_COMMENT


async def test_the_chain_follows_the_raisers_own_branch(db):
    """Two Regional Managers in one project. Branch 1's pilot must reach 603, never
    613 — this is the case a typed list of positions gets wrong."""
    holders = await _org(db, with_second_branch=True)
    await _save(db, holders[601], off={"OE", "District Manager"})

    first = await engine.start(db, "INDENT", 1,
                               {"requester_position_id": 606}, holders[606])
    second = await engine.start(db, "INDENT", 2,
                                {"requester_position_id": 616}, holders[616])

    assert [link["position_id"] for link in first.resolved_chain][0] == 603
    assert [link["position_id"] for link in second.resolved_chain][0] == 613


async def test_role_rung_can_limit_approval_to_selected_positions(db):
    holders = await _org(db, with_second_branch=True)
    scoped_rungs = []
    for rung in _rungs(off={"SPH", "District Manager", "OE", "MMU Pilot"}):
        if rung["position_role_id"] == 3:
            rung["selected_position_ids"] = [603]
        elif rung["position_role_id"] == 1:
            rung["selected_position_ids"] = [601]
        scoped_rungs.append(rung)
    await ladder_config.save_ladder(db, LadderIn(
        project_id=PROJECT, doc_type="INDENT", rungs=scoped_rungs,
    ), holders[601])

    selected_branch = await engine.start(
        db, "INDENT", 21, {"requester_position_id": 606}, holders[606],
    )
    other_branch = await engine.start(
        db, "INDENT", 22, {"requester_position_id": 616}, holders[616],
    )

    assert [link["position_id"] for link in selected_branch.resolved_chain] == [603, 601]
    assert [link["position_id"] for link in other_branch.resolved_chain] == [601]


async def test_the_screens_draft_does_not_pin_a_rank_to_this_projects_own_posts(db):
    """A rung the admin never narrowed means ANY post at that rank.

    The climb walks HCM's real tree, and that tree runs through posts whose holder HCM
    tags to another project or to none at all — the live mirror does exactly that for
    one of the five Regional Managers. A draft that quietly pinned each rung to the
    posts this project's own people happen to hold dropped such an ancestor silently,
    in the preview and again at submit, with the rung still showing as switched on.
    """
    holders = await _org(db, with_second_branch=True)
    # Branch 1's Regional Manager: HCM has him on no project, so 603 is not among the
    # posts project 500's people hold. Branch 2's RM (613) is, so the rank still shows.
    holders[603].project_id = None
    holders[603].project_name = None
    await db.flush()

    draft = await ladder_config.get_ladder(db, PROJECT, "INDENT")
    await ladder_config.save_ladder(db, LadderIn(
        project_id=PROJECT, doc_type="INDENT",
        rungs=[{"position_role_id": rung["position_role_id"], "name": rung["name"],
                "is_enabled": rung["is_enabled"],
                "selected_position_ids": rung["selected_position_ids"],
                "conditions": []}
               for rung in draft["rungs"]],
    ), holders[601])

    instance = await engine.start(db, "INDENT", 1,
                                  {"requester_position_id": 606}, holders[606])

    assert "Regional Manager" in _chain_ranks(instance)


async def test_the_documents_own_project_chooses_the_ladder(db):
    """A ladder belongs to the document's project, not to whoever pressed the button.

    Inventory raises the allocation for somebody else's indent, and the person doing it
    is a storekeeper or an admin whose own HCM project is another one — or none. Reading
    the project off the raiser sent every one of those straight past the project's
    configured ladder and into the fallback.
    """
    holders = await _org(db)
    await _save(db, holders[601], off={"OE", "District Manager"})
    outsider = HcmEmployee(id=901, full_name="Central Stores", emp_code="E901",
                           is_active=True, synced_at=utcnow())
    db.add(outsider)
    await db.flush()

    instance = await engine.start(
        db, "INDENT", 7,
        {"requester_position_id": 606, "project_id": PROJECT}, outsider)

    assert _chain_ranks(instance) == ["Regional Manager", "SPH", "COO"]


async def test_a_rung_nobody_fills_is_skipped(db):
    """The Regional Manager's seat is vacant. The indent climbs past it rather than
    stalling — a vacant post must never strand a document."""
    holders = await _org(db)
    await db.delete(await db.get(HcmPositionAssignment, 603))
    await db.flush()
    await _save(db, holders[601], off={"OE", "District Manager"})

    instance = await engine.start(db, "INDENT", 1,
                                  {"requester_position_id": 606}, holders[606])

    assert _chain_ranks(instance) == ["SPH", "COO"]


async def test_a_raiser_with_no_position_never_self_approves(db):
    """An empty climb reads as 'top of the ladder'. Someone holding no post has an
    empty climb for a different reason, and must not be handed their own approval."""
    holders = await _org(db)
    await _save(db, holders[601], off={"OE", "District Manager"})
    stray = HcmEmployee(id=900, full_name="Stray", emp_code="E900", is_active=True,
                        synced_at=utcnow())
    db.add(stray)
    await db.flush()

    instance = await engine.start(db, "INDENT", 5, {"requester_position_id": None},
                                  stray)

    assert instance.status != InstanceStatus.APPROVED.value
    assert instance.resolved_chain is None


async def test_a_project_with_no_ladder_is_left_to_the_old_path(db):
    """No ladder saved: the engine behaves exactly as it did before this feature."""
    holders = await _org(db)

    instance = await engine.start(db, "INDENT", 1,
                                  {"requester_position_id": 606}, holders[606])

    assert instance.resolved_chain is None


# ---------------- acting on a ladder ----------------

async def test_approving_climbs_the_chain_and_finishes(db):
    holders = await _org(db)
    await _save(db, holders[601], off={"OE", "District Manager"})
    await engine.start(db, "INDENT", 1, {"requester_position_id": 606}, holders[606])

    for position_id in (603, 602, 601):
        approvers = await engine.current_approvers(db, "INDENT", 1)
        assert [a.id for a in approvers] == [position_id]
        instance = await engine.act(db, "INDENT", 1, "APPROVE", holders[position_id])

    assert instance.status == InstanceStatus.APPROVED.value
    assert not await engine.current_approvers(db, "INDENT", 1)


async def test_rejecting_ends_the_document(db):
    holders = await _org(db)
    await _save(db, holders[601], off={"OE", "District Manager"})
    await engine.start(db, "INDENT", 1, {"requester_position_id": 606}, holders[606])

    instance = await engine.act(db, "INDENT", 1, "REJECT", holders[603], "not needed")

    assert instance.status == InstanceStatus.REJECTED.value
    assert not await engine.current_approvers(db, "INDENT", 1)


async def test_return_for_correction_first_stage_assigns_requester_without_pending(db):
    holders = await _org(db)
    await _save(db, holders[601])
    instance = await engine.start(db, "INDENT", 51, {
        "requester_position_id": 606,
    }, holders[606])
    assert instance.current_sequence == 1

    returned = await engine.return_for_correction(
        db, "INDENT", 51, holders[605], "fix quantity",
        context={"requester_position_id": 606},
    )

    state = await engine.get_correction_state(db, "INDENT", 51)
    assert returned.id == instance.id
    assert returned.status == InstanceStatus.IN_PROGRESS.value
    assert returned.current_sequence == 1
    assert state["correction_owner_employee_id"] == holders[606].id
    assert state["correction_owner_position_id"] == 606
    assert state["resubmit_target_sequence"] == 1
    assert state["correction_comment"] == "fix quantity"
    assert not await engine.current_approvers(db, "INDENT", 51)


async def test_return_for_correction_later_stage_assigns_exact_previous_actor(db):
    holders = await _org(db)
    second_dm = HcmEmployee(
        id=1604, full_name="DM Alternate", emp_code="E1604",
        project_id=PROJECT, project_name=PROJECT_NAME,
        is_active=True, synced_at=utcnow(),
    )
    db.add(second_dm)
    await db.flush()
    db.add(HcmPositionAssignment(
        id=1604, employee_id=second_dm.id, position_id=604,
        is_active=True, is_primary=True, synced_at=utcnow(),
    ))
    second_dm.active_position_id = 604
    await db.flush()
    await _save(db, holders[601])
    instance = await engine.start(db, "INDENT", 52, {
        "requester_position_id": 606,
    }, holders[606])

    await engine.act(db, "INDENT", 52, "APPROVE", holders[605])
    await engine.act(db, "INDENT", 52, "APPROVE", holders[604])
    returned = await engine.return_for_correction(
        db, "INDENT", 52, holders[603], "dm to correct",
        context={"requester_position_id": 606},
    )

    state = await engine.get_correction_state(db, "INDENT", 52)
    assert returned.id == instance.id
    assert state["correction_owner_employee_id"] == holders[604].id
    assert state["correction_owner_employee_id"] != second_dm.id
    assert state["correction_owner_position_id"] == 604
    assert state["returned_from_sequence"] == 3
    assert not (await db.execute(
        select(Pending).where(Pending.instance_id == instance.id)
    )).scalars().all()


async def test_resubmit_correction_reopens_returning_stage_on_same_instance(db):
    holders = await _org(db)
    await _save(db, holders[601])
    instance = await engine.start(db, "INDENT", 53, {
        "requester_position_id": 606,
    }, holders[606])
    await engine.return_for_correction(
        db, "INDENT", 53, holders[605], "requester fix",
        context={"requester_position_id": 606},
    )

    resubmitted = await engine.resubmit_correction(
        db, "INDENT", 53, holders[606],
        context={"requester_position_id": 606},
    )
    pending = (await db.execute(
        select(Pending).where(Pending.instance_id == instance.id)
    )).scalars().all()
    actions = (await db.execute(
        select(Action).where(Action.instance_id == instance.id)
    )).scalars().all()

    assert resubmitted.id == instance.id
    assert resubmitted.current_sequence == 1
    assert [row.approver_id for row in pending] == [holders[605].id]
    assert await engine.get_correction_state(db, "INDENT", 53) is None
    assert [row.action for row in actions].count(ApprovalAction.RETURNED.value) == 1


async def test_resubmit_correction_blocks_non_owner_wrong_position_and_duplicate(db):
    holders = await _org(db)
    await _save(db, holders[601])
    await engine.start(db, "INDENT", 54, {
        "requester_position_id": 606,
    }, holders[606])
    await engine.return_for_correction(
        db, "INDENT", 54, holders[605], "requester fix",
        context={"requester_position_id": 606},
    )

    with pytest.raises(PermissionError_):
        await engine.resubmit_correction(db, "INDENT", 54, holders[605])

    holders[606].active_position_id = 605
    with pytest.raises(PermissionError_):
        await engine.resubmit_correction(db, "INDENT", 54, holders[606])

    holders[606].active_position_id = 606
    await engine.resubmit_correction(
        db, "INDENT", 54, holders[606],
        context={"requester_position_id": 606},
    )
    with pytest.raises(ValidationError):
        await engine.resubmit_correction(db, "INDENT", 54, holders[606])


async def test_existing_return_action_behavior_is_unchanged_for_non_indent(db):
    holders = await _org(db)
    await _save(db, holders[601], doc_type="MR")
    await engine.start(db, "MR", 55, {"requester_position_id": 606}, holders[606])

    returned = await engine.act(db, "MR", 55, "RETURN", holders[605])
    pending = await engine.current_approvers(db, "MR", 55)

    assert returned.current_sequence == 1
    assert [employee.id for employee in pending] == [holders[605].id]
    assert await engine.get_correction_state(db, "MR", 55) is None


async def test_someone_not_on_the_current_rung_cannot_approve(db):
    holders = await _org(db)
    await _save(db, holders[601], off={"OE", "District Manager"})
    await engine.start(db, "INDENT", 1, {"requester_position_id": 606}, holders[606])

    with pytest.raises(PermissionError_):
        await engine.act(db, "INDENT", 1, "APPROVE", holders[602])


# ---------------- versioning ----------------

async def test_editing_a_ladder_cannot_move_a_document_already_in_approval(db):
    holders = await _org(db)
    await _save(db, holders[601], off={"OE", "District Manager"})
    instance = await engine.start(db, "INDENT", 1,
                                  {"requester_position_id": 606}, holders[606])
    before = list(instance.resolved_chain)

    await _save(db, holders[601], off={"Regional Manager", "SPH"})

    reloaded = await db.get(Instance, instance.id)
    await db.refresh(reloaded)
    assert reloaded.resolved_chain == before
    approvers = await engine.current_approvers(db, "INDENT", 1)
    assert [a.id for a in approvers] == [603]


async def test_saving_retires_the_previous_version(db):
    holders = await _org(db)
    first = await _save(db, holders[601])
    second = await _save(db, holders[601], off={"OE"})

    assert first["version"] == 1
    assert second["version"] == 2
    old = await db.get(Workflow, first["workflow_id"])
    assert old.is_active is False


async def test_a_ladder_with_nothing_switched_on_is_refused(db):
    holders = await _org(db)

    with pytest.raises(ValidationError):
        await ladder_config.save_ladder(db, LadderIn(
            project_id=PROJECT, doc_type="INDENT",
            rungs=[{"position_role_id": lid, "name": name, "is_enabled": False,
                    "conditions": []} for lid, name in RANKS],
        ), holders[601])


async def test_one_projects_ladder_does_not_answer_for_another(db):
    """A ladder saved for project 500 must not be picked up by a document raised in a
    project that has none."""
    holders = await _org(db)
    await _save(db, holders[601], off={"OE", "District Manager"})
    db.add(HcmPosition(id=700, name="Other-Pilot", role_id=6, role_name="MMU Pilot",
                       parent_position_id=None, is_active=True, synced_at=utcnow()))
    other = HcmEmployee(id=700, full_name="Other", emp_code="E700", project_id=999,
                        project_name="Another project", is_active=True,
                        synced_at=utcnow())
    db.add(other)
    await db.flush()

    instance = await engine.start(db, "INDENT", 9,
                                  {"requester_position_id": 700}, other)

    assert instance.resolved_chain is None


# ---------------- conditions ----------------

async def test_a_condition_can_pull_in_a_rung_that_is_switched_off(db):
    """'Over five lakh, always include the COO' — the rung is off, so it applies only
    when its condition passes."""
    holders = await _org(db)
    saved = await ladder_config.save_ladder(db, LadderIn(
        project_id=PROJECT, doc_type="INDENT",
        rungs=[
            {"position_role_id": 3, "name": "Regional Manager", "is_enabled": True,
             "conditions": []},
            {"position_role_id": 1, "name": "COO", "is_enabled": False,
             "conditions": [{"field_name": "amount",
                             "operator": ConditionOperator.GT.value,
                             "field_value": "500000", "logic": "AND"}]},
        ],
    ), holders[601])
    assert saved["version"] == 1

    small = await engine.start(db, "INDENT", 1,
                               {"requester_position_id": 606, "amount": 1000},
                               holders[606])
    large = await engine.start(db, "INDENT", 2,
                               {"requester_position_id": 606, "amount": 900000},
                               holders[606])

    assert _chain_ranks(small) == ["Regional Manager"]
    assert _chain_ranks(large) == ["Regional Manager", "COO"]


# ---------------- the config screen's own reads ----------------

async def test_a_project_with_no_ladder_gets_a_draft_with_every_rank_on(db):
    await _org(db)

    draft = await ladder_config.get_ladder(db, PROJECT, "INDENT")

    assert draft["is_new"] is True
    assert draft["version"] == 0
    assert [r["name"] for r in draft["rungs"]] == [name for _id, name in RANKS]
    assert all(r["is_enabled"] for r in draft["rungs"])


async def test_a_rank_nobody_holds_is_flagged_as_dead(db):
    holders = await _org(db)
    await _save(db, holders[601])
    await db.delete(await db.get(HcmPositionAssignment, 603))
    await db.flush()

    saved = await ladder_config.get_ladder(db, PROJECT, "INDENT")

    dead = [r["name"] for r in saved["rungs"] if r["is_dead"]]
    assert dead == ["Regional Manager"]


async def test_the_preview_shows_the_chain_without_saving(db):
    await _org(db)

    result = await ladder_config.preview(
        db, PROJECT, "INDENT", _rungs(off={"OE", "District Manager"}), from_role_id=6)

    assert [step["role_name"] for step in result["chain"]] == [
        "Regional Manager", "SPH", "COO"]
    assert result["self_approved"] is False


async def test_the_preview_says_so_when_the_raiser_is_the_top(db):
    await _org(db)

    result = await ladder_config.preview(db, PROJECT, "INDENT", _rungs(),
                                         from_role_id=1)

    assert result["chain"] == []
    assert result["self_approved"] is True


async def test_conditions_survive_a_save(db):
    holders = await _org(db)
    await ladder_config.save_ladder(db, LadderIn(
        project_id=PROJECT, doc_type="INDENT",
        rungs=[{"position_role_id": 3, "name": "Regional Manager", "is_enabled": True,
                "conditions": [{"field_name": "amount", "operator": "GT",
                                "field_value": "1000", "logic": "AND"}]}],
    ), holders[601])

    saved = await ladder_config.get_ladder(db, PROJECT, "INDENT")

    rung = next(r for r in saved["rungs"] if r["position_role_id"] == 3)
    assert rung["conditions"] == [{"field_name": "amount", "operator": "GT",
                                   "field_value": "1000", "logic": "AND"}]


async def test_options_lists_the_project_and_groups_documents_by_module(db):
    await _org(db)

    result = await ladder_config.options(db)

    assert PROJECT in [p["id"] for p in result["projects"]]
    modules = {d["code"]: d["module"] for d in result["doc_types"]}
    assert modules["INDENT"] == "Indents"
    assert modules["GRN"] == "Warehouse"
    assert modules["MR"] == "Inventory"


async def test_a_ladder_can_be_copied_to_another_project(db):
    holders = await _org(db)
    await _save(db, holders[601], off={"OE", "District Manager"})
    db.add(HcmPosition(id=800, name="RM-P2", role_id=3, role_name="Regional Manager",
                       is_active=True, synced_at=utcnow()))
    db.add(HcmPosition(id=801, name="Pilot-P2", role_id=6, role_name="MMU Pilot",
                       parent_position_id=800, is_active=True, synced_at=utcnow()))
    await db.flush()
    for emp_id, position_id in [(800, 800), (801, 801)]:
        db.add(HcmEmployee(id=emp_id, full_name=f"P2-{emp_id}", emp_code=f"E{emp_id}",
                           project_id=800, project_name="Second project",
                           is_active=True, synced_at=utcnow()))
        await db.flush()
        db.add(HcmPositionAssignment(id=emp_id, employee_id=emp_id,
                                     position_id=position_id, is_active=True,
                                     is_primary=True, synced_at=utcnow()))
    await db.flush()

    result = await ladder_config.copy_ladder(db, LadderCopyIn(
        from_project_id=PROJECT, doc_type="INDENT", to_project_ids=[800]),
        holders[601])

    assert result["copied_to"] == [800]
    copied = await ladder_config.get_ladder(db, 800, "INDENT")
    enabled = {r["name"] for r in copied["rungs"] if r["is_enabled"]}
    assert "Regional Manager" in enabled
    assert "District Manager" not in enabled


async def test_the_project_falls_back_to_the_raisers_own(db):
    """The post wins where HCM fills its project in. It does not today — every
    hcm_positions row has an empty project_id — so this falls through to the person."""
    holders = await _org(db)

    project_id, name = await ladder.project_for(db, 606, holders[606])

    assert project_id == PROJECT
    assert name == PROJECT_NAME
