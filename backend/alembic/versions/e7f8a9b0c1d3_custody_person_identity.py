"""Who took the load, pinned to a number.

The dispatch screen has always asked WHO custody passed to — an employee by their
employee id, anybody else by an Aadhaar, plus a number to ring on the day — and had
nowhere to put the answer, so every one of them was typed and thrown away. The same
pair now identifies the driver of an own vehicle, who is the person the load travels
with; their name and phone stay in the driver columns beside the vehicle.

Revision ID: e7f8a9b0c1d3
Revises: d6e7f8a9b0c2
Create Date: 2026-08-20
"""
from alembic import op
import sqlalchemy as sa

revision = "e7f8a9b0c1d3"
down_revision = "d6e7f8a9b0c2"
branch_labels = None
depends_on = None

TABLE = "lgs_transport_requests"
COLUMNS = (
    ("handed_over_employee_id", sa.String(50)),
    ("handed_over_aadhaar", sa.String(12)),
    ("handed_over_phone", sa.String(30)),
)


def _columns() -> set[str]:
    bind = op.get_bind()
    return {row[0] for row in bind.execute(sa.text(f"SHOW COLUMNS FROM {TABLE}"))}


def upgrade() -> None:
    existing = _columns()
    for name, type_ in COLUMNS:
        if name not in existing:
            op.add_column(TABLE, sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    existing = _columns()
    for name, _type in reversed(COLUMNS):
        if name in existing:
            op.drop_column(TABLE, name)
