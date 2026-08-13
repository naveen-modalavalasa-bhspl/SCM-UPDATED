"""Per-company / per-project document number counters.

One nullable column. NULL means "the series an admin configured", which is what every
existing row is, so numbering behaves exactly as before until a pattern names
{COMPANY} or {PROJECT}.

Revision ID: a9b1c2d3e4f5
Revises: c5e6f7a8b9d0
"""
from alembic import op
import sqlalchemy as sa

revision = "a9b1c2d3e4f5"
down_revision = "c5e6f7a8b9d0"
branch_labels = None
depends_on = None


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    return column in {c["name"] for c in sa.inspect(bind).get_columns(table)}


def _indexes(table: str) -> dict:
    bind = op.get_bind()
    return {i["name"]: i for i in sa.inspect(bind).get_indexes(table)}


def upgrade() -> None:
    # Guarded: the live database is brought forward by hand as well (docs/sql), so the
    # column may already be there when this runs.
    if not _has_column("sys_doc_series", "scope_key"):
        op.add_column("sys_doc_series",
                      sa.Column("scope_key", sa.String(60), nullable=True))
        op.create_index("ix_sys_doc_series_scope_key", "sys_doc_series", ["scope_key"])

    # The live table carries a unique key on (doc_type, fiscal_year) that the ORM never
    # declared. A per-project counter is a second row for the same doc_type and year, so
    # the key has to include the scope or the counter cannot be created. Widened, not
    # dropped: two rows for the same doc_type/year/scope stay impossible.
    existing = _indexes("sys_doc_series").get("uq_series")
    if existing and existing.get("column_names") != ["doc_type", "fiscal_year",
                                                     "scope_key"]:
        op.drop_index("uq_series", table_name="sys_doc_series")
        op.create_index("uq_series", "sys_doc_series",
                        ["doc_type", "fiscal_year", "scope_key"], unique=True)


def downgrade() -> None:
    existing = _indexes("sys_doc_series").get("uq_series")
    if existing and "scope_key" in (existing.get("column_names") or []):
        op.drop_index("uq_series", table_name="sys_doc_series")
        op.create_index("uq_series", "sys_doc_series", ["doc_type", "fiscal_year"],
                        unique=True)
    if _has_column("sys_doc_series", "scope_key"):
        op.drop_index("ix_sys_doc_series_scope_key", table_name="sys_doc_series")
        op.drop_column("sys_doc_series", "scope_key")
