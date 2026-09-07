"""pro_quote_otps - the emailed code a vendor needs to submit a quotation

Revision ID: d8f3a7c1e9b4
Revises: a4c8e2b7d1f9
Create Date: 2026-09-07

A tender response is a priced commitment reached through a link in an inbox. Until now
that link was the whole of the authentication. This table holds the one-time code that
proves the person pressing Submit is also reading the address the vendor registered
with us.

Only the SHA-256 of the code is stored, never the digits: a row would otherwise be a
live submit credential, and a database backup a folder full of them. Rows are kept
after use so "already used" and "never existed" stay different answers.
"""
import sqlalchemy as sa
from alembic import op

revision = "d8f3a7c1e9b4"
down_revision = "a4c8e2b7d1f9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Idempotent, like every migration here: this database is brought forward by
    # replaying whatever has not run, and a half-applied revision must not wedge it.
    bind = op.get_bind()
    if sa.inspect(bind).has_table("pro_quote_otps"):
        return

    op.create_table(
        "pro_quote_otps",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("rfq_id", sa.BigInteger(), nullable=False),
        sa.Column("vendor_id", sa.BigInteger(), nullable=False),
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("sent_to", sa.String(255), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("used_at", sa.DateTime(), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("requested_ip", sa.String(45), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False,
                  server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.PrimaryKeyConstraint("id"),
        # CASCADE: the codes issued against a deleted tender have nothing left to
        # authorise. `vendor_id` is a soft FK by contrast — `mst_vendors` is a master,
        # and a deactivated vendor's issued codes must still read back.
        sa.ForeignKeyConstraint(["rfq_id"], ["pro_rfqs.id"], ondelete="CASCADE"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index("ix_pro_quote_otps_rfq_id", "pro_quote_otps", ["rfq_id"])
    op.create_index("ix_pro_quote_otps_vendor_id", "pro_quote_otps", ["vendor_id"])
    # The lookup every verification makes.
    op.create_index("ix_pro_quote_otps_rfq_vendor", "pro_quote_otps",
                    ["rfq_id", "vendor_id"])


def downgrade() -> None:
    op.drop_table("pro_quote_otps")
