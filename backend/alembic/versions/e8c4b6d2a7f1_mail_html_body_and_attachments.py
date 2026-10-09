"""Keep what was actually sent: the html half of a message, and its attachments.

`sys_mail_messages` held `body` alone — the plain-text half — so the Sent tab answered
"what did we send the vendor" with a flat list of codes where the message on the wire
was a letterheaded table, and said nothing at all about the PDF that travelled with it.

Adds:
  * `sys_mail_messages.body_html`  LONGTEXT. An order copy with inline styles runs
    past TEXT's 64 KB, and a body silently truncated at the limit is worse than none.
  * `sys_mail_messages.attachment_count`  so the list can draw a paperclip without
    joining a table of blobs.
  * `sys_mail_attachments`  one row per file, bytes included — see the model for why
    re-deriving a document is not the same as keeping the one that was sent.

Nothing is backfilled. The html and the files of messages sent before this were never
recorded anywhere, so every historical row keeps NULL and draws its plain-text half,
which is exactly what it did yesterday.

Revision ID: e8c4b6d2a7f1
Revises: d5a7c9e1b3f4
Create Date: 2026-09-11
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

revision = "e8c4b6d2a7f1"
down_revision = "d5a7c9e1b3f4"
branch_labels = None
depends_on = None

_LONGTEXT = sa.Text().with_variant(mysql.LONGTEXT(), "mysql")
_LONGBLOB = sa.LargeBinary().with_variant(mysql.LONGBLOB(), "mysql")


def _columns(table: str) -> set[str]:
    bind = op.get_bind()
    return {c["name"] for c in sa.inspect(bind).get_columns(table)}


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    # Idempotent throughout: this tree has had a migration applied by hand more than
    # once, and a re-run must not be the thing that stops an upgrade.
    existing = _columns("sys_mail_messages")
    if "body_html" not in existing:
        op.add_column("sys_mail_messages",
                      sa.Column("body_html", _LONGTEXT, nullable=True))
    if "attachment_count" not in existing:
        op.add_column(
            "sys_mail_messages",
            sa.Column("attachment_count", sa.Integer(), nullable=False,
                      server_default="0"),
        )

    if "sys_mail_attachments" not in _tables():
        op.create_table(
            "sys_mail_attachments",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("message_id", sa.BigInteger(), nullable=False),
            sa.Column("filename", sa.String(255), nullable=False),
            sa.Column("content_type", sa.String(150), nullable=True),
            sa.Column("size_bytes", sa.BigInteger(), nullable=False,
                      server_default="0"),
            sa.Column("content", _LONGBLOB, nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False,
                      server_default=sa.func.now()),
            sa.ForeignKeyConstraint(["message_id"], ["sys_mail_messages.id"],
                                    ondelete="CASCADE"),
        )
        op.create_index("ix_sys_mail_attachments_message_id",
                        "sys_mail_attachments", ["message_id"])


def downgrade() -> None:
    if "sys_mail_attachments" in _tables():
        op.drop_index("ix_sys_mail_attachments_message_id",
                      table_name="sys_mail_attachments")
        op.drop_table("sys_mail_attachments")
    existing = _columns("sys_mail_messages")
    if "attachment_count" in existing:
        op.drop_column("sys_mail_messages", "attachment_count")
    if "body_html" in existing:
        op.drop_column("sys_mail_messages", "body_html")
