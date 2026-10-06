"""Quotation lifecycle: freeze prices, change requests, quote chat.

Three pieces of one lifecycle (2026-09-26):

  * `pro_rfqs` gains the Freeze Prices columns — the lock a buyer closes before
    comparing and awarding, and the gate every PO raised off the tender hangs on.
  * `pro_quotations` gains the negotiation badge columns (`under_negotiation`,
    `accepted_revision`) — a badge COLUMN, not a new QuotationStatus, so every
    existing filter, KPI and report keeps its meaning.
  * `pro_quote_change_requests` and `pro_quotation_comments` are new tables: the
    buyer's ask on a supplier's price (with the before-snapshot, so the price
    trail always has a version to diff against) and the thread beside the paper.

All additive — no backfill: the flags default false and the trails start empty.
A NEW database is built by bootstrap's create_all from the models, which already
carry every table and column named here; this revision brings EXISTING databases
forward.

Revision ID: a2c4e6f8b1d3
Revises: e8b1d4f7a2c3
"""
from alembic import op
import sqlalchemy as sa


revision = "a2c4e6f8b1d3"
down_revision = "e8b1d4f7a2c3"
branch_labels = None
depends_on = None


def _has_column(bind, table: str, column: str) -> bool:
    """The database may already carry any of this from a bootstrap create_all —
    stamp-then-upgrade and a re-run of bootstrap against an old schema are both
    real histories here. Every step is therefore written idempotently."""
    cols = sa.inspect(bind).get_columns(table)
    return any(col["name"] == column for col in cols)


def _has_table(bind, table: str) -> bool:
    return sa.inspect(bind).has_table(table)


def upgrade() -> None:
    bind = op.get_bind()

    # ── pro_rfqs: Freeze Prices ──────────────────────────────────────────── #
    if not _has_column(bind, "pro_rfqs", "is_price_frozen"):
        op.add_column("pro_rfqs",
                      sa.Column("is_price_frozen", sa.Boolean(), nullable=False,
                                server_default=sa.text("0")))
    if not _has_column(bind, "pro_rfqs", "frozen_at"):
        op.add_column("pro_rfqs", sa.Column("frozen_at", sa.DateTime(timezone=True),
                                            nullable=True))
    if not _has_column(bind, "pro_rfqs", "frozen_by_id"):
        op.add_column("pro_rfqs", sa.Column("frozen_by_id", sa.BigInteger(),
                                            nullable=True))
    if not _has_column(bind, "pro_rfqs", "frozen_by_name"):
        op.add_column("pro_rfqs", sa.Column("frozen_by_name", sa.String(200),
                                            nullable=True))
    if not _has_column(bind, "pro_rfqs", "frozen_at_revision"):
        op.add_column("pro_rfqs", sa.Column("frozen_at_revision", sa.Integer(),
                                            nullable=True))

    # ── pro_quotations: negotiation badge ────────────────────────────────── #
    if not _has_column(bind, "pro_quotations", "under_negotiation"):
        op.add_column("pro_quotations",
                      sa.Column("under_negotiation", sa.Boolean(), nullable=False,
                                server_default=sa.text("0")))
    if not _has_column(bind, "pro_quotations", "accepted_revision"):
        op.add_column("pro_quotations",
                      sa.Column("accepted_revision", sa.Integer(), nullable=False,
                                server_default=sa.text("0")))

    # ── pro_quote_change_requests: the buyer's ask on a supplier's price ─── #
    if not _has_table(bind, "pro_quote_change_requests"):
        op.create_table(
            "pro_quote_change_requests",
            sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
            sa.Column("quotation_id", sa.BigInteger(),
                      sa.ForeignKey("pro_quotations.id", ondelete="CASCADE"),
                      nullable=False),
            sa.Column("rfq_id", sa.BigInteger(),
                      sa.ForeignKey("pro_rfqs.id"), nullable=False),
            sa.Column("cr_no", sa.String(30), nullable=False, unique=True),
            sa.Column("status", sa.String(30), nullable=False),
            sa.Column("reason", sa.Text(), nullable=False),
            sa.Column("proposed_lines", sa.JSON(), nullable=False),
            sa.Column("snapshot_before", sa.JSON(), nullable=False),
            sa.Column("proposed_by_id", sa.BigInteger(), nullable=True),
            sa.Column("proposed_by_name", sa.String(200), nullable=True),
            sa.Column("supplier_decision_note", sa.Text(), nullable=True),
            sa.Column("supplier_decided_at", sa.DateTime(timezone=True),
                      nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True),
                      server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True),
                      server_default=sa.func.now(), nullable=False),
        )
        op.create_index("ix_pro_quote_change_requests_quotation_id",
                        "pro_quote_change_requests", ["quotation_id"])
        op.create_index("ix_pro_quote_change_requests_rfq_id",
                        "pro_quote_change_requests", ["rfq_id"])
        op.create_index("ix_pro_quote_change_requests_status",
                        "pro_quote_change_requests", ["status"])
        op.create_index("ix_pro_quote_cr_quote_status",
                        "pro_quote_change_requests",
                        ["quotation_id", "status"])

    # ── pro_quotation_comments: the thread beside the paper ──────────────── #
    if not _has_table(bind, "pro_quotation_comments"):
        op.create_table(
            "pro_quotation_comments",
            sa.Column("id", sa.BigInteger(), autoincrement=True, primary_key=True),
            sa.Column("quotation_id", sa.BigInteger(),
                      sa.ForeignKey("pro_quotations.id", ondelete="CASCADE"),
                      nullable=False),
            sa.Column("author_id", sa.BigInteger(), nullable=True),
            sa.Column("author_name", sa.String(200), nullable=True),
            sa.Column("author_side", sa.String(10), nullable=False,
                      server_default="BUYER"),
            sa.Column("message", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True),
                      server_default=sa.func.now(), nullable=False),
        )
        op.create_index("ix_pro_quotation_comments_quotation_id",
                        "pro_quotation_comments", ["quotation_id"])
        op.create_index("ix_pro_quotation_comments_q_created",
                        "pro_quotation_comments",
                        ["quotation_id", "created_at"])


def downgrade() -> None:
    op.drop_table("pro_quotation_comments")
    op.drop_table("pro_quote_change_requests")
    op.drop_column("pro_quotations", "accepted_revision")
    op.drop_column("pro_quotations", "under_negotiation")
    op.drop_column("pro_rfqs", "frozen_at_revision")
    op.drop_column("pro_rfqs", "frozen_by_name")
    op.drop_column("pro_rfqs", "frozen_by_id")
    op.drop_column("pro_rfqs", "frozen_at")
    op.drop_column("pro_rfqs", "is_price_frozen")
