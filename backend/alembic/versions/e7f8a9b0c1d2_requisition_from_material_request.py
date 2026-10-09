"""A requisition can say which material request it came from.

Closes the one gap in the backward-pointing chain: indent -> MR -> requisition -> RFQ
-> PO. Until now Purchase read an approved material request on one screen and retyped
its lines into a requisition on another, so the two documents had no link and a
quantity could differ between them without anything noticing.

Revision ID: e7f8a9b0c1d2
Revises: d6e7f8a9b0c1
"""
import sqlalchemy as sa
from alembic import op

revision = "e7f8a9b0c1d2"
down_revision = "d6e7f8a9b0c1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {c["name"] for c in inspector.get_columns("pro_requisitions")}
    if "source_mr_id" not in columns:
        # Soft FK: inventory owns inv_material_requests, and a module may not put a
        # hard constraint across that boundary (rule 10).
        op.add_column("pro_requisitions",
                      sa.Column("source_mr_id", sa.BigInteger, nullable=True))
        op.create_index("ix_pro_requisitions_source_mr_id",
                        "pro_requisitions", ["source_mr_id"])
    if "source_mr_no" not in columns:
        op.add_column("pro_requisitions",
                      sa.Column("source_mr_no", sa.String(30), nullable=True))


def downgrade() -> None:
    op.drop_index("ix_pro_requisitions_source_mr_id", table_name="pro_requisitions")
    op.drop_column("pro_requisitions", "source_mr_id")
    op.drop_column("pro_requisitions", "source_mr_no")
