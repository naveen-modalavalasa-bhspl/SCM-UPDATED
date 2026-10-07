"""What a master tells a person when something they typed cannot be saved.

The people filling the masters are storekeepers, not developers. "String should have
at most 10 characters" on a column called `code` told one of them nothing, and he lost
a day to it. So every problem is said the same way, in plain words:

    Row 12 · Brand code — "SUNPHARMA-LTD" is 13 characters long. Brand code can be
    10 characters at most, e.g. SUNPHARMA.

  · WHICH ROW and WHICH COLUMN, by the name the person reads on the screen — never the
    schema's field name (`is_batch_tracked`), never "string" or "input";
  · WHAT is wrong with the value THEY typed, quoted back to them;
  · WHAT TO TYPE instead, with an example where one helps.

The sheet's own headers are NOT renamed by this — files already filled in against the
template must keep importing. Only what is shown to a person changes.
"""
from __future__ import annotations

import re
from typing import Any

# --------------------------------------------------------------------------- #
#  What each column is called, and what it is for
# --------------------------------------------------------------------------- #
LABELS: dict[str, str] = {
    "short_name": "Short name",
    "description": "Description",
    "address": "Address",
    "affects_handling": "Affects handling",
    "allowed_values": "Allowed values",
    "barcode_type": "Barcode type",
    "barcode_value": "Barcode number",
    "bin_type": "Location type",
    "bom_id": "BOM",
    "brand_id": "Brand",
    "brand_ids": "Brands",
    "capacity_qty": "Capacity (quantity)",
    "category_id": "Category",
    "city": "City",
    "component_item_id": "Component item",
    "contact_person": "Contact person",
    "category_ids": "Vendor categories",
    "vendor_ids": "Vendors",
    "credit_limit": "Credit limit",
    "data_type": "Value type",
    "effective_from": "Effective from",
    "effective_to": "Effective to",
    "email": "Email",
    "end_date": "End date",
    "facility_id": "Facility",
    "factor": "Conversion factor",
    "fill_efficiency_pct": "Fill efficiency (%)",
    "from_uom_id": "From unit",
    "generate_unit_code": "Generate unit codes",
    "gross_weight_kg": "Gross weight (kg)",
    "group_id": "Group",
    "gst_rate": "GST rate (%)",
    "gstin": "GSTIN",
    "has_components": "Has components (kit)",
    "has_expiry": "Has expiry date",
    "height_cm": "Height (cm)",
    "incharge_id": "In-charge",
    "is_active": "Active",
    "is_approved": "Approved",
    "is_asset": "Is an asset",
    "is_batch_tracked": "Batch tracked",
    "is_bin_managed": "Uses storage locations",
    "is_blacklisted": "Blacklisted",
    "is_default_putaway_unit": "Default put-away pack",
    "is_imei_tracked": "IMEI tracked",
    "is_preferred": "Preferred vendor",
    "is_required": "Required",
    "is_returnable": "Returnable",
    "is_rotatable": "Can be turned",
    "is_serial_tracked": "Serial number tracked",
    "is_stackable": "Stackable",
    "item_class_id": "Item class",
    "item_id": "Item",
    "last_rate": "Last rate",
    "lead_time_days": "Lead time (days)",
    "length_cm": "Length (cm)",
    "level": "Pack level",
    "line_no": "Line number",
    "manufacturer_id": "Manufacturer",
    "manufacturer_ids": "Manufacturers",
    "max_stack_tiers": "Max stack height (tiers)",
    "min_order_qty": "Minimum order quantity",
    "office_id": "Office",
    "package_id": "Package",
    "pan": "PAN",
    "parent_id": "Parent",
    "payment_terms_days": "Payment terms (days)",
    "advance_split": "Advance — how it is paid",
    "advance_instalment_days": "Advance — instalment days",
    "advance_instalment_pcts": "Advance — instalment shares (%)",
    "delivery_split": "Against delivery — how it is paid",
    "delivery_instalment_days": "Against delivery — instalment days",
    "delivery_instalment_pcts": "Against delivery — instalment shares (%)",
    "installation_split": "Post installation — how it is paid",
    "installation_instalment_days": "Post installation — instalment days",
    "installation_instalment_pcts": "Post installation — instalment shares (%)",
    "warranty_split": "Post warranty — how it is paid",
    "warranty_instalment_days": "Post warranty — instalment days",
    "warranty_instalment_pcts": "Post warranty — instalment shares (%)",
    "phone": "Phone",
    "pincode": "PIN code",
    "profile_key": "Job profile",
    "project_id": "Project",
    "quantity": "Quantity",
    "rating": "Rating",
    "remarks": "Remarks",
    "requires_inward": "Needs material inward",
    "requires_qi": "Needs quality check",
    "requires_special_storage": "Needs special storage",
    "requires_special_transport": "Needs special transport",
    "scope_id": "Role or region",
    "scope_type": "Applies to",
    "segment_code": "Category number",
    "start_date": "Start date",
    "state": "State",
    "storage_conditions": "Storage conditions",
    "tag_id": "Tag",
    "tag_type": "Tag type",
    "to_uom_id": "To unit",
    "transport_conditions": "Transport conditions",
    "uom_class": "Unit type",
    "uom_id": "Unit of measure",
    "valuation_method": "Valuation method",
    "vendor_id": "Vendor",
    "vendor_item_code": "Vendor's item code",
    "vendor_type": "Vendor type",
    "warehouse_id": "Warehouse",
    "warehouse_type": "Warehouse type",
    "weight_kg": "Weight (kg)",
    "width_cm": "Width (cm)",
}

HINTS: dict[str, str] = {
    "code": "A short code: letters and numbers, a hyphen only between them.",
    "uom_class": "What the unit measures: Count, Weight, Volume ... (Masters › UOM Types).",
    "segment_code": "Two digits, 00 to 99.",
    "is_batch_tracked": "Each delivery keeps its own batch number.",
    "is_serial_tracked": "Every single unit has its own serial number.",
    "is_imei_tracked": "Phones and devices tracked by IMEI number.",
    "has_expiry": "Batches carry an expiry date.",
    "requires_qi": "Goods are checked before they go on the shelf.",
    "has_components": "This item is a kit made of other items.",
    "generate_unit_code": "Give every unit its own asset or consumable code at put-away.",
    "is_asset": "Yes for equipment that is kept and returned; No for things used up.",
    "valuation_method": "How stock is costed. FIFO if unsure.",
    "barcode_type": "The kind of barcode printed on the item.",
    "gst_rate": "The GST % for this HSN code, e.g. 12.",
    "gstin": "15 characters, e.g. 37ABCDE1234F1Z5.",
    "pan": "10 characters, e.g. ABCDE1234F.",
    "pincode": "6 digits.",
    "factor": "How many of the 'to' unit make one 'from' unit.",
    "is_default_putaway_unit": "The pack this item is normally shelved in.",
}

ACRONYMS = {"gst": "GST", "hsn": "HSN", "uom": "UOM", "imei": "IMEI", "pan": "PAN",
            "bom": "BOM", "qi": "QI", "id": "ID", "kg": "kg", "cm": "cm"}


def _humanise(field: str) -> str:
    words = [w for w in field.removesuffix("_id").removesuffix("_ids").split("_") if w]
    if words and words[0] == "is":
        words = words[1:]
    text = " ".join(ACRONYMS.get(w, w) for w in words) or field
    return text[:1].upper() + text[1:]


def field_label(defn: Any, field: str) -> str:
    """The name a person reads for this column. A lookup keeps its own label."""
    for lk in getattr(defn, "lookups", ()) or ():
        if lk.field == field:
            return lk.label
    master = getattr(defn, "name", "") or ""
    if field == "code":
        return master if master.lower().endswith("code") else f"{master} code".strip()
    if field == "name":
        return f"{master} name".strip() if master else "Name"
    return LABELS.get(field) or _humanise(field)


def field_hint(defn: Any, field: str) -> str:
    if field == "code":
        from app.shared.masters.short_codes import applies
        if applies(defn):
            return ("Exactly 3 letters, e.g. ERB for Erba. Leave it blank and one is "
                    "made from the name.")
    return HINTS.get(field, "")


# --------------------------------------------------------------------------- #
#  The rule a column enforces, said as a sentence
# --------------------------------------------------------------------------- #
CODE_PATTERNS = {r"^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$", r"^[A-Za-z0-9-]+$"}


def _limits(field_info: Any) -> tuple[int | None, int | None, str | None]:
    low = high = pattern = None
    for meta in getattr(field_info, "metadata", ()) or ():
        low = getattr(meta, "min_length", low)
        high = getattr(meta, "max_length", high)
        pattern = getattr(meta, "pattern", pattern)
    return low, high, pattern


def rule_text(field_info: Any) -> str:
    """'Up to 10 letters or numbers; a hyphen only between them' — for the template."""
    low, high, pattern = _limits(field_info)
    parts = []
    if low and high and low == high:
        parts.append(f"exactly {high} characters")
    elif high:
        parts.append(f"up to {high} characters")
    if pattern in CODE_PATTERNS:
        parts.append("letters and numbers only, a hyphen allowed between them "
                     "(no spaces)")
    return "; ".join(parts)


def _code_example(value: str, limit: int | None) -> str:
    """A cleaned-up version of what they typed, to show what would be accepted."""
    text = re.sub(r"[^A-Za-z0-9]+", "-", value.strip()).strip("-").upper()
    text = re.sub(r"-{2,}", "-", text)
    if limit and len(text) > limit:
        # Keep whole words: SUNPHARMA-LTD -> SUNPHARMA, never SUNPHARMAL.
        kept = ""
        for part in text.split("-"):
            joined = f"{kept}-{part}" if kept else part
            if len(joined) > limit:
                break
            kept = joined
        text = kept or text[:limit]
    return text


def _what_breaks_code(value: str) -> str:
    if " " in value:
        return "has a space"
    if value.startswith("-") or value.endswith("-"):
        return "starts or ends with a hyphen"
    if "--" in value:
        return "has two hyphens together"
    bad = sorted({c for c in value if not (c.isalnum() or c == "-")})
    if bad:
        return "has " + " ".join(f"“{c}”" for c in bad[:4])
    return "is not in the right form"


def _quote(value: Any) -> str:
    text = "" if value is None else str(value)
    return f"“{text[:60]}{'…' if len(text) > 60 else ''}”"


def _number(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    return str(int(number)) if number.is_integer() else f"{number:g}"


def plain_error(issue: dict, label: str, field_info: Any = None) -> str:
    """One Pydantic issue as a sentence a storekeeper can act on."""
    kind = issue.get("type", "")
    value = issue.get("input")
    ctx = issue.get("ctx") or {}
    shown = _quote(value)

    # The column is named beside every message (Row 12 · Brand code — ...), so the
    # sentence itself does not repeat it.
    if kind in ("missing", "missing_argument") or (
            kind == "string_too_short" and ctx.get("min_length") == 1):
        return "This is empty. Please fill it in."
    if kind == "string_too_short":
        return f"{shown} is too short. It needs at least {ctx.get('min_length')} characters."
    if kind == "string_too_long":
        limit = ctx.get("max_length")
        text = (f"{shown} is {len(str(value or ''))} characters long. "
                f"The most allowed is {limit}")
        _, _, pattern = _limits(field_info)
        if pattern in CODE_PATTERNS:
            text += f" — shorten it, e.g. {_code_example(str(value or ''), limit)}"
        return text + "."
    if kind == "string_pattern_mismatch":
        pattern = ctx.get("pattern")
        if pattern in CODE_PATTERNS:
            low, high, _ = _limits(field_info)
            example = _code_example(str(value or ""), high)
            return (f"{shown} {_what_breaks_code(str(value or ''))}. Use only letters, "
                    "numbers and a hyphen between them"
                    + (f", e.g. {example}" if example else "") + ".")
        return f"{shown} is not in the right form."
    if kind in ("int_parsing", "int_type", "int_from_float"):
        return f"{shown} is not a whole number. Type a number like 10."
    if kind in ("float_parsing", "float_type", "decimal_parsing", "decimal_type",
                "finite_number"):
        return f"{shown} is not a number. Type a number like 12.5."
    if kind == "greater_than":
        return f"Must be more than {_number(ctx.get('gt'))}. You typed {_number(value)}."
    if kind == "greater_than_equal":
        return f"Cannot be less than {_number(ctx.get('ge'))}. You typed {_number(value)}."
    if kind == "less_than":
        return f"Must be less than {_number(ctx.get('lt'))}. You typed {_number(value)}."
    if kind == "less_than_equal":
        return f"Cannot be more than {_number(ctx.get('le'))}. You typed {_number(value)}."
    if kind in ("bool_parsing", "bool_type"):
        return f"{shown} is not Yes or No. Type Yes or No."
    if kind.startswith("date") or kind.startswith("datetime"):
        return f"{shown} is not a date. Type it like 31-12-2026."
    if kind in ("literal_error", "enum"):
        return f"{shown} is not one of the choices. Pick one of: {ctx.get('expected', '')}."
    if kind in ("list_type", "too_long", "too_short"):
        return f"{shown} could not be read as a list. Separate the values with commas."
    if "email" in kind:
        return f"{shown} is not an email address."

    # A rule written by hand already reads as a sentence; only the library's own
    # prefix is noise.
    message = str(issue.get("msg", "")).strip()
    for noise in ("Value error, ", "Assertion failed, "):
        message = message.removeprefix(noise)
    return message.rstrip(".") + "."


# --------------------------------------------------------------------------- #
#  One problem, and many problems
# --------------------------------------------------------------------------- #
class Problem(str):
    """A problem line that still knows which row and column it is about.

    A `str` so every caller that printed or joined the old strings keeps working;
    the attributes are what the review screen pins it to a cell with.
    """
    row: int | None
    field: str | None
    label: str
    detail: str

    def __new__(cls, row: int | None, field: str | None, label: str, detail: str):
        where = f"Row {row} · {label}" if row is not None else label
        obj = super().__new__(cls, f"{where} — {detail}")
        obj.row, obj.field, obj.label, obj.detail = row, field, label, detail
        return obj


def summarise(problems: list[str], limit_groups: int = 12) -> str:
    """'Nothing was saved. 59 rows need fixing' plus the problems grouped by column.

    Fifty raw lines in a red box is a wall nobody reads. Grouped, the same file says
    "Brand code — too long in 23 rows: 4, 9, 12 …" and the person knows it is one
    thing to fix, done 23 times.
    """
    rows = {getattr(p, "row", None) for p in problems} - {None}
    # No "Nothing was saved." here: the screen heads every import error with it.
    head = (f"{len(rows)} row{'s need' if len(rows) != 1 else ' needs'} fixing."
            if rows else f"{len(problems)} problem{'s need' if len(problems) != 1 else ' needs'} "
                         "fixing.")
    groups: dict[str, list] = {}
    for p in problems:
        groups.setdefault(getattr(p, "label", None) or "Other", []).append(p)
    lines = [head, ""]
    for label, items in sorted(groups.items(), key=lambda kv: -len(kv[1]))[:limit_groups]:
        numbers = sorted({p.row for p in items if getattr(p, "row", None) is not None})
        where = ""
        if numbers:
            shown = ", ".join(str(n) for n in numbers[:8])
            more = f" (+{len(numbers) - 8} more)" if len(numbers) > 8 else ""
            where = f" — row{'s' if len(numbers) > 1 else ''} {shown}{more}"
        example = getattr(items[0], "detail", str(items[0]))
        lines.append(f"• {label}{where}")
        lines.append(f"    e.g. {example}")
    if len(groups) > limit_groups:
        lines.append(f"…and {len(groups) - limit_groups} more column(s).")
    return "\n".join(lines)
