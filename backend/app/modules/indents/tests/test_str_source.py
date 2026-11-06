"""A Stock Transfer Request names its SOURCE, and the approver's scope decides the act
(2026-11-04).

What these pin:

- the source list is the SAME RANK on the SAME TIER, network-wide, less the raiser's
  own point — a storekeeper at an LIP is never offered an MDP his rank also staffs,
  and an OE is offered the other OEs' MDPs even though OEs sit in a non-stocking
  section there;
- a source is required, and must be a live point;
- the last-level test reads the frozen ladder;
- allocating from a point refuses one outside the approver's scope, refuses a move
  without a reason, refuses a point with nothing free, and otherwise records the
  move and allocates only what the point can give.
"""
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.core.exceptions import ValidationError
from app.modules.approvals import fulfilment
from app.modules.indents import service
from app.modules.indents.enums import IndentType
from app.modules.indents.models import Indent, IndentItem, StrSourceChange
from app.modules.inventory import locations
from app.modules.inventory.models import Allocation, AllocationItem, PositionLocation
from app.platform.hcm.models import HcmPosition
from app.shared.enums import AllocationStatus, IndentStatus
from app.shared.models.base import utcnow
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse

pytestmark = pytest.mark.asyncio

KEEPER, OE = 301, 302   # HCM rank ids


async def _network(db):
    """Two MDPs, three LIPs. Store keepers (one rank) at every point, OEs (another
    rank) at both MDPs in a non-stocking section, as the live mirror has them."""
    pts = {code: Warehouse(code=code, name=name, warehouse_type=kind) for code, name, kind in (
        ("MDP-A", "MDP Alpha", "MDP"), ("MDP-B", "MDP Beta", "MDP"),
        ("LIP-1", "LIP One", "LIP"), ("LIP-2", "LIP Two", "LIP"), ("LIP-3", "LIP Three", "LIP"))}
    db.add_all(pts.values())
    posts = {  # position: (rank, point, section)
        8101: (KEEPER, "LIP-1", "L I P"), 8102: (KEEPER, "LIP-2", "L I P"),
        8103: (KEEPER, "LIP-3", "L I P"),
        8201: (KEEPER, "MDP-A", "M.D.P"), 8202: (KEEPER, "MDP-B", "M.D.P"),
        8301: (OE, "MDP-A", "104 sec"), 8302: (OE, "MDP-B", "104 sec"),
    }
    for pid, (rank, _code, _sec) in posts.items():
        db.add(HcmPosition(id=pid, name=f"Post {pid}", role_id=rank, is_active=True,
                           synced_at=utcnow()))
    await db.flush()
    for pid, (_rank, code, section) in posts.items():
        db.add(PositionLocation(position_id=pid, warehouse_id=pts[code].id,
                                section_name=section))
    await db.flush()
    return pts


async def _sources(db, user, position_id) -> set[str]:
    user.active_position_id = position_id
    db.info.clear()
    return {row["warehouse_code"] for row in await locations.same_rank_points(db, user)}


async def test_sources_are_the_same_rank_on_the_same_tier(db, make_user):
    await _network(db)
    await db.commit()
    raiser = await make_user(employee_id=7101, username="str_raiser", permissions=[])

    # An LIP keeper: the other LIPs — never the MDPs his rank also staffs.
    assert await _sources(db, raiser, 8101) == {"LIP-2", "LIP-3"}
    # An MDP keeper: the other MDP.
    assert await _sources(db, raiser, 8201) == {"MDP-B"}
    # An OE, linked under a non-stocking section: still the other OE's MDP.
    assert await _sources(db, raiser, 8301) == {"MDP-B"}


async def test_a_source_is_required_and_must_be_live(db):
    pts = await _network(db)
    pts["LIP-3"].is_active = False
    await db.commit()

    with pytest.raises(ValidationError, match="Choose the source point"):
        await service._resolve_str_source(db, None)
    with pytest.raises(ValidationError, match="no longer exists"):
        await service._resolve_str_source(db, pts["LIP-3"].id)
    assert (await service._resolve_str_source(db, pts["LIP-2"].id)).code == "LIP-2"


async def test_last_level_reads_the_frozen_ladder():
    chain = [{"sequence": 1}, {"sequence": 2}, {"sequence": 3}]
    assert fulfilment._is_last_level(SimpleNamespace(resolved_chain=chain, current_sequence=2)) is False
    assert fulfilment._is_last_level(SimpleNamespace(resolved_chain=chain, current_sequence=3)) is True
    assert fulfilment._is_last_level(SimpleNamespace(resolved_chain=None, current_sequence=1)) is None


async def test_the_ladder_is_drawn_with_who_has_signed_and_who_comes_next():
    chain = [{"sequence": 1, "role_name": "OE"}, {"sequence": 2, "role_name": "DM"},
             {"sequence": 3, "role_name": "RM"}]
    levels = fulfilment._ladder_levels(SimpleNamespace(resolved_chain=chain, current_sequence=2))
    assert [(lv["role_name"], lv["state"]) for lv in levels] == [
        ("OE", "DONE"), ("DM", "CURRENT"), ("RM", "NEXT")]
    assert fulfilment._ladder_levels(SimpleNamespace(resolved_chain=None, current_sequence=1)) == []


def _approving(indent, line, *, last, scope, monkeypatch, committed=Decimal("0"), allocated=Decimal("0")):
    """An approver at a rung, with an STR whose line holds what was already served."""
    line.allocated_quantity = allocated
    indent.items = [line]

    async def committed_by_line(_db, _indent_id):
        return {line.id: committed} if committed else {}

    async def scope_of(_db, _user):
        return scope

    monkeypatch.setattr(fulfilment, "committed_by_line", committed_by_line)
    monkeypatch.setattr(fulfilment.locations, "location_ids_for_user", scope_of)
    return SimpleNamespace(resolved_chain=[{"sequence": 1}, {"sequence": 2}],
                           current_sequence=2 if last else 1)


async def test_no_next_level_refuses_a_source_outside_scope_with_something_owed(monkeypatch):
    line = SimpleNamespace(id=1, item_name="Gloves", item_code="G", allocated_quantity=0)
    indent = SimpleNamespace(id=9, indent_type=IndentType.STR.value, source_warehouse_id=20, items=[])
    ask = {1: Decimal("10")}

    # Top of the ladder, source not his: refused, naming who can fix it.
    instance = _approving(indent, line, last=True, scope={30}, monkeypatch=monkeypatch)
    with pytest.raises(ValidationError, match="Approvals Config"):
        await fulfilment.assert_str_approvable(None, indent, instance, ask, None)

    # A level above exists: forwarding is fine.
    instance = _approving(indent, line, last=False, scope={30}, monkeypatch=monkeypatch)
    await fulfilment.assert_str_approvable(None, indent, instance, ask, None)

    # Top of the ladder, but the source is his: the Fulfilment Desk can serve it.
    instance = _approving(indent, line, last=True, scope={20}, monkeypatch=monkeypatch)
    await fulfilment.assert_str_approvable(None, indent, instance, ask, None)

    # Top of the ladder, source not his, everything already allocated: nothing is stuck.
    instance = _approving(indent, line, last=True, scope={30}, monkeypatch=monkeypatch,
                          allocated=Decimal("10"))
    await fulfilment.assert_str_approvable(None, indent, instance, ask, None)

    # Every line at zero is a rejection, which is always allowed.
    instance = _approving(indent, line, last=True, scope={30}, monkeypatch=monkeypatch)
    await fulfilment.assert_str_approvable(None, indent, instance, {1: Decimal("0")}, None)


async def test_an_approver_cannot_sign_below_what_is_already_allocated(monkeypatch):
    line = SimpleNamespace(id=1, item_name="Gloves", item_code="G", allocated_quantity=0)
    indent = SimpleNamespace(id=9, indent_type=IndentType.STR.value, source_warehouse_id=20, items=[])

    # 6 signed by the level below, 2 more promised and unsigned: 8 cannot be undercut.
    instance = _approving(indent, line, last=False, scope={20}, monkeypatch=monkeypatch,
                          allocated=Decimal("6"), committed=Decimal("2"))
    with pytest.raises(ValidationError, match="8 is already allocated"):
        await fulfilment.assert_str_approvable(None, indent, instance, {1: Decimal("7")}, None)
    await fulfilment.assert_str_approvable(None, indent, instance, {1: Decimal("8")}, None)


async def test_a_regular_indent_is_not_held_to_the_str_rules(monkeypatch):
    line = SimpleNamespace(id=1, item_name="Gloves", item_code="G", allocated_quantity=0)
    indent = SimpleNamespace(id=9, indent_type=IndentType.REGULAR.value, source_warehouse_id=None, items=[])
    instance = _approving(indent, line, last=True, scope=set(), monkeypatch=monkeypatch,
                          allocated=Decimal("6"))
    await fulfilment.assert_str_approvable(None, indent, instance, {1: Decimal("1")}, None)


async def test_a_signed_allocation_leaves_the_ending_to_the_approvers_press(monkeypatch):
    settled = []

    async def settle(*args, **kwargs):
        settled.append(args)

    monkeypatch.setattr(service.engine, "settle", settle)
    indent = SimpleNamespace(id=9, indent_type=IndentType.STR.value,
                             status=IndentStatus.ALLOCATED.value, items=[])
    await service._settle_indent_approval(None, indent, None, was_in_approval=True)
    assert indent.status == IndentStatus.PENDING_APPROVAL.value and not settled


async def test_goods_wait_until_the_last_level_has_signed(monkeypatch):
    from app.modules.warehouse import service as warehouse_service

    drafted = []

    async def drafts(_db, alloc, _user):
        drafted.append(alloc)
        return [alloc]

    class Db:
        def __init__(self, indent):
            self.indent = indent

        async def get(self, _model, _pk):
            return self.indent

    monkeypatch.setattr(warehouse_service, "create_fulfilment_drafts_for_allocation", drafts)
    alloc = SimpleNamespace(indent_id=9)

    # Still climbing: the allocation is signed, and nothing reaches the warehouse.
    climbing = SimpleNamespace(id=9, indent_type=IndentType.STR.value,
                               status=IndentStatus.PENDING_APPROVAL.value)
    assert await service._fulfilment_drafts(Db(climbing), alloc, None) == [] and not drafted

    # Any other indent still hands over at the signature, as it always did.
    regular = SimpleNamespace(id=9, indent_type=IndentType.REGULAR.value,
                              status=IndentStatus.PENDING_APPROVAL.value)
    assert await service._fulfilment_drafts(Db(regular), alloc, None) == [alloc]


async def test_a_refused_str_gives_back_what_was_allocated(db, make_user):
    pts = await _network(db)
    indent, line = await _str(db, pts)
    user = await make_user(employee_id=7103, username="str_refuser", permissions=[])
    line.allocated_quantity = Decimal("6")
    live = Allocation(allocation_no="ALL-T-1", indent_id=indent.id, indent_no=indent.indent_no,
                      status=AllocationStatus.APPROVED.value)
    done = Allocation(allocation_no="ALL-T-2", indent_id=indent.id, indent_no=indent.indent_no,
                      status=AllocationStatus.REJECTED.value)
    db.add_all([live, done])
    await db.commit()
    await db.refresh(indent, attribute_names=["items"])

    await service._withdraw_str_allocations(db, indent, user, "refused")

    assert live.status == AllocationStatus.CANCELLED.value
    assert done.status == AllocationStatus.REJECTED.value   # a closed decision stands
    assert line.allocated_quantity == Decimal("0")


async def test_serving_in_full_ends_the_ladder_and_a_remainder_climbs(db, make_user, monkeypatch):
    from app.modules.approvals import service as approvals_service

    pts = await _network(db)
    indent, line = await _str(db, pts)
    user = await make_user(employee_id=7104, username="str_oe", permissions=[])
    line.allocated_quantity = Decimal("10")
    await db.commit()
    await db.refresh(indent, attribute_names=["items"])
    seen = {}

    async def act(_db, _indent_id, _action, _comments, _user, final=False):
        seen["final"] = final
        return indent

    monkeypatch.setattr(approvals_service.indent_service, "act_on_indent", act)
    monkeypatch.setattr(approvals_service, "_approval_out", lambda *_args: "ok")
    instance = SimpleNamespace(current_stage_name="OE", current_sequence=1,
                               resolved_chain=[{"sequence": 1}, {"sequence": 2}])
    quantities = [SimpleNamespace(line_id=line.id, approved_quantity=10, excluded=False)]

    await approvals_service.approve_indent(db, indent.id, quantities, "", user,
                                           task=(indent, instance, True))
    assert seen["final"] is True

    # 6 of 10 served: the 4 still owed go to the next level.
    line.allocated_quantity = Decimal("6")
    await db.commit()
    await db.refresh(indent, attribute_names=["items"])
    await approvals_service.approve_indent(db, indent.id, quantities, "", user,
                                           task=(indent, instance, True))
    assert seen["final"] is False


async def test_the_last_level_hands_every_signed_allocation_to_the_warehouse(db, make_user, monkeypatch):
    from app.modules.warehouse import service as warehouse_service

    pts = await _network(db)
    indent, line = await _str(db, pts)
    user = await make_user(employee_id=7105, username="str_top", permissions=[])
    for number, status, qty in (("ALL-T-3", AllocationStatus.APPROVED, "6"),
                                ("ALL-T-4", AllocationStatus.APPROVED, "4"),
                                ("ALL-T-5", AllocationStatus.CANCELLED, "9")):
        alloc = Allocation(allocation_no=number, indent_id=indent.id, indent_no=indent.indent_no,
                           status=status.value)
        db.add(alloc)
        await db.flush()
        db.add(AllocationItem(allocation_id=alloc.id, indent_item_id=line.id, item_id=line.item_id,
                              warehouse_id=pts["LIP-2"].id, requested_qty=Decimal(qty),
                              quantity=Decimal(qty)))
    line.allocated_quantity = Decimal("10")
    indent.status = IndentStatus.AWAITING_ALLOCATION.value
    await db.commit()
    await db.refresh(indent, attribute_names=["items"])
    handed = []

    async def drafts(_db, alloc, _user):
        handed.extend(item.quantity for item in alloc.items)
        return []

    monkeypatch.setattr(warehouse_service, "create_fulfilment_drafts_for_allocation", drafts)
    await service._finish_str_approval(db, indent, user)

    # Together, so the second of two from one point is not read as already issued.
    assert sorted(handed) == [Decimal("4"), Decimal("6")]
    assert indent.status == IndentStatus.ALLOCATED.value


async def _str(db, pts) -> tuple[Indent, IndentItem]:
    item = Item(code="STR-ITEM-1", name="Gloves", uom_code="NOS")
    db.add(item)
    await db.flush()
    indent = Indent(indent_no="STR-T-1", indent_type=IndentType.STR.value,
                    indent_date=date.today(), requested_by_id=1, requested_by_name="Raiser",
                    position_id=8101, status=IndentStatus.PENDING_APPROVAL.value,
                    total_items=1, total_qty=Decimal("10"),
                    source_warehouse_id=pts["LIP-2"].id, source_warehouse_name="LIP Two",
                    source_warehouse_code="LIP-2")
    db.add(indent)
    await db.flush()
    line = IndentItem(indent_id=indent.id, line_no=1, item_id=item.id, item_code=item.code,
                      item_name=item.name, uom_code="NOS", quantity=Decimal("10"),
                      approved_quantity=Decimal("10"))
    db.add(line)
    await db.commit()
    return indent, line


async def test_allocating_follows_the_approvers_scope(db, make_user, monkeypatch):
    pts = await _network(db)
    indent, line = await _str(db, pts)
    approver = await make_user(employee_id=7102, username="str_approver", permissions=[])
    approver.active_position_id = 8201

    scope = {pts["MDP-A"].id, pts["LIP-1"].id, pts["LIP-3"].id}   # LIP-2 is NOT his
    free = {pts["LIP-3"].id: Decimal("4")}                        # LIP-3 holds 4
    issued = {}

    async def task(_db, _indent_id, _user):
        return indent, SimpleNamespace(current_stage_name="District Manager")

    async def scope_of(_db, _user):
        return scope

    async def stock_at(_db, _item_id, points, indent_id=None):
        return {p: free[p] for p in points if p in free}

    async def issue(_db, indent_id, requests, user, reason="", forward_remainder=False,
                    approved_quantities=None):
        issued.update(requests=[(r.line_id, r.warehouse_id, r.quantity) for r in requests],
                      reason=reason, approved=approved_quantities)
        return {"ok": True}

    monkeypatch.setattr(fulfilment, "_str_task", task)
    monkeypatch.setattr(fulfilment.locations, "location_ids_for_user", scope_of)
    monkeypatch.setattr(fulfilment, "_stock_at", stock_at)
    monkeypatch.setattr(fulfilment, "issue_from_my_stock", issue)

    def body(source=None, reason=""):
        return SimpleNamespace(source_warehouse_id=source, reason=reason,
                               items=[SimpleNamespace(line_id=line.id, approved_quantity=10)])

    # The STR's own source is outside this approver's scope.
    with pytest.raises(ValidationError, match="not in your scope"):
        await fulfilment.str_allocate(db, indent.id, body(), approver)
    # Moving it needs a reason.
    with pytest.raises(ValidationError, match="Say why"):
        await fulfilment.str_allocate(db, indent.id, body(pts["LIP-3"].id), approver)
    # A point of his with nothing free is refused in words.
    with pytest.raises(ValidationError, match="none of these items free"):
        await fulfilment.str_allocate(db, indent.id, body(pts["LIP-1"].id, "closer"), approver)

    # His LIP-3 has 4 of the 10: the move is recorded, 4 are allocated, 6 travel on.
    await fulfilment.str_allocate(db, indent.id, body(pts["LIP-3"].id, "Closer to site"), approver)
    assert issued["requests"] == [(line.id, pts["LIP-3"].id, Decimal("4"))]
    assert issued["approved"] == {line.id: 10.0}
    assert "source moved from LIP Two" in issued["reason"]
    assert indent.source_warehouse_id == pts["LIP-3"].id
    change = (await db.execute(select(StrSourceChange))).scalars().one()
    assert (change.from_warehouse_name, change.to_warehouse_name) == ("LIP Two", "LIP Three")
    assert change.reason == "Closer to site" and change.stage_name == "District Manager"
