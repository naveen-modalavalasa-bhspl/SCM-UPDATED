"""restore_outward_qc_menu_page

Revision ID: 96dd19ed80c2
Revises: b7a4400609a7
Create Date: 2026-08-20 10:06:35.423075
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '96dd19ed80c2'
down_revision: Union[str, None] = 'b7a4400609a7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    connection = op.get_bind()
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
            sort_order = VALUES(sort_order),
            required_permission = VALUES(required_permission),
            is_active = 1
    """)
    connection.execute(upsert, {
        "code": "wh_qc_outward",
        "path": "/warehouse/qc-outward",
        "name": "Outward QC",
        "icon": "check-circle",
        # The screen is gated on its OWN page code, like every other page — sync_pages
        # mints exactly this one. It was "inspection.view", which put the row on every
        # inbound-QC profile while the endpoints under it check qc_outward.*: the menu
        # item opened straight onto a 403.
        "permission": "page.wh_qc_outward.view",
        "sort_order": 51,
    })
    
    connection.execute(sa.text("""
        UPDATE rbac_pages AS child
        JOIN rbac_pages AS parent ON parent.code = 'grp_warehouse'
        SET child.parent_id = parent.id
        WHERE child.code = 'wh_qc_outward'
    """))

def downgrade() -> None:
    pass
