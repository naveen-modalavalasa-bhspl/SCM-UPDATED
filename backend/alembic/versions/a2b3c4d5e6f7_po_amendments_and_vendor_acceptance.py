"""Purchase order: the vendor's answer, amendments, and a repair of the folded freight

Three things, all additive except the last, which repairs rows this branch itself
mis-stated:

  * `vendor_status` / `vendor_responded_at` / `vendor_response_note` — what the vendor
    said about the order we sent them. Deliberately NOT a new `POStatus`: every filter,
    badge, GRN guard and report already knows the statuses, and a counterparty's answer
    is a different axis from where the document sits in our own process.
  * `revision_no` / `amended_at` / `amendment_reason`, plus `pro_po_revisions` — an
    amendment writes the whole previous order away before changing anything, so what a
    vendor agreed to is never overwritten.
  * The folded freight, undone. Until the freight column existed, a PO raised from a
    quotation added the quote's freight INTO `sub_total`. Now that the buyer can see
    and edit a freight field, that fold double-counts the moment anybody saves the
    header. Repaired only where the arithmetic proves the fold — `sub_total` exceeds
    the sum of the lines by exactly the quote's freight, and `freight_amount` is still
    zero — and `total_amount` is left alone, because it was already right.

Revision ID: a2b3c4d5e6f7
Revises: f4a5b6c7d8e9
"""
from alembic import op
import sqlalchemy as sa

revision = "a2b3c4d5e6f7"
down_revision = "f4a5b6c7d8e9"
branch_labels = None
depends_on = None

TABLE = "pro_purchase_orders"

COLUMNS = [
    ("vendor_status", sa.String(20), True, None),
    ("vendor_responded_at", sa.DateTime(timezone=True), True, None),
    ("vendor_response_note", sa.Text(), True, None),
    ("revision_no", sa.Integer(), False, "0"),
    ("amended_at", sa.DateTime(timezone=True), True, None),
    ("amendment_reason", sa.Text(), True, None),
]


def _columns(table: str) -> set[str]:
    bind = op.get_bind()
    return {row[0] for row in bind.execute(sa.text(f"SHOW COLUMNS FROM `{table}`"))}


def _tables() -> set[str]:
    bind = op.get_bind()
    return {row[0] for row in bind.execute(sa.text("SHOW TABLES"))}


def upgrade() -> None:
    have = _columns(TABLE)
    for name, type_, nullable, default in COLUMNS:
        if name in have:
            continue
        op.add_column(TABLE, sa.Column(
            name, type_, nullable=nullable,
            server_default=sa.text(default) if default is not None else None,
        ))
    if "vendor_status" not in have:
        op.create_index(f"ix_{TABLE}_vendor_status", TABLE, ["vendor_status"])

    if "pro_po_revisions" not in _tables():
        op.create_table(
            "pro_po_revisions",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("po_id", sa.BigInteger, nullable=False),
            sa.Column("revision_no", sa.Integer, nullable=False, server_default="0"),
            sa.Column("reason", sa.Text, nullable=True),
            sa.Column("status", sa.String(30), nullable=True),
            sa.Column("vendor_status", sa.String(20), nullable=True),
            sa.Column("snapshot", sa.JSON, nullable=True),
            sa.Column("changed_by_id", sa.BigInteger, nullable=True),
            sa.Column("changed_by_name", sa.String(200), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True),
                      server_default=sa.func.now(), nullable=False),
            sa.ForeignKeyConstraint(["po_id"], ["pro_purchase_orders.id"],
                                    ondelete="CASCADE"),
            mysql_charset="utf8mb4",
            mysql_collate="utf8mb4_unicode_ci",
        )
        op.create_index("ix_pro_po_revisions_po_id", "pro_po_revisions", ["po_id"])

    # An order already sent to a vendor has been asked for; it has just never been
    # answered. Marking it PENDING is what the send would have done, so the acceptance
    # screen shows the orders that are genuinely outstanding rather than an empty list.
    op.execute(sa.text(
        "UPDATE pro_purchase_orders SET vendor_status = 'PENDING' "
        "WHERE vendor_status IS NULL AND status IN "
        "('SENT_TO_VENDOR', 'PARTIALLY_RECEIVED')"
    ))
    # Anything already received was accepted in practice, whatever the paperwork said.
    op.execute(sa.text(
        "UPDATE pro_purchase_orders SET vendor_status = 'ACCEPTED' "
        "WHERE vendor_status IS NULL AND status IN ('RECEIVED', 'CLOSED')"
    ))

    # Unfold the freight. Guarded three ways: the PO came off a quotation, its own
    # freight is still zero, and the gap between sub_total and the sum of its lines is
    # EXACTLY that quotation's freight. Anything else is left alone — a row that does
    # not match that shape is not the bug this repairs.
    op.execute(sa.text("""
        UPDATE pro_purchase_orders p
          JOIN pro_quotations q ON q.id = p.quotation_id
          JOIN (SELECT po_id, COALESCE(SUM(amount), 0) AS lines_total
                  FROM pro_po_items GROUP BY po_id) i ON i.po_id = p.id
           SET p.sub_total = i.lines_total,
               p.freight_amount = q.freight_amount
         WHERE COALESCE(p.freight_amount, 0) = 0
           AND COALESCE(q.freight_amount, 0) > 0
           AND p.sub_total - i.lines_total = q.freight_amount
    """))


def downgrade() -> None:
    have = _columns(TABLE)
    if "pro_po_revisions" in _tables():
        op.drop_table("pro_po_revisions")
    if "vendor_status" in have:
        op.drop_index(f"ix_{TABLE}_vendor_status", table_name=TABLE)
    for name, *_ in COLUMNS:
        if name in have:
            op.drop_column(TABLE, name)
