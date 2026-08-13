"""Inventory-owned enums belong here as the module is implemented."""
from enum import Enum


class AdjustmentStatus(str, Enum):
    """inv_adjustments.status.

    Lives here rather than in shared/enums.py because only this module reads or writes
    it, and shared/ is lead-owned. The values are the strings already on the live rows,
    so this names what was there rather than changing it.
    """
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class CycleCountStatus(str, Enum):
    """inv_cycle_counts.status.

    Module-owned for the same reason as `AdjustmentStatus`: nothing outside inventory
    reads it. The values are the strings the service was already writing inline, so
    naming them changes no stored row — it only stops the next typo from inventing a
    fourth status that no screen filters on.
    """
    PLANNED = "PLANNED"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"


class LocationTier(int, Enum):
    """How far down the distribution chain a stocking point sits.

    Derived from `whs_warehouses.warehouse_type`, never stored: the live column
    already carries MAIN/MDP/LIP, so a second copy of the same fact could only drift.
    Lower number = further upstream, so a movement's direction is just a comparison.
    """
    WAREHOUSE = 1   # MAIN and the non-stocking types — the top of the chain
    MDP = 2         # Material Distribution Point: OE, DM, RM, SPH, COO
    LIP = 3         # Local Inventory Point: the storekeeper at the bottom


class MovementKind(str, Enum):
    """What a stock move between two points IS, decided by where they sit.

    Never chosen by a user: the same from/to pair must always produce the same
    document, or picking MOVEMENT over TRANSFER becomes a one-click way to skip the
    Inventory Manager on a cross-project move. Users say WHY (a reason), not WHAT.
    """
    MOVEMENT = "MOVEMENT"   # same point, different bin/rack/floor
    TRANSFER = "TRANSFER"   # same tier, different point — WH<->WH, MDP<->MDP, LIP<->LIP
    ISSUE = "ISSUE"         # downstream — WH->MDP, WH->LIP, MDP->LIP
    RETURN = "RETURN"       # upstream — the same move read backwards


class STOStatus(str, Enum):
    """inv_sto.status — the values the column comment already documents."""
    DRAFT = "DRAFT"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
    DISPATCHED = "DISPATCHED"
    RECEIVED = "RECEIVED"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"
