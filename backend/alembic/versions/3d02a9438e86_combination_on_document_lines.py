"""The combination on every transaction line (2026-10-23).

brand / variant / model ids and names, plus the indent's "any" flag, on each line
table — see shared/models/combination.py. Existing lines read 0 / NULL ("none
named"). Idempotent: adds only what is missing.

Revision ID: 3d02a9438e86
Revises: 11306f9217e6
Create Date: 2026-10-23
"""
import sqlalchemy as sa
from alembic import op

revision = "3d02a9438e86"
down_revision = "11306f9217e6"
branch_labels = None
depends_on = None

TABLES = (
    "ind_indent_items", "inv_allocation_items", "inv_material_request_items",
    "inv_sto_items", "inv_adjustment_items", "inv_reservations",
    "pro_po_items", "pro_requisition_items", "pro_rfq_items", "pro_quotation_items",
    "pro_despatch_note_items", "pro_consolidation_items",
    "inb_receipt_items", "inb_inspection_items", "whs_warehouse_items",
    "out_picking_items", "out_issue_items", "out_dispatch_items", "pro_return_items",
    "whs_inspection_items",
)


def _columns():
    return (
        ("brand_id", lambda: sa.Column("brand_id", sa.BigInteger(), nullable=False, server_default="0")),
        ("variant_id", lambda: sa.Column("variant_id", sa.BigInteger(), nullable=False, server_default="0")),
        ("model_id", lambda: sa.Column("model_id", sa.BigInteger(), nullable=False, server_default="0")),
        ("brand_name", lambda: sa.Column("brand_name", sa.String(200), nullable=True)),
        ("variant_name", lambda: sa.Column("variant_name", sa.String(200), nullable=True)),
        ("model_name", lambda: sa.Column("model_name", sa.String(200), nullable=True)),
        ("combination_any", lambda: sa.Column("combination_any", sa.Boolean(), nullable=False, server_default="0")),
    )


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    for table in TABLES:
        if table not in tables:
            continue
        present = {c["name"] for c in inspector.get_columns(table)}
        for name, make in _columns():
            if name not in present:
                op.add_column(table, make())


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    for table in TABLES:
        if table not in tables:
            continue
        present = {c["name"] for c in inspector.get_columns(table)}
        for name, _make in _columns():
            if name in present:
                op.drop_column(table, name)
