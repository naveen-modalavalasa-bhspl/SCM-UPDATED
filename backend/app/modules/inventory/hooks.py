"""Where inventory hands a settled document forward to a module it may not import.

An approved material request is procurement's cue to raise a draft requisition
(flow doc §3.3 step 2-3), but procurement sits AFTER inventory in the import chain
(rule 5) and inventory may not reach it. So the direction is inverted, the same shape
`hcm.sync.POST_SYNC_HOOKS` and `logistics/hooks.py` already use: procurement registers
itself here at import time and inventory calls whatever it finds.

Nothing registered — a test that imports inventory on its own — and an approval settles
exactly as it did before this file existed.

Unlike the logistics hooks, these run AFTER the caller has committed and never inside
its transaction. Raising the requisition is a CONSEQUENCE of the signature, not part of
it: a procurement failure must never unwind an approval that has already happened, and
the requisition writes its own transaction anyway.
"""
import logging
from typing import Awaitable, Callable

logger = logging.getLogger(__name__)

#: Called once a material request reaches APPROVED, after the approval is committed.
#: Signature: `(db, mr, user)`.
ON_MR_APPROVED: list[Callable[..., Awaitable[None]]] = []


async def fire_mr_approved(db, mr, user) -> None:
    """Run every registered hook, in registration order.

    One that fails is rolled back, logged and skipped. The MR is already approved and
    committed by the time this runs, so the only thing an exception here can achieve is
    turning a successful approval into a 500 for the person who pressed it.
    """
    for hook in ON_MR_APPROVED:
        try:
            await hook(db, mr, user)
        except Exception:  # noqa: BLE001 - a consequence may never fail its cause
            await db.rollback()
            logger.exception(
                "post-approval hook %s failed for material request %s",
                getattr(hook, "__name__", hook), getattr(mr, "mr_no", None))


#: Called once a Stock Transfer Order reaches APPROVED, after the approval is
#: committed. The warehouse registers the handoff that drafts the material issue at
#: the source point — inventory may not import it. Signature: `(db, sto, user)`.
ON_STO_APPROVED: list[Callable[..., Awaitable[None]]] = []


async def fire_sto_approved(db, sto, user) -> None:
    """Same contract as `fire_mr_approved`: a failing consequence never fails the
    signature that caused it."""
    for hook in ON_STO_APPROVED:
        try:
            await hook(db, sto, user)
        except Exception:  # noqa: BLE001 - a consequence may never fail its cause
            await db.rollback()
            logger.exception(
                "post-approval hook %s failed for stock transfer %s",
                getattr(hook, "__name__", hook), getattr(sto, "sto_no", None))


#: Called for every stock movement INTO a warehouse that means goods arrived there —
#: a GRN / receipt posting, a consignment credited at its destination (indent or issue
#: acknowledged), or an internal transfer landing. Runs INSIDE the caller's
#: transaction, right after the ledger row is flushed, so whatever a hook records is
#: committed with the stock or not at all. Signature: `(db, movement, user)`, where
#: `movement` is the `StockMovement` just written.
#:
#: Registered by `integrations.adapters.aims` (the AIMS outbox) — inventory may not
#: import integrations (rule 5), so the direction is inverted like the hooks above.
ON_STOCK_IN: list[Callable[..., Awaitable[None]]] = []

#: The ledger `ref_type`s that mean "goods arrived at this warehouse".
STOCK_IN_REF_TYPES = frozenset({"GRN", "RECEIPT", "DISPATCH", "TRANSFER", "STO"})


async def fire_stock_in(db, movement, user) -> None:
    """Run every registered stock-in hook, each in its own SAVEPOINT.

    A hook that fails rolls back only its own savepoint and is logged: the stock
    movement it observes is the business event, and an outside system's bookkeeping
    must never refuse or unwind it. Nothing registered — the normal case in tests and
    in any deployment without AIMS — and this is a no-op.
    """
    for hook in ON_STOCK_IN:
        try:
            async with db.begin_nested():
                await hook(db, movement, user)
        except Exception:  # noqa: BLE001 - an observer may never fail the movement
            logger.exception(
                "stock-in hook %s failed for ledger ref %s %s",
                getattr(hook, "__name__", hook), getattr(movement, "ref_type", None),
                getattr(movement, "ref_no", None))
