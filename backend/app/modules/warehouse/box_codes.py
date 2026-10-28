"""Codes per ISSUE CONTAINER — an issue names the BOX (2026-10-26).

An item whose Container Usage maps an ISSUE container (a Box, a Strip) is issued in
that container, and the container's code is what the issue asks for, checks and
records — one box, one code — never one code per tablet.

Three kinds of stock reach the issue desk, and all three end up the same shape here:

* NEW stock — boxed at putaway (`packing.shelve` splits the storage packs down to the
  issue container and makes a PART box of whatever is left over); every box code is
  queued for a label.
* OLD stock — coded per base unit before the item was mapped. `rebox_lot` groups those
  units into boxes (whole boxes, then one part box for the remainder) and gives each
  box a code; the units' own codes stay on the unit rows, inside their box, as hidden
  history, so an old label scanned at the desk still finds its box
  (`scripts.setup_container_usage --apply`).
* RE-CODED stock — the Issue container changed after the goods were boxed. A lot no
  document holds is re-cut at once (`packing.recode_item`); a lot an open issue holds
  is re-cut the next time that issue is saved (`ensure_issue_level`), and an issue
  still holding boxes of the old container may not post.

At the desk (`hold_line`): boxes the line names come first (scanned, picked, or echoed
back by the screen), then an exact fill, then whole boxes, then the smallest box that
covers the rest — held with the line's marker, and so are the unit rows inside them,
so `post_issue` moves the right history. At posting (`settle_on_post`) a whole box
leaves under its own code; a part of a box leaves as a NEW part box with a new code
(queued for a label), and the box on the shelf keeps its code, holding less.
"""
from __future__ import annotations

import math
from decimal import Decimal

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.modules.inventory.models import Stock
from app.modules.warehouse import models as m
from app.modules.warehouse import packing as wh_packing
from app.modules.warehouse.enums import (
    LIVE_HANDLING_UNIT_STATUSES as LIVE, BoxLabelReason, BoxLabelStatus,
    HandlingUnitStatus as HUS, IssueDirection, SerialStatus,
)
from app.shared import packing
from app.shared.masters import packs
from app.shared.models.base import utcnow
from app.shared.models.master import Item, ItemPackaging
from app.shared.models.warehouse import Warehouse

ZERO = Decimal("0")
held = wh_packing.held


def _d(value) -> Decimal:
    return Decimal(str(value or 0))


def hold_marker(issue_id: int, line_id: int) -> str:
    """The same stamp a unit held for that line carries."""
    return f"Reserved for issue {issue_id} line {line_id}"


def issued_marker(issue_id: int, line_id: int) -> str:
    return f"Issued by issue {issue_id} line {line_id}"


def _issue_prefix(issue_id: int) -> str:
    return f"Reserved for issue {issue_id} line "


# --------------------------------------------------------------------------- #
#  What an item is issued in
# --------------------------------------------------------------------------- #

async def issue_packages(db: AsyncSession, item_id: int) -> set[int]:
    """The container types (`mst_packaging` ids) the item is ISSUED in; empty when it
    is issued loose."""
    mapped = (await packs.usage_map(db, [item_id])).get(int(item_id), {})
    return {int(pid) for pid, usages in mapped.items() if pid and "ISSUE" in usages}


async def issue_level(db: AsyncSession, item_id: int, ladder: packing.Ladder) -> int | None:
    """The smallest level of this ladder the item is issued in; None = issued loose."""
    levels = await packs.usage_levels(db, item_id, ladder, "ISSUE")
    return min((lv for lv in (levels or []) if lv > 0), default=None)


async def _package_of(db: AsyncSession, rung_ids) -> dict[int, int]:
    rung_ids = {int(r) for r in rung_ids if r}
    if not rung_ids:
        return {}
    return dict((await db.execute(select(ItemPackaging.id, ItemPackaging.package_id)
                                  .where(ItemPackaging.id.in_(rung_ids)))).all())


async def _children(db: AsyncSession, roots) -> dict[int, list]:
    """Every LIVE pack inside the given ones, at any depth, keyed by parent."""
    out: dict[int, list] = {}
    frontier = [hu.id for hu in roots]
    while frontier:
        kids = (await db.execute(select(m.HandlingUnit).where(
            m.HandlingUnit.parent_id.in_(frontier),
            m.HandlingUnit.status.in_(LIVE)))).scalars().all()
        for kid in kids:
            out.setdefault(kid.parent_id, []).append(kid)
        frontier = [kid.id for kid in kids]
    return out


def _tree_ids(hu, children: dict) -> list[int]:
    ids, stack = [], [hu]
    while stack:
        node = stack.pop()
        ids.append(node.id)
        stack.extend(children.get(node.id, []))
    return ids


async def boxes_at(db: AsyncSession, *, item_id: int, warehouse_id: int,
                   batch_id: int | None = None, bin_id: int | None = None,
                   packages: set[int] | None = None, lock: bool = False,
                   all_levels: bool = False) -> list:
    """The live ISSUE containers of an item at a point — narrowed to a batch and a
    location when the line names them. Where two levels of one ladder are both
    mapped for Issue, the smaller one is the box — unless `all_levels`, which returns
    both (2026-10-27): a line may then name whole boxes AND, for what is left, strips
    out of another box."""
    packages = packages if packages is not None else await issue_packages(db, item_id)
    if not packages:
        return []
    stmt = (select(m.HandlingUnit)
            .join(ItemPackaging, ItemPackaging.id == m.HandlingUnit.item_packaging_id)
            .where(m.HandlingUnit.item_id == item_id,
                   m.HandlingUnit.warehouse_id == warehouse_id,
                   m.HandlingUnit.status.in_(LIVE),
                   ItemPackaging.package_id.in_(packages)))
    if batch_id:
        stmt = stmt.where(m.HandlingUnit.batch_id == batch_id)
    if bin_id:
        stmt = stmt.where(m.HandlingUnit.bin_id == bin_id)
    stmt = stmt.order_by(m.HandlingUnit.id)
    if lock:
        stmt = stmt.with_for_update()
    rows = (await db.execute(stmt)).scalars().all()
    if all_levels:
        return list(rows)
    lowest: dict[int, int] = {}
    for hu in rows:
        lowest[hu.pack_hierarchy_id] = min(lowest.get(hu.pack_hierarchy_id, hu.level), hu.level)
    return [hu for hu in rows if hu.level == lowest[hu.pack_hierarchy_id]]


# --------------------------------------------------------------------------- #
#  Labels
# --------------------------------------------------------------------------- #

async def queue_labels(db: AsyncSession, hus, *, item=None, reason: BoxLabelReason,
                       source_no: str | None = None) -> int:
    """Queue a label for every new box code (Labels & Printing > Box labels)."""
    hus = [hu for hu in hus if hu is not None and hu.hu_code
           and not hu.hu_code.startswith("~")]
    if not hus:
        return 0
    item = item or await db.get(Item, hus[0].item_id)
    names = dict((await db.execute(select(Warehouse.id, Warehouse.name).where(
        Warehouse.id.in_({hu.warehouse_id for hu in hus})))).all())
    bins = dict((await db.execute(select(m.WarehouseLocation.id, m.WarehouseLocation.code)
                                  .where(m.WarehouseLocation.id.in_(
                                      {hu.bin_id for hu in hus if hu.bin_id} or {0}))))
                .all())
    batches = dict((await db.execute(select(m.Batch.id, m.Batch.batch_no).where(
        m.Batch.id.in_({hu.batch_id for hu in hus if hu.batch_id} or {0})))).all())
    for hu in hus:
        db.add(m.BoxLabel(
            handling_unit_id=hu.id, hu_code=hu.hu_code, item_id=hu.item_id,
            item_code=getattr(item, "code", None), item_name=getattr(item, "name", None),
            warehouse_id=hu.warehouse_id, warehouse_name=names.get(hu.warehouse_id),
            bin_code=bins.get(hu.bin_id), batch_no=batches.get(hu.batch_id),
            pack_name=hu.pack_name, content_qty=held(hu), pack_size=_d(hu.pack_size),
            uom_code=getattr(item, "uom_code", None), reason=reason.value,
            source_no=(source_no or "")[:60] or None,
            status=BoxLabelStatus.QUEUED.value))
    await db.flush()
    return len(hus)


# --------------------------------------------------------------------------- #
#  Re-boxing a lot: old stock, the leftover part box, a changed Issue container
# --------------------------------------------------------------------------- #

async def _key_total(db: AsyncSession, key: dict) -> Decimal:
    """Stock on hand at one stock key, every brand combination together."""
    return _d(await db.scalar(select(func.coalesce(func.sum(Stock.total_qty), 0)).where(
        Stock.item_id == key["item_id"], Stock.warehouse_id == key["warehouse_id"],
        Stock.bin_id == (key["bin_id"] or 0), Stock.batch_id == (key["batch_id"] or 0),
        Stock.project_id == (key["project_id"] or 0))))


async def _loose_unit_ids(db: AsyncSession, key: dict) -> list[int]:
    return await wh_packing._loose_units(db, key)


def needs_rebox(live: list, level: int) -> bool:
    """Does anything in this lot sit in a container other than the issue one?
    Every innermost pack must be a box of `level`; a smaller pack standing on its own
    must be grouped up."""
    if not live:
        return False
    parents = {hu.parent_id for hu in live if hu.parent_id}
    leaves = [hu for hu in live if hu.id not in parents]
    by_id = {hu.id: hu for hu in live}

    def in_a_box(hu) -> bool:
        # The code tree (2026-10-27) splits a unit-tracked item down past its Issue
        # container: a strip INSIDE a box of the issue level is exactly right, and
        # re-boxing it would throw the tree away on every save.
        node = by_id.get(hu.parent_id) if hu.parent_id else None
        for _ in range(8):
            if node is None:
                return False
            if node.level == level:
                return True
            node = by_id.get(node.parent_id) if node.parent_id else None
        return False

    return any(hu.level > level or (hu.level < level and not in_a_box(hu))
               for hu in leaves)


async def _make_boxes(db: AsyncSession, *, key: dict, ladder: packing.Ladder, level: int,
                      qty: Decimal, source: tuple, lot_no=None, user=None) -> list:
    """Whole boxes of `level` for `qty`, and ONE part box for what is left."""
    size = _d(ladder.at(level).size)
    if qty <= ZERO or size <= ZERO:
        return []
    whole = int(qty // size)
    rest = qty - whole * size
    made = []
    for _ in range(whole):
        made.append(wh_packing._new_pack(key=key, ladder=ladder, level=level, atom=False,
                                         source=source, lot_no=lot_no, user=user))
    if rest > ZERO:
        made.append(wh_packing._new_pack(key=key, ladder=ladder, level=level, atom=False,
                                         source=source, lot_no=lot_no, user=user,
                                         content=rest))
    for hu in made:
        db.add(hu)
    await db.flush()
    return made


async def rebox_lot(db: AsyncSession, key: dict, *, item, ladder: packing.Ladder,
                    level: int, reason: str, label_reason: BoxLabelReason,
                    source: tuple, user=None, box_loose: bool = True) -> dict:
    """Make every unit of one lot sit in a box of `level`, each box with its own code.

    * A pack at `level` standing on its own stays — its code is kept; anything smaller
      inside it is closed (code retired, `reason` recorded) and its units sit in the
      box directly.
    * A pack ABOVE `level` (a carton) stays; what is inside it is re-cut down to boxes
      of `level` unless it already is.
    * A pack BELOW `level` standing on its own (a strip, when the item is now issued
      in boxes) is closed, and its units go back to the loose pool.
    * The loose pool — what no pack holds — is boxed: whole boxes, then ONE part box
      for the remainder (`box_loose`). Unit rows follow in id order.

    Quantities never move; only which pack holds what, and their codes. Returns
    {"kept", "made", "retired", "boxes": [new boxes]}.
    """
    now, who = utcnow(), getattr(user, "full_name", None)
    warehouse = await db.get(Warehouse, key["warehouse_id"])
    live = (await db.execute(select(m.HandlingUnit).where(
        m.HandlingUnit.item_id == key["item_id"],
        m.HandlingUnit.warehouse_id == key["warehouse_id"],
        m.HandlingUnit.bin_id == (key["bin_id"] or m.NO_BIN),
        m.HandlingUnit.batch_id == (key["batch_id"] or m.NO_BATCH),
        m.HandlingUnit.project_id == (key["project_id"] or 0),
        m.HandlingUnit.pack_hierarchy_id == ladder.hierarchy_id,
        m.HandlingUnit.status.in_(LIVE)).with_for_update())).scalars().all()
    kids: dict[int, list] = {}
    for hu in live:
        if hu.parent_id:
            kids.setdefault(hu.parent_id, []).append(hu)
    tops = [hu for hu in live if not hu.parent_id]
    made: list = []
    retired = kept = 0

    async def units_in(ids):
        return list((await db.execute(select(m.SerialNumber.id).where(
            m.SerialNumber.handling_unit_id.in_(ids or [0]),
            m.SerialNumber.warehouse_id == key["warehouse_id"],
            m.SerialNumber.status == SerialStatus.AVAILABLE.value,
            m.SerialNumber.is_active.is_(True)).order_by(m.SerialNumber.id))).scalars().all())

    def close_tree(hu):
        nonlocal retired
        for kid in kids.get(hu.id, []):
            close_tree(kid)
            wh_packing._close(kid, HUS.OPENED.value, reason, who, now)
            retired += 1

    for top in tops:
        tree = _tree_ids(top, kids)
        if top.level < level:
            # Too small to be the box now: closed, its units go loose and are boxed.
            units = await units_in(tree)
            close_tree(top)
            wh_packing._close(top, HUS.OPENED.value, reason, who, now)
            retired += 1
            await wh_packing._link_units(db, units, None)
            continue
        if top.level == level:
            top.is_atom = False
            if kids.get(top.id):
                units = await units_in(tree)
                close_tree(top)
                await wh_packing._link_units(db, units, top.id)
            kept += 1
            continue
        # A carton: re-cut inside it only where it is not already boxes of `level`.
        inside = [hu for hu in live if hu.id in set(tree) and hu.id != top.id]
        if inside and not needs_rebox([top] + inside, level):
            kept += 1
            continue
        units = await units_in(tree)
        close_tree(top)
        await db.flush()
        leaves, cut = await wh_packing.split_down(
            db, [top], ladder=ladder, key=key, level=level, atom=False, source=source,
            lot_no=top.lot_no, user=user)
        made += [hu for hu in cut if hu.level == level]
        cursor = 0
        for leaf in leaves:
            take = units[cursor:cursor + int(held(leaf))]
            cursor += len(take)
            await wh_packing._link_units(db, take, leaf.id)
    await db.flush()

    if box_loose:
        # What no pack holds, boxed — the last box a part box (decision 2026-10-26).
        standing = (await db.execute(select(m.HandlingUnit).where(
            m.HandlingUnit.item_id == key["item_id"],
            m.HandlingUnit.warehouse_id == key["warehouse_id"],
            m.HandlingUnit.bin_id == (key["bin_id"] or m.NO_BIN),
            m.HandlingUnit.batch_id == (key["batch_id"] or m.NO_BATCH),
            m.HandlingUnit.project_id == (key["project_id"] or 0),
            m.HandlingUnit.parent_id.is_(None),
            m.HandlingUnit.status.in_(LIVE)))).scalars().all()
        loose = await _key_total(db, key) - sum((held(hu) for hu in standing), ZERO)
        if loose > ZERO and loose == loose.to_integral_value():
            boxes = await _make_boxes(db, key=key, ladder=ladder, level=level, qty=loose,
                                      source=source, user=user)
            made += boxes
            units = await _loose_unit_ids(db, key)
            cursor = 0
            for box in boxes:
                take = units[cursor:cursor + int(held(box))]
                cursor += len(take)
                await wh_packing._link_units(db, take, box.id)
    if made:
        await wh_packing._name_packs(db, made, item, warehouse, True)
        await queue_labels(db, made, item=item, reason=label_reason, source_no=source[2])
    return {"kept": kept, "made": len(made), "retired": retired, "boxes": made}


async def held_lot(db: AsyncSession, key: dict, *, except_issue: int | None = None) -> str | None:
    """Is anything at this lot held by an open issue? Answers the issue's marker."""
    mine = _issue_prefix(except_issue) if except_issue else None
    for marker in (await db.execute(select(m.HandlingUnit.held_by).where(
            m.HandlingUnit.item_id == key["item_id"],
            m.HandlingUnit.warehouse_id == key["warehouse_id"],
            m.HandlingUnit.bin_id == (key["bin_id"] or m.NO_BIN),
            m.HandlingUnit.batch_id == (key["batch_id"] or m.NO_BATCH),
            m.HandlingUnit.status.in_(LIVE),
            m.HandlingUnit.held_by.like("Reserved for issue %")))).scalars().all():
        if not mine or not marker.startswith(mine):
            return marker
    stmt = select(m.SerialNumber.remarks).where(
        m.SerialNumber.item_id == key["item_id"],
        m.SerialNumber.warehouse_id == key["warehouse_id"],
        m.SerialNumber.status == SerialStatus.AVAILABLE.value,
        m.SerialNumber.remarks.like("Reserved for issue %"))
    for column, value in ((m.SerialNumber.bin_id, key["bin_id"]),
                          (m.SerialNumber.batch_id, key["batch_id"])):
        stmt = stmt.where(column == value) if value else stmt.where(
            or_(column.is_(None), column == 0))
    for marker in (await db.execute(stmt.limit(50))).scalars().all():
        if not mine or not (marker.startswith(mine)
                            or marker == f"Reserved for issue {except_issue}"):
            return marker
    return None


async def holder_label(db: AsyncSession, marker: str | None) -> str:
    """"WHI0009" for a "Reserved for issue 13 line 4" marker."""
    try:
        issue_id = int((marker or "").split("issue ", 1)[1].split()[0])
    except (IndexError, ValueError):
        return "another document"
    no = await db.scalar(select(m.MaterialIssue.issue_no).where(m.MaterialIssue.id == issue_id))
    return no or f"issue {issue_id}"


# --------------------------------------------------------------------------- #
#  The issue desk
# --------------------------------------------------------------------------- #

async def release_issue(db: AsyncSession, issue_id: int, line_ids=None) -> None:
    """Free every box this issue (or these lines of it) holds."""
    stmt = update(m.HandlingUnit).where(
        m.HandlingUnit.held_by.like(f"{_issue_prefix(issue_id)}%"),
        m.HandlingUnit.status.in_(LIVE))
    if line_ids is not None:
        stmt = stmt.where(m.HandlingUnit.held_by.in_(
            [hold_marker(issue_id, line_id) for line_id in line_ids] or [""]))
    await db.execute(stmt.values(held_by=None, held_qty=None)
                     .execution_options(synchronize_session="fetch"))


async def ensure_issue_level(db: AsyncSession, issue, line, *, batch_id, bin_id,
                             user=None) -> bool:
    """Scenario 3 — the item's Issue container changed while this issue held the lot.

    Re-cuts the line's lot to the CURRENT issue container before boxes are held, so the
    codes the line names are always of the container the master says. Refused, naming
    it, when another open issue holds the same lot: re-cutting would change the boxes
    that issue has already named. Returns whether anything was re-cut.
    """
    stmt = select(m.HandlingUnit).where(
        m.HandlingUnit.item_id == line.item_id,
        m.HandlingUnit.warehouse_id == issue.warehouse_id,
        m.HandlingUnit.status.in_(LIVE))
    if batch_id:
        stmt = stmt.where(m.HandlingUnit.batch_id == batch_id)
    if bin_id:
        stmt = stmt.where(m.HandlingUnit.bin_id == bin_id)
    groups: dict[tuple, list] = {}
    for hu in (await db.execute(stmt)).scalars().all():
        groups.setdefault((hu.bin_id, hu.batch_id, hu.project_id, hu.pack_hierarchy_id),
                          []).append(hu)
    item = await db.get(Item, line.item_id)
    changed = False
    for (bin_, batch_, project_, hierarchy_), live in groups.items():
        ladder = await packs.ladder(db, line.item_id, hierarchy_)
        level = await issue_level(db, line.item_id, ladder)
        if not level or not needs_rebox(live, level):
            continue
        key = {"item_id": line.item_id, "warehouse_id": issue.warehouse_id,
               "bin_id": bin_, "batch_id": batch_, "project_id": project_}
        other = await held_lot(db, key, except_issue=issue.id)
        if other:
            raise ValidationError(
                f"{line.item_code or item.code}: this item is now issued in "
                f"{ladder.at(level).name} and the lot still holds the old containers. "
                f"{await holder_label(db, other)} holds the same lot — save or cancel "
                "that issue first, then save this one and its codes are re-made.")
        for hu in live:
            if hu.held_by:
                hu.held_by, hu.held_qty = None, None
        await rebox_lot(db, key, item=item, ladder=ladder, level=level,
                        reason=f"Re-coded on {issue.issue_no}: the item's issue "
                               f"container is now {ladder.at(level).name}",
                        label_reason=BoxLabelReason.RECODED,
                        source=("RECODE", issue.id, issue.issue_no), user=user)
        changed = True
    return changed


def plan_boxes(boxes: list, qty: Decimal, named_ids: list[int]) -> tuple[list, Decimal]:
    """Which boxes a line of `qty` takes, and how much of each.

    The boxes the line names first, in its order. Then a box holding exactly what is
    still wanted; then whole boxes, the fullest first, so the line names as few codes
    as it can; then the SMALLEST box that covers what is left, taken in part. Returns
    ([(box, take)], short).
    """
    rest = _d(qty)
    picks: list[tuple] = []
    used: set[int] = set()
    by_id = {b.id: b for b in boxes}
    for box_id in named_ids:
        box = by_id.get(box_id)
        if box is None or rest <= ZERO or box.id in used:
            continue
        take = min(held(box), rest)
        picks.append((box, take))
        used.add(box.id)
        rest -= take
    pool = [b for b in boxes if b.id not in used and held(b) > ZERO]
    if rest > ZERO:
        exact = next((b for b in pool if held(b) == rest), None)
        if exact is not None:
            picks.append((exact, rest))
            used.add(exact.id)
            rest = ZERO
    if rest > ZERO:
        for box in sorted(pool, key=lambda b: (-held(b), b.id)):
            if box.id in used or held(box) > rest:
                continue
            picks.append((box, held(box)))
            used.add(box.id)
            rest -= held(box)
            if rest <= ZERO:
                break
    if rest > ZERO:
        cover = sorted((b for b in pool if b.id not in used and held(b) > rest),
                       key=lambda b: (held(b), b.id))
        if cover:
            picks.append((cover[0], rest))
            rest = ZERO
    return picks, max(rest, ZERO)


async def _box_of_old_code(db: AsyncSession, code: str, *, item_id: int,
                           warehouse_id: int, boxes: list):
    """An old per-unit code scanned at the desk: the box its unit now sits in."""
    unit = (await db.execute(select(m.SerialNumber).where(
        m.SerialNumber.item_id == item_id, m.SerialNumber.warehouse_id == warehouse_id,
        or_(m.SerialNumber.consumable_code == code, m.SerialNumber.asset_code == code,
            m.SerialNumber.serial_number == code)).limit(1))).scalars().first()
    if unit is None or not unit.handling_unit_id:
        return None
    by_id = {b.id: b for b in boxes}
    hu_id = unit.handling_unit_id
    for _ in range(8):
        if hu_id in by_id:
            return by_id[hu_id]
        hu_id = await db.scalar(select(m.HandlingUnit.parent_id)
                                .where(m.HandlingUnit.id == hu_id))
        if not hu_id:
            return None
    return None


async def hold_line(db: AsyncSession, issue, line, *, named: list[str],
                    claimed_prefixes: tuple, user=None) -> dict | None:
    """Hold the boxes one issue line takes. None: the item is not issued in a
    container here, or the lot holds no boxes — the caller keeps the unit path."""
    if issue.direction != IssueDirection.OUT.value:
        return None
    packages = await issue_packages(db, line.item_id)
    if not packages:
        return None
    batch_id = line.batch_id if line.batch_id and line.batch_id != m.NO_BATCH else None
    bin_id = line.bin_id if line.bin_id and line.bin_id != m.NO_BIN else None
    await ensure_issue_level(db, issue, line, batch_id=batch_id, bin_id=bin_id, user=user)
    boxes = await boxes_at(db, item_id=line.item_id, warehouse_id=issue.warehouse_id,
                           batch_id=batch_id, bin_id=bin_id, packages=packages, lock=True)
    if not boxes:
        return None
    marker = hold_marker(issue.id, line.id)
    # Two Issue containers (2026-10-27): a code may name the BIGGER one too — a whole
    # box when strips are the smallest — so the named codes are looked up over every
    # Issue level. What the server chooses for itself stays the smallest.
    every_level = await boxes_at(db, item_id=line.item_id, warehouse_id=issue.warehouse_id,
                                 batch_id=batch_id, bin_id=bin_id, packages=packages,
                                 lock=True, all_levels=True)
    if len(every_level) > len(boxes):
        inner_of = await _children(db, every_level)
        boxes_by_id = {b.id: b for b in boxes}
        for big in every_level:
            if big.id in boxes_by_id:
                continue
            inner = [n for n in _tree_ids(big, inner_of) if n != big.id]
            busy = [boxes_by_id[n] for n in inner if n in boxes_by_id
                    and boxes_by_id[n].held_by and boxes_by_id[n].held_by != marker]
            if not busy:
                boxes.append(big)
    by_code = {b.hu_code: b for b in boxes}
    named_ids: list[int] = []
    problems: list[str] = []
    for code in named:
        box = by_code.get(code) or await _box_of_old_code(
            db, code, item_id=line.item_id, warehouse_id=issue.warehouse_id, boxes=boxes)
        if box is None:
            # A code of this item that is simply not a box here any more — the old
            # container after a re-code, a box since consumed — is the screen's echo
            # of what the line held: re-made, never refused. Only a code that names
            # nothing of this item is a mistake worth stopping for.
            known = await db.scalar(select(func.count()).select_from(m.HandlingUnit).where(
                m.HandlingUnit.item_id == line.item_id, m.HandlingUnit.hu_code == code))
            if not known:
                known = await db.scalar(select(func.count()).select_from(m.SerialNumber).where(
                    m.SerialNumber.item_id == line.item_id,
                    or_(m.SerialNumber.consumable_code == code,
                        m.SerialNumber.asset_code == code,
                        m.SerialNumber.serial_number == code)))
            if not known:
                problems.append(f"{code} is not a {boxes[0].pack_name or 'box'} of this "
                                "item at this batch and location")
        elif box.held_by and box.held_by != marker:
            problems.append(f"{code} is held by {await holder_label(db, box.held_by)}")
        elif box.id not in named_ids:
            named_ids.append(box.id)
    if problems:
        raise ValidationError(f"{line.item_code or line.item_name}: " + "; ".join(problems))
    # A box named whole takes everything inside it: a strip inside a named box is not
    # named twice, and nothing the server chooses comes out of a named box.
    if len(boxes) > 1:
        inside_of = await _children(db, [b for b in boxes if b.id in named_ids])
        covered: set[int] = set()
        for box_id in named_ids:
            box = next(b for b in boxes if b.id == box_id)
            covered.update(n for n in _tree_ids(box, inside_of) if n != box.id)
        named_ids = [i for i in named_ids if i not in covered]
        smallest = {}
        for b in boxes:
            smallest[b.pack_hierarchy_id] = min(smallest.get(b.pack_hierarchy_id, b.level), b.level)
        boxes = [b for b in boxes if b.id not in covered
                 and (b.id in named_ids or b.level == smallest[b.pack_hierarchy_id])]
    free = [b for b in boxes if not b.held_by or b.held_by == marker]
    picks, short = plan_boxes(free, _d(line.issued_qty), named_ids)
    for box in boxes:
        if box.held_by == marker:
            box.held_by, box.held_qty = None, None
    for box, take in picks:
        box.held_by = marker
        box.held_qty = None if take >= held(box) else take
    await db.flush()
    # The unit rows inside (old stock's per-unit history) move with their box.
    children = await _children(db, [box for box, _ in picks])
    for box, take in picks:
        ids = _tree_ids(box, children)
        units = list((await db.execute(select(m.SerialNumber.id).where(
            m.SerialNumber.handling_unit_id.in_(ids),
            m.SerialNumber.warehouse_id == issue.warehouse_id,
            m.SerialNumber.status == SerialStatus.AVAILABLE.value,
            m.SerialNumber.is_active.is_(True),
            or_(m.SerialNumber.remarks.is_(None), m.SerialNumber.remarks == marker,
                *[~m.SerialNumber.remarks.startswith(p) for p in claimed_prefixes]))
            .order_by(m.SerialNumber.remarks != marker, m.SerialNumber.id)
            .limit(int(take)))).scalars().all())
        if units:
            await db.execute(update(m.SerialNumber).where(m.SerialNumber.id.in_(units))
                             .values(remarks=marker)
                             .execution_options(synchronize_session="fetch"))
    return {"codes": [box.hu_code for box, _ in picks], "short": short}


async def line_boxes(db: AsyncSession, issue_id: int, line_id: int) -> list:
    """The boxes a line holds — or, once posted, the boxes it issued."""
    return list((await db.execute(select(m.HandlingUnit).where(
        m.HandlingUnit.held_by.in_((hold_marker(issue_id, line_id),
                                    issued_marker(issue_id, line_id))))
        .order_by(m.HandlingUnit.id))).scalars().all())


async def line_view(db: AsyncSession, issue, line) -> dict | None:
    """What the issue screen shows for a line of an item issued in a container: the
    box codes, how many it needs, each box, and — when the Issue container changed
    after the boxes were held — the sentence that says so."""
    packages = await issue_packages(db, line.item_id)
    if not packages:
        return None
    boxes = await line_boxes(db, issue.id, line.id)
    issued = _d(line.issued_qty)
    package_of = await _package_of(db, {b.item_packaging_id for b in boxes})
    stale = [b for b in boxes if b.held_by and b.held_by.startswith("Reserved")
             and package_of.get(b.item_packaging_id) not in packages]
    takes = [(_d(b.held_qty) if b.held_qty is not None else held(b)) for b in boxes]
    taken = sum(takes, ZERO)
    need = len(boxes)
    if taken < issued:
        size = _d(boxes[0].pack_size) if boxes else ZERO
        if not size:
            ladder = await packs.ladder(db, line.item_id, getattr(line, "pack_hierarchy_id", None))
            level = await issue_level(db, line.item_id, ladder)
            size = _d(ladder.at(level).size) if level else ZERO
        need += math.ceil((issued - taken) / size) if size else 0
    note = None
    if stale:
        names = await db.execute(select(ItemPackaging.id, ItemPackaging.package_name).where(
            ItemPackaging.id.in_({b.item_packaging_id for b in stale})))
        old = ", ".join(sorted({n for _, n in names.all() if n})) or "the old container"
        note = (f"This item is now issued in a different container than {old}. "
                "Save the issue and its codes are re-made in the new container.")
    return {
        "codes": [b.hu_code for b in boxes],
        "codes_needed": need,
        "container_note": note,
        "boxes": [{"code": b.hu_code, "pack_name": b.pack_name,
                   "take": float(t), "holds": float(held(b)) if b.status in LIVE else float(t),
                   "size": float(_d(b.pack_size)), "part": t < _d(b.pack_size)}
                  for b, t in zip(boxes, takes)],
    }


async def check_line(db: AsyncSession, issue, line) -> str | None:
    """Why this line cannot be submitted or posted on its boxes, or None."""
    view = await line_view(db, issue, line)
    if view is None:
        return None
    if view["container_note"]:
        return (f"line {line.line_no} ({line.item_code}): the item's issue container "
                "changed after its boxes were held — save the issue to re-make its codes")
    boxes = await line_boxes(db, issue.id, line.id)
    if not boxes:
        batch = line.batch_id if line.batch_id and line.batch_id != m.NO_BATCH else None
        bin_ = line.bin_id if line.bin_id and line.bin_id != m.NO_BIN else None
        if await boxes_at(db, item_id=line.item_id, warehouse_id=issue.warehouse_id,
                          batch_id=batch, bin_id=bin_):
            return (f"line {line.line_no} ({line.item_code}) holds no boxes yet — "
                    "save the issue so its box codes are assigned")
        return None
    taken = sum(((_d(b.held_qty) if b.held_qty is not None else held(b)) for b in boxes), ZERO)
    if taken < _d(line.issued_qty):
        return (f"line {line.line_no} ({line.item_code}) needs "
                f"{packing.fmt(_d(line.issued_qty))} but its boxes hold "
                f"{packing.fmt(taken)} at this batch and location")
    return None


async def has_boxes(db: AsyncSession, issue_id: int, line_id: int) -> bool:
    return bool(await db.scalar(select(func.count()).select_from(m.HandlingUnit).where(
        m.HandlingUnit.held_by.in_((hold_marker(issue_id, line_id),
                                    issued_marker(issue_id, line_id))))))


async def settle_on_post(db: AsyncSession, issue, user) -> None:
    """The boxes leave (decisions of 2026-10-26).

    A WHOLE box leaves under its own code: consumed, with everything inside it, and
    every pack around it holds that much less. PART of a box leaves as a NEW part box
    with a new code — queued for a label, stuck on at the desk — and the box on the
    shelf keeps its code, holding less. The unit rows that left move into the part box,
    so the history reads true either way.
    """
    now, who = utcnow(), getattr(user, "full_name", None)
    reason = f"Issued on {issue.issue_no}"
    for line in issue.items:
        marker = hold_marker(issue.id, line.id)
        boxes = (await db.execute(select(m.HandlingUnit).where(
            m.HandlingUnit.held_by == marker).order_by(m.HandlingUnit.id)
            .with_for_update())).scalars().all()
        if not boxes:
            continue
        problem = await check_line(db, issue, line)
        if problem:
            raise ValidationError(f"This issue cannot be posted — {problem}.")
        item = await db.get(Item, line.item_id)
        warehouse = await db.get(Warehouse, issue.warehouse_id)
        children = await _children(db, boxes)
        for box in boxes:
            have = held(box)
            take = _d(box.held_qty) if box.held_qty is not None else have
            parent = box.parent_id
            if take >= have:
                wh_packing._consume(box, children, reason, who, now)
                box.held_by, box.held_qty = issued_marker(issue.id, line.id), None
                await wh_packing._shrink_ancestors(db, parent, have, reason=reason,
                                                   who=who, now=now)
                continue
            ladder = await packs.ladder(db, box.item_id, box.pack_hierarchy_id)
            key = {"item_id": box.item_id, "warehouse_id": box.warehouse_id,
                   "bin_id": box.bin_id, "batch_id": box.batch_id,
                   "project_id": box.project_id}
            part = wh_packing._new_pack(key=key, ladder=ladder, level=box.level,
                                        atom=False, source=("ISSUE", issue.id, issue.issue_no),
                                        lot_no=box.lot_no, user=user, content=take)
            db.add(part)
            await db.flush()
            await wh_packing._name_packs(db, [part], item, warehouse, True)
            await queue_labels(db, [part], item=item, reason=BoxLabelReason.PART_BOX,
                               source_no=issue.issue_no)
            wh_packing._close(part, HUS.CONSUMED.value, reason, who, now)
            part.held_by = issued_marker(issue.id, line.id)
            ids = _tree_ids(box, children)
            await db.execute(update(m.SerialNumber).where(
                m.SerialNumber.handling_unit_id.in_(ids),
                m.SerialNumber.remarks == marker).values(handling_unit_id=part.id)
                .execution_options(synchronize_session="fetch"))
            if children.get(box.id):
                wh_packing._take_inside(box, take, children, reason, who, now)
            else:
                wh_packing._set_held(box, have - take)
            box.held_by, box.held_qty = None, None
            await wh_packing._shrink_ancestors(db, parent, take, reason=reason,
                                               who=who, now=now)
    await db.flush()


# --------------------------------------------------------------------------- #
#  Screens: the box picker and the label queue
# --------------------------------------------------------------------------- #

async def box_sources(db: AsyncSession, *, warehouse_id: int, item_id: int,
                      batch_id: int | None = None, bin_id: int | None = None,
                      issue_id: int | None = None, with_units: bool = False) -> list[dict]:
    """Every box of an item a line could name here, fullest first — and who holds it.

    2026-10-27: every Issue level (a box AND the strips inside it, when both are Issue
    containers), each with the pack it sits in — the carton the picker groups it under —
    and, with `with_units`, the serials / IMEIs / codes inside it in order, so a serial
    or IMEI line picks its unique numbers off the boxes it chose."""
    boxes = await boxes_at(db, item_id=item_id, warehouse_id=warehouse_id,
                           batch_id=batch_id or None, bin_id=bin_id or None,
                           all_levels=True)
    parents = {hu.id: hu for hu in (await db.execute(select(m.HandlingUnit).where(
        m.HandlingUnit.id.in_({b.parent_id for b in boxes if b.parent_id} or {0}))))
        .scalars().all()}
    units: dict[int, list[str]] = {}
    if with_units and boxes:
        tree = await _children(db, boxes)
        owner: dict[int, int] = {}
        for box in boxes:
            for n in _tree_ids(box, tree):
                owner.setdefault(n, box.id)
        for hu_id, code in (await db.execute(select(
                m.SerialNumber.handling_unit_id,
                func.coalesce(m.SerialNumber.imei, m.SerialNumber.serial_number,
                              m.SerialNumber.asset_code, m.SerialNumber.consumable_code))
                .where(m.SerialNumber.handling_unit_id.in_(list(owner) or [0]),
                       m.SerialNumber.warehouse_id == warehouse_id,
                       m.SerialNumber.status == SerialStatus.AVAILABLE.value,
                       m.SerialNumber.is_active.is_(True))
                .order_by(m.SerialNumber.id))).all():
            units.setdefault(owner[hu_id], []).append(code)
    batches = dict((await db.execute(select(m.Batch.id, m.Batch.batch_no).where(
        m.Batch.id.in_({b.batch_id for b in boxes} or {0})))).all())
    bins = dict((await db.execute(select(m.WarehouseLocation.id, m.WarehouseLocation.code)
                                  .where(m.WarehouseLocation.id.in_(
                                      {b.bin_id for b in boxes} or {0})))).all())
    holders: dict[str, str] = {}
    out = []
    for box in sorted(boxes, key=lambda b: (-held(b), b.id)):
        mine = bool(issue_id and box.held_by
                    and box.held_by.startswith(_issue_prefix(issue_id)))
        holder = None
        if box.held_by and not mine:
            holder = holders.get(box.held_by) or await holder_label(db, box.held_by)
            holders[box.held_by] = holder
        parent = parents.get(box.parent_id) if box.parent_id else None
        out.append({
            "id": box.id, "code": box.hu_code, "pack_name": box.pack_name,
            "holds": float(held(box)), "size": float(_d(box.pack_size)),
            "part": held(box) < _d(box.pack_size),
            "batch_no": batches.get(box.batch_id), "bin_code": bins.get(box.bin_id),
            "held_by_this_issue": mine, "held_by": holder,
            "level": box.level, "parent_id": box.parent_id or None,
            "parent_code": parent.hu_code if parent is not None else None,
            "parent_pack_name": parent.pack_name if parent is not None else None,
            "parent_holds": float(held(parent)) if parent is not None else None,
            "parent_size": float(_d(parent.pack_size)) if parent is not None else None,
            "units": units.get(box.id) if with_units else None,
        })
    return out


async def list_labels(db: AsyncSession, *, status: str | None, warehouse_id: int | None,
                      search: str | None, page: int, size: int) -> dict:
    stmt = select(m.BoxLabel)
    if status:
        stmt = stmt.where(m.BoxLabel.status == status)
    if warehouse_id:
        stmt = stmt.where(m.BoxLabel.warehouse_id == warehouse_id)
    if search:
        like = f"%{search.strip()}%"
        stmt = stmt.where(or_(m.BoxLabel.hu_code.like(like), m.BoxLabel.item_code.like(like),
                              m.BoxLabel.item_name.like(like), m.BoxLabel.source_no.like(like)))
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (await db.execute(stmt.order_by(m.BoxLabel.id.desc())
                             .offset((page - 1) * size).limit(size))).scalars().all()
    return {"items": await _label_rows(db, rows), "total": int(total or 0),
            "page": page, "size": size}


async def _label_rows(db: AsyncSession, rows) -> list[dict]:
    """Each label with what its sticker prints and where it sits in the tree
    (2026-10-27): the pack it is inside, how deep, the packs and units inside it, the
    lot's expiry and brand / variant / model, and the signed token its QR carries —
    so a phone that scans it opens live, read-only details. Ordered parent first,
    then its children, so a sheet prints a carton and then its boxes."""
    from app.modules.warehouse.service import public_label_token
    if not rows:
        return []
    hus = {hu.id: hu for hu in (await db.execute(select(m.HandlingUnit).where(
        m.HandlingUnit.id.in_({r.handling_unit_id for r in rows})))).scalars().all()}
    parents = {hu.id: hu for hu in (await db.execute(select(m.HandlingUnit).where(
        m.HandlingUnit.id.in_({hu.parent_id for hu in hus.values() if hu.parent_id} or {0}))))
        .scalars().all()}
    kids: dict[int, dict[str, int]] = {}
    for parent_id, name, n in (await db.execute(
            select(m.HandlingUnit.parent_id, m.HandlingUnit.pack_name, func.count())
            .where(m.HandlingUnit.parent_id.in_(list(hus) or [0]),
                   m.HandlingUnit.status.in_(LIVE))
            .group_by(m.HandlingUnit.parent_id, m.HandlingUnit.pack_name))).all():
        kids.setdefault(parent_id, {})[name or "pack"] = int(n)
    batches = {b.id: b for b in (await db.execute(select(m.Batch).where(
        m.Batch.id.in_({hu.batch_id for hu in hus.values() if hu.batch_id} or {0}))))
        .scalars().all()}
    combos: dict[tuple, dict] = {}
    out = []
    for r in rows:
        hu = hus.get(r.handling_unit_id)
        row = {c.name: getattr(r, c.name) for c in m.BoxLabel.__table__.columns}
        depth, node = 0, hu
        while node is not None and node.parent_id and depth < 8:
            depth += 1
            node = parents.get(node.parent_id) if depth == 1 else await db.get(
                m.HandlingUnit, node.parent_id)
        root = node.id if node is not None else r.handling_unit_id
        parent = parents.get(hu.parent_id) if hu is not None and hu.parent_id else None
        inside = kids.get(r.handling_unit_id, {})
        batch = batches.get(hu.batch_id) if hu is not None else None
        key = ((hu.item_id, hu.warehouse_id, hu.bin_id, hu.batch_id)
               if hu is not None else None)
        if key is not None and key not in combos:
            combos[key] = await _combination_at(db, {
                "item_id": key[0], "warehouse_id": key[1], "bin_id": key[2],
                "batch_id": key[3]})
        combo = combos.get(key, {}) if key is not None else {}
        row.update({
            "parent_code": parent.hu_code if parent is not None else None,
            "depth": depth, "root_id": root,
            "level": hu.level if hu is not None else None,
            "packs_inside": ", ".join(f"{n} {_plural(k, n)}" for k, n in inside.items()) or None,
            "expiry_date": batch.expiry_date if batch is not None else None,
            "brand_name": combo.get("brand_name"), "variant_name": combo.get("variant_name"),
            "model_name": combo.get("model_name"),
            "qr_token": public_label_token("h", r.handling_unit_id),
        })
        out.append(row)
    order = {row["root_id"]: i for i, row in enumerate(out)}
    out.sort(key=lambda row: (order[row["root_id"]], row["depth"], row["id"]))
    return out


async def mark_printed(db: AsyncSession, ids: list[int], user) -> dict:
    result = await db.execute(update(m.BoxLabel).where(
        m.BoxLabel.id.in_(ids or [0]), m.BoxLabel.status == BoxLabelStatus.QUEUED.value)
        .values(status=BoxLabelStatus.PRINTED.value, printed_at=utcnow(),
                printed_by_name=getattr(user, "full_name", None)))
    await db.commit()
    return {"printed": int(result.rowcount or 0)}


async def expand_box_codes(db: AsyncSession, codes: list[str], *, item_id: int) -> list[str]:
    """Accepted codes as the steps after outward QC read them (2026-10-26): a BOX code
    stands for the units inside it — the packer and the receiving point still work unit
    by unit where units are recorded — and any other code stands for itself. A box with
    no unit rows (stock boxed at putaway) expands to nothing: it travels by quantity."""
    if not codes:
        return []
    boxes = (await db.execute(select(m.HandlingUnit).where(
        m.HandlingUnit.item_id == item_id, m.HandlingUnit.hu_code.in_(codes)))).scalars().all()
    if not boxes:
        return list(codes)
    tree: dict[str, list[int]] = {box.hu_code: [box.id] for box in boxes}
    for code, ids in tree.items():
        frontier = list(ids)
        while frontier:
            frontier = list((await db.execute(select(m.HandlingUnit.id).where(
                m.HandlingUnit.parent_id.in_(frontier)))).scalars().all())
            ids.extend(frontier)
    out: list[str] = []
    for code in codes:
        if code not in tree:
            out.append(code)
            continue
        for row in (await db.execute(select(
                m.SerialNumber.consumable_code, m.SerialNumber.asset_code,
                m.SerialNumber.serial_number).where(
                m.SerialNumber.handling_unit_id.in_(tree[code]),
                m.SerialNumber.is_active.is_(True))
                .order_by(m.SerialNumber.id))).all():
            value = row[0] or row[1] or row[2]
            if value:
                out.append(value)
    return out


async def packages_after_qc(db: AsyncSession, issue, line) -> dict[str, Decimal]:
    """The packages an issue line sends on, and what each carries, AFTER outward QC
    (2026-10-26): a package rejected whole is gone, a package with units rejected out
    of it carries that much less. No completed QC: every package, as issued. In issue
    order. Empty for a line not issued in packages."""
    from app.modules.warehouse.enums import InspectionStatus
    boxes = await line_boxes(db, issue.id, line.id)
    if not boxes:
        return {}
    carries = {box.hu_code: held(box) for box in boxes}
    verdict = (await db.execute(
        select(m.OutboundInspectionItem)
        .join(m.OutboundInspection,
              m.OutboundInspection.id == m.OutboundInspectionItem.inspection_id)
        .where(m.OutboundInspection.issue_id == issue.id,
               m.OutboundInspection.status == InspectionStatus.COMPLETED.value,
               m.OutboundInspectionItem.issue_item_id == line.id)
        .order_by(m.OutboundInspectionItem.id.desc()).limit(1))).scalars().first()
    if verdict is None:
        return carries
    data = verdict.serial_numbers
    kept = (data.get("accepted", []) if isinstance(data, dict)
            else data if isinstance(data, list) else [])
    if not kept and _d(verdict.accepted_qty) >= sum(carries.values(), ZERO):
        kept = list(carries)
    partial = {k: _d(v) for k, v in (verdict.pack_rejections or {}).items()}
    return {code: carries[code] - partial.get(code, ZERO)
            for code in carries if code in kept and carries[code] - partial.get(code, ZERO) > ZERO}


async def carton_packs(db: AsyncSession, codes: list[str], carries: dict[str, Decimal],
                       uom: str | None) -> dict | None:
    """How a carton holds a line issued in packages (2026-10-26): exactly the packages
    picked into it — "4 STRIP + 1 STRIP (5 of 10)" — never a re-cut of its quantity."""
    rows = (await db.execute(select(m.HandlingUnit).where(
        m.HandlingUnit.hu_code.in_(codes or [""])))).scalars().all()
    if not rows:
        return None
    by: dict[tuple, dict] = {}
    for hu in rows:
        qty = carries.get(hu.hu_code, ZERO)
        size = _d(hu.pack_size)
        part = qty < size
        key = (hu.level, hu.item_packaging_id, str(qty) if part else "")
        entry = by.setdefault(key, {
            "item_packaging_id": hu.item_packaging_id, "level": hu.level,
            "name": hu.pack_name, "size": str(size), "qty": "0",
            **({"fill": str(qty)} if part else {})})
        entry["qty"] = str(_d(entry["qty"]) + 1)
    entries = sorted(by.values(), key=lambda e: ("fill" in e, -int(e["level"])))
    return {"pack_hierarchy_id": rows[0].pack_hierarchy_id, "pack_breakdown": entries,
            "pack_text": packing.describe(entries, uom)}


def apply_package_receipts(rows, received: dict | None) -> None:
    """What arrived in each PACKAGE row of a consignment (2026-10-26): the package's
    own quantity, unless the receipt said it came short or missing."""
    if received is None:
        return
    for row in rows:
        if row.box_code:
            got = _d(received.get(row.box_code, row.quantity))
            row.delivered_qty = max(ZERO, min(_d(row.quantity), got))


async def land_packages(db: AsyncSession, dispatch, rows, *, batch_id, user=None) -> int:
    """The packages a consignment carried, shelved at the point that received them
    under the SAME codes (2026-10-26) — each holding what arrived in it. A package
    that never arrived stays where it was, consumed. Idempotent: a package already
    standing at the destination is left alone. Returns how many were landed."""
    landed = 0
    for row in rows:
        got = _d(row.delivered_qty)
        if got <= ZERO:
            continue
        hu = (await db.execute(select(m.HandlingUnit).where(
            m.HandlingUnit.hu_code == row.box_code,
            m.HandlingUnit.item_id == row.item_id).with_for_update())).scalars().first()
        if hu is None or (hu.warehouse_id == dispatch.to_warehouse_id and hu.status in LIVE):
            continue
        hu.warehouse_id = dispatch.to_warehouse_id
        hu.bin_id = m.NO_BIN
        hu.batch_id = batch_id or m.NO_BATCH
        hu.project_id = dispatch.project_id or 0
        hu.parent_id = None
        hu.status = HUS.SEALED.value
        hu.content_qty = None if got >= _d(hu.pack_size) else got
        hu.held_by, hu.held_qty = None, None
        hu.closed_reason = hu.closed_by_name = hu.closed_at = None
        hu.source_type, hu.source_id, hu.source_no = "DISPATCH", dispatch.id, dispatch.dispatch_no
        landed += 1
    await db.flush()
    # Each package lists exactly as many unit codes as it holds: the units these
    # packages carried, standing here now, re-seated in order; any beyond what the
    # packages hold stay as loose units (old per-unit history is rarely exact).
    standing = (await db.execute(select(m.HandlingUnit).where(
        m.HandlingUnit.hu_code.in_([row.box_code for row in rows] or [""]),
        m.HandlingUnit.warehouse_id == dispatch.to_warehouse_id,
        m.HandlingUnit.status.in_(LIVE)).order_by(m.HandlingUnit.id))).scalars().all()
    if standing:
        units = list((await db.execute(select(m.SerialNumber.id).where(
            m.SerialNumber.handling_unit_id.in_([hu.id for hu in standing]),
            m.SerialNumber.warehouse_id == dispatch.to_warehouse_id,
            m.SerialNumber.status == SerialStatus.AVAILABLE.value,
            m.SerialNumber.is_active.is_(True)).order_by(m.SerialNumber.id))).scalars().all())
        cursor = 0
        for hu in standing:
            take = units[cursor:cursor + int(held(hu))]
            cursor += len(take)
            if take:
                await wh_packing._link_units(db, take, hu.id)
        if units[cursor:]:
            await wh_packing._link_units(db, units[cursor:], None)
    return landed


# --------------------------------------------------------------------------- #
#  Scanning a pack or a unit label (2026-10-27)
# --------------------------------------------------------------------------- #

async def _combination_at(db: AsyncSession, key: dict) -> dict:
    """The brand / variant / model standing at one stock key, named — when exactly one
    combination stands there. A pack carries no combination of its own; the lot it
    sits in does."""
    from app.shared.masters import combinations
    rows = (await db.execute(select(Stock.brand_id, Stock.variant_id, Stock.model_id).where(
        Stock.item_id == key["item_id"], Stock.warehouse_id == key["warehouse_id"],
        Stock.bin_id == (key["bin_id"] or 0), Stock.batch_id == (key["batch_id"] or 0),
        Stock.total_qty > 0).distinct())).all()
    if len(rows) != 1:
        return {}
    out = {"brand_id": rows[0][0], "variant_id": rows[0][1], "model_id": rows[0][2]}
    await combinations.fill_names(db, [out])
    return out


async def _where(db: AsyncSession, warehouse_id, bin_id) -> str | None:
    """"Central Warehouse-1 › WAREHOUSE-01" — where a pack or a unit stands now."""
    wh = await db.get(Warehouse, warehouse_id) if warehouse_id else None
    loc = (await db.get(m.WarehouseLocation, bin_id)
           if bin_id and bin_id != m.NO_BIN else None)
    parts = [getattr(wh, "name", None), getattr(loc, "code", None)]
    return " › ".join(p for p in parts if p) or None


def _plural(name: str, n: int) -> str:
    name = name or "pack"
    if n == 1:
        return name
    return f"{name}es" if name.endswith(("x", "s", "ch", "sh")) else f"{name}s"


def _expiry(batch) -> str | None:
    return batch.expiry_date.isoformat() if batch is not None and batch.expiry_date else None


async def scan_pack(db: AsyncSession, hu, *, public: bool = False) -> dict:
    """What a pack label answers when it is scanned — the item, where the pack is NOW,
    what is inside it (packs by kind, and units), its batch, expiry and brand /
    variant / model, and who holds it. The `ScanResult` fields, as a dict.

    Read live off the pack row, so a carton opened yesterday reads what is left in it
    today. `public` drops what only an employee should see: who holds it and the unit
    codes themselves."""
    item = await db.get(Item, hu.item_id)
    batch = (await db.get(m.Batch, hu.batch_id)
             if hu.batch_id and hu.batch_id != m.NO_BATCH else None)
    combo = await _combination_at(db, {"item_id": hu.item_id, "warehouse_id": hu.warehouse_id,
                                       "bin_id": hu.bin_id, "batch_id": hu.batch_id})
    children = await _children(db, [hu])
    kids = children.get(hu.id, [])
    tree = _tree_ids(hu, children)
    unit_scope = (m.SerialNumber.handling_unit_id.in_(tree),
                  m.SerialNumber.is_active.is_(True),
                  m.SerialNumber.status == SerialStatus.AVAILABLE.value)
    units = int(await db.scalar(select(func.count()).select_from(m.SerialNumber)
                                .where(*unit_scope)) or 0)
    by_kind: dict[str, int] = {}
    for kid in kids:
        by_kind[kid.pack_name or "pack"] = by_kind.get(kid.pack_name or "pack", 0) + 1
    inside = ", ".join(f"{n} {_plural(name, n)}" for name, n in by_kind.items())
    parent = await db.get(m.HandlingUnit, hu.parent_id) if hu.parent_id else None
    holds = held(hu)
    uom = getattr(item, "uom_code", None) or "units"
    of = f" of {packing.fmt(hu.pack_size)}" if holds < _d(hu.pack_size) else ""
    meta = [
        {"label": "Item code", "value": getattr(item, "code", None)},
        {"label": "Location", "value": await _where(db, hu.warehouse_id, hu.bin_id)},
        {"label": "Holds", "value": f"{packing.fmt(holds)}{of} {uom}"},
        {"label": "Packages inside", "value": inside or None},
        {"label": "Units inside", "value": f"{units:,}" if units else None},
        {"label": "Batch", "value": getattr(batch, "batch_no", None)},
        {"label": "Expiry", "value": _expiry(batch)},
        {"label": "Brand", "value": combo.get("brand_name")},
        {"label": "Variant", "value": combo.get("variant_name")},
        {"label": "Model", "value": combo.get("model_name")},
        {"label": "Inside of", "value": parent.hu_code if parent is not None else None},
    ]
    if not public and hu.held_by:
        meta.append({"label": "Held by", "value": await holder_label(db, hu.held_by)})
    items = []
    if not public and units:
        for code, serial, imei in (await db.execute(select(
                func.coalesce(m.SerialNumber.asset_code, m.SerialNumber.consumable_code,
                              m.SerialNumber.serial_number),
                m.SerialNumber.serial_number, m.SerialNumber.imei)
                .where(*unit_scope).order_by(m.SerialNumber.id).limit(200))).all():
            items.append({"item_code": getattr(item, "code", None),
                          "item_name": getattr(item, "name", None), "uom_code": uom,
                          "quantity": Decimal(1), "batch_no": getattr(batch, "batch_no", None),
                          "serial_no": serial if serial != code else None,
                          "imei_no": imei, "unit_code": code, "package_no": hu.hu_code,
                          "expiry_date": batch.expiry_date if batch is not None else None})
    return {
        "kind": "PACK", "id": hu.id, "doc_no": hu.hu_code,
        "title": getattr(item, "name", None) or hu.hu_code,
        "subtitle": f"{(hu.pack_name or 'Pack').title()} · {hu.hu_code}",
        "status": hu.status, "meta": meta,
        "packages": [{"id": kid.id, "package_no": kid.hu_code, "barcode": kid.hu_code,
                      "package_type": kid.pack_name, "status": kid.status,
                      "item_count": len(children.get(kid.id, [])), "quantity": held(kid)}
                     for kid in kids],
        "items": items, "package_count": len(kids), "item_count": units,
        "total_qty": holds,
        "deep_link": None if public else "/inventory/stock-balance",
    }


async def scan_unit(db: AsyncSession, unit, *, public: bool = False) -> dict:
    """What a unit label answers: the item, where the unit is now, the packs it sits
    in (innermost first), batch, expiry and brand / variant / model."""
    item = await db.get(Item, unit.item_id)
    batch = await db.get(m.Batch, unit.batch_id) if unit.batch_id else None
    combo = await _combination_at(db, {"item_id": unit.item_id,
                                       "warehouse_id": unit.warehouse_id,
                                       "bin_id": unit.bin_id or 0,
                                       "batch_id": unit.batch_id or 0})
    chain: list[str] = []
    hu_id = unit.handling_unit_id
    for _ in range(8):
        if not hu_id:
            break
        hu = await db.get(m.HandlingUnit, hu_id)
        if hu is None:
            break
        chain.append(f"{hu.hu_code} ({hu.pack_name or 'pack'})")
        hu_id = hu.parent_id
    code = unit.asset_code or unit.consumable_code or unit.serial_number
    meta = [
        {"label": "Item code", "value": getattr(item, "code", None)},
        {"label": "Location", "value": await _where(db, unit.warehouse_id, unit.bin_id)},
        {"label": "Inside", "value": " › ".join(chain) or "Loose"},
        {"label": "Serial", "value": unit.serial_number if unit.serial_number != code else None},
        {"label": "IMEI", "value": getattr(unit, "imei", None)},
        {"label": "Batch", "value": getattr(batch, "batch_no", None)},
        {"label": "Expiry", "value": _expiry(batch)},
        {"label": "Brand", "value": combo.get("brand_name")},
        {"label": "Variant", "value": combo.get("variant_name")},
        {"label": "Model", "value": combo.get("model_name")},
    ]
    return {
        "kind": "UNIT", "id": unit.id, "doc_no": code,
        "title": getattr(item, "name", None) or code,
        "subtitle": f"Unit · {code}", "status": unit.status, "meta": meta,
        "item_count": 1, "total_qty": Decimal(1),
        "deep_link": None if public else "/inventory/stock-balance",
    }
