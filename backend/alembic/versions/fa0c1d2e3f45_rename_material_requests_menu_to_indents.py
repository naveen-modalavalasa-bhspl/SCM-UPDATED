"""Rename the "Material Requests" menu group to "Indents".

scripts/seed.py PAGE_TREE has said "Indents" for a while; the live rbac_pages row
never caught up, so the left rail still read "Material Requests" for what is the
indents module. Targeted UPDATE rather than a reseed -- seed.py prunes.

Revision ID: fa0c1d2e3f45
Revises: f9b0c1d2e3f4
"""
from alembic import op
import sqlalchemy as sa

revision = "fa0c1d2e3f45"
down_revision = "f9b0c1d2e3f4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE rbac_pages SET name = 'Indents' "
            "WHERE code = 'grp_indents' AND name = 'Material Requests'"
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE rbac_pages SET name = 'Material Requests' "
            "WHERE code = 'grp_indents' AND name = 'Indents'"
        )
    )
