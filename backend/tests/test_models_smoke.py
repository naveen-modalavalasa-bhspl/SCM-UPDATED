"""Stage 2 smoke: every table builds and basic CRUD works on the portable schema."""
from sqlalchemy import select

import app.all_models  # noqa: F401
from app.core.database import Base
from app.shared.models.master import Item, Uom


def test_all_tables_registered():
    names = set(Base.metadata.tables.keys())
    # a representative sample across every prefix must be present
    expected = {
        "mst_items", "mst_vendors", "mst_uom",
        "hcm_employees", "hcm_positions", "hcm_position_assignments", "sys_hcm_sync_log",
        "rbac_permissions", "rbac_roles", "rbac_user_roles", "rbac_pages",
        "wf_workflows", "wf_stages", "wf_instances", "wf_actions",
        "sys_settings", "sys_doc_numbers", "sys_user_credentials",
        "ind_indents", "ind_indent_items",
        "pro_purchase_orders", "pro_po_items",
        "lgs_grn", "lgs_grn_items", "lgs_issues", "lgs_issue_items",
        "stk_stock", "stk_movements",
    }
    missing = expected - names
    assert not missing, f"missing tables: {missing}"


async def test_insert_and_read_item(db):
    uom = Uom(code="NOS", name="Numbers")
    db.add(uom)
    await db.flush()
    db.add(Item(code="IT-001", name="Test bolt", uom_id=uom.id, uom_code="NOS"))
    await db.commit()

    row = (await db.execute(select(Item).where(Item.code == "IT-001"))).scalar_one()
    assert row.name == "Test bolt"
    assert row.is_active is True
