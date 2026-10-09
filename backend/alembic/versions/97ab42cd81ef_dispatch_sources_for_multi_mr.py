"""dispatch sources for multi-MR consignments

One consignment may carry several material issues bound for the same stocking point.
`out_dispatches.ref_id` can name only one, so the issues are listed in
`out_dispatch_sources` (one row per issue) and every consignment line records which
issue it was packed from.

Revision ID: 97ab42cd81ef
Revises: f3d5a7c9e1b4
"""
from alembic import op
import sqlalchemy as sa

revision = "97ab42cd81ef"
# Cut from `f3d5a7c9e1b4`, the single head at the time. It first hung off
# `92c9c40ec9d7`, an ancestor long since merged, which made two heads and stopped
# `alembic upgrade head` altogether. It had been applied nowhere, so it is re-pointed
# rather than merged.
down_revision = "f3d5a7c9e1b4"
branch_labels = None
depends_on = None


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _indexes(table: str) -> set[str]:
    return {ix["name"] for ix in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    item_cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("out_dispatch_items")}
    for name in ("issue_id", "mr_id"):
        if name not in item_cols:
            op.add_column("out_dispatch_items", sa.Column(name, sa.BigInteger(), nullable=True))
            op.create_index(f"ix_out_dispatch_items_{name}", "out_dispatch_items", [name])
    for name in ("issue_no", "mr_no"):
        if name not in item_cols:
            op.add_column("out_dispatch_items", sa.Column(name, sa.String(50), nullable=True))

    if "out_dispatch_sources" not in _tables():
        op.create_table(
            "out_dispatch_sources",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("dispatch_id", sa.BigInteger(), nullable=False),
            sa.Column("source_type", sa.String(30), nullable=False, server_default="ISSUE"),
            sa.Column("source_id", sa.BigInteger(), nullable=False),
            sa.Column("source_no", sa.String(50), nullable=True),
            sa.Column("issue_id", sa.BigInteger(), nullable=True),
            sa.Column("issue_no", sa.String(50), nullable=True),
            sa.Column("mr_id", sa.BigInteger(), nullable=True),
            sa.Column("mr_no", sa.String(50), nullable=True),
            sa.Column("indent_id", sa.BigInteger(), nullable=True),
            sa.Column("indent_no", sa.String(50), nullable=True),
            sa.Column("destination_warehouse_id", sa.BigInteger(), nullable=True),
            sa.Column("destination_warehouse_name", sa.String(200), nullable=True),
            sa.Column("quantity", sa.Numeric(16, 3), nullable=False, server_default="0"),
            sa.ForeignKeyConstraint(["dispatch_id"], ["out_dispatches.id"], ondelete="CASCADE"),
        )
        op.create_index("ix_out_dispatch_sources_dispatch_id", "out_dispatch_sources", ["dispatch_id"])
        op.create_index("ix_out_dispatch_sources_issue_id", "out_dispatch_sources", ["issue_id"])
        op.create_index("ix_out_dispatch_sources_mr_id", "out_dispatch_sources", ["mr_id"])
        op.create_index("ix_out_dispatch_sources_indent_id", "out_dispatch_sources", ["indent_id"])
    if "uq_out_dispatch_sources_dispatch_issue" not in _indexes("out_dispatch_sources"):
        op.create_index("uq_out_dispatch_sources_dispatch_issue", "out_dispatch_sources",
                        ["dispatch_id", "issue_id"], unique=True)


def downgrade() -> None:
    if "out_dispatch_sources" in _tables():
        op.drop_table("out_dispatch_sources")
    item_cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("out_dispatch_items")}
    for name in ("mr_no", "issue_no"):
        if name in item_cols:
            op.drop_column("out_dispatch_items", name)
    for name in ("mr_id", "issue_id"):
        if name in item_cols:
            op.drop_index(f"ix_out_dispatch_items_{name}", table_name="out_dispatch_items")
            op.drop_column("out_dispatch_items", name)
