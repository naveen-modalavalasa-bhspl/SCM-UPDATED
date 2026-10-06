"""HSN tax is one GST rate, and so is a quoted line's

`mst_hsn_codes` carried four tax columns — `cgst_rate`, `sgst_rate`, `igst_rate` and
`cess_rate` — and `pro_quotation_items` carried three of the same split, so the same
number had to be kept consistent in seven places and a masters screen had four rate
boxes to fill in for one government notification.

GST is ONE rate. A within-state supply is charged as CGST + SGST, each half of it, and
an across-state supply as the whole of it as IGST — the two routes are the same number
by law, which is exactly why storing both let them drift. This replaces the split with
a single `gst_rate`, and anything that genuinely needs a half derives it.

* `mst_hsn_codes`: `gst_rate` added and backfilled from `igst_rate` (falling back to
  CGST + SGST where IGST was never written), then the four split columns dropped.
  Cess is NOT folded into `gst_rate` — compensation cess is a separate levy, not part
  of the rate — so it is left out of the GST figure rather than silently becoming part
  of it.
* `pro_quotation_items`: the vendor's own split is dropped. `tax_percent` already
  carries the total they quoted (it was written as the sum of the split at submit
  time), so it is backfilled from the split first, defensively, for any row that
  somehow holds a split without a total.

Both halves are guarded by the inspector and are safe to re-run: on a database built
from the models by `bootstrap` (which stamps alembic at head) the columns are already
the new shape and nothing here does anything.

Revision ID: e8b1d4f7a2c3
Revises: d4e6f8a2c0b1
Create Date: 2026-09-26
"""
from alembic import op
import sqlalchemy as sa

revision = "e8b1d4f7a2c3"
down_revision = "d4e6f8a2c0b1"
branch_labels = None
depends_on = None

HSN = "mst_hsn_codes"
QUOTE_ITEMS = "pro_quotation_items"


def _columns(bind, table) -> set[str]:
    return {c["name"] for c in sa.inspect(bind).get_columns(table)}


def _tables(bind) -> set[str]:
    return set(sa.inspect(bind).get_table_names())


def upgrade() -> None:
    bind = op.get_bind()
    tables = _tables(bind)

    if HSN in tables:
        held = _columns(bind, HSN)
        if "gst_rate" not in held:
            op.add_column(HSN, sa.Column("gst_rate", sa.Numeric(6, 3), nullable=False,
                                         server_default="0"))
        # Only where something is already stated. A zero everywhere is the ordinary
        # "finance has not confirmed the notification yet" row and stays zero.
        if {"cgst_rate", "sgst_rate", "igst_rate"} & held:
            bind.execute(sa.text(
                f"UPDATE {HSN} SET gst_rate = GREATEST("
                f"COALESCE(cgst_rate, 0) + COALESCE(sgst_rate, 0), "
                f"COALESCE(igst_rate, 0)) "
                f"WHERE gst_rate = 0 AND ("
                f"COALESCE(cgst_rate, 0) + COALESCE(sgst_rate, 0) > 0 "
                f"OR COALESCE(igst_rate, 0) > 0)"))
        for column in ("cgst_rate", "sgst_rate", "igst_rate", "cess_rate"):
            if column in held:
                op.drop_column(HSN, column)

    if QUOTE_ITEMS in tables:
        held = _columns(bind, QUOTE_ITEMS)
        # The total is what `_quote_totals` and every PO snapshot actually charge, and
        # it was written as the sum of the split. Fill it first so dropping the split
        # cannot lose a tax figure.
        if {"cgst_rate", "sgst_rate", "igst_rate"} & held:
            bind.execute(sa.text(
                f"UPDATE {QUOTE_ITEMS} SET tax_percent = "
                f"COALESCE(cgst_rate, 0) + COALESCE(sgst_rate, 0) + COALESCE(igst_rate, 0) "
                f"WHERE COALESCE(tax_percent, 0) = 0 AND ("
                f"COALESCE(cgst_rate, 0) + COALESCE(sgst_rate, 0) "
                f"+ COALESCE(igst_rate, 0) > 0)"))
        for column in ("cgst_rate", "sgst_rate", "igst_rate"):
            if column in held:
                op.drop_column(QUOTE_ITEMS, column)


def downgrade() -> None:
    bind = op.get_bind()
    tables = _tables(bind)

    if HSN in tables:
        held = _columns(bind, HSN)
        for column in ("cgst_rate", "sgst_rate", "igst_rate", "cess_rate"):
            if column not in held:
                op.add_column(HSN, sa.Column(column, sa.Numeric(6, 3), nullable=False,
                                             server_default="0"))
        # The reverse split: half each within a state, the whole across one.
        bind.execute(sa.text(
            f"UPDATE {HSN} SET "
            f"cgst_rate = gst_rate / 2, sgst_rate = gst_rate / 2, igst_rate = gst_rate"))
        if "gst_rate" in held:
            op.drop_column(HSN, "gst_rate")

    if QUOTE_ITEMS in tables:
        held = _columns(bind, QUOTE_ITEMS)
        for column in ("cgst_rate", "sgst_rate", "igst_rate"):
            if column not in held:
                op.add_column(QUOTE_ITEMS, sa.Column(column, sa.Numeric(5, 2),
                                                     nullable=True))
        bind.execute(sa.text(
            f"UPDATE {QUOTE_ITEMS} SET cgst_rate = tax_percent / 2, "
            f"sgst_rate = tax_percent / 2, igst_rate = tax_percent"))
