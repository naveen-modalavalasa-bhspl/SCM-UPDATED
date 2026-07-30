"""Provision the complete Approvals, RBAC, and Settings navigation.

Several screens were added to PAGE_TREE after existing databases were seeded.
Provisioning them through Alembic keeps the database-driven menu synchronized
as part of every normal deployment.

Revision ID: f7a8b9c0d1e2
Revises: f6a7b8c9d0e1
"""
from alembic import op
import sqlalchemy as sa


revision = "f7a8b9c0d1e2"
down_revision = "f6a7b8c9d0e1"
branch_labels = None
depends_on = None


# code, path, name, icon, module, permission, sort order, parent code
PAGES = (
    ("approvals", "/approvals", "Approvals", "check-circle", "approvals",
     "indent.view", 20, None),
    ("approval_waiting", "/approvals", "Waiting for Me", "check-circle",
     "approvals", "indent.view", 21, "approvals"),
    ("approval_decisions", "/approvals/decisions", "My Decisions", "history",
     "approvals", "indent.view", 22, "approvals"),
    ("approval_team", "/approvals/team-queue", "Team Queue", "users",
     "approvals", "indent.view", 23, "approvals"),
    ("approval_delegations", "/approvals/delegations", "Delegations",
     "arrow-right-left", "approvals", "indent.view", 24, "approvals"),

    ("grp_rbac", "/rbac/access", "RBAC", "shield", "rbac",
     "admin.roles.manage", 80, None),
    ("rbac_access", "/rbac/access", "Roles & Access", "shield", "rbac",
     "admin.roles.manage", 81, "grp_rbac"),
    ("rbac_groups", "/rbac/groups", "User Groups", "users", "rbac",
     "admin.groups.manage", 82, "grp_rbac"),

    ("grp_settings", "/admin", "Settings", "settings", "admin",
     "admin.roles.manage", 90, None),
    ("admin", "/admin", "HCM & Config", "settings", "admin",
     "admin.roles.manage", 91, "grp_settings"),
    ("admin_settings", "/admin/settings", "Company Settings", "settings",
     "admin", "admin.settings.manage", 92, "grp_settings"),
    ("admin_policies", "/admin/policies", "Approval & Automation", "sparkles",
     "admin", "admin.workflow.manage", 93, "grp_settings"),
    ("admin_workflows", "/admin/workflows", "Approval Workflows", "route",
     "admin", "admin.workflow.manage", 94, "grp_settings"),
    ("admin_approvals_config", "/admin/approvals-config", "Approvals Config",
     "list-ordered", "admin", "admin.workflow.manage", 95, "grp_settings"),
    ("admin_rules", "/admin/rules", "Rules Engine", "git-branch", "admin",
     "admin.rules.manage", 96, "grp_settings"),
    ("admin_numbering", "/admin/numbering", "Document Numbering", "hash",
     "admin", "admin.numbering.manage", 97, "grp_settings"),
    ("admin_notifications", "/admin/notifications", "Notifications", "bell",
     "admin", "admin.notifications.manage", 98, "grp_settings"),
    ("admin_audit", "/admin/audit", "Audit Log", "scroll-text", "admin",
     "admin.audit.view", 99, "grp_settings"),
    ("admin_fallback", "/admin/fallback-log", "Fallback Log", "shield",
     "admin", "admin.audit.view", 100, "grp_settings"),
)


def upgrade() -> None:
    connection = op.get_bind()

    connection.execute(sa.text("""
        INSERT INTO rbac_permissions
            (code, module, resource, action, description)
        SELECT
            'admin.settings.manage', 'admin', 'settings', 'manage',
            'Manage system settings'
        WHERE NOT EXISTS (
            SELECT 1 FROM rbac_permissions
            WHERE code = 'admin.settings.manage'
        )
    """))
    connection.execute(sa.text("""
        INSERT INTO rbac_role_permissions (role_id, permission_id)
        SELECT role.id, permission.id
        FROM rbac_roles AS role
        JOIN rbac_permissions AS permission
          ON permission.code = 'admin.settings.manage'
        WHERE role.code = 'ADMIN'
          AND NOT EXISTS (
              SELECT 1
              FROM rbac_role_permissions AS existing
              WHERE existing.role_id = role.id
                AND existing.permission_id = permission.id
          )
    """))

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
    # These rows may predate this migration or be required by live documents.
    # Removing navigation or the admin grant on rollback would be destructive.
    pass
