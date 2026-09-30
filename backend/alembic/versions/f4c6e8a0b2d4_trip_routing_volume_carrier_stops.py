"""Road distances, load volume and carrier-reported stops for multi-drop trips.

* `lgs_road_distances` — the cache of routed road kilometres between map points
  (`logistics/routing.py`), one row per direction, keyed on five-decimal coordinates.
* `lgs_consolidated_trips.distance_basis` / `vehicle_capacity_cbm` /
  `total_volume_cbm` — what a plan's kilometres were measured with, and the cargo
  box it was checked against.
* `lgs_consolidated_trip_stops.delivered_via` / `pod_url` / `contact_person` /
  `contact_phone` — who reported the stop (the desk or the carrier's portal), their
  proof for THAT stop, and who the driver rings at the gate.

Idempotent: every table and column is created only if missing.

Revision ID: f4c6e8a0b2d4
Revises: e3b5d7f9a1c4
"""
import sqlalchemy as sa
from alembic import op

revision = "f4c6e8a0b2d4"
down_revision = "e3b5d7f9a1c4"
branch_labels = None
depends_on = None

COLUMNS = {
    "lgs_consolidated_trips": [
        sa.Column("distance_basis", sa.String(20)),
        sa.Column("vehicle_capacity_cbm", sa.Numeric(10, 3)),
        sa.Column("total_volume_cbm", sa.Numeric(12, 4)),
    ],
    "lgs_consolidated_trip_stops": [
        sa.Column("delivered_via", sa.String(20)),
        sa.Column("pod_url", sa.String(500)),
        sa.Column("contact_person", sa.String(200)),
        sa.Column("contact_phone", sa.String(20)),
    ],
}


def _inspector():
    return sa.inspect(op.get_bind())


def _columns(table):
    return {row["name"] for row in _inspector().get_columns(table)}


def upgrade():
    if "lgs_road_distances" not in _inspector().get_table_names():
        op.create_table(
            "lgs_road_distances",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("pair_key", sa.String(64), nullable=False),
            sa.Column("from_lat", sa.Numeric(10, 5), nullable=False),
            sa.Column("from_lon", sa.Numeric(10, 5), nullable=False),
            sa.Column("to_lat", sa.Numeric(10, 5), nullable=False),
            sa.Column("to_lon", sa.Numeric(10, 5), nullable=False),
            sa.Column("distance_km", sa.Numeric(12, 3), nullable=False),
            sa.Column("duration_min", sa.Numeric(12, 2)),
            sa.Column("source", sa.String(40), nullable=False),
            sa.Column("fetched_at", sa.DateTime, nullable=False),
            sa.UniqueConstraint("pair_key", name="uq_lgs_road_distances_pair_key"),
        )
        # The planner reads the cache by both ends of the pair.
        op.create_index("ix_lgs_road_distances_from", "lgs_road_distances",
                        ["from_lat", "from_lon"])
        op.create_index("ix_lgs_road_distances_to", "lgs_road_distances",
                        ["to_lat", "to_lon"])
    for table, columns in COLUMNS.items():
        present = _columns(table)
        for column in columns:
            if column.name not in present:
                op.add_column(table, column)


def downgrade():
    for table, columns in COLUMNS.items():
        present = _columns(table)
        for column in columns:
            if column.name in present:
                op.drop_column(table, column.name)
    if "lgs_road_distances" in _inspector().get_table_names():
        op.drop_table("lgs_road_distances")
