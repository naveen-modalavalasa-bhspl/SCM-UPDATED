"""The inventory stage reads only the indents its OWN points serve (2026-11-02).

An LIP store keeper holds `stock.view` because his Stock screens need it, and that
permission alone used to show him every indent past approval in the company — the
Puthalapattu store keeper listed Punganur's and Nr Peta's. What these pin:

- an LIP holder reads the indents raised by posts linked to HIS LIP, never another's;
- an MDP holder reads his own and those of the LIPs under him, never a cousin's;
- a main-warehouse holder (the central desk) still reads every one;
- nothing before approval leaks through this door.
"""
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.modules.indents import service
from app.modules.indents.models import Indent
from app.modules.inventory.models import PositionLocation
from app.platform.hcm.models import HcmPosition
from app.shared.enums import IndentStatus
from app.shared.models.base import utcnow
from app.shared.models.warehouse import Warehouse

pytestmark = pytest.mark.asyncio


async def _network(db):
    """Main warehouse; MDP A over LIP 1 and LIP 2; MDP B over LIP 3. Each point has a
    store keeper (in the stocking section) and a raiser posted at the same office."""
    main = Warehouse(code="WH-M", name="Central", warehouse_type="MAIN")
    mdp_a = Warehouse(code="MDP-A", name="MDP Alpha", warehouse_type="MDP")
    mdp_b = Warehouse(code="MDP-B", name="MDP Beta", warehouse_type="MDP")
    lip_1 = Warehouse(code="LIP-1", name="LIP One", warehouse_type="LIP")
    lip_2 = Warehouse(code="LIP-2", name="LIP Two", warehouse_type="LIP")
    lip_3 = Warehouse(code="LIP-3", name="LIP Three", warehouse_type="LIP")
    db.add_all([main, mdp_a, mdp_b, lip_1, lip_2, lip_3])
    posts = {  # position: (parent, point, section)
        9000: (None, main, "WAREHOUSE-01"),
        9001: (9000, mdp_a, "M.D.P"), 9002: (9000, mdp_b, "M.D.P"),
        9011: (9001, lip_1, "L I P"), 9012: (9001, lip_2, "L I P"), 9013: (9002, lip_3, "L I P"),
        9111: (9011, lip_1, None), 9112: (9012, lip_2, None), 9113: (9013, lip_3, None),
    }
    for pid, (parent, _wh, _sec) in posts.items():
        db.add(HcmPosition(id=pid, name=f"Post {pid}", parent_position_id=parent,
                           is_active=True, synced_at=utcnow()))
    await db.flush()
    for pid, (_parent, wh, section) in posts.items():
        db.add(PositionLocation(position_id=pid, warehouse_id=wh.id, section_name=section))
    await db.flush()


def _indent(no, position_id, status=IndentStatus.APPROVED.value):
    return Indent(indent_no=no, indent_date=date.today(), requested_by_id=1,
                  requested_by_name="Raiser", position_id=position_id, status=status,
                  total_items=0, total_qty=Decimal("0"))


async def _visible(db, user, position_id) -> set[str]:
    user.active_position_id = position_id
    db.info.clear()
    clause = await service._indent_visibility(db, user)
    return set((await db.execute(select(Indent.indent_no).where(clause))).scalars().all())


async def test_each_point_reads_only_the_indents_it_serves(db, make_user):
    await _network(db)
    db.add_all([
        _indent("IND-LIP1", 9111), _indent("IND-LIP2", 9112), _indent("IND-LIP3", 9113),
        _indent("IND-LIP1-DRAFT", 9111, IndentStatus.PENDING_APPROVAL.value),
    ])
    await db.commit()
    keeper = await make_user(employee_id=7001, username="lip_keeper", permissions=["stock.view"])

    assert await _visible(db, keeper, 9011) == {"IND-LIP1"}
    assert await _visible(db, keeper, 9001) == {"IND-LIP1", "IND-LIP2"}
    assert await _visible(db, keeper, 9000) == {"IND-LIP1", "IND-LIP2", "IND-LIP3"}


async def test_without_an_inventory_permission_the_stage_shows_nothing(db, make_user):
    await _network(db)
    db.add(_indent("IND-LIP1", 9111))
    await db.commit()
    clerk = await make_user(employee_id=7002, username="lip_clerk", permissions=["indent.view"])
    assert await _visible(db, clerk, 9011) == set()
