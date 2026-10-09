"""po_items.delivery_days — the vendor's per-line promise, carried onto the order

The quotation states delivery days per LINE, and the purchase order raised from it
dropped them: one order commonly mixes something off the shelf with something built to
order, and the header's single expected date cannot say that. The header date and the
payment terms now come across too (`create_po_from_quotation`), but those are the
document-level promises, not this one.

Nullable with no backfill on purpose. A PO raised from an indent has no quotation
behind it, so nobody promised anything and NULL is the honest answer — inventing a
number for the rows that predate this would put a commitment on paper no vendor made.

Revision ID: c22e205fa149
Revises: f12e18b268f5
"""
from alembic import op
import sqlalchemy as sa

revision = "c22e205fa149"
down_revision = "f12e18b268f5"
branch_labels = None
depends_on = None

TABLE = "pro_po_items"
COLUMN = "delivery_days"


def _has_column() -> bool:
    """`pro_po_items` is one of the tables built by create_all rather than by a
    migration, so a database brought up by bootstrap already carries whatever the
    models declare. Checked rather than assumed, so this is safe on both routes."""
    inspector = sa.inspect(op.get_bind())
    return COLUMN in {c["name"] for c in inspector.get_columns(TABLE)}


def upgrade() -> None:
    if not _has_column():
        op.add_column(TABLE, sa.Column(COLUMN, sa.Integer(), nullable=True))


def downgrade() -> None:
    if _has_column():
        op.drop_column(TABLE, COLUMN)
