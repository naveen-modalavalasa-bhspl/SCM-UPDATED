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
        "new_flag": await value("codes.new_flag", "1"),
        "legacy_flag": await value("codes.legacy_flag", "0"),
        "legacy_before": await value("codes.legacy_before", ""),
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
