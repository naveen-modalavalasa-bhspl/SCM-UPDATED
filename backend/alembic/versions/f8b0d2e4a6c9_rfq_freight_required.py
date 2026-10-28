"""An RFQ says whether it asks for freight (2026-10-27).

`pro_rfqs.freight_required` — the buyer's switch. Off, the supplier portal shows no
Freight field and a quote's freight is saved as 0; on, the supplier quotes it.
Existing RFQs read as off. Idempotent.

Revision ID: f8b0d2e4a6c9
Revises: e6a8c0d2f4b7
Create Date: 2026-10-27
"""
import sqlalchemy as sa
from alembic import op

revision = "f8b0d2e4a6c9"
down_revision = "e6a8c0d2f4b7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("pro_rfqs")}
    if "freight_required" not in cols:
        op.add_column("pro_rfqs", sa.Column("freight_required", sa.Boolean(),
                                            nullable=False, server_default=sa.false()))


def downgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("pro_rfqs")}
    if "freight_required" in cols:
        op.drop_column("pro_rfqs", "freight_required")
