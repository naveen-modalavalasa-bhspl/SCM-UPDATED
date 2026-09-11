"""The asset / consumable code formula — configured, not compiled in.

The code a unit carries for the rest of its life used to be one f-string buried in
warehouse putaway, so every change of mind about its shape was a code change, a review
and a deploy. The shape is a business decision that moves; it belongs in settings.

A format is a plain template of `{token}` placeholders, optionally widthed:

    {item_code}-{new_flag}-{serial:8}   ->   ELCCBL01-GEN-SMS-MFR-0001-1-00042317

Rendering never fails at putaway. A template that cannot be rendered (an unknown
token, a bad width) is rejected when it is SAVED, and if a broken one somehow reaches
the goods-in — hand-edited in sys_settings, restored from an old backup — the built-in
default stands in and the fault is logged. A putaway must not be blocked by a
misconfigured string, and a unit must never leave the dock without a code.
"""
import logging
import re
from datetime import date, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError

logger = logging.getLogger(__name__)

# What the codes looked like before this screen existed: item code + a padded row id.
# Kept as the fallback so an unconfigured or broken system still generates exactly
# what it generated yesterday.
DEFAULT_ASSET_FORMAT = "{item_code}-{new_flag}-{serial:8}"
DEFAULT_CONSUMABLE_FORMAT = "{item_code}-{new_flag}-{serial:8}"
LEGACY_FORMAT = "{item_code}-{seq:6}"

# The serial MINTED for a unit that arrived without one. A vendor serial always wins;
# this is only for goods that come in unlabelled, which used to block the GRN outright
# ("N of M serial numbers captured"). {serial} is not available here — it is the thing
# being generated — so the running number is the identity, and validate_serial_format
# insists on it.
#
# Shaped like the asset and consumable codes above (2026-09-10), because on the shelf
# it IS one of them: a minted serial is a label this system printed, not a number the
# manufacturer stamped, and the storekeeper reading it has no way to know which of the
# four kinds he is holding if one of them is shaped differently from the other three.
# The `{new_flag}` segment is what makes an item code read `...-0001-1-00000042`, and
# leaving it out of this one format was the whole of the difference.
DEFAULT_SERIAL_FORMAT = "{item_code}-{new_flag}-{seq:8}"

# Every token a format may use, and what it means on screen. The screen renders this
# table, so a token added here is documented for the user by construction.
TOKENS: dict[str, str] = {
    "item_code": "Item code, e.g. ELCCBL01-GEN-SMS-MFR-0001",
    "item_name": "Item name",
    "general_name": "General name from the item master",
    "category": "Item category name",
    "brand": "Brand code",
    "manufacturer": "Manufacturer code",
    "new_flag": "1 for a new item, 0 for an item created before the cutover date",
    "serial": "Serial / IMEI of the unit. Width pads or trims: {serial:8}",
    "seq": "Running number of the unit in the system. Width pads: {seq:6}",
    "warehouse": "Code of the stocking point it was put away into",
    "year": "Year of putaway, 2026",
    "yy": "Year of putaway, 26",
    "mm": "Month of putaway, 08",
}

_PLACEHOLDER = re.compile(r"\{(\w+)(?::(\d+))?\}")


def validate_format(template: str, *, label: str = "Format") -> str:
    """Reject a template the day it is typed, not the day a lorry is being unloaded."""
    template = (template or "").strip()
    if not template:
        return ""   # empty means "use the default", which is a legitimate choice
    unknown = sorted({name for name, _ in _PLACEHOLDER.findall(template)
                      if name not in TOKENS})
    if unknown:
        raise ValidationError(
            f"{label} uses unknown token(s): {', '.join('{' + u + '}' for u in unknown)}. "
            f"Available: {', '.join('{' + t + '}' for t in TOKENS)}"
        )
    # A template of pure literals gives every unit the same code, which is worse than
    # no code at all — duplicates cannot be told apart on a shelf.
    if not _PLACEHOLDER.search(template):
        raise ValidationError(
            f"{label} has no tokens, so every unit would get the same code. "
            f"Include at least {'{serial}'} or {'{seq}'}."
        )
    if not any(name in ("serial", "seq") for name, _ in _PLACEHOLDER.findall(template)):
        raise ValidationError(
            f"{label} must include {'{serial}'} or {'{seq}'}, or two units of the same "
            f"item would receive the same code."
        )
    return template


def validate_serial_format(template: str, *, label: str = "Serial format") -> str:
    """Same rules, minus {serial}: this template IS the serial, so it cannot quote one.

    A template that leaned on {serial} would render blank and hand every unlabelled
    unit the same string, which the receipt would then reject as a duplicate.
    """
    template = validate_format(template, label=label)
    if not template:
        return ""
    names = {name for name, _ in _PLACEHOLDER.findall(template)}
    if "serial" in names:
        raise ValidationError(
            f"{label} cannot use {'{serial}'} — it is what this template generates. "
            f"Use {'{seq}'} for the running number."
        )
    if "seq" not in names:
        raise ValidationError(
            f"{label} must include {'{seq}'}, or every unit of an item would be given "
            f"the same serial."
        )
    return template


def _fit(value: str, width: int | None, *, numeric: bool) -> str:
    """Pad to the asked width, and keep the RIGHT-hand end when it overflows.

    A serial is trimmed from the left because its tail is the part that varies —
    cutting the other end would collapse a whole batch onto one code.
    """
    if width is None:
        return value
    if len(value) > width:
        return value[-width:]
    # Only numbers are padded — spaces inside a printed code are unreadable and text
    # that is shorter than the width is simply shorter.
    return value.rjust(width, "0") if numeric else value


def render(template: str, values: dict[str, object]) -> str:
    """Substitute the tokens. Anything missing renders empty rather than 'None'."""
    def one(match: re.Match) -> str:
        name, width = match.group(1), match.group(2)
        raw = values.get(name)
        text = "" if raw is None else str(raw)
        numeric = name in ("serial", "seq", "new_flag", "year", "yy", "mm")
        return _fit(text, int(width) if width else None, numeric=numeric)
    return _PLACEHOLDER.sub(one, template).strip("-").strip()


def build_values(*, item=None, serial: str | None = None, seq: int | None = None,
                 warehouse_code: str | None = None, is_new: bool = True,
                 new_flag: str = "1", legacy_flag: str = "0",
                 when: datetime | date | None = None) -> dict[str, object]:
    """The facts a code can be built from, gathered in one place."""
    when = when or datetime.now()
    return {
        "item_code": getattr(item, "code", None) or "ITM",
        "item_name": getattr(item, "name", None),
        "general_name": getattr(item, "general_name", None),
        "category": getattr(item, "category_name", None),
        "brand": getattr(item, "brand_code", None),
        "manufacturer": getattr(item, "manufacturer_code", None),
        "new_flag": new_flag if is_new else legacy_flag,
        # The serial is the unit's own identity when it has one; without it the row id
        # is the only thing that distinguishes two otherwise identical units.
        "serial": serial or (str(seq) if seq is not None else ""),
        "seq": seq,
        "warehouse": warehouse_code,
        "year": when.strftime("%Y"),
        "yy": when.strftime("%y"),
        "mm": when.strftime("%m"),
    }


def is_new_item(item, cutoff: str | None) -> bool:
    """Whether this item counts as "new" for the {new_flag} token.

    "Old" is defined by a date the business sets, not by anything in the item itself:
    the rule they described is "everything created before we changed the scheme carries
    a 0". No cutoff configured means nothing is old yet, which is the safe reading —
    it stamps the new flag rather than silently back-dating the whole catalogue.
    """
    if not cutoff:
        return True
    created = getattr(item, "created_at", None)
    if created is None:
        return True
    try:
        boundary = date.fromisoformat(cutoff)
    except ValueError:
        logger.warning("code format: cutoff date %r is not a date, ignoring", cutoff)
        return True
    created_date = created.date() if isinstance(created, datetime) else created
    return created_date >= boundary


# Which items get an asset / consumable code minted at putaway — the item master's
# fifth tracking toggle, beside batch / serial / IMEI / expiry. It is a LIST OF ITEM
# CODES in one setting rather than a column on mst_items, because the live schema is
# frozen; item codes are unique and are never regenerated on an edit (masters overhaul,
# 2026-07-28), so they key this as safely as an id would.
#
# Absent (None) means "never configured" and reads as ALL items tracked — that is what
# the dock did before the toggle existed, and an unset field must not silently stop
# goods being coded. An EMPTY string is a configured "none".
TRACKED_ITEMS_KEY = "codes.tracked_items"


def _split(raw: str | None) -> set[str]:
    return {part.strip() for part in (raw or "").split(",") if part.strip()}


def is_code_tracked(item, config: dict | None) -> bool:
    """Does this item's unit get an asset / consumable code at putaway?"""
    if not config:
        return True
    tracked = config.get("tracked_items")
    if tracked is None:      # never configured — legacy behaviour, code everything
        return True
    return (getattr(item, "code", None) or "") in tracked


async def set_item_tracked(db: AsyncSession, item_code: str, on: bool) -> None:
    """Turn the toggle on or off for one item. Does NOT commit — the caller's unit of
    work owns the transaction (this runs inside the item master's save).

    The first write seeds the list from every existing item, so switching one item on
    cannot silently switch every other item off.
    """
    from sqlalchemy import select as _select

    from app.platform.settings.models import Setting
    from app.shared.models.master import Item

    row = (await db.execute(
        _select(Setting).where(Setting.setting_key == TRACKED_ITEMS_KEY)
    )).scalar_one_or_none()
    if row is None:
        seeded = {c for (c,) in (await db.execute(
            _select(Item.code).where(Item.code.is_not(None)))).all()}
        row = Setting(setting_key=TRACKED_ITEMS_KEY, setting_value=",".join(sorted(seeded)),
                      value_type="string", category="codes",
                      description="Item codes whose units are given an asset/consumable code")
        db.add(row)
    tracked = _split(row.setting_value)
    tracked.add(item_code) if on else tracked.discard(item_code)
    row.setting_value = ",".join(sorted(tracked))
    await db.flush()


async def tracked_items(db: AsyncSession) -> set[str] | None:
    from app.platform.settings.service import get_setting
    raw = await get_setting(db, TRACKED_ITEMS_KEY)
    return None if raw is None else _split(raw)


async def code_settings(db: AsyncSession) -> dict:
    """The configured formula, with today's behaviour as the default."""
    from app.platform.settings.service import get_setting

    async def value(key: str, default: str) -> str:
        raw = await get_setting(db, key)
        return default if raw is None or raw == "" else raw

    return {
        "asset_format": await value("codes.asset_format", DEFAULT_ASSET_FORMAT),
        "consumable_format": await value("codes.consumable_format",
                                         DEFAULT_CONSUMABLE_FORMAT),
        "serial_format": await value("codes.serial_format", DEFAULT_SERIAL_FORMAT),
        "new_flag": await value("codes.new_flag", "1"),
        "legacy_flag": await value("codes.legacy_flag", "0"),
        "legacy_before": await value("codes.legacy_before", ""),
        "tracked_items": await tracked_items(db),
    }


async def unit_code(db: AsyncSession, *, item, is_asset: bool,
                    serial: str | None = None, seq: int | None = None,
                    warehouse_code: str | None = None,
                    config: dict | None = None) -> str:
    """The asset or consumable code for one unit, per the configured formula.

    Called at putaway. Falls back rather than raising, for the reason in the module
    docstring: a broken setting must not stop goods being received.

    `config` is the already-read settings, for a caller coding a whole putaway at
    once: the formula cannot change between two units of the same lorry, and reading
    five settings per unit turned a 500-unit putaway into 2,500 queries.
    """
    config = config or await code_settings(db)
    template = config["asset_format"] if is_asset else config["consumable_format"]
    values = build_values(
        item=item, serial=serial, seq=seq, warehouse_code=warehouse_code,
        is_new=is_new_item(item, config["legacy_before"]),
        new_flag=config["new_flag"], legacy_flag=config["legacy_flag"],
    )
    try:
        validate_format(template, label="Code format")
        code = render(template, values)
    except (ValidationError, ValueError) as exc:
        logger.error("code format %r is unusable (%s) — falling back to %r",
                     template, exc, LEGACY_FORMAT)
        code = render(LEGACY_FORMAT, values)
    # An empty render (every token blank) is not a code. The legacy shape always
    # produces something, because seq is always known.
    return code or render(LEGACY_FORMAT, values)


async def mint_serials(db: AsyncSession, *, item, count: int,
                       warehouse_code: str | None = None,
                       config: dict | None = None,
                       taken: set[str] | None = None) -> list[str]:
    """`count` serials for units that arrived without one, per the configured format.

    Goods that come in unlabelled used to stop the GRN dead: a serial-tracked line
    demanded one serial per unit and there was nowhere to get them. This mints them
    from the same token engine the asset and consumable codes use, so the shape is a
    setting rather than a code change.

    `taken` is every serial this item must not collide with — the caller owns those
    tables (platform may not read a module's, rule 5) and knows that "already used"
    means both the registered units AND the ones sitting on other open receipts, which
    have no rows yet. The running number starts past that set and skips anything in it.

    Falls back rather than raising, for the reason in the module docstring: a broken
    setting must not stop goods being received.
    """
    if count <= 0:
        return []
    config = config or await code_settings(db)
    template = config.get("serial_format") or DEFAULT_SERIAL_FORMAT
    try:
        validate_serial_format(template)
    except (ValidationError, ValueError) as exc:
        logger.error("serial format %r is unusable (%s) — falling back to %r",
                     template, exc, DEFAULT_SERIAL_FORMAT)
        template = DEFAULT_SERIAL_FORMAT

    used = {value.strip().lower() for value in (taken or set()) if value}

    minted: list[str] = []
    seq = len(used) + 1
    # Bounded so a template that renders the same string forever cannot spin: at that
    # point the shape is wrong and the default, which always varies, takes over.
    limit = seq + count * 100
    while len(minted) < count and seq < limit:
        values = build_values(
            item=item, serial=None, seq=seq, warehouse_code=warehouse_code,
            is_new=is_new_item(item, config["legacy_before"]),
            new_flag=config["new_flag"], legacy_flag=config["legacy_flag"],
        )
        candidate = render(template, values) or render(DEFAULT_SERIAL_FORMAT, values)
        seq += 1
        if candidate.lower() in used:
            continue
        used.add(candidate.lower())
        minted.append(candidate)
    if len(minted) < count:
        raise ValidationError(
            f"Could not generate {count} unique serials for {item.code} from the "
            f"configured Serial format. Check Settings > Code Formats."
        )
    return minted


def preview(template: str, *, is_asset: bool = True) -> str:
    """What the format produces for a made-up unit. Rendered by the SAME code the
    putaway uses, so the screen cannot promise a shape the dock will not produce."""
    class _SampleItem:
        code = "ELCCBL01-GEN-SMS-MFR-0001"
        name = "Sample item"
        general_name = "CABLE"
        category_name = "Electricals"
        brand_code = "SMS"
        manufacturer_code = "MFR"
    values = build_values(item=_SampleItem(), serial="42317", seq=42317,
                          warehouse_code="WH-MDP-01", is_new=True)
    validate_format(template, label="Code format")
    return render(template or (DEFAULT_ASSET_FORMAT if is_asset
                               else DEFAULT_CONSUMABLE_FORMAT), values)
