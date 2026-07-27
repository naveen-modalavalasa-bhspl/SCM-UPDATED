"""The one test that proves the system works, end to end, through the HTTP API:

indent -> submit -> approve -> PO -> submit -> approve -> send-to-vendor ->
GRN -> QC pass -> assert stock increased by the accepted quantity.
"""
from app.platform.hcm.models import (
    HcmDepartment, HcmFacility, HcmPosition, HcmPositionAssignment,
)
from app.platform.workflow.models import Stage, Workflow
from app.shared.models.base import utcnow
from app.shared.models.master import Item, Uom, Vendor

FACILITY_ID = 801
DEPT_ID = 501
POS_PROC_HEAD = 9002


async def _setup_world(db, make_user):
    # masters
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    item = Item(code="IT-0001", name="Hex Bolt", uom_id=uom.id, uom_code="NOS")
    vendor = Vendor(code="VEN-001", name="Acme Supplies", is_active=True)
    db.add_all([item, vendor])
    # org
    db.add(HcmFacility(id=FACILITY_ID, name="Main Store", is_stock_location=True,
                       is_active=True, synced_at=utcnow()))
    db.add(HcmDepartment(id=DEPT_ID, name="Mechanical", head_employee_id=3, synced_at=utcnow()))
    db.add(HcmPosition(id=POS_PROC_HEAD, name="Procurement Head", is_active=True, synced_at=utcnow()))
    await db.flush()

    # workflows
    wf_i = Workflow(code="WF-INDENT", name="Indent", doc_type="INDENT", is_active=True)
    wf_p = Workflow(code="WF-PO", name="PO", doc_type="PO", is_active=True)
    db.add_all([wf_i, wf_p])
    await db.flush()
    db.add(Stage(workflow_id=wf_i.id, sequence=1, name="Dept Head",
                 approver_type="DEPT_HEAD", approval_mode="ANY_ONE"))
    db.add(Stage(workflow_id=wf_p.id, sequence=1, name="Procurement Head",
                 approver_type="POSITION", position_id=POS_PROC_HEAD, approval_mode="ANY_ONE"))
    await db.commit()

    # users
    requester = await make_user(employee_id=2, username="req", password="pw",
                                permissions=["indent.view", "indent.create", "indent.submit"])
    requester.department_id = DEPT_ID
    await make_user(employee_id=3, username="depthead", password="pw",
                    permissions=["indent.view", "indent.approve"])
    await make_user(employee_id=4, username="proc", password="pw",
                    permissions=["po.view", "po.create", "po.submit", "po.send_vendor"])
    po_approver = await make_user(employee_id=5, username="pohead", password="pw",
                                  permissions=["po.view", "po.approve"])
    db.add(HcmPositionAssignment(id=POS_PROC_HEAD, employee_id=po_approver.id,
                                 position_id=POS_PROC_HEAD, is_active=True, synced_at=utcnow()))
    await make_user(employee_id=6, username="store", password="pw",
                    permissions=["grn.view", "grn.create", "grn.qc", "stock.view"])
    await db.commit()
    return item


async def test_indent_to_stock_full_flow(client, db, make_user, login):
    item = await _setup_world(db, make_user)

    # 1. requester creates + submits an indent
    h = await login("req", "pw")
    r = await client.post("/api/indents", headers=h, json={
        "facility_id": FACILITY_ID, "items": [{"item_id": item.id, "quantity": 10}]})
    assert r.status_code == 200, r.text
    indent = r.json()
    indent_id, indent_item_id = indent["id"], indent["items"][0]["id"]

    r = await client.post(f"/api/indents/{indent_id}/submit", headers=h)
    assert r.json()["status"] == "PENDING_APPROVAL"

    # 2. dept head approves
    h = await login("depthead", "pw")
    r = await client.post(f"/api/indents/{indent_id}/approve", headers=h, json={"comments": "ok"})
    assert r.status_code == 200, r.text
    # Was "APPROVED". Approval now runs the availability check (flow doc §3 steps 3-5):
    # this world has no stock, so every line is short and the indent goes straight to
    # procurement with a material request raised for it.
    # NOTE: this becomes AWAITING_ALLOCATION once allocation becomes a human decision
    # -- see docs/superpowers/specs/2026-07-26-allocation-is-a-decision-CHANGE.md
    assert r.json()["status"] == "PENDING_PROCUREMENT"

    # 3. procurement creates PO from the approved indent, submits
    h = await login("proc", "pw")
    r = await client.post(f"/api/pos/from-indent/{indent_id}", headers=h, json={
        "vendor_id": 1,
        "lines": [{"item_id": item.id, "indent_item_id": indent_item_id,
                   "quantity": 10, "rate": 100}]})
    assert r.status_code == 200, r.text
    po = r.json()
    po_id, po_item_id = po["id"], po["items"][0]["id"]
    assert po["total_amount"] == 1000

    r = await client.post(f"/api/pos/{po_id}/submit", headers=h)
    assert r.json()["status"] == "PENDING_APPROVAL"

    # 4. PO approver (holds Procurement Head position) approves
    h = await login("pohead", "pw")
    r = await client.post(f"/api/pos/{po_id}/approve", headers=h, json={"comments": "go"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "APPROVED"

    # 5. procurement sends PO to vendor
    h = await login("proc", "pw")
    r = await client.post(f"/api/pos/{po_id}/send-to-vendor", headers=h)
    assert r.json()["status"] == "SENT_TO_VENDOR"

    # 6. store receives goods (GRN) then QC passes
    h = await login("store", "pw")
    r = await client.post(f"/api/grn/from-po/{po_id}", headers=h, json={
        "invoice_no": "INV-1",
        "lines": [{"po_item_id": po_item_id, "item_id": item.id,
                   "received_quantity": 10, "accepted_quantity": 10}]})
    assert r.status_code == 200, r.text
    grn_id = r.json()["id"]
    assert r.json()["status"] == "RECEIVED"

    r = await client.post(f"/api/grn/{grn_id}/qc-pass", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "QC_PASSED"

    # 7. stock increased by the accepted quantity
    r = await client.get("/api/stock", headers=h, params={"item_id": item.id})
    assert r.status_code == 200, r.text
    rows = r.json()["items"]
    assert len(rows) == 1
    assert rows[0]["quantity"] == 10
    assert rows[0]["facility_id"] == FACILITY_ID
