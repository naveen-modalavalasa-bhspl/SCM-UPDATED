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


async def fire(hooks: list, db, doc, user) -> None:
    """Run every registered hook, in registration order, in the caller's transaction."""
    for hook in hooks:
        await hook(db, doc, user)
