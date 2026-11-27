"""A warehouse's shipping addresses (2026-11-23).

A warehouse may receive at several gates or docks, each its own SHIPPING ADDRESS, one
of them the default. They are kept on the warehouse master (one save with the
warehouse) and picked on an RFQ and a PO, which keep the chosen text as written — an
address edited later never rewrites an order already sent.

Rules, all here so the master, the RFQ and the PO agree:
- every address has a label (blank gets "Address N") and an address line;
- exactly one active address is the default — none ticked makes the first one it,
  two ticked is refused;
- nothing is deleted once saved: an address left out of a save goes inactive, so the
  id an RFQ or PO recorded still says what it was;
- the default's text is mirrored onto `whs_warehouses.address`, which everything that
  reads one address (the Delivery Challan's godown, labels) already reads.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.shared.models.warehouse import Warehouse, WarehouseAddress, address_text

FIELDS = ("label", "address", "city", "state", "pincode", "contact_name", "contact_phone")


def _get(entry, key, default=None):
    return entry.get(key, default) if isinstance(entry, dict) else getattr(entry, key, default)


def plan(incoming: list) -> list[dict]:
    """The addresses as they will be saved, checked and with one default. Pure."""
    out: list[dict] = []
    for n, entry in enumerate(incoming, start=1):
        line = (str(_get(entry, "address") or "")).strip()
        if not line:
            raise ValidationError(f"Shipping address {n}: give the address itself.")
        row = {key: (str(_get(entry, key) or "").strip() or None) for key in FIELDS}
        row["address"] = line[:500]
        row["label"] = (row["label"] or f"Address {n}")[:100]
        pin = row["pincode"]
        if pin and not (pin.isdigit() and len(pin) == 6):
            raise ValidationError(f"{row['label']}: a pincode is 6 digits.")
        phone = (row["contact_phone"] or "").replace(" ", "")
        if phone and not (phone.isdigit() and 10 <= len(phone) <= 12):
            raise ValidationError(f"{row['label']}: the contact phone is 10 digits.")
        row["id"] = _get(entry, "id")
        row["is_default"] = bool(_get(entry, "is_default", False))
        out.append(row)
    labels = [r["label"].lower() for r in out]
    dupes = {label for label in labels if labels.count(label) > 1}
    if dupes:
        raise ValidationError(f"Two shipping addresses are both called “{sorted(dupes)[0]}” — give each its own name.")
    defaults = [r for r in out if r["is_default"]]
    if len(defaults) > 1:
        raise ValidationError("Only one shipping address can be the default.")
    if out and not defaults:
        out[0]["is_default"] = True
    return out


async def save(db: AsyncSession, warehouse: Warehouse, incoming: list) -> None:
    """Replace the warehouse's addresses with `incoming` — matched by id, new ones
    added, the rest set inactive (never deleted)."""
    rows = plan(incoming)
    existing = {a.id: a for a in (await db.execute(
        select(WarehouseAddress).where(WarehouseAddress.warehouse_id == warehouse.id)
    )).scalars().all()}
    kept: set[int] = set()
    default = None
    for row in rows:
        target = existing.get(row["id"]) if row["id"] else None
        if target is None:
            target = WarehouseAddress(warehouse_id=warehouse.id)
            db.add(target)
        for key in FIELDS:
            setattr(target, key, row[key])
        target.is_default = row["is_default"]
        target.is_active = True
        if target.id:
            kept.add(target.id)
        if row["is_default"]:
            default = target
    for address_id, target in existing.items():
        if address_id not in kept:
            target.is_active = False
            target.is_default = False
    if default is not None:
        warehouse.address = address_text(default).split("\nContact:")[0].replace("\n", ", ")[:500]
    await db.flush()


async def list_for(db: AsyncSession, warehouse_id: int, *, include_inactive: bool = False) -> list[dict]:
    stmt = select(WarehouseAddress).where(WarehouseAddress.warehouse_id == warehouse_id)
    if not include_inactive:
        stmt = stmt.where(WarehouseAddress.is_active.is_(True))
    rows = (await db.execute(stmt.order_by(WarehouseAddress.is_default.desc(),
                                           WarehouseAddress.id))).scalars().all()
    return [{"id": r.id, "warehouse_id": r.warehouse_id, "label": r.label,
             "address": r.address, "city": r.city, "state": r.state, "pincode": r.pincode,
             "contact_name": r.contact_name, "contact_phone": r.contact_phone,
             "is_default": r.is_default, "is_active": r.is_active,
             "text": address_text(r)} for r in rows]


async def resolve(db: AsyncSession, warehouse_id: int | None, address_id: int | None,
                  text: str | None, *, where: str) -> tuple[str | None, int | None]:
    """The (text, id) a document keeps for its shipping address. The id must be an
    active address of THIS warehouse; blank text takes the address's own."""
    if not address_id:
        return ((text or "").strip() or None), None
    row = await db.get(WarehouseAddress, address_id)
    if row is None or not row.is_active or (warehouse_id and row.warehouse_id != warehouse_id):
        raise ValidationError(
            f"{where}: that shipping address is not one of the chosen warehouse's — pick it again.")
    return ((text or "").strip() or address_text(row)), row.id
