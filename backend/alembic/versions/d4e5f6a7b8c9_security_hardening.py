"""Harden requester and stock-valuation permissions.

Revision ID: d4e5f6a7b8c9
Revises: c2d3e4f5a6b7
"""
from alembic import op


revision = "d4e5f6a7b8c9"
down_revision = "c2d3e4f5a6b7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        INSERT INTO rbac_permissions
            (code, module, resource, action, description)
        SELECT
            'stock.valuation.view', 'inventory', 'stock_valuation', 'view',
            'View stock costs and valuation'
        WHERE NOT EXISTS (
            SELECT 1 FROM rbac_permissions
            WHERE code = 'stock.valuation.view'
        )
    """)
    op.execute("""
        INSERT INTO rbac_role_permissions (role_id, permission_id)
        SELECT role.id, permission.id
        FROM rbac_roles AS role
        JOIN rbac_permissions AS permission
          ON permission.code = 'stock.valuation.view'
        WHERE role.code = 'ADMIN'
          AND NOT EXISTS (
              SELECT 1
              FROM rbac_role_permissions AS existing
              WHERE existing.role_id = role.id
                AND existing.permission_id = permission.id
          )
    """)
    op.execute("""
        DELETE role_permission
        FROM rbac_role_permissions AS role_permission
        JOIN rbac_roles AS role ON role.id = role_permission.role_id
        JOIN rbac_permissions AS permission
          ON permission.id = role_permission.permission_id
        WHERE role.code = 'REQUESTER'
          AND permission.code IN ('indent.approve', 'indent.reject')
    """)
    op.execute("""
        UPDATE rbac_pages
        SET required_permission = 'stock.valuation.view'
        WHERE code = 'inv_valuation'
    """)


def downgrade() -> None:
    op.execute("""
        UPDATE rbac_pages
        SET required_permission = 'stock.view'
        WHERE code = 'inv_valuation'
    """)
    op.execute("""
        INSERT INTO rbac_role_permissions (role_id, permission_id)
        SELECT role.id, permission.id
        FROM rbac_roles AS role
        JOIN rbac_permissions AS permission
          ON permission.code IN ('indent.approve', 'indent.reject')
        WHERE role.code = 'REQUESTER'
          AND NOT EXISTS (
              SELECT 1
              FROM rbac_role_permissions AS existing
              WHERE existing.role_id = role.id
                AND existing.permission_id = permission.id
          )
    """)
    op.execute("""
        DELETE role_permission
        FROM rbac_role_permissions AS role_permission
        JOIN rbac_permissions AS permission
          ON permission.id = role_permission.permission_id
        WHERE permission.code = 'stock.valuation.view'
    """)
    op.execute("""
        DELETE FROM rbac_permissions
        WHERE code = 'stock.valuation.view'
    """)
