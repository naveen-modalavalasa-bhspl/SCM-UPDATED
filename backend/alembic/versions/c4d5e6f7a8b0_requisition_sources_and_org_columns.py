"""MR consolidation sources, and who is buying on whose paper

Three additive changes, none of which rewrite an existing row:

  * `pro_requisition_sources` — the many material requests a single requisition was
    consolidated from. `pro_requisitions.source_mr_id` stays exactly as it is; it holds
    the first (or only) MR and every existing row keeps reading correctly.
  * `department_id` / `department_name` / `company_name` on `pro_requisitions` and
    `pro_rfqs` — nullable, because a document raised before this migration has none and
    goes on being read from the raiser's HCM record instead.
  * `required_date` on `pro_requisitions` — one date for the document, so a buyer stops
    typing the same one on every line. A line that genuinely differs still carries its
    own in `pro_requisition_items.required_date`.

Revision ID: c4d5e6f7a8b0
Revises: b3c4d5e6f7a9
"""
from alembic import op
import sqlalchemy as sa

revision = "c4d5e6f7a8b0"
down_revision = "b3c4d5e6f7a9"
branch_labels = None
depends_on = None


def _columns(table: str) -> set[str]:
    """What the live table already has.

    The QA and production schemas were built by hand before Alembic caught up, so a
    column this migration adds may already be there. Checked rather than assumed —
    a duplicate ADD COLUMN stops the whole upgrade.
    """
    bind = op.get_bind()
    return {row[0] for row in bind.execute(sa.text(f"SHOW COLUMNS FROM `{table}`"))}


def _tables() -> set[str]:
    bind = op.get_bind()
    return {row[0] for row in bind.execute(sa.text("SHOW TABLES"))}


def upgrade() -> None:
    if "pro_requisition_sources" not in _tables():
        op.create_table(
            "pro_requisition_sources",
            sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
            sa.Column("requisition_id", sa.BigInteger, nullable=False),
            sa.Column("mr_id", sa.BigInteger, nullable=True),
            sa.Column("mr_no", sa.String(30), nullable=True),
            sa.Column("indent_no", sa.String(30), nullable=True),
            sa.Column("item_count", sa.Integer, nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(timezone=True),
                      server_default=sa.func.now(), nullable=False),
            sa.ForeignKeyConstraint(["requisition_id"], ["pro_requisitions.id"],
                                    ondelete="CASCADE"),
            mysql_charset="utf8mb4",
            mysql_collate="utf8mb4_unicode_ci",
        )
        op.create_index("ix_pro_requisition_sources_requisition_id",
                        "pro_requisition_sources", ["requisition_id"])
        op.create_index("ix_pro_req_source_mr", "pro_requisition_sources", ["mr_id"])

    existing = _columns("pro_requisitions")
    for name, column in (
        ("department_id", sa.Column("department_id", sa.BigInteger, nullable=True)),
        ("department_name", sa.Column("department_name", sa.String(200), nullable=True)),
        ("company_name", sa.Column("company_name", sa.String(200), nullable=True)),
        ("required_date", sa.Column("required_date", sa.Date, nullable=True)),
    ):
        if name not in existing:
            op.add_column("pro_requisitions", column)

    existing = _columns("pro_rfqs")
    for name, column in (
        ("department_id", sa.Column("department_id", sa.BigInteger, nullable=True)),
        ("department_name", sa.Column("department_name", sa.String(200), nullable=True)),
        ("company_name", sa.Column("company_name", sa.String(200), nullable=True)),
    ):
        if name not in existing:
            op.add_column("pro_rfqs", column)


def downgrade() -> None:
    for table in ("pro_rfqs", "pro_requisitions"):
        existing = _columns(table)
        for name in ("company_name", "department_name", "department_id"):
            if name in existing:
                op.drop_column(table, name)
    if "required_date" in _columns("pro_requisitions"):
        op.drop_column("pro_requisitions", "required_date")
    if "pro_requisition_sources" in _tables():
        op.drop_table("pro_requisition_sources")
