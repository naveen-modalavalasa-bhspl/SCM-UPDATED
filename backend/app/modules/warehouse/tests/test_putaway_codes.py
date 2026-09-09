"""The label sheet a completed putaway hands back.

The asset / consumable code is minted at putaway, because a unit only becomes an asset
once it is physically somewhere — and until this endpoint existed it was minted and
never seen. These pin the one thing that decides whether the printed sheet is right:
**which units belong to THIS putaway.**

The answer is the task's own `lot_no`, stamped at confirm from the storage path and
belonging to exactly one placement. Item plus bin is the obvious key and the wrong one:
the same item goes into the same bin again next week, and printing the whole shelf means
re-labelling goods somebody already stickered.

Two endpoints, because the list is a list (rule 11): `/codes` is the header and a COUNT,
`/codes/units` is the paged rows. Opening the panel must not depend on how big the lorry
was.
"""
import pytest

from app.modules.warehouse.enums import (
    PUTAWAY_EXECUTE, PUTAWAY_VIEW, RECEIPT_CREATE, RECEIPT_VIEW,
)
from app.shared.models.master import Item
from app.shared.models.warehouse import Bin, Warehouse

pytestmark = pytest.mark.asyncio


async def _put_away(client, headers, *, warehouse_id, item_id, bin_id, qty):
    """Receive `qty`, submit, and confirm the task it raises into `bin_id`."""
    created = await client.post("/api/warehouse/receipts", json={
        "receipt_type": "PURCHASE",
        "grn_date": "2026-09-03",
        "warehouse_id": warehouse_id,
        "items": [{"item_id": item_id, "received_qty": qty}],
    }, headers=headers)
    assert created.status_code == 201, created.text
    submitted = await client.post(
        f"/api/warehouse/receipts/{created.json()['id']}/submit", headers=headers)
    assert submitted.status_code == 200, submitted.text

    tasks = await client.get("/api/warehouse/putaways", params={"status": "PENDING"},
                             headers=headers)
    task_id = tasks.json()["items"][0]["id"]
    confirmed = await client.post(f"/api/warehouse/putaways/{task_id}/confirm", json={
        "actual_bin_id": bin_id, "qty": qty,
    }, headers=headers)
    assert confirmed.status_code == 200, confirmed.text
    return task_id, confirmed.json()


async def _fixtures(db, *, is_asset=False):
    wh = Warehouse(code="WH-LBL", name="Label store", warehouse_type="MAIN",
                   is_bin_managed=True, is_active=True)
    item = Item(code="ELE-GEN-0042", name="Ceiling fan", uom_code="NOS",
                requires_qi=False, is_asset=is_asset, is_active=True)
    db.add_all([wh, item])
    await db.commit()
    target = Bin(warehouse_id=wh.id, code="A1", name="A1", bin_type="BIN",
                 is_active=True)
    db.add(target)
    await db.commit()
    return wh, item, target


async def _codes(client, headers, task_id, **params):
    """The header, and every page of units behind it, as one list — so a test can talk
    about "the codes this putaway minted" without repeating the pager."""
    head = await client.get(f"/api/warehouse/putaways/{task_id}/codes", headers=headers)
    assert head.status_code == 200, head.text
    units, page = [], 1
    while True:
        got = await client.get(f"/api/warehouse/putaways/{task_id}/codes/units",
                               params={"page": page, "size": 50, **params},
                               headers=headers)
        assert got.status_code == 200, got.text
        body = got.json()
        units.extend(body["items"])
        if len(units) >= body["total"] or not body["items"]:
            return head.json(), units, body["total"]
        page += 1


async def test_a_putaway_prints_only_the_codes_it_minted(db, client, make_user, login):
    wh, item, target = await _fixtures(db)
    await make_user(username="labeller", permissions=[RECEIPT_CREATE, RECEIPT_VIEW,
                                                      PUTAWAY_VIEW, PUTAWAY_EXECUTE,
                                                      "stock.view", "stock.transfer"])
    headers = await login("labeller", "pw")

    first, _ = await _put_away(client, headers, warehouse_id=wh.id, item_id=item.id,
                               bin_id=target.id, qty=5)
    # The same item, into the same bin, a second time. Every unit of both placements is
    # now sitting on one shelf, which is exactly the case an item+bin lookup gets wrong.
    second, _ = await _put_away(client, headers, warehouse_id=wh.id, item_id=item.id,
                                bin_id=target.id, qty=3)

    head, first_units, first_total = await _codes(client, headers, first)
    _, second_units, second_total = await _codes(client, headers, second)

    first_codes = {u["code"] for u in first_units}
    second_codes = {u["code"] for u in second_units}
    assert (first_total, len(first_codes)) == (5, 5)
    assert (second_total, len(second_codes)) == (3, 3)
    # A code names ONE physical thing, so the two sheets can never overlap.
    assert not (first_codes & second_codes)
    # The header counts without pulling the rows, and must agree with them.
    assert head["total_codes"] == 5

    # The three things a label has to name besides the code itself. Served, so the
    # sticker and the task cannot drift apart.
    assert head["item_code"] == item.code
    assert head["bin_code"] == "A1"
    assert head["lot_no"]
    assert head["code_type"] == "CONSUMABLE"
    assert all(u["scope"] == "UNIT" for u in first_units)
    assert all(u["code_type"] == "CONSUMABLE" for u in first_units)


async def test_the_codes_paginate_without_repeating_or_dropping_a_row(
    db, client, make_user, login,
):
    """A putaway writes its whole batch of units in ONE transaction, so every row of it
    shares a `created_at`. Ordering a page on that leaves the tie undefined and rows
    repeat on page 2 or vanish — the ordering is the primary key for exactly that
    reason, and this is what would catch it going back."""
    wh, item, target = await _fixtures(db)
    await make_user(username="pager", permissions=[RECEIPT_CREATE, RECEIPT_VIEW,
                                                   PUTAWAY_VIEW, PUTAWAY_EXECUTE,
                                                   "stock.view", "stock.transfer"])
    headers = await login("pager", "pw")
    task_id, _ = await _put_away(client, headers, warehouse_id=wh.id, item_id=item.id,
                                 bin_id=target.id, qty=9)

    seen: list[str] = []
    for page in (1, 2, 3):
        body = (await client.get(f"/api/warehouse/putaways/{task_id}/codes/units",
                                 params={"page": page, "size": 4},
                                 headers=headers)).json()
        assert body["total"] == 9
        assert body["page"] == page and body["size"] == 4
        seen.extend(u["code"] for u in body["items"])

    assert len(seen) == 9, seen
    assert len(set(seen)) == 9, "a code appeared on two pages"
    # Page 4 is past the end and is empty, not a repeat of the last page.
    over = (await client.get(f"/api/warehouse/putaways/{task_id}/codes/units",
                             params={"page": 4, "size": 4}, headers=headers)).json()
    assert over["items"] == [] and over["total"] == 9


async def test_a_code_can_be_found_without_paging_to_it(db, client, make_user, login):
    """500 stickers and one unit to re-label is the everyday case. Searching is how the
    storekeeper gets to it, so it filters the whole set on the server — not the page
    that happens to be on screen."""
    wh, item, target = await _fixtures(db)
    await make_user(username="finder", permissions=[RECEIPT_CREATE, RECEIPT_VIEW,
                                                    PUTAWAY_VIEW, PUTAWAY_EXECUTE,
                                                    "stock.view", "stock.transfer"])
    headers = await login("finder", "pw")
    task_id, _ = await _put_away(client, headers, warehouse_id=wh.id, item_id=item.id,
                                 bin_id=target.id, qty=6)

    _head, units, _total = await _codes(client, headers, task_id)
    wanted = units[-1]["code"]

    body = (await client.get(f"/api/warehouse/putaways/{task_id}/codes/units",
                             params={"search": wanted}, headers=headers)).json()
    assert body["total"] == 1
    assert body["items"][0]["code"] == wanted


async def test_an_asset_item_mints_asset_codes(db, client, make_user, login):
    wh, item, target = await _fixtures(db, is_asset=True)
    await make_user(username="assetman", permissions=[RECEIPT_CREATE, RECEIPT_VIEW,
                                                      PUTAWAY_VIEW, PUTAWAY_EXECUTE,
                                                      "stock.view", "stock.transfer"])
    headers = await login("assetman", "pw")

    task_id, _ = await _put_away(client, headers, warehouse_id=wh.id, item_id=item.id,
                                 bin_id=target.id, qty=2)
    head, units, total = await _codes(client, headers, task_id)
    assert head["is_asset"] is True
    assert head["code_type"] == "ASSET"
    assert head["total_codes"] == total == 2
    assert [u["code_type"] for u in units] == ["ASSET", "ASSET"]


async def test_an_unfinished_putaway_says_why_it_has_nothing_to_print(
    db, client, make_user, login,
):
    """A code names a unit that is physically somewhere, so there is nothing to print
    until the stock is placed. An empty list with no sentence reads as a defect in the
    screen rather than as the task simply not being done."""
    wh, item, _target = await _fixtures(db)
    await make_user(username="waiter", permissions=[RECEIPT_CREATE, RECEIPT_VIEW,
                                                    PUTAWAY_VIEW, PUTAWAY_EXECUTE,
                                                    "stock.view", "stock.transfer"])
    headers = await login("waiter", "pw")

    created = await client.post("/api/warehouse/receipts", json={
        "receipt_type": "PURCHASE",
        "grn_date": "2026-09-03",
        "warehouse_id": wh.id,
        "items": [{"item_id": item.id, "received_qty": 4}],
    }, headers=headers)
    await client.post(f"/api/warehouse/receipts/{created.json()['id']}/submit",
                      headers=headers)
    tasks = await client.get("/api/warehouse/putaways", headers=headers)
    task_id = tasks.json()["items"][0]["id"]

    head, units, total = await _codes(client, headers, task_id)
    assert (units, total, head["total_codes"]) == ([], 0, 0)
    assert head["reason"] and "placed in its bin" in head["reason"]
