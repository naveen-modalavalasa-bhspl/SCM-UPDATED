"""Report ledger keys. These are the URL segments and the frontend tab ids."""
from enum import Enum


class LedgerKey(str, Enum):
    INDENTS = "indents"
    APPROVALS = "approvals"
    INVENTORY = "inventory"
    WAREHOUSE = "warehouse"
