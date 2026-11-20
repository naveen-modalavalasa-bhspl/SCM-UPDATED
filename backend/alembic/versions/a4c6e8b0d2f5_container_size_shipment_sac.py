"""container size and the shipment's SAC (MoM 2026-11-18, points 16 and 4)

- `mst_packaging.size_class` — SMALL / MEDIUM / LARGE / EXTRA_LARGE.
- `lgs_transport_requests.destination_sac` — the destination office's service area
  code, copied from the consignment when the leg is raised.

Idempotent.

Revision ID: a4c6e8b0d2f5
Revises: f3b5d7c9e1a2
Create Date: 2026-11-20
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a4c6e8b0d2f5"
down_revision: Union[str, None] = "f3b5d7c9e1a2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = (
    ("mst_packaging", "size_class", sa.String(20)),
    ("lgs_transport_requests", "destination_sac", sa.String(30)),
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table, name, kind in COLUMNS:
        if inspector.has_table(table) and name not in {c["name"] for c in inspector.get_columns(table)}:
            op.add_column(table, sa.Column(name, kind, nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table, name, _ in COLUMNS:
        if inspector.has_table(table) and name in {c["name"] for c in inspector.get_columns(table)}:
            op.drop_column(table, name)
