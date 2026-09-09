"""out_issues split across the floors that hold the stock

A material issue is generic — the allocation raises one per warehouse and it belongs
to nobody in particular. That is right, and tagging it to a floor would be wrong: the
document would start lying the moment the stock moved.

So the issue is BROKEN UP instead. The warehouse manager approves the generic issue
and splits it; each child names the floor it was handed to and carries only what that
floor actually holds. `floor_location_id` is a fact about the document — who was given
this piece of work — not about the stock, which is why it can be stored at all.

Revision ID: c7d8e9f0a1b2
Revises: e9a4b5c6d7f8
"""
from alembic import op
import sqlalchemy as sa

revision = "c7d8e9f0a1b2"
down_revision = "e9a4b5c6d7f8"
branch_labels = None
depends_on = None


# Idempotent for the reason every migration here is: this database was built by
# create_all and hand edits before Alembic caught up, so a column may already be
# present and re-adding it is a hard failure on an otherwise correct database.
def _columns(bind, table):
    return {row[0] for row in bind.execute(sa.text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = DATABASE() AND table_name = :t"), {"t": table})}


def _indexes(bind, table):
    return {row[0] for row in bind.execute(sa.text(
        "SELECT index_name FROM information_schema.statistics "
        "WHERE table_schema = DATABASE() AND table_name = :t"), {"t": table})}


def upgrade() -> None:
    bind = op.get_bind()
    have = _columns(bind, "out_issues")

    if "parent_issue_id" not in have:
        op.add_column("out_issues",
                      sa.Column("parent_issue_id", sa.BigInteger(), nullable=True))
    if "parent_issue_no" not in have:
        op.add_column("out_issues",
                      sa.Column("parent_issue_no", sa.String(50), nullable=True))
    if "floor_location_id" not in have:
        op.add_column("out_issues",
                      sa.Column("floor_location_id", sa.BigInteger(), nullable=True))
    if "floor_location_name" not in have:
        op.add_column("out_issues",
                      sa.Column("floor_location_name", sa.String(200), nullable=True))

    # Both are read on every list: the children of one parent, and the issues on the
    # floors this login holds. Without them the material issue list filesorts the
    # whole table on a column nothing indexes.
    known = _indexes(bind, "out_issues")
    if "ix_out_issues_parent_issue_id" not in known:
        op.create_index("ix_out_issues_parent_issue_id", "out_issues",
                        ["parent_issue_id"])
    if "ix_out_issues_floor_location_id" not in known:
        op.create_index("ix_out_issues_floor_location_id", "out_issues",
                        ["floor_location_id"])


def downgrade() -> None:
    bind = op.get_bind()
    known = _indexes(bind, "out_issues")
    if "ix_out_issues_floor_location_id" in known:
        op.drop_index("ix_out_issues_floor_location_id", table_name="out_issues")
    if "ix_out_issues_parent_issue_id" in known:
        op.drop_index("ix_out_issues_parent_issue_id", table_name="out_issues")
    have = _columns(bind, "out_issues")
    for column in ("floor_location_name", "floor_location_id",
                   "parent_issue_no", "parent_issue_id"):
        if column in have:
            op.drop_column("out_issues", column)
