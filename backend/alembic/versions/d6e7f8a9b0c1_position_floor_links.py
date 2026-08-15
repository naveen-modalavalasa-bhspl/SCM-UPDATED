"""A position link can name the FLOOR it works, not just the warehouse.

HCM models the warehouse floor as the position's section ("WAREHOUSE OFFICE @1ST",
"WAREHOUSE-2ND"). Until now a position was only ever linked to a whole warehouse, so a
floor in-charge saw everything in the building or — where HCM had made the second floor
its own office — nothing at all.

`inv_position_locations.location_id` is a soft FK to `whs_warehouse_locations`: NULL
means the whole warehouse, which is what every existing row means and keeps meaning.

Revision ID: d6e7f8a9b0c1
Revises: c5d6e7f8a9b0
"""
import sqlalchemy as sa
from alembic import op

revision = "d6e7f8a9b0c1"
down_revision = "c5d6e7f8a9b0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {c["name"] for c in inspector.get_columns("inv_position_locations")}
    if "location_id" not in columns:
        op.add_column("inv_position_locations",
                      sa.Column("location_id", sa.BigInteger, nullable=True))
        op.create_index("ix_inv_position_locations_location_id",
                        "inv_position_locations", ["location_id"])
    # The floor this link was derived from, kept verbatim so a rename in HCM can be
    # spotted rather than silently creating a second floor. See
    # inventory.locations.rebuild_stocking_points.
    if "section_name" not in columns:
        op.add_column("inv_position_locations",
                      sa.Column("section_name", sa.String(200), nullable=True))


def downgrade() -> None:
    op.drop_index("ix_inv_position_locations_location_id",
                  table_name="inv_position_locations")
    op.drop_column("inv_position_locations", "location_id")
    op.drop_column("inv_position_locations", "section_name")
