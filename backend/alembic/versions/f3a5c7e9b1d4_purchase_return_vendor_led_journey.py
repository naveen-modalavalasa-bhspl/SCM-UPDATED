"""Purchase return: the vendor-led journey.

Revision ID: f3a5c7e9b1d4
Revises: e2f4a6b8c0d1
Create Date: 2026-09-12

WHAT THIS IS FOR
----------------
The post-send half of a purchase return was built on assumptions the business does not
share: our own desk answered the return the vendor was holding, the goods left the
warehouse in the same press that sent the paperwork, and the only transport leg the
document knew about ran vendor -> warehouse. The business sends the paperwork first, the
VENDOR approves or rejects it, the vendor then says refund or replacement, and only then
does our warehouse decide whose vehicle carries the goods TO them.

This revision adds the columns that journey needs and moves every row already in flight
onto it. There is no second flow kept alongside — one ladder, one set of rungs.

IDEMPOTENT AND REVERSIBLE. Every column is nullable with no server default, so adding
them changes no existing row's behaviour, and each `op.add_column` is guarded against a
column that is already there (a half-applied migration is re-runnable). `downgrade`
drops the columns and puts the remapped statuses back.

THE REMAP, and why each row moves where it does
-----------------------------------------------
Checked against the live database before it was written (19 rows):

  DRAFT                                   stays          — nothing has been asked yet
  SENT_TO_VENDOR, vendor_response REPLACED -> REPLACEMENT_AGREED
  SENT_TO_VENDOR, unanswered              stays          — still waiting on the vendor
  VENDOR_APPROVED                         stays          — already the vendor-approved rung
  RECEIVED_AT_WAREHOUSE                   stays          — the goods are in the building
  any row with vendor_response RETURNED   -> REJECTED    — nil on this database, mapped
                                                           anyway so a differently-aged
                                                           deployment lands correctly

The REPLACED rows are the interesting case. Those suppliers HAD answered — they accepted
the goods and promised a replacement — but under the old shape that answer lived on a
separate axis from the status, so the document still read SENT_TO_VENDOR. Accepting IS
approving, so the backfill also writes `vendor_decision = APPROVED` with the answer's own
timestamp and the vendor's name, rather than leaving the decision blank and inviting
somebody to ask a supplier who has already answered.

ONE THING THOSE ROWS CARRY THAT NEW ONES WILL NOT. Checked on the live database: eleven
of them already have a `vendor_followup_receipt_no`, because the old flow raised the
replacement's draft inbound receipt the instant the supplier answered. The new flow raises
it later, on the dispatch-note press, when the goods are actually on a vehicle. Nothing is
undone here — that receipt is a real document the store may already have worked — so the
dispatch press is written to REUSE an existing `vendor_followup_receipt_id` rather than
raise a second one. A remapped row therefore reaches the same end state as a new one
without the store ever seeing two receipts for one replacement. None of the eleven has a
`collection_tr_no` or a supplier signature, so nothing else is part-way through.
"""
from alembic import op
import sqlalchemy as sa


revision = "f3a5c7e9b1d4"
down_revision = "e2f4a6b8c0d1"
branch_labels = None
depends_on = None


#: (name, type) for every column this revision adds to `pro_returns`. Declared as data so
#: upgrade and downgrade cannot disagree about what was added.
NEW_COLUMNS: list[tuple[str, sa.types.TypeEngine]] = [
    # The QC that condemned the goods.
    ("inspection_id", sa.BigInteger()),
    ("inspection_no", sa.String(50)),
    # The outward leg — our warehouse to the vendor's dock.
    ("outbound_tr_id", sa.BigInteger()),
    ("outbound_tr_no", sa.String(50)),
    # The vendor accepting the collection job, on a vendor-arranged leg.
    ("vendor_transport_accepted_at", sa.DateTime()),
    ("vendor_transport_accepted_by_name", sa.String(200)),
    # The replacement dispatch note.
    ("replacement_dispatched_at", sa.DateTime()),
    ("replacement_dispatch_no", sa.String(100)),
    ("replacement_dispatch_date", sa.Date()),
    ("replacement_expected_date", sa.Date()),
    ("replacement_transporter_name", sa.String(200)),
    ("replacement_vehicle_no", sa.String(50)),
    ("replacement_lr_no", sa.String(50)),
    ("replacement_remarks", sa.Text()),
]

#: The columns that get an index, and the index name. Indexed because the release hook
#: asks "is a purchase return waiting on this leg?" on every shipment that goes out, and
#: the QC id is read back per return on the register.
NEW_INDEXES: list[tuple[str, str]] = [
    ("ix_pro_returns_inspection_id", "inspection_id"),
    ("ix_pro_returns_outbound_tr_id", "outbound_tr_id"),
]


def _existing_columns(bind) -> set[str]:
    return {row["name"] for row in sa.inspect(bind).get_columns("pro_returns")}


def _existing_indexes(bind) -> set[str]:
    return {row["name"] for row in sa.inspect(bind).get_indexes("pro_returns")}


def upgrade() -> None:
    bind = op.get_bind()
    present = _existing_columns(bind)
    for name, type_ in NEW_COLUMNS:
        if name not in present:
            op.add_column("pro_returns", sa.Column(name, type_, nullable=True))

    indexed = _existing_indexes(bind)
    for index_name, column in NEW_INDEXES:
        if index_name not in indexed:
            op.create_index(index_name, "pro_returns", [column])

    # --- the remap ----------------------------------------------------------------
    #
    # Ordered deliberately: the RETURNED refusal is settled FIRST, so a row carrying both
    # a refusal and a SENT_TO_VENDOR status cannot be caught by the REPLACED rule below
    # and land on the replacement ladder.
    op.execute("""
        UPDATE pro_returns
           SET status = 'REJECTED'
         WHERE vendor_response = 'RETURNED'
           AND status IN ('SENT_TO_VENDOR', 'DISPATCHED')
    """)

    # A supplier who accepted and promised a replacement has approved the return. Move the
    # document onto the rung that says the warehouse now owes a transport decision, and
    # record the decision they actually made rather than leaving it blank.
    op.execute("""
        UPDATE pro_returns
           SET status = 'REPLACEMENT_AGREED',
               vendor_decision = COALESCE(vendor_decision, 'APPROVED'),
               vendor_decision_at = COALESCE(vendor_decision_at, vendor_response_at),
               vendor_decision_by_name = COALESCE(vendor_decision_by_name, vendor_name),
               vendor_decision_note = COALESCE(vendor_decision_note, vendor_response_note)
         WHERE vendor_response = 'REPLACED'
           AND status IN ('SENT_TO_VENDOR', 'DISPATCHED')
    """)

    # A supplier who accepted and refunded has settled it in money. The refund stamp is
    # left alone — `vendor_refund_amount` already carries the figure and REFUNDED is what
    # the document should have read all along.
    op.execute("""
        UPDATE pro_returns
           SET status = 'REFUNDED',
               vendor_decision = COALESCE(vendor_decision, 'APPROVED'),
               vendor_decision_at = COALESCE(vendor_decision_at, vendor_response_at),
               vendor_decision_by_name = COALESCE(vendor_decision_by_name, vendor_name)
         WHERE vendor_response = 'REFUNDED'
           AND status IN ('SENT_TO_VENDOR', 'DISPATCHED')
    """)

    # Backfill the QC number for every return that can name one. The same query the read
    # path uses: the latest non-cancelled inbound inspection against the return's own GRN.
    # Nothing is invented — a return with no GRN, or a GRN with no inspection, stays null.
    op.execute("""
        UPDATE pro_returns r
          JOIN (
                SELECT i.receipt_id,
                       MAX(i.id) AS inspection_id
                  FROM inb_inspections i
                 WHERE i.receipt_id IS NOT NULL
                   AND i.status NOT IN ('CANCELLED', 'REJECTED')
                 GROUP BY i.receipt_id
               ) latest ON latest.receipt_id = r.grn_id
          JOIN inb_inspections qc ON qc.id = latest.inspection_id
           SET r.inspection_id = qc.id,
               r.inspection_no = qc.inspection_no
         WHERE r.grn_id IS NOT NULL
           AND r.inspection_id IS NULL
    """)


def downgrade() -> None:
    # The statuses first, while the columns the remap read are still here.
    op.execute("""
        UPDATE pro_returns
           SET status = 'SENT_TO_VENDOR'
         WHERE status IN ('REPLACEMENT_AGREED', 'VENDOR_TRANSPORT_ACCEPTED',
                          'STOCK_PICKED_UP', 'VENDOR_RECEIVED',
                          'REPLACEMENT_DISPATCHED')
    """)

    bind = op.get_bind()
    indexed = _existing_indexes(bind)
    for index_name, _column in NEW_INDEXES:
        if index_name in indexed:
            op.drop_index(index_name, table_name="pro_returns")

    present = _existing_columns(bind)
    for name, _type in NEW_COLUMNS:
        if name in present:
            op.drop_column("pro_returns", name)
