"""sys_mail_messages + sys_password_resets

Two new tables, nothing altered. Additive on purpose: this ships beside a working
system, so a deployment that never configures a mailbox gains two empty tables and
behaves exactly as it did before.

Revision ID: c49dca12c5f5
Revises: d4e5f6a7b8c1
Create Date: 2026-08-23
"""
import sqlalchemy as sa
from alembic import op

revision = "c49dca12c5f5"
down_revision = "d4e5f6a7b8c1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = set(sa.inspect(bind).get_table_names())

    # Guarded: a database built by `scripts.bootstrap` already has both tables from
    # the models, and this migration has to be a no-op there rather than an error.
    if "sys_password_resets" not in existing:
        op.create_table(
            "sys_password_resets",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("employee_id", sa.BigInteger(), nullable=False),
            # SHA-256 hex of the token that went out. The raw token is NEVER stored:
            # a reset link is a bearer secret, so a row (or a backup) must not carry
            # anything that can be replayed against an account.
            sa.Column("token_hash", sa.String(length=64), nullable=False),
            sa.Column("expires_at", sa.DateTime(), nullable=False),
            sa.Column("used_at", sa.DateTime(), nullable=True),
            sa.Column("requested_ip", sa.String(length=45), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("token_hash", name="uq_sys_password_resets_token"),
        )
        op.create_index("ix_sys_password_resets_employee_id",
                        "sys_password_resets", ["employee_id"])

    if "sys_mail_messages" not in existing:
        op.create_table(
            "sys_mail_messages",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("to_addrs", sa.String(length=1000), nullable=False),
            sa.Column("cc_addrs", sa.String(length=1000), nullable=True),
            sa.Column("subject", sa.String(length=500), nullable=True),
            sa.Column("body", sa.Text(), nullable=True),
            sa.Column("status", sa.String(length=20), nullable=False),
            sa.Column("error", sa.Text(), nullable=True),
            sa.Column("kind", sa.String(length=30), nullable=False,
                      server_default="MANUAL"),
            sa.Column("sent_by_id", sa.BigInteger(), nullable=True),
            sa.Column("sent_by_name", sa.String(length=200), nullable=True),
            sa.Column("sent_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_sys_mail_messages_status", "sys_mail_messages", ["status"])
        op.create_index("ix_sys_mail_messages_kind", "sys_mail_messages", ["kind"])
        op.create_index("ix_sys_mail_messages_sent_by_id",
                        "sys_mail_messages", ["sent_by_id"])
        op.create_index("ix_sys_mail_messages_created_at",
                        "sys_mail_messages", ["created_at"])


def downgrade() -> None:
    op.drop_table("sys_mail_messages")
    op.drop_table("sys_password_resets")
