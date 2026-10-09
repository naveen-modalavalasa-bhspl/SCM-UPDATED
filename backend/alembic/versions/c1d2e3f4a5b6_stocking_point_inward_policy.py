"""Per-stocking-point "does this point run Material Inward?" policy.

Adds `whs_warehouses.requires_inward` plus the company-wide default it falls back
to, and finally puts Acknowledge Delivery on the menu — the screen existed and was
routed, but no `rbac_pages` row ever pointed at it, so nobody could reach it
without typing the URL.

Both the column and the setting default to today's behaviour: acknowledging a
transfer consignment credits the stock. Nothing changes until somebody switches a
point on.

Revision ID: c1d2e3f4a5b6
Revises: b9c1d2e3f4a6
"""
from alembic import op
import sqlalchemy as sa


revision = "c1d2e3f4a5b6"
down_revision = "b9c1d2e3f4a6"
branch_labels = None
depends_on = None


def _has_column(connection, table: str, column: str) -> bool:
    return bool(connection.execute(sa.text("""
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = :table AND column_name = :column
    """), {"table": table, "column": column}).scalar())


def upgrade() -> None:
    connection = op.get_bind()

    if not _has_column(connection, "whs_warehouses", "requires_inward"):
        op.add_column(
            "whs_warehouses",
            sa.Column("requires_inward", sa.Boolean(), nullable=True),
        )

    # NULL on the warehouse reads this. 'false' keeps every existing point on the
    # behaviour it has today; an admin turns GRN + QC on where it is actually run.
    connection.execute(sa.text("""
        INSERT INTO sys_settings
            (setting_key, setting_value, value_type, category, description,
             is_editable, updated_at)
        SELECT 'warehouse.requires_inward_default', 'false', 'bool', 'warehouse',
               'Default for stocking points that have not set their own inward '
               'policy: true = arrivals need Material Inward, GRN and QC before '
               'they count as stock.',
               1, NOW()
        WHERE NOT EXISTS (
            SELECT 1 FROM sys_settings
            WHERE setting_key = 'warehouse.requires_inward_default'
        )
    """))

    connection.execute(sa.text("""
        INSERT INTO rbac_pages
            (code, path, name, icon, module, parent_id, sort_order,
             required_permission, show_on_mobile, is_active)
        VALUES
            ('wh_ack', '/warehouse/acknowledge-delivery', 'Acknowledge Delivery',
             'check-circle', 'warehouse', NULL, 50, 'dispatch.acknowledge', 1, 1)
        ON DUPLICATE KEY UPDATE
            path = VALUES(path),
            name = VALUES(name),
            icon = VALUES(icon),
            module = VALUES(module),
            sort_order = VALUES(sort_order),
            required_permission = VALUES(required_permission),
            is_active = 1
    """))

    # Slot 50 belonged to Purchase Returns. Re-stated absolutely rather than shifted
    # by one, so re-running the migration lands on the same order instead of walking
    # the tail of the menu further down every time.
    for code, order in (("wh_returns", 51), ("wh_notifications", 52),
                        ("wh_reports", 53), ("wh_masters", 54)):
        connection.execute(
            sa.text("UPDATE rbac_pages SET sort_order = :order WHERE code = :code"),
            {"order": order, "code": code},
        )

    # Sit the new row under whichever group the other warehouse screens hang off,
    # rather than assuming a code: the live menu was seeded before this migration.
    connection.execute(sa.text("""
        UPDATE rbac_pages AS ack
        JOIN (SELECT parent_id FROM rbac_pages
              WHERE code = 'wh_dispatch' LIMIT 1) AS sibling
        SET ack.parent_id = sibling.parent_id
        WHERE ack.code = 'wh_ack'
    """))

    # Whoever can already see a dispatch is who receives one. Granting off the
    # existing view permission avoids guessing role codes that differ per database.
    connection.execute(sa.text("""
        INSERT INTO rbac_role_permissions (role_id, permission_id)
        SELECT viewer.role_id, ack.id
        FROM rbac_role_permissions AS viewer
        JOIN rbac_permissions AS seen ON seen.id = viewer.permission_id
                                     AND seen.code = 'dispatch.view'
        JOIN rbac_permissions AS ack ON ack.code = 'dispatch.acknowledge'
        WHERE NOT EXISTS (
            SELECT 1 FROM rbac_role_permissions AS existing
            WHERE existing.role_id = viewer.role_id
              AND existing.permission_id = ack.id
        )
    """))


def downgrade() -> None:
    # The menu row and the grant may be in use by live sessions, and dropping the
    # column would lose an admin's configuration. Rolling back leaves them.
    pass
