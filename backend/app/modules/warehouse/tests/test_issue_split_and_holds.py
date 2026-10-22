"""Material issue scenarios against a real database (2026-10-06).

Each test builds a small world — a main warehouse with two floors, an MDP and a LIP,
one item in two batches, an approved indent with its allocation — and walks a
material issue through the paths that have been getting it wrong:

- a split across floors numbers its children off the parent (WHI-…-001, -002);
- the same indent line can never be issued twice, through a child, the parent, or a
  fresh issue raised while the parent was split;
- an indent served from several points (warehouse, MDP, LIP) issues each point's
  share and no more, and a cancelled issue gives the indent back to that point;
- a coded item allocated out of a batch with no codes may move to the oldest batch
  that has them, and the hold moves with it;
- a direct issue reserves its stock on save and gives it back on cancel.

Approval is the workflow engine's and is not what is being tested, so an issue is
moved to APPROVED directly where a test needs to post it.
"""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from app.core.exceptions import ValidationError
from app.modules.indents.models import Indent, IndentItem
from app.modules.inventory import allocation
from app.modules.inventory.models import Reservation, Stock
from app.modules.inventory.service import move_stock
from app.modules.warehouse import models as m
from app.modules.warehouse import schemas as s
from app.modules.warehouse import service
from app.modules.warehouse.enums import IssueStatus
from app.platform.hcm.models import HcmEmployee
from app.platform.settings import codeformat
from app.shared.enums import RefType, ReservationStatus
from app.shared.models.base import utcnow
from app.shared.models.master import Item
from app.shared.models.warehouse import Bin, Warehouse

D = Decimal
TODAY = date.today()


class World:
    """Handles on everything a scenario touches."""


async def _point(db, code, kind, floors=()):
    wh = Warehouse(code=code, name=f"{kind} {code}", warehouse_type=kind,
                   is_bin_managed=True, is_active=True)
    db.add(wh)
    await db.flush()
    bins = {}
    for floor in floors:
        root = Bin(warehouse_id=wh.id, code=floor, name=f"Floor {floor}",
                   bin_type="FLOOR", is_active=True)
        db.add(root)
        await db.flush()
        bay = Bin(warehouse_id=wh.id, code=f"{floor}-B1", name=f"{floor} bay 1",
                  bin_type="BIN", parent_id=root.id, is_active=True)
        db.add(bay)
        await db.flush()
        bins[floor] = bay
    return wh, bins


async def _stock(db, user, item, wh, qty, bin_id=0, batch_id=0):
    await move_stock(db, item_id=item.id, qty=qty, direction="IN", ref_type="ADJUSTMENT",
                     ref_id=0, ref_no="OPENING", user=user, warehouse_id=wh.id,
                     bin_id=bin_id, batch_id=batch_id)


async def _world(db, *, coded=False) -> World:
    w = World()
    w.user = HcmEmployee(id=1, full_name="Store Keeper", emp_code="sk", is_active=True,
                         synced_at=utcnow())
    db.add(w.user)
    w.item = Item(code="GLV-0001", name="Gloves", uom_code="NOS", is_active=True,
                  is_batch_tracked=True, is_serial_tracked=coded)
    db.add(w.item)
    await db.flush()
    # The code-tracking toggle, stated: unconfigured, every countable item is coded.
    await codeformat.set_item_tracked(db, w.item.code, coded)
    w.main, w.floors = await _point(db, "WH1", "MAIN", floors=("F1", "F2"))
    w.mdp, w.mdp_bins = await _point(db, "MDP1", "MDP", floors=("M1",))
    w.lip, w.lip_bins = await _point(db, "LIP1", "LIP", floors=("L1",))
    w.old = m.Batch(batch_no="B-OLD", item_id=w.item.id, expiry_date=TODAY + timedelta(days=60))
    w.new = m.Batch(batch_no="B-NEW", item_id=w.item.id, expiry_date=TODAY + timedelta(days=200))
    db.add_all([w.old, w.new])
    await db.flush()
    w.indent = Indent(indent_no="IND-0001", indent_date=TODAY, status="APPROVED",
                      requested_by_id=w.user.id, requested_by_name=w.user.full_name)
    db.add(w.indent)
    await db.flush()
    w.line = IndentItem(indent_id=w.indent.id, line_no=1, item_id=w.item.id,
                        item_code=w.item.code, item_name=w.item.name, uom_code="NOS",
                        quantity=D(10), approved_quantity=D(10))
    db.add(w.line)
    await db.flush()
    return w


async def _allocate(db, w, wh, qty):
    got, short = await allocation.reserve(
        db, w.item.id, qty, RefType.RESERVATION.value, w.indent.id, w.indent.indent_no,
        w.user, warehouse_ids=[wh.id], ref_line_id=w.line.id)
    assert got == D(qty) and short == 0
    await db.commit()


def _write(w, wh, picks, *, indent=True):
    """picks: [(bin, batch, qty)]"""
    return s.IssueWrite(
        issue_type="INDENT_BASED" if indent else "DIRECT",
        issue_date=TODAY, warehouse_id=wh.id,
        indent_id=w.indent.id if indent else None,
        # A direct issue must say where it goes and who takes it (2026-10-21).
        destination_warehouse_id=None if indent else w.mdp.id,
        issued_to_id=None if indent else w.user.id,
        items=[s.IssueItemWrite(
            indent_item_id=w.line.id if indent else None, item_id=w.item.id,
            bin_id=bay.id if bay else None, batch_id=batch.id if batch else None,
            requested_qty=D(qty), issued_qty=D(qty)) for bay, batch, qty in picks])


async def _approve(db, issue_id):
    issue = await db.get(m.MaterialIssue, issue_id)
    issue.status = IssueStatus.APPROVED.value
    await db.commit()


async def _held(db, ref_type, ref_id) -> Decimal:
    return D(str(await db.scalar(
        select(func.coalesce(func.sum(Reservation.quantity), 0)).where(
            Reservation.ref_type == ref_type, Reservation.ref_id == ref_id,
            Reservation.status == ReservationStatus.ACTIVE.value)) or 0))


async def _free(db, item, wh) -> Decimal:
    return D(str(await db.scalar(
        select(func.coalesce(func.sum(Stock.available_qty), 0)).where(
            Stock.item_id == item.id, Stock.warehouse_id == wh.id)) or 0))


# --------------------------------------------------------------------------------- #
#  1. Split across floors: children numbered off the parent, never issued twice
# --------------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_a_floor_split_numbers_children_off_the_parent(db):
    w = await _world(db)
    await _stock(db, w.user, w.item, w.main, 6, w.floors["F1"].id, w.old.id)
    await _stock(db, w.user, w.item, w.main, 4, w.floors["F2"].id, w.old.id)
    await _allocate(db, w, w.main, 10)

    parent = await service.create_issue(db, _write(w, w.main, [(None, None, 10)]), w.user)
    await _approve(db, parent.id)
    result = await service.split_issue_by_floor(db, parent.id, w.user)

    numbers = sorted(child["issue_no"] for child in result["children"])
    assert numbers == [f"{parent.issue_no}-001", f"{parent.issue_no}-002"]
    assert sorted(D(c["total_qty"]) for c in result["children"]) == [D(4), D(6)]
    assert (await db.get(m.MaterialIssue, parent.id)).status == IssueStatus.SPLIT.value


@pytest.mark.asyncio
async def test_a_resplit_never_reuses_a_printed_child_number(db):
    w = await _world(db)
    await _stock(db, w.user, w.item, w.main, 10, w.floors["F1"].id, w.old.id)
    await _allocate(db, w, w.main, 10)
    parent = await service.create_issue(db, _write(w, w.main, [(None, None, 10)]), w.user)
    await _approve(db, parent.id)
    first = await service.split_issue_by_floor(db, parent.id, w.user)
    await service.cancel_issue(db, first["children"][0]["id"], "re-plan", w.user)
    assert (await db.get(m.MaterialIssue, parent.id)).status == IssueStatus.APPROVED.value

    again = await service.split_issue_by_floor(db, parent.id, w.user)
    assert again["children"][0]["issue_no"] == f"{parent.issue_no}-002"


@pytest.mark.asyncio
async def test_a_split_parent_cannot_be_posted_beside_its_children(db):
    w = await _world(db)
    await _stock(db, w.user, w.item, w.main, 10, w.floors["F1"].id, w.old.id)
    await _allocate(db, w, w.main, 10)
    parent = await service.create_issue(db, _write(w, w.main, [(None, None, 10)]), w.user)
    await _approve(db, parent.id)
    result = await service.split_issue_by_floor(db, parent.id, w.user)

    with pytest.raises(ValidationError):
        await service.post_issue(db, parent.id, w.user)

    child_id = result["children"][0]["id"]
    await _approve(db, child_id)
    posted = await service.post_issue(db, child_id, w.user)
    assert posted.status == IssueStatus.ISSUED.value
    assert (await db.get(m.MaterialIssue, parent.id)).status == IssueStatus.CLOSED.value
    # Fully served: a fresh issue for the same indent line is refused.
    with pytest.raises(ValidationError, match="already covered"):
        await service.create_issue(db, _write(w, w.main, [(w.floors["F1"], w.old, 1)]),
                                   w.user)


@pytest.mark.asyncio
async def test_a_parent_back_from_its_split_cannot_double_issue_a_newer_issue(db):
    """The loophole: parent split, a fresh issue covers the shortfall, then every
    child is cancelled and the parent returns to APPROVED holding its full quantity."""
    w = await _world(db)
    await _stock(db, w.user, w.item, w.main, 6, w.floors["F1"].id, w.old.id)
    await _stock(db, w.user, w.item, w.main, 4, 0, w.old.id)     # unplaced: no floor
    await _allocate(db, w, w.main, 10)
    parent = await service.create_issue(db, _write(w, w.main, [(None, None, 10)]), w.user)
    await _approve(db, parent.id)
    result = await service.split_issue_by_floor(db, parent.id, w.user)
    assert result["unfulfilled"] and D(result["unfulfilled"][0]["qty"]) == D(4)

    extra = await service.create_issue(db, _write(w, w.main, [(None, w.old, 4)]), w.user)
    await service.cancel_issue(db, result["children"][0]["id"], "wrong floor", w.user)
    # Reviving the parent at 10 beside the 4 already raised would claim the line
    # twice, so it closes instead of returning to APPROVED.
    assert await db.scalar(select(m.MaterialIssue.status).where(
        m.MaterialIssue.id == parent.id)) == IssueStatus.CLOSED.value

    await _approve(db, extra.id)
    await service.post_issue(db, extra.id, w.user)
    with pytest.raises(ValidationError):
        await service.post_issue(db, parent.id, w.user)
    # The 6 the cancelled child carried is free for a fresh issue — and no more.
    with pytest.raises(ValidationError, match="outstanding"):
        await service.create_issue(db, _write(w, w.main, [(None, w.old, 7)]), w.user)
    # The extra issue named no bay, so it drew from F1 first: 2 left there, 4 unplaced.
    fresh = await service.create_issue(db, _write(w, w.main, [(None, w.old, 6)]), w.user)
    assert fresh.total_qty == D(6)


@pytest.mark.asyncio
async def test_a_second_draft_for_the_same_reserved_units_is_refused(db):
    w = await _world(db)
    await _stock(db, w.user, w.item, w.main, 10, w.floors["F1"].id, w.old.id)
    await _allocate(db, w, w.main, 4)
    first = await service.create_issue(
        db, _write(w, w.main, [(w.floors["F1"], w.old, 4)]), w.user)
    with pytest.raises(ValidationError, match="already claimed"):
        await service.create_issue(
            db, _write(w, w.main, [(w.floors["F1"], w.old, 4)]), w.user)
    with pytest.raises(ValidationError, match="nothing left to issue"):
        await service.indent_issue_source(db, w.indent.id, w.main.id)
    await service.cancel_issue(db, first.id, "redo", w.user)
    source = await service.indent_issue_source(db, w.indent.id, w.main.id)
    assert sum(D(str(i["issued_qty"])) for i in source["items"]) == D(4)


# --------------------------------------------------------------------------------- #
#  2. One indent served from the warehouse, an MDP and a LIP
# --------------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_each_point_issues_its_own_share_and_a_cancel_gives_it_back(db):
    w = await _world(db)
    await _stock(db, w.user, w.item, w.main, 4, w.floors["F1"].id, w.old.id)
    await _stock(db, w.user, w.item, w.mdp, 3, w.mdp_bins["M1"].id, w.old.id)
    await _stock(db, w.user, w.item, w.lip, 3, w.lip_bins["L1"].id, w.old.id)
    await _allocate(db, w, w.main, 4)
    await _allocate(db, w, w.mdp, 3)
    await _allocate(db, w, w.lip, 3)

    # Each point's prefill is its own allocation, never the whole indent.
    for point, share in ((w.main, 4), (w.mdp, 3), (w.lip, 3)):
        source = await service.indent_issue_source(db, w.indent.id, point.id)
        assert sum(D(str(i["issued_qty"])) for i in source["items"]) == D(share)

    # A point cannot issue more than is reserved there.
    over = await service.create_issue(
        db, _write(w, w.lip, [(w.lip_bins["L1"], w.old, 3)]), w.user)
    assert over.total_qty == D(3)
    with pytest.raises(ValidationError):
        await service.create_issue(
            db, _write(w, w.mdp, [(w.mdp_bins["M1"], w.old, 5)]), w.user)

    # The LIP issue is cancelled: the indent comes back to the LIP's dropdown with the
    # same 3 still reserved there.
    options = {o["id"] for o in await service.indent_options(db, None, w.lip.id)}
    assert w.indent.id not in options
    await service.cancel_issue(db, over.id, "wrong vehicle", w.user)
    options = {o["id"] for o in await service.indent_options(db, None, w.lip.id)}
    assert w.indent.id in options
    again = await service.indent_issue_source(db, w.indent.id, w.lip.id)
    assert sum(D(str(i["issued_qty"])) for i in again["items"]) == D(3)


@pytest.mark.asyncio
async def test_an_item_reserved_in_two_batches_prefills_no_more_than_is_owed(db):
    w = await _world(db)
    await _stock(db, w.user, w.item, w.main, 6, w.floors["F1"].id, w.old.id)
    await _stock(db, w.user, w.item, w.main, 6, w.floors["F2"].id, w.new.id)
    await _allocate(db, w, w.main, 10)          # 6 of the old + 4 of the new
    first = await service.create_issue(
        db, _write(w, w.main, [(w.floors["F1"], w.old, 4)]), w.user)
    assert first.total_qty == D(4)
    source = await service.indent_issue_source(db, w.indent.id, w.main.id)
    assert sum(D(str(i["issued_qty"])) for i in source["items"]) == D(6)


# --------------------------------------------------------------------------------- #
#  3. A coded item allocated from a batch carrying no codes
# --------------------------------------------------------------------------------- #
async def _codes(db, w, wh, bay, batch, n):
    for k in range(n):
        db.add(m.SerialNumber(item_id=w.item.id, serial_number=f"SN-{batch.batch_no}-{k}",
                              batch_id=batch.id, warehouse_id=wh.id, bin_id=bay.id,
                              status="AVAILABLE", is_active=True))
    await db.commit()


@pytest.mark.asyncio
async def test_a_coded_item_may_move_off_an_uncoded_allocated_batch(db):
    w = await _world(db, coded=True)
    await _stock(db, w.user, w.item, w.main, 5, w.floors["F1"].id, w.old.id)   # no codes
    await _stock(db, w.user, w.item, w.main, 5, w.floors["F2"].id, w.new.id)
    await _codes(db, w, w.main, w.floors["F2"], w.new, 5)
    await _allocate(db, w, w.main, 5)            # FEFO: the old, uncoded batch

    issue = await service.create_issue(
        db, _write(w, w.main, [(w.floors["F2"], w.new, 5)]), w.user)

    rows = (await db.execute(select(Reservation.batch_id, func.sum(Reservation.quantity))
                             .where(Reservation.ref_id == w.indent.id,
                                    Reservation.ref_type == RefType.RESERVATION.value,
                                    Reservation.status == ReservationStatus.ACTIVE.value)
                             .group_by(Reservation.batch_id))).all()
    assert {b: D(str(q)) for b, q in rows} == {w.new.id: D(5)}
    old_row = (await db.execute(select(Stock).where(Stock.batch_id == w.old.id))).scalar_one()
    assert old_row.available_qty == D(5) and old_row.reserved_qty == D(0)
    assert issue.items[0].batch_id == w.new.id


@pytest.mark.asyncio
async def test_the_coded_exception_still_takes_the_oldest_coded_batch(db):
    w = await _world(db, coded=True)
    mid = m.Batch(batch_no="B-MID", item_id=w.item.id, expiry_date=TODAY + timedelta(days=120))
    db.add(mid)
    await db.flush()
    await _stock(db, w.user, w.item, w.main, 5, w.floors["F1"].id, w.old.id)   # no codes
    await _stock(db, w.user, w.item, w.main, 5, w.floors["F1"].id, mid.id)
    await _stock(db, w.user, w.item, w.main, 5, w.floors["F2"].id, w.new.id)
    await _codes(db, w, w.main, w.floors["F1"], mid, 5)
    await _codes(db, w, w.main, w.floors["F2"], w.new, 5)
    await _allocate(db, w, w.main, 5)

    with pytest.raises(ValidationError, match="B-MID"):
        await service.create_issue(
            db, _write(w, w.main, [(w.floors["F2"], w.new, 5)]), w.user)


@pytest.mark.asyncio
async def test_an_uncoded_item_is_still_held_to_same_day_fefo(db):
    w = await _world(db)
    await _stock(db, w.user, w.item, w.main, 5, w.floors["F1"].id, w.old.id)
    await _stock(db, w.user, w.item, w.main, 5, w.floors["F2"].id, w.new.id)
    await _allocate(db, w, w.main, 5)
    with pytest.raises(ValidationError, match="oldest first"):
        await service.create_issue(
            db, _write(w, w.main, [(w.floors["F2"], w.new, 5)]), w.user)


# --------------------------------------------------------------------------------- #
#  4. A direct issue reserves its stock
# --------------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_a_direct_issue_reserves_on_save_and_releases_on_cancel(db):
    w = await _world(db)
    await _stock(db, w.user, w.item, w.main, 10, w.floors["F1"].id, w.old.id)

    issue = await service.create_issue(
        db, _write(w, w.main, [(w.floors["F1"], w.old, 7)], indent=False), w.user)
    assert await _held(db, RefType.ISSUE_HOLD.value, issue.id) == D(7)
    assert await _free(db, w.item, w.main) == D(3)

    # A second direct issue cannot promise the same units.
    with pytest.raises(ValidationError):
        await service.create_issue(
            db, _write(w, w.main, [(w.floors["F1"], w.old, 5)], indent=False), w.user)

    # Editing the same picks keeps the hold (it is its own), changing them re-takes it.
    await service.update_issue(
        db, issue.id, _write(w, w.main, [(w.floors["F1"], w.old, 9)], indent=False), w.user)
    assert await _held(db, RefType.ISSUE_HOLD.value, issue.id) == D(9)

    await service.cancel_issue(db, issue.id, "not needed", w.user)
    assert await _held(db, RefType.ISSUE_HOLD.value, issue.id) == D(0)
    assert await _free(db, w.item, w.main) == D(10)


@pytest.mark.asyncio
async def test_a_direct_issue_posts_off_its_own_hold(db):
    w = await _world(db)
    await _stock(db, w.user, w.item, w.main, 10, w.floors["F1"].id, w.old.id)
    issue = await service.create_issue(
        db, _write(w, w.main, [(w.floors["F1"], w.old, 6)], indent=False), w.user)
    await _approve(db, issue.id)
    await service.post_issue(db, issue.id, w.user)
    row = (await db.execute(select(Stock).where(Stock.item_id == w.item.id))).scalar_one()
    assert (row.total_qty, row.available_qty, row.reserved_qty) == (D(4), D(4), D(0))
    assert await _held(db, RefType.ISSUE_HOLD.value, issue.id) == D(0)


@pytest.mark.asyncio
async def test_a_direct_split_hands_each_floor_its_own_hold(db):
    w = await _world(db)
    await _stock(db, w.user, w.item, w.main, 6, w.floors["F1"].id, w.old.id)
    await _stock(db, w.user, w.item, w.main, 4, w.floors["F2"].id, w.old.id)
    issue = await service.create_issue(
        db, _write(w, w.main, [(None, w.old, 10)], indent=False), w.user)
    assert await _held(db, RefType.ISSUE_HOLD.value, issue.id) == D(10)
    await _approve(db, issue.id)
    result = await service.split_issue_by_floor(db, issue.id, w.user)
    assert await _held(db, RefType.ISSUE_HOLD.value, issue.id) == D(0)
    held = sorted([await _held(db, RefType.ISSUE_HOLD.value, c["id"])
                   for c in result["children"]])
    assert held == [D(4), D(6)]
    assert await _free(db, w.item, w.main) == D(0)


# --------------------------------------------------------------------------------- #
#  5. Across the chain: own stock is capped network-wide, forwarding is not
# --------------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_a_served_indent_cannot_be_served_again_from_another_tier(db):
    w = await _world(db)
    await _stock(db, w.user, w.item, w.main, 14, w.floors["F1"].id, w.old.id)
    await _stock(db, w.user, w.item, w.lip, 6, w.lip_bins["L1"].id, w.old.id)
    await _allocate(db, w, w.main, 4)
    await _allocate(db, w, w.lip, 6)
    for point, bay, qty in ((w.main, w.floors["F1"], 4), (w.lip, w.lip_bins["L1"], 6)):
        issue = await service.create_issue(db, _write(w, point, [(bay, w.old, qty)]), w.user)
        await _approve(db, issue.id)
        await service.post_issue(db, issue.id, w.user)
    # Allocation spent, 10 of 10 given. The main warehouse still has 10 free — and the
    # per-tier cap alone would let it give 6 more to the same indent.
    with pytest.raises(ValidationError, match="already been served 10"):
        await service.create_issue(
            db, _write(w, w.main, [(w.floors["F1"], w.old, 6)]), w.user)


@pytest.mark.asyncio
async def test_a_forwarded_leg_is_not_counted_twice(db):
    w = await _world(db)
    await _stock(db, w.user, w.item, w.main, 10, w.floors["F1"].id, w.old.id)
    await _allocate(db, w, w.main, 10)
    issue = await service.create_issue(
        db, _write(w, w.main, [(w.floors["F1"], w.old, 10)]), w.user)
    await _approve(db, issue.id)
    await service.post_issue(db, issue.id, w.user)
    # The 10 arrive at the MDP on a dispatch receipt raised for the indent.
    receipt = m.Receipt(grn_no="RCV-1", receipt_type="DISPATCH", grn_date=TODAY,
                        warehouse_id=w.mdp.id, status="RECEIVED", items=[])
    receipt.items.append(m.ReceiptItem(line_no=1, indent_id=w.indent.id,
                                       item_id=w.item.id, received_qty=D(10),
                                       accepted_qty=D(10)))
    db.add(receipt)
    await db.commit()
    await _stock(db, w.user, w.item, w.mdp, 10, w.mdp_bins["M1"].id, w.old.id)
    forward = await service.create_issue(
        db, _write(w, w.mdp, [(w.mdp_bins["M1"], w.old, 10)]), w.user)
    assert forward.total_qty == D(10)


# --------------------------------------------------------------------------------- #
#  The FEFO exception, read without a database
# --------------------------------------------------------------------------------- #
def test_the_coded_swap_exception_needs_every_condition():
    ok = dict(codes_required=True, allocated_has_codes=False, wanted_has_codes=True,
              earlier_coded=[])
    assert service._coded_swap_verdict(**ok) is True
    assert service._coded_swap_verdict(**{**ok, "codes_required": False}) is None
    assert service._coded_swap_verdict(**{**ok, "allocated_has_codes": True}) is None
    assert service._coded_swap_verdict(**{**ok, "wanted_has_codes": False}) is None
    assert service._coded_swap_verdict(**{**ok, "earlier_coded": ["older"]}) is None


def test_an_undated_batch_is_never_older_than_a_dated_one():
    assert service._expires_before(TODAY, TODAY + timedelta(days=1))
    assert service._expires_before(TODAY, None)
    assert not service._expires_before(None, TODAY)
    assert not service._expires_before(None, None)


@pytest.mark.asyncio
async def test_an_mdp_forwards_while_the_lip_still_holds_its_own_share(db):
    """WH 4 -> MDP -> requester, and the LIP's 6 still reserved. The MDP's forward
    used to be refused at posting: "held anywhere" was read as "must be held here"."""
    w = await _world(db)
    await _stock(db, w.user, w.item, w.main, 4, w.floors["F1"].id, w.old.id)
    await _stock(db, w.user, w.item, w.lip, 6, w.lip_bins["L1"].id, w.old.id)
    await _allocate(db, w, w.main, 4)
    await _allocate(db, w, w.lip, 6)
    leg = await service.create_issue(db, _write(w, w.main, [(w.floors["F1"], w.old, 4)]),
                                     w.user)
    await _approve(db, leg.id)
    await service.post_issue(db, leg.id, w.user)
    receipt = m.Receipt(grn_no="RCV-2", receipt_type="DISPATCH", grn_date=TODAY,
                        warehouse_id=w.mdp.id, status="RECEIVED", items=[])
    receipt.items.append(m.ReceiptItem(line_no=1, indent_id=w.indent.id,
                                       item_id=w.item.id, received_qty=D(4),
                                       accepted_qty=D(4)))
    db.add(receipt)
    await db.commit()
    await _stock(db, w.user, w.item, w.mdp, 4, w.mdp_bins["M1"].id, w.old.id)

    forward = await service.create_issue(
        db, _write(w, w.mdp, [(w.mdp_bins["M1"], w.old, 4)]), w.user)
    await _approve(db, forward.id)
    posted = await service.post_issue(db, forward.id, w.user)
    assert posted.status == IssueStatus.ISSUED.value
    # The LIP's own share is untouched and still issuable.
    assert await _held(db, RefType.RESERVATION.value, w.indent.id) == D(6)
