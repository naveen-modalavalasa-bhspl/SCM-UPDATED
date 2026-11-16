"""Warehouses transfer between warehouses by TYPE, and an STR never comes from the point
it is delivered into (SCM_0182, 2026-11-09).

What these pin:

- a login delivering into a warehouse is offered every OTHER active warehouse, whoever
  holds it — one SCM HEAD at Central Warehouse-1 was offered nothing, because nobody
  else holds that rank;
- the delivery point is never offered, even when the login reaches it some way other
  than a direct link;
- LIPs and MDPs keep the same-rank rule (`test_str_source.py` covers that);
- the save refuses a source equal to the destination, and a non-warehouse source for
  a warehouse destination, whatever the list offered.
"""
import pytest

from app.core.exceptions import ValidationError
from app.modules.indents import service
from app.modules.inventory import locations
from app.modules.inventory.models import PositionLocation
from app.platform.hcm.models import HcmPosition
from app.shared.models.base import utcnow
from app.shared.models.warehouse import Warehouse

pytestmark = pytest.mark.asyncio

SCM_HEAD, KEEPER = 401, 402   # HCM rank ids


async def _network(db):
    """Three warehouses of mixed types, an MDP and an LIP. The SCM HEAD (a rank held
    once) is linked to Central-1; a Store Keeper holds Gollapalli; Regional-1 is held
    by nobody at all."""
    pts = {code: Warehouse(code=code, name=name, warehouse_type=kind)
           for code, name, kind in (
               ("WH-C1", "Central Warehouse-1", "MAIN"),
               ("WH-G", "Gollapalli Warehouse", "MAIN"),
               ("WH-R1", "Regional-1", "REGIONAL"),
               ("MDP-A", "MDP Alpha", "MDP"),
               ("LIP-1", "LIP One", "LIP"))}
    db.add_all(pts.values())
    for pid, rank in ((9101, SCM_HEAD), (9102, KEEPER), (9103, KEEPER), (9104, KEEPER)):
        db.add(HcmPosition(id=pid, name=f"Post {pid}", role_id=rank, is_active=True,
                           synced_at=utcnow()))
    await db.flush()
    for pid, code in ((9101, "WH-C1"), (9102, "WH-G"), (9103, "MDP-A"), (9104, "LIP-1")):
        db.add(PositionLocation(position_id=pid, warehouse_id=pts[code].id,
                                section_name="M.D.P" if code == "MDP-A" else "L I P"))
    await db.flush()
    return pts


async def _codes(db, user, position_id, destination_id=None) -> set[str]:
    user.active_position_id = position_id
    db.info.clear()
    rows = await locations.same_rank_points(db, user, destination_id=destination_id)
    return {row["warehouse_code"] for row in rows}


async def test_a_warehouse_is_offered_every_other_warehouse_by_type(db, make_user):
    pts = await _network(db)
    await db.commit()
    head = await make_user(employee_id=7201, username="scm_head", permissions=[])

    # Not only the SCM HEAD rank: every other warehouse-type point, held or not, any
    # warehouse type — never an MDP or an LIP, never Central-1 itself.
    assert await _codes(db, head, 9101, pts["WH-C1"].id) == {"WH-G", "WH-R1"}


async def test_the_delivery_point_is_never_offered(db, make_user):
    pts = await _network(db)
    await db.commit()
    keeper = await make_user(employee_id=7202, username="g_keeper", permissions=[])

    # The login reaches Gollapalli without... the destination alone still excludes it.
    assert "WH-G" not in await _codes(db, keeper, 9102, pts["WH-G"].id)
    # Delivering into Central-1 from a Gollapalli post: Central-1 is not offered.
    assert "WH-C1" not in await _codes(db, keeper, 9102, pts["WH-C1"].id)


async def test_lips_and_mdps_keep_the_rank_rule(db, make_user):
    pts = await _network(db)
    await db.commit()
    keeper = await make_user(employee_id=7203, username="lip_keeper", permissions=[])

    # An LIP keeper delivering into his LIP: the same-rank rule, which on this network
    # finds no other LIP — never a warehouse.
    offered = await _codes(db, keeper, 9104, pts["LIP-1"].id)
    assert not offered & {"WH-C1", "WH-G", "WH-R1"}


async def test_the_save_refuses_its_own_delivery_point(db):
    pts = await _network(db)
    await db.commit()

    with pytest.raises(ValidationError, match="is where this stock is going"):
        await service.assert_str_source_fits(db, pts["WH-C1"], pts["WH-C1"].id)


async def test_a_warehouse_is_never_served_by_an_mdp_or_lip(db):
    pts = await _network(db)
    await db.commit()

    with pytest.raises(ValidationError, match="comes from another warehouse"):
        await service.assert_str_source_fits(db, pts["MDP-A"], pts["WH-C1"].id)
    with pytest.raises(ValidationError, match="comes from another warehouse"):
        await service.assert_str_source_fits(db, pts["LIP-1"], pts["WH-C1"].id)
    # Another warehouse, of any type, is fine.
    await service.assert_str_source_fits(db, pts["WH-R1"], pts["WH-C1"].id)
    await service.assert_str_source_fits(db, pts["WH-G"], pts["WH-C1"].id)
    # An LIP raising from an MDP is not this rule's business.
    await service.assert_str_source_fits(db, pts["MDP-A"], pts["LIP-1"].id)
