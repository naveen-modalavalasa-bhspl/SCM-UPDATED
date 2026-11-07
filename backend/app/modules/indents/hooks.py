"""Where a delivery that was not fully accepted hands its rejected goods on.

A requester who finds some of a delivery damaged, expired or broken says so when they
acknowledge it, and the goods have to go back. Returns own that document, and they sit
AFTER indents in the import chain (rule 5): indents may not import them.

So the direction is inverted, exactly as `logistics/hooks.py` does it. The returns module
registers itself here at import and indents calls whatever it finds. Nothing registered
(a test that imports indents on its own) and the acknowledgement simply records the
rejection on the receipt, as it would have before this file existed.

A hook runs INSIDE the caller's transaction and never commits: the goods landing on the
shelf and the return that sends them back have to be written together or not at all.
"""
from typing import Awaitable, Callable

#: Called once per acknowledgement that rejected something.
#: Signature: `(db, user, source, groups) -> list[dict]`.
#:
#: `source` says what was acknowledged: `{"kind": "INDENT" | "DIRECT_ISSUE", "number": str,
#: "indent_id": int | None, "issue_id": int | None}`.
#: `groups` is one entry per REASON: `{"reason": str, "total": float, "notes": [str],
#: "lines": [{"item_id": int, "line_id": int, "quantity": float, "remarks": str | None}]}`.
#: It returns what it raised, `[{"id", "return_no", "reason", "quantity"}]`.
ON_RECEIPT_REJECTIONS: list[Callable[..., Awaitable[list[dict]]]] = []


async def raise_returns(db, user, source: dict, groups: list[dict]) -> list[dict]:
    """Run every registered handler and collect the returns they raised."""
    raised: list[dict] = []
    if not groups:
        return raised
    for hook in ON_RECEIPT_REJECTIONS:
        raised.extend(await hook(db, user, source, groups) or [])
    return raised
