"""Document-number columns hold 50 characters (2026-11-11).

Numbers now print the organisation's and the project's / department's CODES instead of
the first three letters of their names (`AP-104-MMU` rather than `104`), up to twelve
characters each. The longest default-pattern number is then ~44 characters, so every
document-number column — and every column that keeps a copy of one — still at 30 is
widened to 50, the width the rest already have. Only widens, never narrows; a column
already 50 or wider is left as it is. Idempotent.

Revision ID: 1c24d996aa06
Revises: 1236d92a1ca7
Create Date: 2026-11-11
"""
import sqlalchemy as sa
from alembic import op

revision = "1c24d996aa06"
down_revision = "1236d92a1ca7"
branch_labels = None
depends_on = None

# (table, column, nullable)
COLUMNS = (
    ("inv_allocations", "indent_no", True),
    ("inv_material_requests", "indent_no", True),
    ("inv_sto", "sto_no", False),
    ("pro_consolidations", "cons_no", False),
    ("pro_requisitions", "req_no", False),
    ("pro_consolidation_sources", "requisition_no", True),
    ("pro_requisition_sources", "indent_no", True),
    ("pro_rfqs", "rfq_no", False),
    ("pro_rfqs", "requisition_no", True),
    ("pro_rfqs", "consolidation_no", True),
    ("lgs_issues", "issue_no", False),
    ("lgs_issues", "indent_no", True),
    ("pro_purchase_orders", "po_no", False),
    ("pro_purchase_orders", "indent_no", True),
    ("pro_purchase_orders", "requisition_no", True),
    ("pro_purchase_orders", "rfq_no", True),
    ("pro_quotations", "rfq_no", True),
    ("lgs_grn", "po_no", True),
    ("pro_despatch_notes", "dn_no", False),
    ("pro_despatch_notes", "po_no", True),
    ("pro_quote_change_requests", "cr_no", False),
    ("pro_requisition_items", "indent_no", True),
    ("acc_vendor_payments", "po_no", True),
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    for table, column, nullable in COLUMNS:
        if table not in tables:
            continue  # A new database is built by bootstrap, from the models.
        have = {c["name"]: c for c in inspector.get_columns(table)}
        current = have.get(column)
        if current is None or (getattr(current["type"], "length", None) or 0) >= 50:
            continue
        op.alter_column(table, column, existing_type=sa.String(30),
                        type_=sa.String(50), existing_nullable=nullable)


def downgrade() -> None:
    # Narrowing would truncate any number already longer than 30; left as it is.
    pass
