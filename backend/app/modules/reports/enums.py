"""Report ledger keys. These are the URL segments and the frontend tab ids."""
from enum import Enum


class LedgerKey(str, Enum):
    INDENTS = "indents"
    APPROVALS = "approvals"
    INVENTORY = "inventory"
    WAREHOUSE = "warehouse"
    STOCK = "stock"
    ACKNOWLEDGEMENTS = "acknowledgements"
    INDENT_TRACKER = "indent_tracker"
    APPROVAL_SLA = "approval_sla"
    CONSUMPTION = "consumption"
    # Everything going back: field returns up the chain (`inv_sto` rows carrying the
    # returns marker) and purchase returns out to vendors (`pro_returns`), on one
    # ledger because "what went back and what happened to it" is one question.
    RETURNS = "returns"
    # The outward transport leg — mode, carrier, freight, where it got to.
    TRANSPORT = "transport"


class AgeBucket(str, Enum):
    """Days a balance has sat without a movement. Same cut points as the stock ageing
    screen (`inventory.service.get_stock_ageing`) so the two never disagree."""
    D0_30 = "0-30"
    D31_60 = "31-60"
    D61_90 = "61-90"
    D90_PLUS = "90+"


class ExpiryBucket(str, Enum):
    """Days left before expiry, ageing-screen cut points. EXPIRED is already past."""
    EXPIRED = "EXPIRED"
    D0_30 = "0-30"
    D31_60 = "31-60"
    D61_90 = "61-90"
    D90_PLUS = "90+"


class Breach(str, Enum):
    """Did the decision land after the stage was due. NULL means no due date was set."""
    YES = "YES"
    NO = "NO"
