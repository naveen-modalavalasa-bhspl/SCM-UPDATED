"""Stage 2 smoke: every table builds and basic CRUD works on the portable schema."""
from sqlalchemy import select

import app.all_models  # noqa: F401
from app.core.database import Base
from app.shared.models.master import Item, Uom


def test_all_tables_registered():
    names = set(Base.metadata.tables.keys())
    # A representative sample across every prefix must be present. Names here are the
    # ones the live SCM_REBUILD schema actually uses: the balance/ledger pair is
    # stk_balance/stk_ledger, and the sys_ tables are sys_doc_series and
    # sys_local_credentials.
    expected = {
        "mst_items", "mst_vendors", "mst_uom", "mst_uom_conversions", "mst_projects",
        "whs_warehouses", "whs_bins",
        "hcm_employees", "hcm_positions", "hcm_position_assignments", "sys_hcm_sync_log",
        "rbac_permissions", "rbac_roles", "rbac_user_roles", "rbac_pages",
        "rbac_user_groups", "rbac_user_group_members",
        "wf_workflows", "wf_stages", "wf_instances", "wf_actions",
        "rule_events", "rule_rules", "rule_conditions", "rule_actions",
        "rule_executions",
        "sys_settings", "sys_doc_series", "sys_local_credentials", "sys_audit_log",
        "sys_notification_rules",
        "ind_indents", "ind_indent_items",
        "pro_purchase_orders", "pro_po_items",
        "stk_balance", "stk_ledger",
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
