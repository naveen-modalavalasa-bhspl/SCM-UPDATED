"""Payment terms master, PO payment milestones, and the accounts module (2026-10-06).

* `mst_payment_terms` — the four-milestone split (advance / against delivery / post
  installation / post warranty), each a percent and a number of days.
* `pro_purchase_orders.payment_term_id` and `pro_po_payment_milestones` — the term a PO
  picked, frozen onto the order.
* `acc_vendor_payments` — payments recorded by accounts, signed on VENDOR_PAYMENT.

Idempotent: each table and column is created only when missing.

Revision ID: d6f8b0c2e4a6
Revises: c5e7a9b1d3f5
Create Date: 2026-10-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d6f8b0c2e4a6"
down_revision: Union[str, Sequence[str], None] = "c5e7a9b1d3f5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _columns(table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _ts():
    return [sa.Column("created_at", sa.DateTime(timezone=True),
                      server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True),
                      server_default=sa.func.now(), nullable=True)]


def upgrade() -> None:
    tables = _tables()
    if "mst_payment_terms" not in tables:
        stages = []
        for f in ("advance", "delivery", "installation", "warranty"):
            stages += [sa.Column(f"{f}_pct", sa.Numeric(5, 2), nullable=False,
                                 server_default="0"),
                       sa.Column(f"{f}_days", sa.Integer, nullable=False,
                                 server_default="0")]
        op.create_table(
            "mst_payment_terms",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("code", sa.String(20), nullable=False, unique=True),
            sa.Column("name", sa.String(150), nullable=False),
            sa.Column("description", sa.String(300), nullable=True),
            *stages,
            sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
            *_ts(),
        )

    if "payment_term_id" not in _columns("pro_purchase_orders"):
        op.add_column("pro_purchase_orders",
                      sa.Column("payment_term_id", sa.BigInteger, nullable=True))
        op.create_index("ix_pro_purchase_orders_payment_term_id",
                        "pro_purchase_orders", ["payment_term_id"])

    if "pro_po_payment_milestones" not in tables:
        op.create_table(
            "pro_po_payment_milestones",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("po_id", sa.BigInteger,
                      sa.ForeignKey("pro_purchase_orders.id", ondelete="CASCADE"),
                      nullable=False, index=True),
            sa.Column("seq", sa.Integer, nullable=False, server_default="1"),
            sa.Column("stage", sa.String(30), nullable=False),
            sa.Column("percent", sa.Numeric(5, 2), nullable=False),
            sa.Column("due_days", sa.Integer, nullable=False, server_default="0"),
        )

    if "acc_vendor_payments" not in tables:
        op.create_table(
            "acc_vendor_payments",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("payment_no", sa.String(30), nullable=False, unique=True),
            sa.Column("po_id", sa.BigInteger, sa.ForeignKey("pro_purchase_orders.id"),
                      nullable=False, index=True),
            sa.Column("po_no", sa.String(30), nullable=True),
            sa.Column("milestone_id", sa.BigInteger,
                      sa.ForeignKey("pro_po_payment_milestones.id"),
                      nullable=False, index=True),
            sa.Column("stage", sa.String(30), nullable=False),
            sa.Column("vendor_id", sa.BigInteger, sa.ForeignKey("mst_vendors.id"),
                      nullable=False, index=True),
            sa.Column("vendor_name", sa.String(200), nullable=True),
            sa.Column("project_id", sa.BigInteger, nullable=True, index=True),
            sa.Column("amount", sa.Numeric(16, 2), nullable=False),
            sa.Column("paid_on", sa.Date, nullable=False),
            sa.Column("mode", sa.String(20), nullable=False),
            sa.Column("reference_no", sa.String(100), nullable=True),
            sa.Column("invoice_attachment_id", sa.BigInteger, nullable=True, index=True),
            sa.Column("remarks", sa.Text, nullable=True),
            sa.Column("status", sa.String(30), nullable=False, index=True),
            sa.Column("current_approver_name", sa.String(200), nullable=True),
            sa.Column("created_by_id", sa.BigInteger, nullable=True, index=True),
            sa.Column("created_by_name", sa.String(200), nullable=True),
            sa.Column("approved_by_id", sa.BigInteger, nullable=True, index=True),
            sa.Column("approved_by_name", sa.String(200), nullable=True),
            sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
            *_ts(),
        )
        op.create_index("ix_acc_payment_milestone_status", "acc_vendor_payments",
                        ["milestone_id", "status"])


def downgrade() -> None:
    tables = _tables()
    if "acc_vendor_payments" in tables:
        op.drop_table("acc_vendor_payments")
    if "pro_po_payment_milestones" in tables:
        op.drop_table("pro_po_payment_milestones")
    if "payment_term_id" in _columns("pro_purchase_orders"):
        op.drop_index("ix_pro_purchase_orders_payment_term_id",
                      table_name="pro_purchase_orders")
        op.drop_column("pro_purchase_orders", "payment_term_id")
    if "mst_payment_terms" in tables:
        op.drop_table("mst_payment_terms")
