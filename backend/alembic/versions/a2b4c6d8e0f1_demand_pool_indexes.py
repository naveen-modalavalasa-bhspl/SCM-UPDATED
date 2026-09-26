"""Add indexes for demand pool queries.

The demand pool endpoints filter on three columns that are currently
unindexed.  Adding them now is one migration instead of a slow-screen
mystery once the tables grow.  New databases get the indexes through
Base.metadata.create_all(); existing ones through alembic upgrade head.

Columns indexed:
    * out_issue_items.indent_item_id     — every warehouse-pool query
      and several existing guards (_already_issued, _receiver_confirmed)
      scan on this.  Plain BigInteger with no index today.
    * out_dispatch_items.indent_id       — the dispatch-side counterpart,
      equally hot.
    * out_dispatches (ref_type, ref_id)  — the issue→consignment join the
      pool and four existing guards all run; the composite covers both sides
      of the equality so MySQL can seek on either column first.

Revision ID: a2b4c6d8e0f1
Revises: e1f3a5c7b9d2
"""
from alembic import op

revision = "a2b4c6d8e0f1"
down_revision = "e1f3a5c7b9d2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_out_issue_items_indent_item_id",
        "out_issue_items",
        ["indent_item_id"],
    )
    op.create_index(
        "ix_out_dispatch_items_indent_id",
        "out_dispatch_items",
        ["indent_id"],
    )
    op.create_index(
        "ix_out_dispatches_ref_type_ref_id",
        "out_dispatches",
        ["ref_type", "ref_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_out_dispatches_ref_type_ref_id", table_name="out_dispatches")
    op.drop_index("ix_out_dispatch_items_indent_id",  table_name="out_dispatch_items")
    op.drop_index("ix_out_issue_items_indent_item_id", table_name="out_issue_items")
