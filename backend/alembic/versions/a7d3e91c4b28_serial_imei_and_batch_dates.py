"""Carry batch dates, serials and IMEI through the whole outward flow.

IMEI was captured once, on the inbound GRN, as a JSON blob on `inb_receipt_items`.
Nothing downstream could read it: `whs_serial_numbers` names a unit by serial only, so
issue -> consignment -> GRN had no IMEI to carry and the receiving storekeeper was
asked to retype every number off the handset. Making it a column on the unit is what
lets it be *picked* by batch and bin instead.

The dates had the same shape of problem in reverse: `out_issue_items` snapshots
`expiry_date` but not `mfg_date`, and `out_dispatch_items` snapshots neither, so the
consignment was a lossy hop and the inward form re-derived what it could from
`stk_batches` — which works only while `batch_id` survives.

Backfill pairs `inb_receipt_items.serial_numbers[i]` with `imei_numbers[i]`: they are
written together, in order, by `create_receipt`, one entry per unit.

Revision ID: a7d3e91c4b28
Revises: e3f4a5b6c7d8
"""
import json

import sqlalchemy as sa
from alembic import op

revision = "a7d3e91c4b28"
down_revision = "e3f4a5b6c7d8"
branch_labels = None
depends_on = None


def _has_column(table: str, column: str) -> bool:
    inspector = sa.inspect(op.get_bind())
    return column in {row["name"] for row in inspector.get_columns(table)}


def upgrade() -> None:
    if not _has_column("whs_serial_numbers", "imei"):
        op.add_column("whs_serial_numbers", sa.Column("imei", sa.String(50), nullable=True))
        op.create_index("ix_whs_serial_numbers_imei", "whs_serial_numbers", ["imei"])

    for column in ("mfg_date", "expiry_date"):
        if not _has_column("out_dispatch_items", column):
            op.add_column("out_dispatch_items", sa.Column(column, sa.Date(), nullable=True))
    if not _has_column("out_dispatch_items", "imei_no"):
        op.add_column("out_dispatch_items", sa.Column("imei_no", sa.String(50), nullable=True))

    if not _has_column("out_issue_items", "mfg_date"):
        op.add_column("out_issue_items", sa.Column("mfg_date", sa.Date(), nullable=True))

    _backfill_imei()
    _backfill_dispatch_dates()


def _backfill_imei() -> None:
    """Move the IMEIs already captured on inbound GRNs onto the units they name."""
    bind = op.get_bind()
    rows = bind.execute(sa.text(
        "select item_id, serial_numbers, imei_numbers from inb_receipt_items "
        "where imei_numbers is not null and serial_numbers is not null"
    )).all()

    pairs: list[dict] = []
    for item_id, serials, imeis in rows:
        serials = json.loads(serials) if isinstance(serials, str) else serials
        imeis = json.loads(imeis) if isinstance(imeis, str) else imeis
        if not serials or not imeis:
            continue
        for serial, imei in zip(serials, imeis):
            if serial and imei:
                pairs.append({"item_id": item_id, "serial": str(serial).strip(),
                              "imei": str(imei).strip()})

    for pair in pairs:
        bind.execute(sa.text(
            "update whs_serial_numbers set imei = :imei "
            "where item_id = :item_id and serial_number = :serial and imei is null"
        ), pair)


def _backfill_dispatch_dates() -> None:
    """Fill the new dispatch columns from the batch each line already points at.

    Consignments in flight were dispatched before the columns existed; without this
    the receiving point still sees blanks on everything already on the road.
    """
    bind = op.get_bind()
    bind.execute(sa.text(
        "update out_dispatch_items d "
        "join stk_batches b on b.id = d.batch_id "
        "set d.mfg_date = b.mfg_date, d.expiry_date = b.expiry_date "
        "where d.batch_id is not null and d.batch_id > 0"
    ))
    bind.execute(sa.text(
        "update out_dispatch_items d "
        "join whs_serial_numbers s on s.serial_number = d.serial_no "
        "and s.item_id = d.item_id "
        "set d.imei_no = s.imei "
        "where d.serial_no is not null and s.imei is not null"
    ))
    bind.execute(sa.text(
        "update out_issue_items i "
        "join stk_batches b on b.id = i.batch_id "
        "set i.mfg_date = b.mfg_date "
        "where i.batch_id is not null and i.batch_id > 0"
    ))


def downgrade() -> None:
    if _has_column("out_issue_items", "mfg_date"):
        op.drop_column("out_issue_items", "mfg_date")
    for column in ("imei_no", "expiry_date", "mfg_date"):
        if _has_column("out_dispatch_items", column):
            op.drop_column("out_dispatch_items", column)
    if _has_column("whs_serial_numbers", "imei"):
        op.drop_index("ix_whs_serial_numbers_imei", table_name="whs_serial_numbers")
        op.drop_column("whs_serial_numbers", "imei")
