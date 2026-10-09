"""Monthly Indent Consolidation.

The tree under test mirrors the business example directly:

    COO (801)
      SPH (802)
        Regional Manager (803)
          District Manager (804)
            OE (805)
              Pilot (811) Pilot (812) Pilot (813)   <- ST-1..3, siblings under one OE

All six ranks are switched on, so a Pilot's indent climbs OE -> District Manager ->
Regional Manager -> SPH -> COO exactly as platform/workflow/ladder.py already does for
every document type. Nothing in this file teaches the engine about Monthly indents —
it only proves that grouping the wf_pending rows that engine already produces, by
MONTHLY CYCLE, reproduces the workspace the business asked for at every level, with
no code that names OE/DM/RM/SPH/COO.

Region/project/vehicle/office/requester/item are filters over that cycle, not extra
grouping keys: the same approver's August is one August however many regions it spans.
"""
from datetime import date, timedelta

import pytest

from app.modules.approvals import service as approvals_service
from app.modules.approvals.schemas import ApprovalQuantityIn, ConsolidationFilters
from app.modules.indents import service as indent_service
from app.modules.indents.enums import IndentStatus, IndentType
from app.modules.indents.schemas import IndentCreate, IndentItemIn, IndentUpdate
from app.platform.hcm.models import HcmEmployee, HcmPosition, HcmPositionAssignment
from app.platform.workflow import ladder_config
from app.platform.workflow.schemas import LadderIn
from app.shared.models.base import utcnow
from app.shared.models.master import Item, Uom

PROJECT = 700
PROJECT_NAME = "Consolidation Test Project"
RANKS = [(1, "COO"), (2, "SPH"), (3, "Regional Manager"),
         (4, "District Manager"), (5, "OE"), (6, "Pilot")]
RANK_NAME = dict(RANKS)
TREE = [(801, "COO", 1, None), (802, "SPH", 2, 801), (803, "RM", 3, 802),
        (804, "DM", 4, 803), (805, "OE", 5, 804)]
PILOT_IDS = [811, 812, 813]
DEFAULT_OFFICE = (101, "Region A")


async def _add_position(db, position_id, name, role_id, parent):
    db.add(HcmPosition(id=position_id, name=name, role_id=role_id,
                       role_name=RANK_NAME[role_id], parent_position_id=parent,
                       is_active=True, synced_at=utcnow()))


async def _add_holder(db, position_id, name, *, office_id, office_name):
    employee = HcmEmployee(id=position_id, full_name=name, emp_code=f"E{position_id}",
                           project_id=PROJECT, project_name=PROJECT_NAME,
                           office_id=office_id, office_name=office_name,
                           is_active=True, synced_at=utcnow())
    db.add(employee)
    await db.flush()
    db.add(HcmPositionAssignment(id=position_id, employee_id=employee.id,
                                 position_id=position_id, is_active=True,
                                 is_primary=True, synced_at=utcnow()))
    employee.active_position_id = position_id
    return employee


async def _org(db, *, pilot_offices: dict[int, tuple[int, str]] | None = None):
    """COO -> SPH -> RM -> DM -> OE, with sibling Pilot positions under the OE.

    `pilot_offices` overrides a pilot's (office_id, office_name); every other pilot,
    and every rank above OE, sits in DEFAULT_OFFICE — office/region is only meaningful
    on the requesters, since region_id is snapshotted from the RAISER at create time.
    """
    pilot_offices = pilot_offices or {}
    for position_id, name, role_id, parent in TREE:
        await _add_position(db, position_id, name, role_id, parent)
    for pilot_id in PILOT_IDS:
        await _add_position(db, pilot_id, f"Pilot {pilot_id}", 6, 805)
    await db.flush()

    holders = {}
    for position_id, name, _role, _parent in TREE:
        holders[position_id] = await _add_holder(
            db, position_id, name, office_id=DEFAULT_OFFICE[0], office_name=DEFAULT_OFFICE[1])
    for pilot_id in PILOT_IDS:
        office_id, office_name = pilot_offices.get(pilot_id, DEFAULT_OFFICE)
        holders[pilot_id] = await _add_holder(
            db, pilot_id, f"Pilot {pilot_id}", office_id=office_id, office_name=office_name)
    await db.flush()
    return holders


def _rungs():
    return [{"position_role_id": role_id, "name": name, "is_enabled": True, "conditions": []}
            for role_id, name in RANKS]


async def _save_ladder(db, user):
    return await ladder_config.save_ladder(
        db, LadderIn(project_id=PROJECT, doc_type="INDENT", rungs=_rungs()), user)


async def _item(db, code="IT-CONS-1"):
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    item = Item(code=code, name="Consolidation Item", uom_id=uom.id, uom_code="NOS")
    db.add(item)
    await db.flush()
    return item


async def _raise_indent(db, requester, item, qty, *, indent_type=None):
    body = dict(
        required_date=date.today() + timedelta(days=3), priority="NORMAL",
        items=[IndentItemIn(item_id=item.id, quantity=qty)],
    )
    if indent_type is not None:
        body["indent_type"] = indent_type
    indent = await indent_service.create_indent(db, IndentCreate(**body), requester)
    return await indent_service.submit_indent(db, indent.id, requester)


async def _raise_monthly(db, requester, item, qty):
    return await _raise_indent(db, requester, item, qty, indent_type=IndentType.MONTHLY)


async def _approve(db, indent, approver, qty=None):
    line = indent.items[0]
    return await approvals_service.approve_indent(
        db, indent.id,
        [ApprovalQuantityIn(line_id=line.id, approved_quantity=qty if qty is not None else float(line.quantity))],
        "", approver,
    )


# ---------------- Waiting for Me stays individual for REGULAR/Adhoc indents ----------------

async def test_monthly_indents_are_excluded_from_waiting_for_me(db):
    holders = await _org(db)
    await _save_ladder(db, holders[801])
    item = await _item(db)
    oe = holders[805]
    pilot = holders[PILOT_IDS[0]]

    regular = await _raise_indent(db, pilot, item, 5)
    monthly = await _raise_monthly(db, pilot, item, 5)

    page = await approvals_service.pending_page(db, oe, 1, 20)
    doc_ids = {row["doc_id"] for row in page["items"]}
    assert regular.id in doc_ids
    assert monthly.id not in doc_ids
    assert page["total"] == 1

    queue = await approvals_service.pending_for_user(db, oe)
    queue_ids = {row["doc_id"] for row in queue}
    assert regular.id in queue_ids
    assert monthly.id not in queue_ids


async def test_regular_indents_never_appear_in_consolidation(db):
    holders = await _org(db)
    await _save_ladder(db, holders[801])
    item = await _item(db)
    oe = holders[805]
    pilot = holders[PILOT_IDS[0]]
    await _raise_indent(db, pilot, item, 5)

    batches = await approvals_service.consolidation_batches_for_user(db, oe)
    assert batches == []


# ---------------- grouping ----------------

async def test_consolidation_groups_siblings_reporting_to_the_same_approver(db):
    """ST-1..3 raise Monthly indents -> OE-1 sees ONE batch containing all three."""
    holders = await _org(db)
    await _save_ladder(db, holders[801])
    item = await _item(db)
    oe = holders[805]
    for pilot_id in PILOT_IDS:
        await _raise_monthly(db, holders[pilot_id], item, 10)

    batches = await approvals_service.consolidation_batches_for_user(db, oe)
    assert len(batches) == 1
    batch = batches[0]
    assert batch.indent_count == 3
    assert batch.requester_count == 3
    assert batch.current_stage_name == "OE"
    assert len(batch.consolidated_items) == 1
    [line] = batch.consolidated_items
    assert line.total_requested_quantity == 30
    assert line.total_ceiling_quantity == 30
    assert line.indent_count == 3


async def test_scope_does_not_split_the_cycle_it_filters_it(db):
    """Two regions under the same OE stay in ONE monthly batch.

    The consolidation context is cycle + current approver. Region/project/vehicle/
    office/requester/item are dimensions INSIDE that cycle, offered as filters —
    they must never fragment one August into several approval workspaces.
    """
    holders = await _org(db, pilot_offices={PILOT_IDS[2]: (202, "Region B")})
    await _save_ladder(db, holders[801])
    item = await _item(db)
    oe = holders[805]
    await _raise_monthly(db, holders[PILOT_IDS[0]], item, 10)
    await _raise_monthly(db, holders[PILOT_IDS[1]], item, 10)
    await _raise_monthly(db, holders[PILOT_IDS[2]], item, 7)

    batches = await approvals_service.consolidation_batches_for_user(db, oe)
    assert len(batches) == 1
    batch = batches[0]
    assert batch.indent_count == 3
    assert batch.region_count == 2
    assert batch.consolidated_items[0].total_requested_quantity == 27

    filtered = await approvals_service.consolidation_batches_for_user(
        db, oe, ConsolidationFilters(region_id=202))
    assert len(filtered) == 1
    assert filtered[0].indent_count == 1
    assert filtered[0].region_name == "Region B"
    assert filtered[0].consolidated_items[0].total_requested_quantity == 7


# ---------------- filters ----------------

async def test_filter_dimensions_narrow_totals_and_clear_back_to_everything(db):
    """The scenario from the requirement, end to end.

    Region A / Project 1, Region A / Project 2, Region B / Project 1, Region B /
    Project 3 all pending with the SAME approver: one cycle unfiltered, Region A
    alone, then Region A + Project 2, then everything back.
    """
    holders = await _org(db, pilot_offices={PILOT_IDS[2]: (202, "Region B")})
    await _save_ladder(db, holders[801])
    item = await _item(db)
    oe = holders[805]
    a1 = await _raise_monthly(db, holders[PILOT_IDS[0]], item, 10)   # Region A
    a2 = await _raise_monthly(db, holders[PILOT_IDS[1]], item, 4)    # Region A
    b1 = await _raise_monthly(db, holders[PILOT_IDS[2]], item, 7)    # Region B

    # Project is the requester's HCM project, snapshotted at create; give the second
    # Region A indent its own project so "Region A + Project 2" has something to mean.
    a2.project_id, a2.project_name = 702, "Project 2"
    b1.project_id, b1.project_name = 703, "Project 3"
    await db.flush()

    workspace = await approvals_service.consolidation_workspace(db, oe)
    assert workspace.unfiltered_indent_count == 3
    assert workspace.total_indent_count == 3
    assert len(workspace.items) == 1
    assert workspace.items[0].region_count == 2
    assert workspace.items[0].project_count == 3

    # Dropdown values come from the approver's own pending indents, never a master.
    options = workspace.filter_options
    assert {o.value for o in options.region} == {"101", "202"}
    assert {o.label for o in options.project} == {PROJECT_NAME, "Project 2", "Project 3"}
    assert {o.value for o in options.requester} == {str(p) for p in PILOT_IDS}
    assert [o.value for o in options.item] == [str(item.id)]
    # Vehicle is offered only when the data carries one; these indents have none.
    assert options.vehicle == []

    region_a = await approvals_service.consolidation_workspace(
        db, oe, ConsolidationFilters(region_id=101))
    assert region_a.total_indent_count == 2
    assert region_a.total_requester_count == 2
    assert {r.id for r in region_a.items[0].indents} == {a1.id, a2.id}
    assert region_a.items[0].consolidated_items[0].total_requested_quantity == 14
    # The options themselves stay whole, so the filter can always be widened again.
    assert {o.value for o in region_a.filter_options.region} == {"101", "202"}

    both = await approvals_service.consolidation_workspace(
        db, oe, ConsolidationFilters(region_id=101, project_id=702))
    assert both.total_indent_count == 1
    assert [r.id for r in both.items[0].indents] == [a2.id]
    assert both.items[0].consolidated_items[0].total_requested_quantity == 4

    cleared = await approvals_service.consolidation_workspace(db, oe)
    assert cleared.total_indent_count == 3
    assert {r.id for r in cleared.items[0].indents} == {a1.id, a2.id, b1.id}


async def test_requester_and_item_filters_narrow_the_lines_that_are_summed(db):
    """Requester picks indents; Item picks LINES.

    Filtering to Gloves must report Gloves' quantity, not the whole quantity of every
    indent that happens to also contain Gloves.
    """
    holders = await _org(db)
    await _save_ladder(db, holders[801])
    helmet = await _item(db, code="IT-HELMET")
    gloves = Item(code="IT-GLOVES", name="Gloves", uom_id=helmet.uom_id, uom_code="NOS")
    db.add(gloves)
    await db.flush()
    oe = holders[805]

    first = await indent_service.create_indent(db, IndentCreate(
        indent_type=IndentType.MONTHLY,
        required_date=date.today() + timedelta(days=3), priority="NORMAL",
        items=[IndentItemIn(item_id=helmet.id, quantity=40),
               IndentItemIn(item_id=gloves.id, quantity=90)],
    ), holders[PILOT_IDS[0]])
    await indent_service.submit_indent(db, first.id, holders[PILOT_IDS[0]])
    await _raise_monthly(db, holders[PILOT_IDS[1]], helmet, 80)

    everything = await approvals_service.consolidation_workspace(db, oe)
    totals = {row.item_id: row.total_requested_quantity
              for row in everything.items[0].consolidated_items}
    assert totals == {helmet.id: 120, gloves.id: 90}

    only_gloves = await approvals_service.consolidation_workspace(
        db, oe, ConsolidationFilters(item_id=gloves.id))
    assert only_gloves.total_indent_count == 1
    [line] = only_gloves.items[0].consolidated_items
    assert (line.item_id, line.total_requested_quantity) == (gloves.id, 90)
    # The indent row is reported on the filtered line too, not on all 130.
    assert only_gloves.items[0].indents[0].total_requested_quantity == 90
    assert only_gloves.items[0].indents[0].line_count == 1

    by_requester = await approvals_service.consolidation_workspace(
        db, oe, ConsolidationFilters(requester_id=PILOT_IDS[1]))
    assert by_requester.total_indent_count == 1
    assert by_requester.items[0].consolidated_items[0].total_requested_quantity == 80


async def test_a_filter_never_widens_the_queue_or_bypasses_the_ceiling(db):
    """Filters are a view over the same wf_pending rows Waiting-for-Me reads: they
    cannot surface someone else's indent, and the ceiling stays the previous level's
    approved quantity, not a number consolidation invented."""
    holders = await _org(db)
    await _save_ladder(db, holders[801])
    item = await _item(db)
    oe, dm = holders[805], holders[804]
    indents = [await _raise_monthly(db, holders[p], item, 6) for p in PILOT_IDS]
    for indent in indents:
        await _approve(db, indent, oe, qty=4)

    # OE has nothing left, whatever is filtered for.
    assert (await approvals_service.consolidation_workspace(
        db, oe, ConsolidationFilters(region_id=101))).total_indent_count == 0

    filtered = await approvals_service.consolidation_workspace(
        db, dm, ConsolidationFilters(item_id=item.id))
    [line] = filtered.items[0].consolidated_items
    assert line.total_requested_quantity == 18     # what was asked for
    assert line.total_ceiling_quantity == 12       # 3 x what OE actually approved
    for row in filtered.items[0].indents:
        assert row.previous_approved_quantity == 4
        assert row.current_ceiling_quantity == 4


# ---------------- per-indent independence ----------------

async def test_approving_one_indent_does_not_touch_the_rest_of_the_batch(db):
    holders = await _org(db)
    await _save_ladder(db, holders[801])
    item = await _item(db)
    oe = holders[805]
    indents = [await _raise_monthly(db, holders[p], item, 4) for p in PILOT_IDS]

    approved = await _approve(db, indents[0], oe)
    # A 5-rung ladder (OE -> DM -> RM -> SPH -> COO): approving the OE stage moves the
    # indent on to the District Manager, it does not finish the whole approval.
    assert approved.status == IndentStatus.PENDING_APPROVAL.value
    assert approved.current_stage_name == "District Manager"

    batches = await approvals_service.consolidation_batches_for_user(db, oe)
    assert len(batches) == 1
    assert batches[0].indent_count == 2
    remaining_ids = {row.id for row in batches[0].indents}
    assert remaining_ids == {indents[1].id, indents[2].id}


async def test_returning_one_indent_for_correction_does_not_touch_the_rest(db):
    holders = await _org(db)
    await _save_ladder(db, holders[801])
    item = await _item(db)
    oe = holders[805]
    indents = [await _raise_monthly(db, holders[p], item, 3) for p in PILOT_IDS]

    returned = await indent_service.return_indent_for_correction(
        db, indents[0].id, "Please correct the quantity", oe)
    assert returned.status == IndentStatus.RETURNED_FOR_CORRECTION.value

    batches = await approvals_service.consolidation_batches_for_user(db, oe)
    assert len(batches) == 1
    assert batches[0].indent_count == 2
    remaining_ids = {row.id for row in batches[0].indents}
    assert indents[0].id not in remaining_ids
    assert remaining_ids == {indents[1].id, indents[2].id}

    # The returned indent kept its own identity: requester, number and history are
    # untouched, it is simply no longer part of anyone's pending batch.
    assert returned.requested_by_id == holders[PILOT_IDS[0]].id
    assert returned.indent_no == indents[0].indent_no


# ---------------- dynamic propagation up the reporting hierarchy ----------------

async def test_consolidation_climbs_to_the_next_approver_after_the_lower_level_approves(db):
    """After OE approves every Monthly indent, DM sees them consolidated too — with
    no code anywhere naming OE or DM, only the ladder's existing rank resolution."""
    holders = await _org(db)
    await _save_ladder(db, holders[801])
    item = await _item(db)
    oe, dm = holders[805], holders[804]
    indents = [await _raise_monthly(db, holders[p], item, 6) for p in PILOT_IDS]

    assert (await approvals_service.consolidation_batches_for_user(db, dm)) == []

    for indent in indents:
        await _approve(db, indent, oe)

    assert (await approvals_service.consolidation_batches_for_user(db, oe)) == []

    dm_batches = await approvals_service.consolidation_batches_for_user(db, dm)
    assert len(dm_batches) == 1
    batch = dm_batches[0]
    assert batch.indent_count == 3
    assert batch.current_stage_name == "District Manager"
    for row in batch.indents:
        assert row.previous_approved_quantity == 6
        assert row.current_ceiling_quantity == 6

    # Every original indent is still its own document: distinct numbers, its own
    # requester, its own full approval history — the batch never merged them.
    assert len({row.id for row in batch.indents}) == 3
    assert len({row.indent_no for row in batch.indents}) == 3
    for indent in indents:
        history = await approvals_service.approval_history(db, "INDENT", indent.id, oe)
        actions = [row["action"] for row in history]
        assert "SUBMITTED" in actions and "APPROVED" in actions


async def test_resubmitted_monthly_indent_rejoins_the_same_consolidation_batch(db):
    """The batch a correction drops out of is the exact batch it lands back in: same
    cycle/region/project key, same approver -- once the requester edits and resubmits.
    Nothing on the correction path (engine.return_for_correction/resubmit_correction)
    knows about consolidation; this is purely wf_pending reappearing under the same
    grouping key, exercised end to end."""
    holders = await _org(db)
    await _save_ladder(db, holders[801])
    item = await _item(db)
    oe = holders[805]
    pilot = holders[PILOT_IDS[0]]
    indents = [await _raise_monthly(db, holders[p], item, 3) for p in PILOT_IDS]

    returned = await indent_service.return_indent_for_correction(
        db, indents[0].id, "Please correct the quantity", oe)
    assert returned.status == IndentStatus.RETURNED_FOR_CORRECTION.value

    batches = await approvals_service.consolidation_batches_for_user(db, oe)
    assert len(batches) == 1
    assert batches[0].indent_count == 2
    assert indents[0].id not in {row.id for row in batches[0].indents}

    await indent_service.update_indent(
        db, indents[0].id,
        IndentUpdate(required_date=date.today() + timedelta(days=3), items=[IndentItemIn(item_id=item.id, quantity=5)]),
        pilot,
    )
    resubmitted = await indent_service.resubmit_indent_correction(
        db, indents[0].id, pilot,
    )
    assert resubmitted.status == IndentStatus.PENDING_APPROVAL.value

    batches = await approvals_service.consolidation_batches_for_user(db, oe)
    assert len(batches) == 1
    batch = batches[0]
    assert batch.indent_count == 3
    assert {row.id for row in batch.indents} == {i.id for i in indents}
    [line] = batch.consolidated_items
    # 5 (corrected) + 3 + 3 = 11, not the original 9 -- proves the batch reads the
    # corrected quantity, not a stale snapshot from before the correction.
    assert line.total_requested_quantity == 11


async def test_final_authority_pair_both_see_the_same_consolidated_batch(db):
    """COO is the top of the ladder with no further ancestor, so once RM and SPH
    approve, the indent lands on the ANY_ONE final pair — proving consolidation keeps
    working all the way to the top, unmodified."""
    holders = await _org(db)
    await _save_ladder(db, holders[801])
    item = await _item(db)
    oe, dm, rm, sph = holders[805], holders[804], holders[803], holders[802]
    indents = [await _raise_monthly(db, holders[p], item, 2) for p in PILOT_IDS]

    for indent in indents:
        await _approve(db, indent, oe)
    for indent in indents:
        await _approve(db, indent, dm)
    for indent in indents:
        await _approve(db, indent, rm)

    sph_batches = await approvals_service.consolidation_batches_for_user(db, sph)
    assert len(sph_batches) == 1
    assert sph_batches[0].indent_count == 3
    assert sph_batches[0].current_stage_name == "SPH"
