"""Who came for the load: the driver's licence number.

The one-press dispatch asked a provider leg for an AGREED FREIGHT it never needed — a
courier is booked at a published rate and a tender is priced by the carriers, so the
amount is never the desk's to type here. What the gate and the receiving site actually
chase is the person who took it. The name, phone and vehicle number were already
columns; the licence behind the wheel was not, and it is the only thing that names a
driver who is not ours.

Revision ID: d6e7f8a9b0c2
Revises: c5d6e7f8a9b2
Create Date: 2026-08-20
"""
from alembic import op
import sqlalchemy as sa

revision = "d6e7f8a9b0c2"
down_revision = "c5d6e7f8a9b2"
branch_labels = None
depends_on = None

TABLE = "lgs_transport_requests"


def _columns() -> set[str]:
    bind = op.get_bind()
    return {row[0] for row in bind.execute(sa.text(f"SHOW COLUMNS FROM {TABLE}"))}


def upgrade() -> None:
    if "driver_licence_no" not in _columns():
        op.add_column(TABLE,
                      sa.Column("driver_licence_no", sa.String(50), nullable=True))


def downgrade() -> None:
    if "driver_licence_no" in _columns():
        op.drop_column(TABLE, "driver_licence_no")
