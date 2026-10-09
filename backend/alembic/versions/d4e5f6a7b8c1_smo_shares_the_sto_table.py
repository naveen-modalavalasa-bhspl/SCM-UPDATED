"""Give a Stock Movement Order somewhere to live, so it can be approved.

`create_stock_movement_order` minted a number, moved the stock and returned. No header
row was ever written — the code said so outright: "the document IS its ref_no". So an
SMO could not be approved, rejected, held, or looked up afterwards, and the
`MOVEMENT_APPROVE` permission had been defined for months with no route able to use it.

It shares `inv_sto` rather than taking a table of its own, because a transfer order and
a movement order are the same paperwork: a header, lines, and a
DRAFT -> PENDING_APPROVAL -> APPROVED ladder. What they do NOT share is what approval
means — a transfer moves stock on RECEIPT, a movement moves it on APPROVAL — so
`doc_kind` is load-bearing and every reader filters on it. See the note on
`inventory.models.STO_KIND_TRANSFER`.

Every existing row is a transfer, so `doc_kind` defaults to 'STO' and the backfill is
the server default doing its job. The four line columns are null on every transfer and
stay that way: a transfer names warehouses and lets putaway choose the bin at the far
end, while a movement IS the choice of bin.

Revision ID: d4e5f6a7b8c1
Revises: c3d4e5f6a7b9
Create Date: 2026-08-21
"""
from alembic import op
import sqlalchemy as sa

revision = "d4e5f6a7b8c1"
down_revision = "c3d4e5f6a7b9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("inv_sto", sa.Column(
        "doc_kind", sa.String(10), nullable=False, server_default="STO"))
    op.create_index("ix_inv_sto_doc_kind", "inv_sto", ["doc_kind"])

    op.add_column("inv_sto_items", sa.Column("source_bin_id", sa.BigInteger(),
                                             nullable=True))
    op.add_column("inv_sto_items", sa.Column("destination_bin_id", sa.BigInteger(),
                                             nullable=True))
    op.add_column("inv_sto_items", sa.Column("batch_id", sa.BigInteger(),
                                             nullable=True))
    op.add_column("inv_sto_items", sa.Column("serial_numbers", sa.JSON(),
                                             nullable=True))


def downgrade() -> None:
    op.drop_column("inv_sto_items", "serial_numbers")
    op.drop_column("inv_sto_items", "batch_id")
    op.drop_column("inv_sto_items", "destination_bin_id")
    op.drop_column("inv_sto_items", "source_bin_id")
    op.drop_index("ix_inv_sto_doc_kind", table_name="inv_sto")
    op.drop_column("inv_sto", "doc_kind")
