"""Split SMO approval from completion: APPROVED rows that already moved become COMPLETED.

Approval used to move the bins at once, so every `inv_sto` SMO row carrying
`APPROVED` is a movement whose stock has already changed hands. Approval now only
signs the paperwork and a later `complete` press moves the bins and writes
COMPLETED. Without this rename those historical rows would read as "approved but
not yet moved" and offer a second completion that moves the same bins twice.

Revision ID: e9f0a1b2c3d5
Revises: e8c4b6d2a7f1
Create Date: 2026-09-19
"""
from alembic import op
import sqlalchemy as sa

revision = "e9f0a1b2c3d5"
down_revision = "e8c4b6d2a7f1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(sa.text(
        "UPDATE inv_sto SET status = 'COMPLETED' "
        "WHERE doc_kind = 'SMO' AND status = 'APPROVED'"
    ))


def downgrade() -> None:
    # Deliberately empty: COMPLETED rows cannot be told apart from rows approved
    # after the split, and converting them back would re-offer a second movement.
    pass
