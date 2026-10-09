"""A consolidated trip is carried by ONE shipment, and signed for stop by stop.

Adds the link from a trip to the transport request that prices, awards and releases
it (`tr_id`/`tr_no`), the planning inputs the route was costed with, and — per stop
and per consignment — who delivered and who signed. Also snapshots the indent behind
each consignment so logistics can answer "which trip is my material on" without
reading the warehouse's tables.

Idempotent: every column is added only if missing, so a database that was patched by
hand or half-upgraded still moves forward.

Revision ID: e3b5d7f9a1c4
Revises: d9a2b4c6e8f0
"""
import sqlalchemy as sa
from alembic import op

revision = "e3b5d7f9a1c4"
down_revision = "d9a2b4c6e8f0"
branch_labels = None
depends_on = None

MONEY = sa.Numeric(16, 2)

COLUMNS = {
    "lgs_consolidated_trips": [
        sa.Column("tr_id", sa.BigInteger),
        sa.Column("tr_no", sa.String(50)),
        sa.Column("vehicle_profile", sa.String(100)),
        sa.Column("returns_to_origin", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("road_factor", sa.Numeric(6, 3)),
        sa.Column("cost_per_km", MONEY),
        sa.Column("cancelled_at", sa.DateTime),
    ],
    "lgs_consolidated_trip_stops": [
        sa.Column("destination_code", sa.String(50)),
        sa.Column("delivered_by_name", sa.String(200)),
        sa.Column("received_by_name", sa.String(200)),
        sa.Column("acknowledged_at", sa.DateTime),
    ],
    "lgs_consolidated_trip_consignments": [
        sa.Column("destination_warehouse_id", sa.BigInteger),
        sa.Column("indent_id", sa.BigInteger),
        sa.Column("indent_no", sa.String(50)),
        sa.Column("indent_nos", sa.String(500)),
        sa.Column("acknowledged_at", sa.DateTime),
        sa.Column("acknowledged_by_name", sa.String(200)),
        sa.Column("ack_condition", sa.String(20)),
    ],
}

INDEXES = [
    ("ix_lgs_consolidated_trips_tr_id", "lgs_consolidated_trips", ["tr_id"]),
    ("ix_lgs_consolidated_trip_consignments_indent_id",
     "lgs_consolidated_trip_consignments", ["indent_id"]),
]


def _columns(table):
    return {row["name"] for row in sa.inspect(op.get_bind()).get_columns(table)}


def _indexes(table):
    return {row["name"] for row in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade():
    for table, columns in COLUMNS.items():
        present = _columns(table)
        for column in columns:
            if column.name not in present:
                op.add_column(table, column)
    for name, table, cols in INDEXES:
        if name not in _indexes(table):
            op.create_index(name, table, cols)


def downgrade():
    for name, table, _ in INDEXES:
        if name in _indexes(table):
            op.drop_index(name, table_name=table)
    for table, columns in COLUMNS.items():
        present = _columns(table)
        for column in columns:
            if column.name in present:
                op.drop_column(table, column.name)
