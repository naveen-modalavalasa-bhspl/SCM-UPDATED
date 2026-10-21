"""Packing on every document line, and packs on the shelf (2026-10-08).

* `pack_hierarchy_id` + `pack_breakdown` (JSON) on PO, despatch note, GRN, putaway
  and material issue lines. Every quantity column keeps meaning base units; the
  breakdown is HOW those units are packed, and always adds up to them.
* `pro_despatch_note_items.pack_change_*` — a supplier sending a different hierarchy
  from the order's, and the buyer's answer.
* `inb_receipt_items.declared_pack_breakdown` — the despatch note's packing, frozen.
* `out_issue_items.break_bulk`.
* `whs_handling_units` — one row per physical pack on the shelf.
* `whs_serial_numbers.handling_unit_id` — the pack a unit sits in.

Idempotent: every step checks the live schema first.

Revision ID: e2a4c6e8f0b3
Revises: d1f3a5c7e9b2
Create Date: 2026-10-08
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e2a4c6e8f0b3"
down_revision: Union[str, Sequence[str], None] = "d1f3a5c7e9b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

HU = "whs_handling_units"

COLUMNS: dict[str, list[sa.Column]] = {
    "pro_po_items": [
        sa.Column("pack_hierarchy_id", sa.BigInteger(), nullable=True),
        sa.Column("pack_breakdown", sa.JSON(), nullable=True),
    ],
    "pro_despatch_note_items": [
        sa.Column("pack_hierarchy_id", sa.BigInteger(), nullable=True),
        sa.Column("pack_breakdown", sa.JSON(), nullable=True),
        sa.Column("pack_change_status", sa.String(20), nullable=False,
                  server_default="NONE"),
        sa.Column("ordered_pack_hierarchy_id", sa.BigInteger(), nullable=True),
        sa.Column("ordered_pack_hierarchy_name", sa.String(100), nullable=True),
        sa.Column("pack_change_reason", sa.String(500), nullable=True),
        sa.Column("pack_change_note", sa.String(500), nullable=True),
        sa.Column("pack_change_by_name", sa.String(200), nullable=True),
        sa.Column("pack_change_at", sa.DateTime(), nullable=True),
    ],
    "inb_receipt_items": [
        sa.Column("pack_hierarchy_id", sa.BigInteger(), nullable=True),
        sa.Column("declared_pack_breakdown", sa.JSON(), nullable=True),
        sa.Column("pack_breakdown", sa.JSON(), nullable=True),
        sa.Column("despatch_note_item_id", sa.BigInteger(), nullable=True),
    ],
    "whs_warehouse_items": [
        sa.Column("pack_hierarchy_id", sa.BigInteger(), nullable=True),
        sa.Column("pack_breakdown", sa.JSON(), nullable=True),
    ],
    "out_issue_items": [
        sa.Column("pack_hierarchy_id", sa.BigInteger(), nullable=True),
        sa.Column("pack_breakdown", sa.JSON(), nullable=True),
        sa.Column("break_bulk", sa.Boolean(), nullable=False,
                  server_default=sa.text("0")),
    ],
    "whs_serial_numbers": [
        sa.Column("handling_unit_id", sa.BigInteger(), nullable=True),
    ],
}

INDEXES = [
    ("ix_pro_po_items_pack_hierarchy_id", "pro_po_items", ["pack_hierarchy_id"]),
    ("ix_pro_despatch_note_items_pack_hierarchy_id", "pro_despatch_note_items",
     ["pack_hierarchy_id"]),
    ("ix_inb_receipt_items_pack_hierarchy_id", "inb_receipt_items",
     ["pack_hierarchy_id"]),
    ("ix_whs_serial_numbers_handling_unit_id", "whs_serial_numbers",
     ["handling_unit_id"]),
]


def _insp():
    return sa.inspect(op.get_bind())


def _columns(table: str) -> set[str]:
    return {c["name"] for c in _insp().get_columns(table)}


def _indexes(table: str) -> set[str]:
    return {i["name"] for i in _insp().get_indexes(table)}


def upgrade() -> None:
    tables = set(_insp().get_table_names())
    for table, columns in COLUMNS.items():
        if table not in tables:
            continue
        have = _columns(table)
        for column in columns:
            if column.name not in have:
                op.add_column(table, column.copy())
    for name, table, cols in INDEXES:
        if table in tables and name not in _indexes(table):
            op.create_index(name, table, cols)

    if HU not in tables:
        op.create_table(
            HU,
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("hu_code", sa.String(120), nullable=False),
            sa.Column("code_kind", sa.String(20), nullable=False, server_default="PACK"),
            sa.Column("item_id", sa.BigInteger(), nullable=False),
            sa.Column("warehouse_id", sa.BigInteger(), nullable=False),
            sa.Column("bin_id", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("batch_id", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("project_id", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("pack_hierarchy_id", sa.BigInteger(), nullable=False),
            sa.Column("item_packaging_id", sa.BigInteger(), nullable=True),
            sa.Column("level", sa.Integer(), nullable=False),
            sa.Column("pack_name", sa.String(200), nullable=True),
            sa.Column("pack_size", sa.Numeric(16, 3), nullable=False),
            sa.Column("parent_id", sa.BigInteger(), nullable=True),
            sa.Column("is_atom", sa.Boolean(), nullable=False, server_default=sa.text("0")),
            sa.Column("status", sa.String(20), nullable=False, server_default="SEALED"),
            sa.Column("lot_no", sa.String(120), nullable=True),
            sa.Column("source_type", sa.String(30), nullable=True),
            sa.Column("source_id", sa.BigInteger(), nullable=True),
            sa.Column("source_no", sa.String(60), nullable=True),
            sa.Column("closed_reason", sa.String(300), nullable=True),
            sa.Column("closed_by_name", sa.String(200), nullable=True),
            sa.Column("closed_at", sa.DateTime(), nullable=True),
            sa.Column("created_by_id", sa.BigInteger(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False,
                      server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=True,
                      server_default=sa.func.now()),
            sa.UniqueConstraint("hu_code", name="uq_whs_handling_units_hu_code"),
        )
        op.create_index("ix_whs_hu_stock_key", HU,
                        ["item_id", "warehouse_id", "bin_id", "batch_id", "status"])
        op.create_index("ix_whs_handling_units_item_id", HU, ["item_id"])
        op.create_index("ix_whs_handling_units_parent_id", HU, ["parent_id"])
        op.create_index("ix_whs_handling_units_pack_hierarchy_id", HU,
                        ["pack_hierarchy_id"])
        op.create_index("ix_whs_handling_units_item_packaging_id", HU,
                        ["item_packaging_id"])
        op.create_index("ix_whs_handling_units_created_by_id", HU, ["created_by_id"])


def downgrade() -> None:
    tables = set(_insp().get_table_names())
    if HU in tables:
        op.drop_table(HU)
    for name, table, _cols in INDEXES:
        if table in tables and name in _indexes(table):
            op.drop_index(name, table_name=table)
    for table, columns in COLUMNS.items():
        if table not in tables:
            continue
        have = _columns(table)
        for column in columns:
            if column.name in have:
                op.drop_column(table, column.name)
