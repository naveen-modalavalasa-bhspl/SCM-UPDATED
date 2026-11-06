"""A document's number belongs to a financial year (2026-11-05).

Two changes, both so the year in a number can follow the calendar and be picked:

- `fiscal_year` on the seven procurement documents. An organised document already raised
  takes the year its own number prints, so re-saving it never looks like a change.
- Counters split by year. A number that prints {FY} now has one counter per year, keyed
  `...|FY:2026-27`. Every counter that exists is moved under the year it counted, and a
  series whose own row was the counter gets a year counter starting where it stopped.
  Without this the next number in each series would start again at 1 and collide.

Numbers already issued are not touched. Idempotent.

Revision ID: d9e3b5c7a1f4
Revises: d8f2b4a6c1e3
Create Date: 2026-11-05
"""
import re

import sqlalchemy as sa
from alembic import op

revision = "d9e3b5c7a1f4"
down_revision = "d8f2b4a6c1e3"
branch_labels = None
depends_on = None

DOCUMENTS = {"pro_purchase_orders": "po_no", "pro_requisitions": "req_no", "pro_rfqs": "rfq_no",
             "pro_consolidations": "cons_no", "pro_quotations": "quotation_no",
             "pro_quote_change_requests": "cr_no", "pro_despatch_notes": "dn_no"}
_PRINTS_YEAR = re.compile(r"\{(FY|fy)\}")
_SPLIT = re.compile(r"\{(COMPANY|PROJECT|company|project)\}")


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    for table, number in DOCUMENTS.items():
        if table not in tables:
            continue  # A new database is built by bootstrap, from the models.
        if "fiscal_year" not in {c["name"] for c in inspector.get_columns(table)}:
            op.add_column(table, sa.Column("fiscal_year", sa.String(10), nullable=True))
        bind.execute(sa.text(
            f"UPDATE {table} SET fiscal_year = REGEXP_SUBSTR({number}, '[0-9]{{4}}-[0-9]{{2}}') "
            "WHERE organization_id IS NOT NULL AND fiscal_year IS NULL"))

    if "sys_doc_series" not in tables:
        return
    rows = bind.execute(sa.text(
        "SELECT id, doc_type, fiscal_year, prefix, pattern, last_number, reset_policy, "
        "scope_key, is_active FROM sys_doc_series")).mappings().all()
    prints_year = {row["doc_type"].lower(): bool(_PRINTS_YEAR.search(row["pattern"] or ""))
                   for row in rows if row["scope_key"] is None}
    have = {(row["doc_type"].lower(), row["scope_key"]) for row in rows}

    for row in rows:
        kind = row["doc_type"].lower()
        if row["scope_key"] is not None:
            if prints_year.get(kind) and "FY:" not in row["scope_key"]:
                bind.execute(sa.text("UPDATE sys_doc_series SET scope_key = :key WHERE id = :id"),
                             {"key": f"{row['scope_key']}|FY:{row['fiscal_year']}", "id": row["id"]})
            continue
        # A series with no company or project token counted on its own row.
        if (prints_year.get(kind) and not _SPLIT.search(row["pattern"] or "")
                and (kind, f"FY:{row['fiscal_year']}") not in have):
            bind.execute(sa.text(
                "INSERT INTO sys_doc_series (doc_type, fiscal_year, prefix, pattern, last_number, "
                "reset_policy, scope_key, is_active) VALUES (:doc_type, :fiscal_year, :prefix, "
                ":pattern, :last_number, :reset_policy, :key, 1)"),
                {**{k: row[k] for k in ("doc_type", "fiscal_year", "prefix", "pattern",
                                        "last_number", "reset_policy")},
                 "key": f"FY:{row['fiscal_year']}"})


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("DELETE FROM sys_doc_series WHERE scope_key LIKE 'FY:%'"))
    bind.execute(sa.text(
        "UPDATE sys_doc_series SET scope_key = SUBSTRING_INDEX(scope_key, '|FY:', 1) "
        "WHERE scope_key LIKE '%|FY:%'"))
    for table in DOCUMENTS:
        op.drop_column(table, "fiscal_year")
