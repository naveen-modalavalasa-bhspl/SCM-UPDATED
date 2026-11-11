"""An STR whose source nobody below the SPH holds climbs OE -> DM -> RM -> SPH, and at
every level it is in that approver's "Waiting for me" inbox (2026-11-06).

Real engine, real STR ladder, and the same HTTP routes the approvals screen calls:
`GET /api/approvals/pending` (the inbox), `GET .../str-source` (the panel) and
`POST .../approve` (the forward press). Nothing is monkeypatched.
"""
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.security import hash_password
from app.modules.indents import service as indent_service
from app.modules.indents.schemas import IndentCreate, IndentItemIn
from app.modules.inventory.models import PositionLocation
from app.platform.hcm.models import HcmEmployee, HcmPosition, HcmPositionAssignment
from app.platform.rbac.models import Permission, Role, RolePermission, UserRole
from app.platform.settings.models import UserCredential
from app.platform.workflow import ladder
from app.platform.workflow.models import Instance
from app.shared.enums import DocType, InstanceStatus
from app.shared.models.base import utcnow
from app.shared.models.master import Item, Uom
from app.shared.models.warehouse import Warehouse

pytestmark = pytest.mark.asyncio

SK, OE, DM, RM, SPH = 7, 5, 4, 3, 2   # HCM rank ids

APPROVER_PERMS = ["indent.view", "indent.approve", "indent.reject"]
RAISER_PERMS = ["indent.view", "indent.create", "indent.submit", "indent.edit",
                "stock.transfer.request"]


async def _grant(db, employee, username, codes):
    db.add(UserCredential(employee_id=employee.id, password_hash=hash_password("pw")))
    role = Role(code=f"R_{username}", name=username, is_active=True)
    db.add(role)
    await db.flush()
    db.add(UserRole(employee_id=employee.id, role_id=role.id))
    for code in codes:
        perm = (await db.execute(
            select(Permission).where(Permission.code == code))).scalar_one_or_none()
        if perm is None:
            head, _, tail = code.partition(".")
            perm = Permission(code=code, module=head, resource=head,
                              action=tail or "view", description=code)
            db.add(perm)
            await db.flush()
        db.add(RolePermission(role_id=role.id, permission_id=perm.id))


async def _world(db):
    """Two branches under one SPH. The raiser's branch (SK -> OE -> DM -> RM) holds
    LIP-OWN; the other branch (SK2 -> OE2 -> DM2 -> RM2) holds the SOURCE, LIP-SRC.
    So the source is outside the OE's, DM's and RM's scope, and inside the SPH's."""
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    item = Item(code="IT-STR-1", name="Cable", uom_id=uom.id, uom_code="NOS")
    own = Warehouse(code="LIP-OWN", name="LIP Own", warehouse_type="LIP")
    src = Warehouse(code="LIP-SRC", name="LIP Source", warehouse_type="LIP")
    db.add_all([item, own, src])

    posts = {  # id: (name, rank, parent)
        1000: ("SK", SK, 1001), 1001: ("OE", OE, 1002), 1002: ("DM", DM, 1003),
        1003: ("RM", RM, 1004), 1004: ("SPH", SPH, None),
        1100: ("SK2", SK, 1101), 1101: ("OE2", OE, 1102), 1102: ("DM2", DM, 1103),
        1103: ("RM2", RM, 1004),
    }
    for pid, (name, rank, parent) in posts.items():
        db.add(HcmPosition(id=pid, name=name, role_id=rank, role_name=name.rstrip("2"),
                           parent_position_id=parent, is_active=True, synced_at=utcnow()))
    people = {}
    for index, (pid, (name, _rank, _parent)) in enumerate(posts.items(), start=1):
        emp = HcmEmployee(id=500 + index, full_name=f"{name} person",
                          emp_code=name.lower(), is_active=True, synced_at=utcnow())
        db.add(emp)
        people[name] = emp
        db.add(HcmPositionAssignment(
            id=9000 + index, employee_id=emp.id, employee_name=emp.full_name,
            position_id=pid, is_primary=True, is_active=True, synced_at=utcnow()))
    await db.flush()
    db.add(PositionLocation(position_id=1000, warehouse_id=own.id, section_name="L I P"))
    db.add(PositionLocation(position_id=1100, warehouse_id=src.id, section_name="L I P"))

    # The STR ladder, company-wide: OE, DM, RM, SPH all switched on.
    wf = ladder.new_workflow(None, None, DocType.STOCK_TRANSFER_REQUEST.value, 1)
    db.add(wf)
    await db.flush()
    for seq, (role, name) in enumerate([(OE, "OE"), (DM, "DM"), (RM, "RM"), (SPH, "SPH")],
                                       start=1):
        db.add(ladder.new_stage(wf.id, seq, name, role, True))

    await _grant(db, people["SK"], "sk", RAISER_PERMS)
    for name in ("OE", "DM", "RM", "SPH"):
        await _grant(db, people[name], name.lower(), APPROVER_PERMS)
    await db.commit()
    return people, item, own, src


async def _inbox(client, login, username):
    headers = await login(username, "pw")
    r = await client.get("/api/approvals/pending",
                         params={"page": 1, "size": 20, "scope": "mine"}, headers=headers)
    assert r.status_code == 200, r.text
    return headers, r.json()["items"]


async def test_an_str_forwarded_past_the_oe_reaches_each_level_inbox(db, client, login):
    people, item, own, src = await _world(db)
    raiser = people["SK"]
    raiser.active_position_id = 1000
    indent = await indent_service.create_indent(db, IndentCreate(
        indent_type="STR", source_warehouse_id=src.id, required_date=date.today(),
        items=[IndentItemIn(item_id=item.id, quantity=5)]), raiser)
    await indent_service.submit_indent(db, indent.id, raiser)

    instance = (await db.execute(select(Instance).where(
        Instance.doc_type == DocType.INDENT.value, Instance.doc_id == indent.id)
    )).scalars().first()
    assert [link["role_name"] for link in instance.resolved_chain] == \
        ["OE", "DM", "RM", "SPH"], instance.resolved_chain

    line_id = indent.items[0].id
    for level, nxt in (("oe", "dm"), ("dm", "rm"), ("rm", "sph")):
        headers, items = await _inbox(client, login, level)
        mine = [row for row in items if row["doc_id"] == indent.id]
        assert mine, f"{level.upper()} inbox is empty: {items}"
        assert mine[0]["display_doc_type"] == "STOCK_TRANSFER_REQUEST"

        review = (await client.get(f"/api/approvals/indents/{indent.id}/str-source",
                                   headers=headers)).json()
        assert review["in_scope"] is False, review
        assert review["is_last_level"] is False, review

        # The screen's "Approve and forward to next level" press.
        r = await client.post(f"/api/approvals/indents/{indent.id}/approve", headers=headers,
                              json={"items": [{"line_id": line_id, "approved_quantity": 5}],
                                    "comments": f"Source not in {level.upper()} scope"})
        assert r.status_code == 200, r.text

        # The level just passed no longer sees it; the next one does.
        _h, after = await _inbox(client, login, level)
        assert not [row for row in after if row["doc_id"] == indent.id]
        _h, nxt_items = await _inbox(client, login, nxt)
        assert [row for row in nxt_items if row["doc_id"] == indent.id], \
            f"{nxt.upper()} inbox is empty after {level.upper()} forwarded"

    # SPH: the last level, and the source IS his — approve, and the ladder ends.
    headers, _items = await _inbox(client, login, "sph")
    review = (await client.get(f"/api/approvals/indents/{indent.id}/str-source",
                               headers=headers)).json()
    assert review["in_scope"] is True and review["is_last_level"] is True, review
    r = await client.post(f"/api/approvals/indents/{indent.id}/approve", headers=headers,
                          json={"items": [{"line_id": line_id, "approved_quantity": 5}],
                                "comments": ""})
    assert r.status_code == 200, r.text
    await db.commit()   # end this session's snapshot; the API wrote in its own
    status = (await db.execute(select(Instance.status).where(
        Instance.id == instance.id))).scalar_one()
    assert status == InstanceStatus.APPROVED.value


async def test_with_no_str_ladder_the_fallback_still_climbs_to_the_dm(db, client, login):
    """No STR ladder configured: the reporting-line fallback still climbs one level per
    approval (engine._next_reporting_ladder_approvers), so the DM is asked next. The
    panel has no frozen ladder to read, so it shows a plain Approve."""
    people, item, own, src = await _world(db)
    from app.platform.workflow.models import Workflow
    for wf in (await db.execute(select(Workflow))).scalars().all():
        wf.is_active = False
    await db.commit()

    raiser = people["SK"]
    raiser.active_position_id = 1000
    indent = await indent_service.create_indent(db, IndentCreate(
        indent_type="STR", source_warehouse_id=src.id, required_date=date.today(),
        items=[IndentItemIn(item_id=item.id, quantity=5)]), raiser)
    await indent_service.submit_indent(db, indent.id, raiser)

    headers, items = await _inbox(client, login, "oe")
    assert [row for row in items if row["doc_id"] == indent.id]
    review = (await client.get(f"/api/approvals/indents/{indent.id}/str-source",
                               headers=headers)).json()
    assert review["is_last_level"] is None   # no frozen ladder -> plain "Approve"
    r = await client.post(f"/api/approvals/indents/{indent.id}/approve", headers=headers,
                          json={"items": [{"line_id": indent.items[0].id,
                                           "approved_quantity": 5}], "comments": ""})
    assert r.status_code == 200, r.text
    _h, dm_items = await _inbox(client, login, "dm")
    assert [row for row in dm_items if row["doc_id"] == indent.id]
