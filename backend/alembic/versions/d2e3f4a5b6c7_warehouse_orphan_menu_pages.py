"""Put the five built-but-unreachable warehouse screens on the menu.

Stock Segregation, Stock Movements, Material Returns, Outward QC and Outward
Labelling were all routed and working, but no `rbac_pages` row ever pointed at
them — so the only way in was to type the URL. Same gap Acknowledge Delivery had.

The whole warehouse group is re-stated at absolute sort orders rather than shifted,
so re-running lands on the same menu instead of walking the tail further down each
time. Nothing is deleted and no permission is invented: each new row reuses the
permission its own endpoints already require.

Revision ID: d2e3f4a5b6c7
Revises: c1d2e3f4a5b6
"""
from alembic import op
import sqlalchemy as sa


revision = "d2e3f4a5b6c7"
down_revision = "c1d2e3f4a5b6"
branch_labels = None
depends_on = None


# code, path, name, icon, permission, sort order. Mirrors PAGE_TREE in scripts/seed.py
# — the two must agree or a reseed would silently reorder the live menu.
PAGES = (
    ("wh_dashboard", "/warehouse", "Dashboard", "layout-dashboard", "stock.view", 41),
    ("wh_inward", "/warehouse/material-inward", "Material Inward", "truck",
     "receipt.view", 42),
    ("wh_grn", "/warehouse/grn", "Goods Receipt", "file-text", "receipt.view", 43),
    ("wh_qc", "/warehouse/quality-inspection", "Quality Inspection", "check-circle",
     "inspection.view", 44),
    ("wh_putaway", "/warehouse/putaway", "Put-away", "package", "putaway.view", 45),
    ("wh_segregation", "/warehouse/stock-segregation", "Stock Segregation", "split",
     "stock.view", 46),
    # Already on the live menu under this code — reused rather than re-coded, or the
    # screen ends up with two entries pointing at the same path.
    ("wh_stock_movements", "/warehouse/stock-movements", "Stock Movements", "move",
     "stock.view", 47),
    ("wh_picklist", "/warehouse/picklist", "Picklists", "list-checks",
     "picking.view", 48),
    ("wh_issues", "/warehouse/material-issues", "Material Issues", "send",
     "issue.view", 49),
    ("wh_material_returns", "/warehouse/material-returns", "Material Returns",
     "undo-2", "issue.view", 50),
    ("wh_consignments", "/warehouse/dispatch/consignments", "Consignments", "boxes",
     "dispatch.view", 52),
    ("wh_dispatch", "/warehouse/dispatch", "Dispatch", "truck", "dispatch.view", 54),
    ("wh_ack", "/warehouse/acknowledge-delivery", "Acknowledge Delivery",
     "check-circle", "dispatch.acknowledge", 55),
    ("wh_notifications", "/warehouse/notifications", "Notifications", "bell",
     "stock.view", 57),
    ("wh_reports", "/warehouse/reports", "Reports", "bar-chart",
     "warehouse.report.view", 58),
    ("wh_masters", "/warehouse/masters", "Warehouse Masters", "settings",
     "master.location.manage", 59),
)


def upgrade() -> None:
    connection = op.get_bind()

    # An earlier revision of this migration added Stock Movements under a second code
    # before the existing `wh_stock_movements` row was noticed, so a database that ran
    # it shows the screen twice. Harmless to run where it never existed.
    connection.execute(
        sa.text("DELETE FROM rbac_pages WHERE code = 'wh_movements'"))

    # Outward QC, Outward Labelling and Purchase Returns were dropped from the module
    # on 2026-08-13. Their screens and routes are gone, so a menu row would open a
    # page that no longer exists.
    connection.execute(sa.text(
        "DELETE FROM rbac_pages "
        "WHERE code IN ('wh_qc_outward', 'wh_labelling', 'wh_returns')"))

    upsert = sa.text("""
        INSERT INTO rbac_pages
            (code, path, name, icon, module, parent_id, sort_order,
             required_permission, show_on_mobile, is_active)
        VALUES
            (:code, :path, :name, :icon, 'warehouse', NULL, :sort_order,
             :permission, 1, 1)
        ON DUPLICATE KEY UPDATE
            path = VALUES(path),
            name = VALUES(name),
            icon = VALUES(icon),
            module = VALUES(module),
            sort_order = VALUES(sort_order),
            required_permission = VALUES(required_permission),
            is_active = 1
    """)
    for code, path, name, icon, permission, sort_order in PAGES:
        connection.execute(upsert, {
            "code": code, "path": path, "name": name, "icon": icon,
            "permission": permission, "sort_order": sort_order,
        })

    # Every one of these hangs off the Warehouse group. Resolved by code rather than
    # assumed, so a database whose group row carries a different id still lands right.
    connection.execute(sa.text("""
        UPDATE rbac_pages AS child
        JOIN rbac_pages AS parent ON parent.code = 'grp_warehouse'
        SET child.parent_id = parent.id
        WHERE child.code IN (
            'wh_dashboard', 'wh_inward', 'wh_grn', 'wh_qc', 'wh_putaway',
            'wh_segregation', 'wh_stock_movements', 'wh_picklist', 'wh_issues',
            'wh_material_returns', 'wh_consignments', 'wh_dispatch', 'wh_ack',
            'wh_notifications', 'wh_reports', 'wh_masters'
        )
    """))


def downgrade() -> None:
    # Removing navigation on a rollback would hide screens people are mid-way through
    # using, and the rows may predate this migration.
    pass
