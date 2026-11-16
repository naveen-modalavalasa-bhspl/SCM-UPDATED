"""The unit codes a stock audit writes off, on the line that writes them off.

A DAMAGE / EXPIRY / SHORTAGE audit took the stock away but its codes stayed
`available` in `whs_serial_numbers`: the issue screen kept offering codes for
units the auditor had declared gone. The audit line now CARRIES the codes it
retires (`serial_numbers` on `inv_adjustment_items`), stored on the line so the
document remains the record of which physical units died; the warehouse module
retires exactly those rows inside the posting transaction, through
`inventory.hooks.ON_ADJUSTMENT_OUT`.

The column is added raw and IF NOT EXISTS, like its neighbours on this table:
a database built by bootstrap's create_all already has it from the model, and
this migration only has to catch the ones that do not.

Revision ID: a1b0c9d8e7f6
Revises: fe8c42388ba7
Create Date: 2026-10-13
"""
from alembic import op
import sqlalchemy as sa
from typing import Sequence, Union


revision: str = "a1b0c9d8e7f6"
down_revision: Union[str, Sequence[str], None] = "fe8c42388ba7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE inv_adjustment_items
        ADD COLUMN serial_numbers JSON NULL
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE inv_adjustment_items
        DROP COLUMN serial_numbers
    """)
