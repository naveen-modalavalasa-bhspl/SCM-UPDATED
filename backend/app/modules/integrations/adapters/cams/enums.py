"""Vocabulary this integration pins. Nothing here belongs in `shared/enums.py`: it
describes what B-CAMS is told, not a document status any SCM module reads.
"""
from enum import Enum

# `apis.` keys this feature writes into sys_settings. Same store as the console's
# clients and keys, same category, so a stray row can never be read as a real setting.
EVENT_PREFIX = "apis.cams.evt."

# `apis.cams.evt.` is 14 characters and `sys_settings.setting_key` is VARCHAR(100), so
# an event_id longer than this could be silently truncated on MySQL — which would make
# two different events collide onto one row and the second be answered "duplicate".
MAX_EVENT_ID = 80

# How many receipts are kept. The oldest are dropped on ingest: this is a de-duplication
# window, not an archive. Wide enough that a client retrying yesterday's batch is still
# recognised.
MAX_EVENTS = 5000

# A payload larger than this is recorded by its digest and row counts only. The store is
# `sys_settings.setting_value`, a MySQL TEXT — 65,535 BYTES, not characters. Writing past
# it truncates the JSON, and a truncated receipt reads back as corrupt.
MAX_STORED_PAYLOAD = 40_000

# Page size B-CAMS asks for is 500; the ceiling is the console's own.
DEFAULT_PAGE_SIZE = 500

class Tier(str, Enum):
    """`warehouse.tier` — Q1 of the ask.

    Derived from `whs_warehouses.warehouse_type`, never stored. The live column already
    carries MAIN/MDP/LIP (see `shared/enums.WarehouseType`), so a second copy of the
    same fact could only drift out of step with it.
    """
    WH = "WH"
    MDP = "MDP"
    LIP = "LIP"


class EventType(str, Enum):
    """`event` on each of the five write payloads."""
    ACK = "material_issue.acknowledged"
    CONSUMPTION = "facility.consumption"
    STOCK_BALANCE = "facility.stock_balance"
    STOCK_TRANSFER = "facility.stock_transfer"
    WASTAGE = "facility.wastage"


class Scope(str, Enum):
    """`scope` on the movement-driven payloads — how much of the picture one push is.

    Not enforced on the way in (`schemas._Payload.scope` is a plain string): an
    unrecognised scope word is worth recording, never worth refusing a batch over.
    """
    PARTIAL = "partial"     # one facility, seconds after the change. An increment.
    FULL = "full"           # the nightly sweep. Authoritative for all it covers.


class Basis(str, Enum):
    """`basis` on stock-balance — which of two different numbers arrived.

    They can legitimately disagree; the gap is the reconciliation signal. SCM records
    which one it got and never averages the two.
    """
    STOCK_BALANCE = "stock_balance"   # live ledger on-hand, the ~60s push
    EOD_CLOSING = "eod_closing"       # the LT's declared close, the nightly snapshot


class AckStatus(str, Enum):
    RECEIVED = "received"
    PARTIAL = "partial"
    REJECTED = "rejected"
