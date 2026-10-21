"""Pack hierarchies — the arithmetic every module shares (2026-10-08).

An item is COUNTED in one base unit (the tablet) and that never changes: stock,
ledger, reservations, indents and every quantity column in the system stay in it.
What this module adds is the layer on top that says HOW those units are bagged:

    Pack hierarchy  "Strip of 10"          (mst_pack_hierarchies — one per family)
      level 1       Strip  = 10 TAB        (mst_item_packaging rungs, ratio to the
      level 2       Box    = 10 Strip         level below; the size in base units is
      level 3       Carton = 12 Box           multiplied up here, never stored)

One item may carry several hierarchies at once (strips of 10 AND strips of 15). A
pack never changes hierarchy — a tablet cannot move from a 10-strip into a 15-strip
without going back to the factory — so every document line names ONE hierarchy and
a BREAKDOWN inside it: "1 Carton + 10 Box + 20 Strip". Level 0 is loose base units.

A breakdown is stored as snapshotted JSON entries::

    {"item_packaging_id": 12, "level": 2, "name": "Box", "size": "100", "qty": "10"}

`size` is frozen at the moment the document was written, so a document keeps saying
what it said even if somebody later edits the master. The base quantity of a line is
ALWAYS `sum(qty x held)` — computed by the server, never trusted from a client.

PART PACKS (2026-10-11). The size of a level is the STANDARD — the most one pack
holds — not a rule every pack obeys. A carton of 600 may really hold 500, and an
entry says so with `fill`::

    {"level": 2, "name": "Carton", "size": "600", "qty": "1", "fill": "500"}

"1 Carton (500 of 600)". `fill` is per pack, so `qty: 2, fill: 500` is two cartons
of 500 each; an entry without `fill` is full. A line stays ONE line however many part
packs it holds — every per-line rule (what a PO line has received, the issue splits,
the double-issue guards) keeps counting what it always counted.

A level may carry a MINIMUM fill (`mst_item_packaging.min_fill_qty`). Making a pack
below it is refused where we make it (a PO, a putaway, a repack); a pack that
FALLS below it — stock issued out of it, a short carton at the gate — is allowed and
flagged until somebody repacks it (`warnings`).

Pure: no database, no ORM. The DB-backed half lives in `shared/masters/defs.py`
(the master) and `modules/warehouse/packing.py` (packs on the shelf).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation

ZERO = Decimal("0")
ONE = Decimal("1")

#: The wording for level 0 — loose base units, no pack around them.
LOOSE = "Loose"


class PackError(ValueError):
    """A breakdown or a repack that cannot be true. The message is shown as-is."""


def dec(value) -> Decimal:
    if value is None or value == "":
        return ZERO
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:  # pragma: no cover - defensive
        raise PackError(f"{value!r} is not a number") from exc


def plain(value) -> str:
    """A Decimal as JSON-safe text with no exponent: 10, not 1E+1."""
    text = format(dec(value).normalize(), "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def fmt(value) -> str:
    """12 not 12.000, 2.5 not 2.500 — and thousands grouped for the big numbers."""
    number = dec(value).normalize()
    if number == number.to_integral_value():
        return f"{int(number):,}"
    return f"{number:,f}".rstrip("0").rstrip(".")


# --------------------------------------------------------------------------- #
#  The ladder
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class Level:
    """One rung, multiplied up. Level 0 is the loose base unit and has no row."""
    level: int
    name: str
    size: Decimal                 # base units in ONE of these
    ratio: Decimal                # how many of the level below fit in one
    item_packaging_id: int | None = None
    package_id: int | None = None
    #: The least one pack of this level may be MADE with, in base units. None: any.
    min_fill: Decimal | None = None

    @property
    def is_loose(self) -> bool:
        return self.level == 0


@dataclass(frozen=True)
class Ladder:
    hierarchy_id: int | None
    hierarchy_name: str
    base_uom: str | None
    levels: tuple[Level, ...]     # index == level; levels[0] is LOOSE

    @property
    def top(self) -> int:
        return len(self.levels) - 1

    def at(self, level: int) -> Level:
        if level < 0 or level > self.top:
            raise PackError(
                f"{self.hierarchy_name} has no level {level} — it goes up to "
                f"{self.levels[self.top].name} (level {self.top}).")
        return self.levels[level]

    def by_rung(self, item_packaging_id: int | None) -> Level:
        if not item_packaging_id:
            return self.levels[0]
        for row in self.levels:
            if row.item_packaging_id == item_packaging_id:
                return row
        raise PackError(
            f"That pack level is not part of the {self.hierarchy_name} hierarchy. "
            "Pick a level from this hierarchy's own list.")

    def label(self, level: int) -> str:
        """"Box · 10 Strip (100 TAB)" — what one of this level is, in one line."""
        row = self.at(level)
        unit = self.base_uom or "units"
        if row.is_loose:
            return f"{LOOSE} {unit}"
        if row.level == 1:
            return f"{row.name} ({fmt(row.size)} {unit})"
        below = self.levels[row.level - 1]
        return f"{row.name} · {fmt(row.ratio)} {below.name} ({fmt(row.size)} {unit})"


def build_ladder(*, hierarchy_id: int | None, hierarchy_name: str,
                 base_uom: str | None, rungs) -> Ladder:
    """`rungs` are objects (or dicts) with level, quantity, package_name, id,
    package_id — active ones only, any order. A gap in the sequence drops everything
    above it: a missing rung multiplies the wrong rungs together, which would
    UNDERSTATE every pack above it rather than fail."""
    def get(row, key):
        return row.get(key) if isinstance(row, dict) else getattr(row, key, None)

    ordered = sorted(rungs, key=lambda r: int(get(r, "level") or 0))
    levels = [Level(level=0, name=LOOSE, size=ONE, ratio=ONE)]
    running = ONE
    for rung in ordered:
        number = int(get(rung, "level") or 0)
        if number != len(levels):
            break
        ratio = dec(get(rung, "quantity"))
        if ratio <= ZERO:
            break
        running = running * ratio
        floor = get(rung, "min_fill_qty")
        levels.append(Level(
            level=number,
            name=(get(rung, "package_name") or f"Level {number}"),
            size=running, ratio=ratio,
            item_packaging_id=get(rung, "id"),
            package_id=get(rung, "package_id"),
            min_fill=dec(floor) if floor not in (None, "") and dec(floor) > ZERO else None,
        ))
    return Ladder(hierarchy_id=hierarchy_id, hierarchy_name=hierarchy_name,
                  base_uom=base_uom, levels=tuple(levels))


# --------------------------------------------------------------------------- #
#  A breakdown — "1 Carton + 10 Box + 20 Strip"
# --------------------------------------------------------------------------- #

def entry(row: Level, qty, fill=None) -> dict:
    """One snapshotted breakdown entry. Strings for the decimals: JSON has no
    Decimal, and a float turns 0.1 into 0.1000000000000000055. `fill` only when the
    pack holds less than its size — a full pack never carries one."""
    out = {"item_packaging_id": row.item_packaging_id, "level": row.level,
           "name": row.name, "size": plain(row.size), "qty": plain(qty)}
    if fill is not None and not row.is_loose and dec(fill) < row.size:
        out["fill"] = plain(fill)
    return out


def _getter(raw):
    return raw.get if isinstance(raw, dict) else (lambda k, r=raw: getattr(r, k, None))


def held(e) -> Decimal:
    """Base units in ONE pack of this entry: its `fill`, else its full size."""
    get = _getter(e)
    fill = get("fill")
    return dec(fill) if fill not in (None, "") else dec(get("size") or 1)


def is_partial(e) -> bool:
    """A pack entry holding less than its level's size."""
    get = _getter(e)
    fill = get("fill")
    return (int(get("level") or 0) > 0 and fill not in (None, "")
            and dec(fill) < dec(get("size") or 0))


def _fill_of(row: Level, raw_fill, *, enforce_min: bool, uom: str | None):
    """A client's `fill` for one pack of `row`, checked: never more than the pack
    holds, never nothing, and — where a pack is being MADE — never under the floor."""
    if raw_fill in (None, "") or row.is_loose:
        return None
    fill = dec(raw_fill)
    unit = uom or "units"
    if fill <= ZERO:
        raise PackError(f"{row.name}: a part pack has to hold something.")
    if fill > row.size:
        raise PackError(
            f"{fmt(fill)} {unit} cannot go in one {row.name} — it holds at most "
            f"{fmt(row.size)}. Use more packs, or a bigger level.")
    if fill == row.size:
        return None
    if enforce_min and row.min_fill is not None and fill < row.min_fill:
        raise PackError(
            f"A {row.name} must hold at least {fmt(row.min_fill)} {unit}; "
            f"{fmt(fill)} is below that. Pack it in a smaller level, or leave it loose.")
    return fill


def normalize(ladder: Ladder, entries, *, allow_fraction_loose: bool = True,
              min_level: int = 0, enforce_min: bool = False) -> list[dict]:
    """Validate a client's breakdown against the hierarchy and snapshot it.

    Each entry names a rung by `item_packaging_id` (None / 0 = loose) or by `level`.
    Packs are counted whole; a pack holding less than its size says so with `fill`
    ("1 Carton (500 of 600)"), never with a fraction of a carton. Entries of the same
    level AND fill are added together. Zero entries are dropped. Ordered biggest pack
    first, full before part, which is how a person reads a delivery.

    `enforce_min` is for where a pack is being MADE (a PO, a putaway, a repack): a
    part pack under its level's minimum is refused there. Elsewhere it is a warning.
    """
    totals: dict[tuple, Decimal] = {}
    for raw in entries or []:
        get = raw.get if isinstance(raw, dict) else (lambda k, r=raw: getattr(r, k, None))
        rung_id = get("item_packaging_id")
        if rung_id:
            row = ladder.by_rung(int(rung_id))
        else:
            row = ladder.at(int(get("level") or 0))
        qty = dec(get("qty"))
        if qty < ZERO:
            raise PackError(f"{row.name}: a pack count cannot be negative.")
        if qty == ZERO:
            continue
        if not row.is_loose and qty != qty.to_integral_value():
            raise PackError(
                f"{row.name}: packs come whole — {fmt(qty)} {row.name} is not a "
                f"number of {row.name}. Put the part pack in a smaller level.")
        if row.is_loose and not allow_fraction_loose and qty != qty.to_integral_value():
            raise PackError(
                f"Loose {ladder.base_uom or 'units'} must be a whole number here.")
        if row.level < min_level:
            low = ladder.at(min_level)
            raise PackError(
                f"This stock is coded as {low.name}, and a code cannot be split — "
                f"it can be packed into {low.name} or anything bigger, never into "
                f"{row.name if not row.is_loose else 'loose ' + (ladder.base_uom or 'units')}.")
        fill = _fill_of(row, get("fill"), enforce_min=enforce_min, uom=ladder.base_uom)
        totals[(row.level, fill)] = totals.get((row.level, fill), ZERO) + qty
    order = sorted(totals, key=lambda k: (-k[0], k[1] is not None, -(k[1] or ZERO)))
    return [entry(ladder.at(level), totals[(level, fill)], fill) for level, fill in order]


def base_of(entries) -> Decimal:
    """How many base units a breakdown holds. Reads the SNAPSHOT size (or the part
    pack's own fill), so a stored document answers what it said when it was written."""
    return sum((dec(e.get("qty")) * held(e) for e in entries or []), ZERO)


def warnings(entries, ladder: Ladder | None = None, uom: str | None = None) -> list[str]:
    """What is allowed but worth saying about a breakdown. Never refuses anything.

    * more than one part pack of a level on one line — usually only the last pack of
      a delivery is short, so two is worth a second look;
    * a part pack under its level's minimum (needs the ladder for the floor).
    """
    unit = uom or (ladder.base_uom if ladder else None) or "units"
    out: list[str] = []
    part: dict[int, Decimal] = {}
    names: dict[int, str] = {}
    for e in entries or []:
        if not is_partial(e):
            continue
        level = int(e.get("level") or 0)
        part[level] = part.get(level, ZERO) + dec(e.get("qty"))
        names[level] = e.get("name") or "pack"
        floor = ladder.at(level).min_fill if ladder is not None and level <= ladder.top \
            else None
        if floor is not None and held(e) < floor:
            out.append(f"{names[level]} ({fmt(held(e))} of {fmt(e.get('size'))}) is below "
                       f"the {fmt(floor)} {unit} minimum — repack it.")
    for level, qty in sorted(part.items(), reverse=True):
        if qty > ONE:
            out.append(f"{fmt(qty)} part-filled {names[level]} on one line — usually only "
                       "one pack is short. Check the count.")
    return out


def counts(entries) -> dict[int, Decimal]:
    """{level: qty}"""
    out: dict[int, Decimal] = {}
    for e in entries or []:
        level = int(e.get("level") or 0)
        out[level] = out.get(level, ZERO) + dec(e.get("qty"))
    return out


def greedy(ladder: Ladder, base_qty, *, max_level: int | None = None,
           min_level: int = 0) -> list[dict]:
    """Biggest packs first: 2,740 TAB -> 2 Carton + 2 Box + 14 Strip (+ 0 loose).

    `max_level` caps how big a pack may be (a delivery that came in boxes is not
    suddenly cartons); `min_level` is the smallest allowed — a remainder that does
    not fill one whole pack there is an error, because it would need splitting.
    """
    remaining = dec(base_qty)
    if remaining < ZERO:
        raise PackError("A quantity cannot be negative.")
    top = ladder.top if max_level is None else min(max_level, ladder.top)
    out: list[dict] = []
    for level in range(top, min_level - 1, -1):
        row = ladder.at(level)
        if level == 0:
            if remaining > ZERO:
                out.append(entry(row, remaining))
            remaining = ZERO
            break
        whole = (remaining / row.size).to_integral_value(rounding="ROUND_FLOOR")
        if whole > ZERO:
            out.append(entry(row, whole))
            remaining -= whole * row.size
    if remaining > ZERO:
        low = ladder.at(min_level)
        raise PackError(
            f"{fmt(remaining)} {ladder.base_uom or 'units'} do not make a whole "
            f"{low.name} ({fmt(low.size)} {ladder.base_uom or 'units'}), and it "
            "cannot be split smaller.")
    return out


def describe(entries, base_uom: str | None = None, *, with_total: bool = True) -> str:
    """"1 Carton + 10 Box + 20 Strip = 2,400 TAB" — the sentence every screen shows."""
    parts = []
    for e in sorted(entries or [], key=lambda x: -int(x.get("level") or 0)):
        qty = dec(e.get("qty"))
        if qty == ZERO:
            continue
        if int(e.get("level") or 0) == 0:
            parts.append(f"{fmt(qty)} {LOOSE.lower()} {base_uom or 'units'}")
        elif is_partial(e):
            parts.append(f"{fmt(qty)} {e.get('name') or 'pack'} "
                         f"({fmt(held(e))} of {fmt(e.get('size'))})")
        else:
            parts.append(f"{fmt(qty)} {e.get('name') or 'pack'}")
    if not parts:
        return f"0 {base_uom or 'units'}"
    text = " + ".join(parts)
    if with_total:
        only_loose = all(int(e.get("level") or 0) == 0 for e in entries)
        if not only_loose:
            text += f" = {fmt(base_of(entries))} {base_uom or 'units'}"
    return text


def rescale(ladder: Ladder, entries, base_qty) -> list[dict]:
    """Bring a breakdown to a new base total, keeping its shape where it can.

    Used when a quantity changes underneath a line that already says how it is
    packed (an approver trims a PO line). Shrinks from the smallest pack up, then
    falls back to a greedy split under the largest level the line already used.
    """
    target = dec(base_qty)
    current = base_of(entries)
    if target == current:
        return list(entries)
    top = max((int(e.get("level") or 0) for e in entries), default=ladder.top)
    return greedy(ladder, target, max_level=top)


def shrink_to(ladder: Ladder, declared, base_qty) -> list[dict]:
    """The packs of `declared` that make up `base_qty`, never more of a level than
    was declared: biggest first, the remainder loose.

    How a short delivery is read at the gate — the supplier said 1 Carton + 10 Box +
    20 Strip (2,400) and 2,300 arrived, so the count is 1 Carton + 10 Box + 10 Strip.
    """
    remaining = dec(base_qty)
    limit = counts(declared)
    if remaining > base_of(declared):
        raise PackError(
            f"{fmt(remaining)} {ladder.base_uom or 'units'} is more than the "
            f"{fmt(base_of(declared))} declared ({describe(declared, ladder.base_uom)}).")
    out: list[dict] = []
    for level in sorted(limit, reverse=True):
        row = ladder.at(level)
        if level == 0:
            continue
        whole = min(limit[level], (remaining / row.size).to_integral_value(
            rounding="ROUND_FLOOR"))
        if whole > ZERO:
            out.append(entry(row, whole))
            remaining -= whole * row.size
    if remaining > ZERO:
        out.append(entry(ladder.at(0), remaining))
    return out


def shrink_snapshot(declared, base_qty) -> list[dict]:
    """`shrink_to` off a frozen breakdown alone — no ladder needed, because each
    entry carries its own size. Used where a document is read back (a capped despatch
    prefill, the part of a receipt line a putaway takes)."""
    remaining = dec(base_qty)
    hierarchy = next((e.get("hierarchy") for e in declared or [] if e.get("hierarchy")),
                     None)
    out: list[dict] = []
    for e in sorted(declared or [], key=lambda x: -held(x)):
        if int(e.get("level") or 0) == 0:
            continue
        size = held(e)
        if size <= ZERO:
            continue
        whole = min(dec(e.get("qty")), (remaining / size).to_integral_value(
            rounding="ROUND_FLOOR"))
        if whole > ZERO:
            out.append({**e, "qty": plain(whole)})
            remaining -= whole * size
    if remaining > ZERO:
        loose = {"item_packaging_id": None, "level": 0, "name": LOOSE, "size": "1",
                 "qty": plain(remaining)}
        if hierarchy:
            loose["hierarchy"] = hierarchy
        out.append(loose)
    return out


def assert_within(ladder: Ladder, counted, declared) -> None:
    """A count may only come up SHORT of what was declared, level by level — it may
    not add a level the supplier never sent, nor more of one. The packing the gate
    receives is the supplier's; the gate's job is to say how much of it is there."""
    limit = counts(declared)
    for level, qty in counts(counted).items():
        if level == 0:
            continue
        if level not in limit:
            raise PackError(
                f"The supplier did not send any {ladder.at(level).name}. The packing "
                f"on the despatch note is fixed: {describe(declared, ladder.base_uom)}. "
                "Record what is missing, not a different packing.")
        if qty > limit[level]:
            raise PackError(
                f"{fmt(qty)} {ladder.at(level).name} counted, but the despatch note "
                f"says {fmt(limit[level])}. A receipt can be short of the despatch "
                "note, never over it.")
    if base_of(counted) > base_of(declared):
        raise PackError(
            f"{describe(counted, ladder.base_uom)} is more than the "
            f"{fmt(base_of(declared))} declared.")


# --------------------------------------------------------------------------- #
#  Repack — keep, open and form packs so the shelf matches a target
# --------------------------------------------------------------------------- #

@dataclass
class Node:
    """One physical pack on the shelf, as the planner sees it.

    `atom` is a pack whose CODE was minted at its own level — at putaway, or by a
    break bulk. It may be wrapped in bigger packs but never opened: the code names
    everything inside it, and a code cannot be split.
    """
    id: int | str
    level: int
    atom: bool = False
    children: list["Node"] = field(default_factory=list)
    #: Carved out of a parent that was put away whole: a box shelved as a box has no
    #: strip rows inside it until somebody opens it. Created only if it survives.
    implied: bool = False
    #: Base units really inside, when less than the level's size. None: full.
    content: Decimal | None = None


@dataclass
class Creation:
    ref: str                       # "new-3-1": a temporary id for the new pack
    level: int
    children: list                 # Node ids / refs one level down
    loose_units: Decimal = ZERO    # base units taken straight from loose
    fill: Decimal | None = None    # a PART pack: what it holds (None: full)


@dataclass
class RepackPlan:
    opened: list                   # ids of packs whose code retires
    created: list[Creation]
    top: list                      # ids/refs of the packs left standing on top
    loose: Decimal                 # loose base units afterwards
    #: Packs carved out of an opened parent that had no recorded children — the ten
    #: strips inside a box shelved as a box. (ref, level, parent id), parent first.
    carved: list = field(default_factory=list)


def plan_repack(ladder: Ladder, top_nodes: list[Node], loose, target: dict[int, Decimal],
                *, partial: list | None = None,
                allow_open_atoms: bool = False) -> RepackPlan:
    """Work out the fewest changes that turn the shelf into `target`.

    `top_nodes` are the packs not inside anything; `loose` the base units outside
    every pack; `target` the wanted count of FULL packs per level (0 = loose units);
    `partial` the wanted PART packs, one `(level, fill)` per pack (`split_target`).

    Top-down, each level keeps as many existing full packs as the target and the packs
    to be formed above it need, and keeps a part pack only where the target names one
    of that level holding exactly what it holds; everything else there opens (an atom
    refuses to). A pack opened with nothing recorded inside is carved into as many
    whole packs of the level below as it really holds, the rest loose. Bottom-up, the
    missing full packs are formed from what stands one level down, and new part packs
    straight from loose. Packs that can stay whole stay whole, so their codes survive.
    """
    loose = dec(loose)
    target = {int(k): dec(v) for k, v in (target or {}).items() if dec(v) != ZERO}
    for level, qty in target.items():
        row = ladder.at(level)
        if qty < ZERO:
            raise PackError(f"{row.name}: a count cannot be negative.")
        if level and qty != qty.to_integral_value():
            raise PackError(f"{row.name}: packs come whole.")
    wanted_part: dict[int, list[Decimal]] = {}
    for level, fill in partial or []:
        ladder.at(int(level))
        wanted_part.setdefault(int(level), []).append(dec(fill))

    def content(node) -> Decimal:
        return dec(node.content) if node.content is not None else ladder.at(node.level).size

    def full(node) -> bool:
        return content(node) >= ladder.at(node.level).size

    have = sum((content(n) for n in top_nodes), ZERO) + loose
    want = (sum((ladder.at(level).size * qty for level, qty in target.items()), ZERO)
            + sum((f for fills in wanted_part.values() for f in fills), ZERO))
    if have != want:
        raise PackError(
            f"The new packing holds {fmt(want)} {ladder.base_uom or 'units'} but the "
            f"shelf holds {fmt(have)}. Repacking never changes the quantity.")

    pool: dict[int, list] = {level: [] for level in range(ladder.top + 1)}
    for node in top_nodes:
        if node.level < 1 or node.level > ladder.top:
            raise PackError(f"A pack at level {node.level} is not on this hierarchy.")
        pool[node.level].append(node)

    opened: list = []
    implied: dict = {}
    stay: dict[int, list] = {level: [] for level in range(ladder.top + 1)}
    new_part: list[tuple[int, Decimal]] = []
    need_new = {level: 0 for level in range(ladder.top + 2)}

    def open_node(node, level):
        nonlocal loose
        if node.atom and not allow_open_atoms:
            row = ladder.at(level)
            raise PackError(
                f"{row.name} packs here carry their own codes (coded at putaway), "
                f"and a code cannot be split. Keep them as {row.name} or pack "
                f"them into something bigger — or use break bulk at the issue "
                f"desk, which needs its own permission.")
        opened.append(node.id)
        inside = content(node)
        if level == 1:
            loose += inside
        elif node.children:
            pool[level - 1].extend(node.children)
            loose += inside - sum((content(c) for c in node.children), ZERO)
        else:
            child_size = ladder.at(level - 1).size
            pieces = int((inside / child_size).to_integral_value(rounding="ROUND_FLOOR"))
            carved_children = [
                Node(id=f"cut-{node.id}-{k + 1}", level=level - 1, implied=True)
                for k in range(pieces)]
            for child in carved_children:
                implied[child.id] = (level - 1, node.id)
            pool[level - 1].extend(carved_children)
            loose += inside - child_size * pieces

    for level in range(ladder.top, 0, -1):
        above = ladder.levels[level + 1].ratio if level < ladder.top else ZERO
        wanted = int(target.get(level, ZERO) + above * need_new[level + 1])
        standing_full = [n for n in pool[level] if full(n)]
        standing_part = [n for n in pool[level] if not full(n)]
        # A part pack stays only where the target names one holding what it holds.
        for fill in wanted_part.get(level, []):
            match = next((n for n in standing_part if content(n) == fill), None)
            if match is not None:
                standing_part.remove(match)
                stay[level].append(match)
            else:
                new_part.append((level, fill))
        for node in standing_part:
            open_node(node, level)
        # Atoms first: they cannot be opened, so they are the ones kept.
        standing_full.sort(key=lambda n: (not n.atom, str(n.id)))
        keep, extra = standing_full[:wanted], standing_full[wanted:]
        for node in extra:
            open_node(node, level)
        pool[level] = keep
        need_new[level] = wanted - len(keep)

    loose_needed = (target.get(0, ZERO)
                    + (ladder.at(1).ratio * need_new[1] if ladder.top >= 1 else ZERO)
                    + sum((fill for _level, fill in new_part), ZERO))
    if loose_needed != loose:
        # Equal totals guarantee this only fails when something had to be split.
        raise PackError(
            "That packing would need a pack split below the level it was coded at. "
            "Pick bigger packs, or keep the smaller ones as they are.")

    created: list[Creation] = []
    for level in range(1, ladder.top + 1):
        row = ladder.at(level)
        made: list = []
        for index in range(need_new[level]):
            ref = f"new-{level}-{index + 1}"
            if level == 1:
                created.append(Creation(ref=ref, level=1, children=[],
                                        loose_units=row.ratio))
                loose -= row.ratio
            else:
                take = int(row.ratio)
                children = [n if isinstance(n, (int, str)) else n.id
                            for n in pool[level - 1][-take:]]
                del pool[level - 1][-take:]
                created.append(Creation(ref=ref, level=level, children=children))
            made.append(ref)
        pool[level] = [n.id if isinstance(n, Node) else n for n in pool[level]] + made
    for index, (level, fill) in enumerate(new_part):
        ref = f"part-{level}-{index + 1}"
        created.append(Creation(ref=ref, level=level, children=[], loose_units=fill,
                                fill=fill))
        loose -= fill
        stay[level].append(ref)
    top_ids = [n.id if isinstance(n, Node) else n
               for level in range(ladder.top, 0, -1)
               for n in pool[level] + stay[level]]
    gone = set(opened)
    carved = [(ref, level, parent) for ref, (level, parent) in implied.items()
              if ref not in gone]
    return RepackPlan(opened=opened, created=created, top=top_ids, loose=loose,
                      carved=carved)


def split_target(entries) -> tuple[dict[int, Decimal], list[tuple[int, Decimal]]]:
    """A normalized breakdown as the planner reads it: full packs per level (loose at
    0), and one `(level, fill)` per part pack."""
    full_counts: dict[int, Decimal] = {}
    part: list[tuple[int, Decimal]] = []
    for e in entries or []:
        level, qty = int(e.get("level") or 0), dec(e.get("qty"))
        if is_partial(e):
            part += [(level, held(e))] * int(qty)
        else:
            full_counts[level] = full_counts.get(level, ZERO) + qty
    return full_counts, part


# --------------------------------------------------------------------------- #
#  The request shape every module accepts for a breakdown
# --------------------------------------------------------------------------- #
from pydantic import BaseModel as _BaseModel, Field as _Field  # noqa: E402

from app.shared.limits import MAX_PACK_ENTRIES  # noqa: E402


class PackEntryIn(_BaseModel):
    """One level of a breakdown as a client sends it. Name the rung by
    `item_packaging_id`, or by `level` (0 = loose units). The server snapshots the
    name and size itself — a client never says how big a pack is."""
    item_packaging_id: int | None = None
    level: int | None = _Field(default=None, ge=0, le=50)
    qty: Decimal = _Field(ge=0, max_digits=16, decimal_places=3)
    #: A PART pack: what each of these packs really holds, in base units. Omitted:
    #: full. Never more than the level's size — the server checks.
    fill: Decimal | None = _Field(default=None, gt=0, max_digits=16, decimal_places=3)


#: A whole breakdown on a request body.
PackBreakdownIn = list[PackEntryIn]
PACK_ENTRIES = _Field(default=None, max_length=MAX_PACK_ENTRIES)
