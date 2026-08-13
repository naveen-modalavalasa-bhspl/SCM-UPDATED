"""Merge the warehouse-policy and Acknowledgements migration branches.

The warehouse acknowledgement page was introduced on the warehouse-policy branch,
while the Indents acknowledgement rename was developed from the same earlier
revision. Joining them restores one Alembic head so deployments can use the standard
``alembic upgrade head`` command.

The warehouse-policy migration can only create ``wh_ack`` as a root page because its
parent id is installation-specific. Now that both branches are present, attach it to
the Warehouse group as the seed catalogue does.

Revision ID: f1a2b3c4d5e6
Revises: c1d2e3f4a5b6, c6f7a8b9d0e1
"""
from alembic import op
import sqlalchemy as sa


revision = "f1a2b3c4d5e6"
down_revision = ("c1d2e3f4a5b6", "c6f7a8b9d0e1")
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(sa.text("""
        UPDATE rbac_pages AS child
        JOIN rbac_pages AS parent ON parent.code = 'grp_warehouse'
        SET child.parent_id = parent.id
        WHERE child.code = 'wh_ack'
    """))


def downgrade() -> None:
    op.execute(sa.text("""
        UPDATE rbac_pages AS child
        JOIN rbac_pages AS parent ON parent.code = 'grp_warehouse'
        SET child.parent_id = NULL
        WHERE child.code = 'wh_ack' AND child.parent_id = parent.id
    """))
