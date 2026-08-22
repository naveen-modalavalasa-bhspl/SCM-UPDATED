"""Give a vendor somewhere to be told things.

`sys_notifications` is keyed on `employee_id` and a vendor is not an employee and never
will be (see `procurement.models.VendorUser`), so there was nowhere to put a message for
one. In practice that meant a buyer could amend a purchase order and the vendor was told
nothing at all: the order dropped back to DRAFT, left their portal until somebody
re-sent it, and returned later carrying different numbers with no statement anywhere
that it had changed or why.

Keyed on the VENDOR rather than on the vendor USER, so re-issuing a login never loses
the history — the message is for the company, not for whoever holds the account today.

Revision ID: b2d3e4f5a6c8
Revises: a1c2e3f4b5d6
Create Date: 2026-08-21
"""
from alembic import op
import sqlalchemy as sa

revision = "b2d3e4f5a6c8"
down_revision = "a1c2e3f4b5d6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "pro_vendor_notifications",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("vendor_id", sa.BigInteger(), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("body", sa.String(1000), nullable=True),
        sa.Column("entity_type", sa.String(30), nullable=True),
        sa.Column("entity_id", sa.BigInteger(), nullable=True),
        sa.Column("deep_link", sa.String(300), nullable=True),
        sa.Column("is_read", sa.Boolean(), nullable=False,
                  server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["vendor_id"], ["mst_vendors.id"],
                                ondelete="CASCADE"),
    )
    op.create_index("ix_pro_vendor_notif_vendor", "pro_vendor_notifications",
                    ["vendor_id"])
    # The portal's default read is "what have I not seen", so the unread filter is
    # paired with the vendor rather than indexed on its own.
    op.create_index("ix_pro_vendor_notif_unread", "pro_vendor_notifications",
                    ["vendor_id", "is_read"])


def downgrade() -> None:
    op.drop_index("ix_pro_vendor_notif_unread", table_name="pro_vendor_notifications")
    op.drop_index("ix_pro_vendor_notif_vendor", table_name="pro_vendor_notifications")
    op.drop_table("pro_vendor_notifications")
