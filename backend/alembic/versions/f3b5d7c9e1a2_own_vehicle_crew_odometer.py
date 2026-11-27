"""own vehicle: vehicle types master, crew, odometer readings

- `mst_vehicle_types` — Logistics › Masters › Vehicle Types.
- `lgs_shipment_crew` — the people travelling with an own-vehicle load.
- `lgs_transport_requests` — vehicle type (id + name snapshot), crew count, and the
  odometer's start and end readings with when and by whom.

Idempotent: a table or column already there is left alone.

Revision ID: f3b5d7c9e1a2
Revises: e2a4c6b8d0f3
Create Date: 2026-11-20
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f3b5d7c9e1a2"
down_revision: Union[str, None] = "e2a4c6b8d0f3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TR = "lgs_transport_requests"
TR_COLUMNS = (
    ("vehicle_type_id", sa.BigInteger()),
    ("vehicle_type_name", sa.String(200)),
    ("crew_count", sa.Integer()),
    ("odometer_start", sa.Numeric(12, 1)),
    ("odometer_start_at", sa.DateTime()),
    ("odometer_start_by_name", sa.String(200)),
    ("odometer_end", sa.Numeric(12, 1)),
    ("odometer_end_at", sa.DateTime()),
    ("odometer_end_by_name", sa.String(200)),
)


def _inspector():
    return sa.inspect(op.get_bind())


def upgrade() -> None:
    inspector = _inspector()
    if not inspector.has_table("mst_vehicle_types"):
        op.create_table(
            "mst_vehicle_types",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("code", sa.String(10), nullable=False, unique=True),
            sa.Column("name", sa.String(200), nullable=False),
            sa.Column("description", sa.String(300), nullable=True),
            sa.Column("capacity_kg", sa.Numeric(12, 2), nullable=True),
            sa.Column("capacity_cbm", sa.Numeric(12, 3), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        )
    if inspector.has_table(TR):
        have = {c["name"] for c in inspector.get_columns(TR)}
        for name, kind in TR_COLUMNS:
            if name not in have:
                op.add_column(TR, sa.Column(name, kind, nullable=True))
        indexes = {i["name"] for i in inspector.get_indexes(TR)}
        if "ix_lgs_transport_requests_vehicle_type_id" not in indexes:
            op.create_index("ix_lgs_transport_requests_vehicle_type_id", TR, ["vehicle_type_id"])
        if not inspector.has_table("lgs_shipment_crew"):
            op.create_table(
                "lgs_shipment_crew",
                sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
                sa.Column("tr_id", sa.BigInteger(),
                          sa.ForeignKey(f"{TR}.id", ondelete="CASCADE"), nullable=False),
                sa.Column("sequence", sa.Integer(), nullable=False, server_default="1"),
                sa.Column("role", sa.String(20), nullable=False),
                sa.Column("name", sa.String(200), nullable=False),
                sa.Column("phone", sa.String(20), nullable=False),
                sa.Column("id_number", sa.String(50), nullable=True),
                sa.Column("employee_id", sa.BigInteger(), nullable=True),
            )
            op.create_index("ix_lgs_shipment_crew_tr_id", "lgs_shipment_crew", ["tr_id"])
            op.create_index("ix_lgs_shipment_crew_employee_id", "lgs_shipment_crew",
                            ["employee_id"])


def downgrade() -> None:
    inspector = _inspector()
    if inspector.has_table("lgs_shipment_crew"):
        op.drop_table("lgs_shipment_crew")
    if inspector.has_table(TR):
        have = {c["name"] for c in inspector.get_columns(TR)}
        indexes = {i["name"] for i in inspector.get_indexes(TR)}
        if "ix_lgs_transport_requests_vehicle_type_id" in indexes:
            op.drop_index("ix_lgs_transport_requests_vehicle_type_id", table_name=TR)
        for name, _ in TR_COLUMNS:
            if name in have:
                op.drop_column(TR, name)
    if inspector.has_table("mst_vehicle_types"):
        op.drop_table("mst_vehicle_types")
