"""Warehouse address snapshots for the outward leg (SCM_0053, 2026-10-19).

The DC/DOD gate pass named the origin warehouse but never its address — HCM already
sends one (`hcm_offices.address`, via `platform.hcm.mappers.map_office`), but nothing
between there and the printed pass ever carried it. `whs_warehouses.address` already
exists and is unaffected here; this adds the two SNAPSHOT columns the chain was
missing: `out_dispatches.warehouse_address` (set when a consignment is raised, off
the warehouse it ships from) and `lgs_transport_requests.from_warehouse_address` (set
when a transport leg is raised, off the consignment's own snapshot) — the same rule
`warehouse_name`/`from_warehouse_name` already follow, so a document that has left the
building never goes stale because somebody later edits the warehouse master.

Both nullable and additive: an existing row simply has no address until it is next
edited or re-dispatched. Idempotent.

Revision ID: b4c6d8e0f2a4
Revises: 7d1e2f3a4b5c
"""
from alembic import op
import sqlalchemy as sa

revision = "b4c6d8e0f2a4"
down_revision = "7d1e2f3a4b5c"
branch_labels = None
depends_on = None


def _columns(table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "out_dispatches" in tables and "warehouse_address" not in _columns("out_dispatches"):
        op.add_column("out_dispatches",
                       sa.Column("warehouse_address", sa.String(500), nullable=True))
    if ("lgs_transport_requests" in tables
            and "from_warehouse_address" not in _columns("lgs_transport_requests")):
        op.add_column("lgs_transport_requests",
                       sa.Column("from_warehouse_address", sa.String(500), nullable=True))


def downgrade() -> None:
    if "warehouse_address" in _columns("out_dispatches"):
        op.drop_column("out_dispatches", "warehouse_address")
    if "from_warehouse_address" in _columns("lgs_transport_requests"):
        op.drop_column("lgs_transport_requests", "from_warehouse_address")
