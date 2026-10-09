"""Warehouse coordinate provenance for dynamic map matching.

Revision ID: d9a2b4c6e8f0
Revises: c8f1a3d5e7b9
"""
import sqlalchemy as sa
from alembic import op

revision = "d9a2b4c6e8f0"
down_revision = "c8f1a3d5e7b9"
branch_labels = None
depends_on = None


def _columns():
    return {row["name"] for row in sa.inspect(op.get_bind()).get_columns("whs_warehouses")}


def upgrade():
    columns = _columns()
    if "coordinate_source" not in columns:
        op.add_column("whs_warehouses", sa.Column("coordinate_source", sa.String(30)))
    if "coordinate_label" not in columns:
        op.add_column("whs_warehouses", sa.Column("coordinate_label", sa.String(200)))
    if "coordinate_confidence" not in columns:
        op.add_column("whs_warehouses", sa.Column("coordinate_confidence", sa.Numeric(5, 4)))
    op.execute(sa.text(
        "UPDATE whs_warehouses SET coordinate_source='MANUAL' "
        "WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND coordinate_source IS NULL"
    ))


def downgrade():
    columns = _columns()
    for name in ("coordinate_confidence", "coordinate_label", "coordinate_source"):
        if name in columns:
            op.drop_column("whs_warehouses", name)
