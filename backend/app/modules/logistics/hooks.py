"""Where the outward leg hands back to the documents it is carrying.

Logistics releases a consignment and the receiving site signs for it. Both facts
settle paperwork logistics does not own: `out_dispatches`, `out_issues` and the indent
behind them all live in the warehouse module, which sits AFTER logistics in the import
chain (rule 5). Logistics may not import it.

So the direction is inverted. The warehouse registers itself here at import time and
logistics calls whatever it finds — the same shape as `hcm.sync.POST_SYNC_HOOKS`.
Nothing registered (a test that imports logistics on its own) and the transport
request settles by itself exactly as it did before this file existed.

A hook runs INSIDE the caller's transaction and never commits: a consignment that has
left the yard and the issue that says so have to land together or not at all.
"""
from typing import Awaitable, Callable

#: Called when a transport request is released and the load actually leaves
#: (`transport.dispatch_tr`). Signature: `(db, transport_request, user)`.
ON_RELEASE: list[Callable[..., Awaitable[None]]] = []

#: Called when the receiving site signs for the shipment (`transport.acknowledge_tr`).
#: Signature: `(db, transport_request, user)`.
ON_ACKNOWLEDGE: list[Callable[..., Awaitable[None]]] = []

#: Asked BEFORE the load is released, while a release can still be refused.
#: Signature: `(db, transport_request, user) -> str | None` — a reason it may not
#: leave, or None.
#:
#: `ON_RELEASE` runs AFTER the goods have gone and so cannot veto anything: a hook
#: that declines to settle its own paperwork there does not stop the departure, it
#: only stops the RECORD of it, and the two documents end up further apart than if it
#: had said nothing. Whatever wants a say has to be asked here instead.
#:
#: Only the strict path asks. A carrier scan or a site signature arriving on a
#: shipment still reading READY is news that it left days ago — news to be recorded,
#: never a decision to veto.
BEFORE_RELEASE: list[Callable[..., Awaitable["str | None"]]] = []


async def fire(hooks: list, db, doc, user) -> None:
    """Run every registered hook, in registration order, in the caller's transaction."""
    for hook in hooks:
        await hook(db, doc, user)


async def first_objection(hooks: list, db, doc, user) -> str | None:
    """The first registered reason the load may not leave, or None if there is none."""
    for hook in hooks:
        reason = await hook(db, doc, user)
        if reason:
            return reason
    return None
