"""What each supplier actually WON, as against what they were asked to quote.

`pro_rfq_vendors.item_quantities` is the ASK: it is filled at send time with the
whole line for every invited supplier, so it cannot also carry the award — by the
time anything is awarded it is already populated, and overwriting it would erase what
the supplier was invited to quote for.

The split is decided against the quotations, which is the first moment anybody knows
the prices, so it belongs to the award and not to the invitation.

Revision ID: d5a7c9e1b3f4
Revises: c4f6b8d0e2a3
Create Date: 2026-09-10
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d5a7c9e1b3f4"
down_revision: Union[str, Sequence[str], None] = "c4f6b8d0e2a3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "pro_rfq_vendors",
        sa.Column("awarded_quantities", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("pro_rfq_vendors", "awarded_quantities")
