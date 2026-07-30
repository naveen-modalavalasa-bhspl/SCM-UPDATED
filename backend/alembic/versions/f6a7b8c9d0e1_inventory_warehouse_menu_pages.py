"""Provision the complete Inventory and Warehouse navigation.

The sidebar is database-driven.  These page rows were added to PAGE_TREE after
some environments had already been seeded, leaving working routes invisible
until a provisioning script was run manually.  Keeping the repair in Alembic
makes it part of every normal deployment.

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
"""
from alembic import op
import sqlalchemy as sa


revision = "f6a7b8c9d0e1"
down_revision = "e5f6a7b8c9d0"
branch_labels = None
depends_on = None


# code, path, name, icon, module, permission, sort order, parent code
PAGES = (
    ("grp_warehouse", "/warehouse", "Warehouse", "truck", "warehouse",
     "stock.view", 40, None),
    ("wh_dashboard", "/warehouse", "Dashboard", "layout-dashboard", "warehouse",
     "stock.view", 41, "grp_warehouse"),
    ("wh_inward", "/warehouse/material-inward", "Material Inward", "truck",
     "warehouse", "receipt.view", 42, "grp_warehouse"),
    ("wh_grn", "/warehouse/grn", "Goods Receipt", "file-text", "warehouse",
     "receipt.view", 43, "grp_warehouse"),
    ("wh_qc", "/warehouse/quality-inspection", "Quality Inspection",
     "check-circle", "warehouse", "inspection.view", 44, "grp_warehouse"),
    ("wh_putaway", "/warehouse/putaway", "Put-away", "package", "warehouse",
     "putaway.view", 45, "grp_warehouse"),
    ("wh_picklist", "/warehouse/picklist", "Picklists", "list-checks",
     "warehouse", "picking.view", 46, "grp_warehouse"),
    ("wh_issues", "/warehouse/material-issues", "Material Issues", "send",
     "warehouse", "issue.view", 47, "grp_warehouse"),
    ("wh_dispatch", "/warehouse/dispatch", "Dispatch", "truck", "warehouse",
     "dispatch.view", 48, "grp_warehouse"),
    ("wh_returns", "/warehouse/purchase-returns", "Purchase Returns",
     "rotate-ccw", "warehouse", "return.view", 49, "grp_warehouse"),
    ("wh_notifications", "/warehouse/notifications", "Notifications", "bell",
     "warehouse", "stock.view", 50, "grp_warehouse"),
    ("wh_reports", "/warehouse/reports", "Reports", "bar-chart", "warehouse",
     "warehouse.report.view", 51, "grp_warehouse"),
    ("wh_masters", "/warehouse/masters", "Warehouse Masters", "settings",
     "warehouse", "master.location.manage", 52, "grp_warehouse"),

    ("grp_inventory", "/inventory", "Inventory", "package", "inventory",
     "stock.view", 50, None),
    ("inv_overview", "/inventory", "Overview", "layout-dashboard", "inventory",
     "stock.view", 51, "grp_inventory"),
    ("inv_balance", "/inventory/stock-balance", "Stock Balance", "boxes",
     "inventory", "stock.view", 52, "grp_inventory"),
    ("inv_ledger", "/inventory/ledger", "Stock Ledger", "history", "inventory",
     "stock.view", 53, "grp_inventory"),
    ("inv_replenishment", "/inventory/replenishment", "Replenishment",
     "refresh-cw", "inventory", "stock.view", 54, "grp_inventory"),
    ("inv_transfers", "/inventory/transfers", "Transfers", "arrow-left-right",
     "inventory", "stock.adjust", 55, "grp_inventory"),
    ("inv_fulfillment", "/inventory/fulfillment", "Fulfilment Queue",
     "check-circle", "inventory", "stock.reserve", 56, "grp_inventory"),
    ("inv_allocation_approvals", "/inventory/allocation-approvals",
     "Allocation Approvals", "badge-check", "inventory", "allocation.approve",
     57, "grp_inventory"),
    ("inv_demand", "/inventory/demand", "Demand by Item", "boxes", "inventory",
     "allocation.view", 58, "grp_inventory"),
    ("inv_mr", "/inventory/material-requests", "Store Requests", "file-text",
     "inventory", "mr.view", 59, "grp_inventory"),
    ("inv_adjustments", "/inventory/adjustments", "Adjustments", "sliders",
     "inventory", "stock.adjust", 60, "grp_inventory"),
    ("inv_cycle_counts", "/inventory/cycle-counts", "Cycle Counts",
     "clipboard-check", "inventory", "stock.adjust", 61, "grp_inventory"),
    ("inv_reservations", "/inventory/reservations", "Reservations", "lock",
     "inventory", "stock.reserve", 62, "grp_inventory"),
    ("inv_valuation", "/inventory/valuation", "Valuation & Ageing",
     "indian-rupee", "inventory", "stock.valuation.view", 63, "grp_inventory"),
    ("inv_labels", "/inventory/labels", "Labels & Printing", "printer",
     "inventory", "stock.view", 64, "grp_inventory"),
)


def upgrade() -> None:
    connection = op.get_bind()
    upsert = sa.text("""
        INSERT INTO rbac_pages
            (code, path, name, icon, module, parent_id, sort_order,
             required_permission, show_on_mobile, is_active)
        VALUES
            (:code, :path, :name, :icon, :module, NULL, :sort_order,
             :permission, 1, 1)
        ON DUPLICATE KEY UPDATE
            path = VALUES(path),
            name = VALUES(name),
            icon = VALUES(icon),
            module = VALUES(module),
            sort_order = VALUES(sort_order),
            required_permission = VALUES(required_permission),
            show_on_mobile = VALUES(show_on_mobile),
            is_active = VALUES(is_active)
    """)

    # Groups are listed before children, so every parent exists before wiring.
    for code, path, name, icon, module, permission, sort_order, _parent in PAGES:
        connection.execute(
            upsert,
            {
                "code": code,
                "path": path,
                "name": name,
                "icon": icon,
                "module": module,
                "permission": permission,
                "sort_order": sort_order,
            },
        )

    set_parent = sa.text("""
        UPDATE rbac_pages AS child
        JOIN rbac_pages AS parent ON parent.code = :parent_code
        SET child.parent_id = parent.id
        WHERE child.code = :code
    """)
    clear_parent = sa.text("""
        UPDATE rbac_pages
        SET parent_id = NULL
        WHERE code = :code
    """)
    for code, *_fields, parent in PAGES:
        if parent is None:
            connection.execute(clear_parent, {"code": code})
        else:
            connection.execute(
                set_parent, {"code": code, "parent_code": parent}
            )


def downgrade() -> None:
    # Navigation rows may already have existed and may have been customized.
    # Removing them on rollback would hide working screens, so this data repair
    # is intentionally irreversible.
    pass
