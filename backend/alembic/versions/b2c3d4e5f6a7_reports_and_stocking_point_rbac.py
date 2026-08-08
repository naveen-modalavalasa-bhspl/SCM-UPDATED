"""Reports menu, Stocking Points, Stock Movements and Consolidation — RBAC rows.

These pages and permissions were added to `scripts/seed.py` PAGE_TREE and to
`platform/rbac/permissions.py` after the deployment database had been provisioned.
Reseeding is not an option there — `scripts.seed` prunes `rbac_pages` and rewrites
real data — so the rows are carried in Alembic like `f6a7b8c9d0e1` before it, and
arrive with a normal `alembic upgrade head`.

Without them the routes exist and the endpoints answer 403: the sidebar is built
from `rbac_pages` and `require_permission` reads `rbac_permissions`.

Every statement is an upsert or an INSERT ... SELECT with a NOT EXISTS guard, so
running this against a database that already has the rows changes nothing.

Revision ID: b2c3d4e5f6a7
Revises: a6b7c8d9e0f1
Create Date: 2026-08-08
"""
import sqlalchemy as sa
from alembic import op

revision = "b2c3d4e5f6a7"
down_revision = "a6b7c8d9e0f1"
branch_labels = None
depends_on = None


# code, module, resource, action, description
PERMISSIONS = (
    ("report.view", "reports", "report", "view",
     "View the cross-module report ledgers"),
    ("report.export", "reports", "report", "export",
     "Download a report ledger as a file"),
    ("page.grp_reports.view", "reports", "page", "view",
     "See the Reports page"),
    ("page.rep_indents.view", "reports", "page", "view",
     "See the Reports > Indents Ledger page"),
    ("page.rep_approvals.view", "reports", "page", "view",
     "See the Reports > Approvals Ledger page"),
    ("page.rep_inventory.view", "reports", "page", "view",
     "See the Reports > Inventory Ledger page"),
    ("page.rep_warehouse.view", "reports", "page", "view",
     "See the Reports > Warehouse Ledger page"),
    ("stock.points.manage", "inventory", "stock", "points_manage",
     "Tag positions to stocking points (MDP / LIP)"),
    ("stock.view.subtree", "inventory", "stock", "view_subtree",
     "View stock at every point reporting under you, not just your own"),
    ("stock.transfer.approve", "inventory", "stock", "transfer_approve",
     "Approve a stock transfer that crosses a project boundary"),
)

# code, path, name, icon, module, required_permission, sort_order, parent code.
# Groups first, so a parent always exists before its children are wired.
PAGES = (
    ("grp_reports", "/reports/indents", "Reports", "bar-chart", None,
     "report.view", 70, None),
    ("rep_indents", "/reports/indents", "Indent Ledger", "file-text", None,
     "report.view", 71, "grp_reports"),
    ("rep_approvals", "/reports/approvals", "Approval Ledger", "check-circle", None,
     "report.view", 72, "grp_reports"),
    ("rep_inventory", "/reports/inventory", "Stock Ledger", "boxes", None,
     "report.view", 73, "grp_reports"),
    ("rep_warehouse", "/reports/warehouse", "Warehouse Ledger", "truck", None,
     "report.view", 74, "grp_reports"),

    ("approval_consolidation", "/approvals/consolidation", "Consolidation", "layers",
     None, "indent.view", 22, "approvals"),
    ("inv_stocking_points", "/inventory/stocking-points", "Stocking Points", "map-pin",
     None, "stock.points.manage", 58, "grp_inventory"),
    ("wh_stock_movements", "/warehouse/stock-movements", "Stock Movements",
     "arrow-right-left", "warehouse", "stock.view", 45, "grp_warehouse"),
)

# permission code -> role codes. A role that does not exist in this environment is
# skipped by the JOIN rather than failing the migration.
GRANTS = {
    "report.view": ("ADMIN",),
    "report.export": ("ADMIN",),
    "page.grp_reports.view": ("ADMIN",),
    "page.rep_indents.view": ("ADMIN",),
    "page.rep_approvals.view": ("ADMIN",),
    "page.rep_inventory.view": ("ADMIN",),
    "page.rep_warehouse.view": ("ADMIN",),
    # ADMIN is included on the stock permissions deliberately: it holds every other
    # permission in the system, and the three below were simply missed when they
    # were added by hand on the development copy.
    "stock.points.manage": ("ADMIN", "jp_dm", "jp_oe", "jp_sv"),
    "stock.view.subtree": ("ADMIN", "jp_dm", "jp_oe", "jp_sv"),
    "stock.transfer.approve": ("ADMIN", "jp_sv"),
}


def upgrade() -> None:
    connection = op.get_bind()

    permission = sa.text("""
        INSERT INTO rbac_permissions (code, module, resource, action, description)
        VALUES (:code, :module, :resource, :action, :description)
        ON DUPLICATE KEY UPDATE
            module = VALUES(module),
            resource = VALUES(resource),
            action = VALUES(action),
            description = VALUES(description)
    """)
    for code, module, resource, action, description in PERMISSIONS:
        connection.execute(permission, {
            "code": code, "module": module, "resource": resource,
            "action": action, "description": description,
        })

    page = sa.text("""
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
    for code, path, name, icon, module, perm, sort_order, _parent in PAGES:
        connection.execute(page, {
            "code": code, "path": path, "name": name, "icon": icon,
            "module": module, "permission": perm, "sort_order": sort_order,
        })

    # Parenting is a second pass so a child listed before its group still resolves.
    # A parent that is absent (an environment without that module's group row) leaves
    # the child top-level rather than aborting the upgrade.
    set_parent = sa.text("""
        UPDATE rbac_pages AS child
        JOIN rbac_pages AS parent ON parent.code = :parent_code
        SET child.parent_id = parent.id
        WHERE child.code = :code
    """)
    clear_parent = sa.text("UPDATE rbac_pages SET parent_id = NULL WHERE code = :code")
    for code, *_fields, parent in PAGES:
        if parent is None:
            connection.execute(clear_parent, {"code": code})
        else:
            connection.execute(set_parent, {"code": code, "parent_code": parent})

    grant = sa.text("""
        INSERT INTO rbac_role_permissions (role_id, permission_id)
        SELECT r.id, p.id
          FROM rbac_roles r
          JOIN rbac_permissions p ON p.code = :permission
         WHERE r.code = :role
           AND NOT EXISTS (
               SELECT 1 FROM rbac_role_permissions rp
                WHERE rp.role_id = r.id AND rp.permission_id = p.id
           )
    """)
    for permission_code, roles in GRANTS.items():
        for role in roles:
            connection.execute(grant, {"permission": permission_code, "role": role})


def downgrade() -> None:
    # Navigation and permission rows may already have existed and may have been
    # customized since. Removing them on rollback would hide working screens and
    # revoke live access, so this data repair is intentionally irreversible.
    pass
