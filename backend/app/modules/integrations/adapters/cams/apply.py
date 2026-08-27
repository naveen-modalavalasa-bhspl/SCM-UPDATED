"""Turning a field event into an actual stock movement.

`ingest.py` deliberately stops at recording what arrived — see its docstring. This is
the other half: what a recorded consumption or wastage event DOES to the shelf it was
reported against, so SCM's stock reflects what the field actually used.

**Every deduction goes through `inventory.service.move_stock_out()`.** Nothing here
assigns to `stk_balance` and nothing writes a ledger row of its own (rule 7). The
integrations module sits outside the dependency chain and may import inventory, which
is the base module, so this is the allowed direction (rule 5).

**The two feeds overlap by design and must not be summed.** A consumption record
repeats its wastage in `wastage_qty` for reporting, and the same quantity arrives again
on the wastage feed with the reason and the value attached. So consumption posts
`consumed_qty` ONLY and wastage posts `wastage_qty` ONLY. Adding `wastage_qty` into the
consumption post would deduct every spoiled unit twice, and the error would look like
theft rather than like a bug.

**A record that cannot post is KEPT, never dropped.** Over-consumption almost always
means SCM's balance is stale — goods reached the point but the receipt was never posted
here — so the field's number is the true one and ours is behind. Throwing the record
away would discard the only signal saying so. It is parked with the reason, on the
event it arrived on, for somebody to reconcile; the rest of the batch still posts.
"""
import logging
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.integrations.adapters.cams.enums import EventType
from app.modules.inventory import service as inventory
from app.shared.enums import RefType
from app.shared.models.master import Item
from app.shared.time import now as ist_now

log = logging.getLogger("app.integrations.cams")


class _FieldActor:
    """Who the ledger says moved the stock.

    A field event has no SCM employee behind it — the person named on the record is a
    B-CAMS user this system has never authenticated, and writing their name into
    `created_by_name` would claim an SCM identity for them. `created_by_id` is a soft
    FK and nullable (see `shared/models/base.soft_fk`), so the honest answer is no id
    and a name that says where the movement came from.
    """
    id = None
    full_name = "B-CAMS field feed"


ACTOR = _FieldActor()

#: Which quantity each event posts, and under which head. Stated once so the two can
#: never drift into summing the same units twice — see the module docstring.
POSTING = {
    EventType.CONSUMPTION.value: ("consumed_qty", RefType.CONSUMPTION.value),
    EventType.WASTAGE.value: ("wastage_qty", RefType.WASTAGE.value),
}


async def _item_id(db: AsyncSession, item_code: str | None) -> int | None:
    if not item_code:
        return None
    return await db.scalar(select(Item.id).where(Item.code == item_code))


async def apply_event(db: AsyncSession, event: str, payload, event_id: str) -> dict:
    """Post every line of one event that can be posted. Never raises.

    Returns a summary the receipt carries, so "what happened to my push" is answerable
    from the same place the push is: how many lines moved stock, how many could not,
    and why each of those could not.
    """
    posting = POSTING.get(event)
    if posting is None:
        return {"posted": 0, "skipped": 0, "problems": []}
    qty_field, ref_type = posting

    records = getattr(payload, "records", None) or []
    posted, problems = 0, []

    for index, line in enumerate(records, start=1):
        qty = Decimal(str(getattr(line, qty_field, 0) or 0))
        where = f"line {index} ({getattr(line, 'item_code', '?')})"
        if qty <= 0:
            # Nothing left the shelf. Not a problem — a zero row is how the field says
            # "this item was stocked and untouched today".
            continue

        warehouse_id = getattr(line, "warehouse_id", None)
        if not warehouse_id:
            # The one key SCM matches a point on. `facility_name` is free text and
            # matches nothing, so a record without this cannot be posted anywhere.
            problems.append(f"{where}: no warehouse_id, so there is no point to "
                            f"deduct it from")
            continue

        item_id = await _item_id(db, getattr(line, "item_code", None))
        if item_id is None:
            problems.append(f"{where}: item_code is not in the SCM item master")
            continue

        try:
            await inventory.move_stock_out(
                db, item_id=item_id, qty=qty,
                ref_type=ref_type, ref_id=0, ref_no=event_id,
                user=ACTOR, warehouse_id=int(warehouse_id),
            )
            posted += 1
        except Exception as exc:  # noqa: BLE001 — one bad line must not sink the batch
            # Insufficient stock lands here, and it is the case worth reading: it
            # almost always means a receipt was never posted in SCM, not that the
            # field is wrong. Kept with its reason rather than dropped.
            problems.append(f"{where}: {exc}")

    if problems:
        log.warning("cams %s %s: %s of %s lines could not post — %s",
                    event, event_id, len(problems), len(records), problems[:5])

    return {"posted": posted, "skipped": len(problems), "problems": problems,
            "applied_at": ist_now().isoformat()}
