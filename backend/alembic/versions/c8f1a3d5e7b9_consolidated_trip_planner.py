"""Dynamic consolidated-trip planning and verified stocking-point coordinates.

Revision ID: c8f1a3d5e7b9
Revises: b7e2d9f4a6c1
"""
import sqlalchemy as sa
from alembic import op

revision = "c8f1a3d5e7b9"
down_revision = "b7e2d9f4a6c1"
branch_labels = None
depends_on = None

QTY = sa.Numeric(16, 3)
MONEY = sa.Numeric(16, 2)


def _tables():
    return set(sa.inspect(op.get_bind()).get_table_names())


def _columns(table):
    return {row["name"] for row in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade():
    if "latitude" not in _columns("whs_warehouses"):
        op.add_column("whs_warehouses", sa.Column("latitude", sa.Numeric(10, 7)))
    if "longitude" not in _columns("whs_warehouses"):
        op.add_column("whs_warehouses", sa.Column("longitude", sa.Numeric(10, 7)))

    tables = _tables()
    if "lgs_consolidated_trips" not in tables:
        op.create_table(
            "lgs_consolidated_trips",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("trip_no", sa.String(50), nullable=False, unique=True),
            sa.Column("status", sa.String(30), nullable=False, server_default="PLANNED"),
            sa.Column("departure_date", sa.Date, nullable=False),
            sa.Column("from_warehouse_id", sa.BigInteger, nullable=False),
            sa.Column("from_warehouse_name", sa.String(200)),
            sa.Column("origin_latitude", sa.Numeric(10, 7), nullable=False),
            sa.Column("origin_longitude", sa.Numeric(10, 7), nullable=False),
            sa.Column("policy_name", sa.String(100), nullable=False, server_default="Balanced"),
            sa.Column("route_version", sa.Integer, nullable=False, server_default="1"),
            sa.Column("total_consignments", sa.Integer, nullable=False, server_default="0"),
            sa.Column("total_stops", sa.Integer, nullable=False, server_default="0"),
            sa.Column("total_packages", sa.Integer, nullable=False, server_default="0"),
            sa.Column("total_weight_kg", QTY, nullable=False, server_default="0"),
            sa.Column("vehicle_capacity_kg", QTY),
            sa.Column("estimated_distance_km", sa.Numeric(12, 2), nullable=False, server_default="0"),
            sa.Column("separate_distance_km", sa.Numeric(12, 2), nullable=False, server_default="0"),
            sa.Column("estimated_saving_km", sa.Numeric(12, 2), nullable=False, server_default="0"),
            sa.Column("estimated_saving_amount", MONEY, nullable=False, server_default="0"),
            sa.Column("vehicle_number", sa.String(50)),
            sa.Column("driver_name", sa.String(200)),
            sa.Column("driver_phone", sa.String(30)),
            sa.Column("gate_pass_no", sa.String(50)),
            sa.Column("dispatched_at", sa.DateTime),
            sa.Column("completed_at", sa.DateTime),
            sa.Column("remarks", sa.Text),
            sa.Column("created_by_id", sa.BigInteger),
            sa.Column("created_by_name", sa.String(200)),
            sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
        )
        op.create_index("ix_lgs_consolidated_trips_status", "lgs_consolidated_trips", ["status"])
        op.create_index("ix_lgs_trip_origin_status", "lgs_consolidated_trips",
                        ["from_warehouse_id", "status"])

    if "lgs_consolidated_trip_stops" not in tables:
        op.create_table(
            "lgs_consolidated_trip_stops",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("trip_id", sa.BigInteger, nullable=False),
            sa.Column("sequence", sa.Integer, nullable=False),
            sa.Column("destination_warehouse_id", sa.BigInteger, nullable=False),
            sa.Column("destination_name", sa.String(200), nullable=False),
            sa.Column("delivery_address", sa.String(500)),
            sa.Column("latitude", sa.Numeric(10, 7), nullable=False),
            sa.Column("longitude", sa.Numeric(10, 7), nullable=False),
            sa.Column("status", sa.String(30), nullable=False, server_default="PLANNED"),
            sa.Column("distance_from_previous_km", sa.Numeric(12, 2), nullable=False, server_default="0"),
            sa.Column("total_consignments", sa.Integer, nullable=False, server_default="0"),
            sa.Column("total_packages", sa.Integer, nullable=False, server_default="0"),
            sa.Column("total_weight_kg", QTY, nullable=False, server_default="0"),
            sa.Column("arrived_at", sa.DateTime),
            sa.Column("delivered_at", sa.DateTime),
            sa.ForeignKeyConstraint(["trip_id"], ["lgs_consolidated_trips.id"], ondelete="CASCADE"),
        )
        op.create_index("ix_lgs_consolidated_trip_stops_trip_id", "lgs_consolidated_trip_stops", ["trip_id"])
        op.create_index("ix_lgs_trip_stop_destination", "lgs_consolidated_trip_stops", ["destination_warehouse_id"])

    if "lgs_consolidated_trip_consignments" not in tables:
        op.create_table(
            "lgs_consolidated_trip_consignments",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("trip_id", sa.BigInteger, nullable=False),
            sa.Column("stop_id", sa.BigInteger, nullable=False),
            sa.Column("dispatch_id", sa.BigInteger, nullable=False),
            sa.Column("consignment_no", sa.String(50), nullable=False),
            sa.Column("destination_name", sa.String(200), nullable=False),
            sa.Column("packages", sa.Integer, nullable=False, server_default="0"),
            sa.Column("weight_kg", QTY, nullable=False, server_default="0"),
            sa.Column("status", sa.String(30), nullable=False, server_default="PLANNED"),
            sa.Column("delivered_at", sa.DateTime),
            sa.ForeignKeyConstraint(["trip_id"], ["lgs_consolidated_trips.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["stop_id"], ["lgs_consolidated_trip_stops.id"], ondelete="CASCADE"),
        )
        op.create_index("ix_lgs_consolidated_trip_consignments_trip_id",
                        "lgs_consolidated_trip_consignments", ["trip_id"])
        op.create_index("ix_lgs_consolidated_trip_consignments_stop_id",
                        "lgs_consolidated_trip_consignments", ["stop_id"])
        op.create_index("ix_lgs_trip_consignment_active",
                        "lgs_consolidated_trip_consignments", ["dispatch_id", "status"])


def downgrade():
    tables = _tables()
    if "lgs_consolidated_trip_consignments" in tables:
        op.drop_table("lgs_consolidated_trip_consignments")
    if "lgs_consolidated_trip_stops" in tables:
        op.drop_table("lgs_consolidated_trip_stops")
    if "lgs_consolidated_trips" in tables:
        op.drop_table("lgs_consolidated_trips")
    columns = _columns("whs_warehouses")
    if "longitude" in columns:
        op.drop_column("whs_warehouses", "longitude")
    if "latitude" in columns:
        op.drop_column("whs_warehouses", "latitude")
