"""The Delivery Challan (2026-11-19, reshaped 2026-11-20) — the paper that travels with a DISPATCH.

One challan per dispatch, numbered with the DISPATCH number (the gate pass, the DSP
series), never a consignment's: one truck can carry several consignments — a
multi-drop trip — and the challan is the one sheet for the whole load. Inside it, one
block per consignment, and inside each, one block per package with what is in it.

Read, never stored. Everything here is already on the shipment
(`lgs_transport_requests`), the consignments (`out_dispatches`, `out_dispatch_items`,
`out_dispatch_packages`), the warehouse master (`whs_warehouses`, the godown address)
and the item master (HSN, the purchase price fallback). A stored challan would be a
second answer the day any of those is corrected.

It lives in warehouse, not logistics, because it reads consignments: warehouse sits
AFTER logistics in the import chain (rule 5) and may read the shipment; logistics may
not read a consignment.

Prices are printed on EVERY line (decided 2026-11-19): the consignment line's own rate
where it carries one, else the item master's purchase price — the same valuation
fallback stock uses — and the source of each figure is served so the sheet can mark
one that is the master's rather than the line's.
"""
from __future__ import annotations

from collections import OrderedDict
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.modules.logistics.models import (
    ConsolidatedTripConsignment, ConsolidatedTripStop, TransportRequest,
)
from app.modules.warehouse import models as m
from app.modules.warehouse import service as svc
from app.shared.models.master import HsnCode, Item
from app.shared.models.warehouse import Warehouse

ZERO = Decimal("0")
_TRIP = "TRIP"


def _d(value) -> Decimal:
    return Decimal(str(value)) if value is not None else ZERO


def _volume_cbm(package: m.DispatchPackage) -> Decimal | None:
    """A package's outer cube in m³, or None when any side is unmeasured — an
    unmeasured carton has no volume, not zero (CLAUDE.md rule 14)."""
    sides = (package.length_cm, package.width_cm, package.height_cm)
    if any(side is None or _d(side) <= 0 for side in sides):
        return None
    cube = _d(sides[0]) * _d(sides[1]) * _d(sides[2]) / Decimal("1000000")
    return cube.quantize(Decimal("0.001"))


async def _dispatch_ids(db: AsyncSession, tr: TransportRequest) -> list[int]:
    """The consignments this shipment carries, in the order they come off the truck."""
    if (tr.source_type or "").upper() == _TRIP and tr.source_id:
        rows = (await db.execute(
            select(ConsolidatedTripConsignment.dispatch_id)
            .join(ConsolidatedTripStop,
                  ConsolidatedTripStop.id == ConsolidatedTripConsignment.stop_id)
            .where(ConsolidatedTripConsignment.trip_id == tr.source_id)
            .order_by(ConsolidatedTripStop.sequence, ConsolidatedTripConsignment.id)
        )).scalars().all()
        return list(OrderedDict.fromkeys(rows))
    return [tr.dispatch_id] if tr.dispatch_id else []


async def _item_facts(db: AsyncSession, item_ids: set[int]) -> dict[int, dict]:
    """HSN code and purchase price per item, two queries for any number of items."""
    if not item_ids:
        return {}
    items = (await db.execute(select(Item).where(Item.id.in_(item_ids)))).scalars().all()
    hsn_ids = {item.hsn_id for item in items if getattr(item, "hsn_id", None)}
    hsn = {row.id: row for row in (await db.execute(
        select(HsnCode).where(HsnCode.id.in_(hsn_ids)))).scalars().all()} if hsn_ids else {}
    out: dict[int, dict] = {}
    for item in items:
        master = hsn.get(getattr(item, "hsn_id", None))
        out[item.id] = {
            "hsn_code": (getattr(master, "code", None) or getattr(item, "hsn_code", None)),
            "purchase_price": _d(getattr(item, "purchase_price", None)),
            "uom_code": None,
        }
    return out


def _line_key(row: m.DispatchItem, price: Decimal) -> tuple:
    # A coded item is stored one row PER UNIT (and one per package code); on paper
    # that is one line per item, batch and price inside a package.
    return (row.item_id, row.batch_no or "", row.brand_id or 0, row.variant_id or 0,
            row.model_id or 0, str(price))


def _summarise_lines(rows: list[m.DispatchItem], facts: dict[int, dict], *,
                     with_codes: bool = True) -> list[dict]:
    lines: OrderedDict[tuple, dict] = OrderedDict()
    for row in rows:
        qty = _d(row.quantity)
        if qty <= 0:
            continue
        own = _d(row.rate)
        fact = facts.get(row.item_id, {})
        price = own if own > 0 else fact.get("purchase_price", ZERO)
        source = "LINE" if own > 0 else ("ITEM_MASTER" if price > 0 else "NONE")
        key = _line_key(row, price)
        line = lines.get(key)
        if line is None:
            line = lines[key] = {
                "item_id": row.item_id,
                "item_code": row.item_code,
                "item_name": row.item_name,
                "uom_code": row.uom_code,
                "batch_no": row.batch_no,
                "expiry_date": row.expiry_date,
                "hsn_code": fact.get("hsn_code"),
                "quantity": ZERO,
                "unit_price": price,
                "price_source": source,
                "amount": ZERO,
                "codes": [],
            }
        line["quantity"] += qty
        code = row.box_code or row.serial_no or row.imei_no
        if code and with_codes:
            line["codes"].append(code)
    for line in lines.values():
        line["amount"] = (line["quantity"] * line["unit_price"]).quantize(Decimal("0.01"))
    return list(lines.values())


async def _godown(db: AsyncSession, warehouse_id: int | None) -> dict:
    """The source godown, off the warehouse master: name, code and address."""
    wh = await db.get(Warehouse, warehouse_id) if warehouse_id else None
    if wh is None:
        return {"id": warehouse_id, "name": None, "code": None, "address": None}
    return {"id": wh.id, "name": wh.name, "code": wh.code,
            "address": await svc._resolve_warehouse_address(db, wh)}


async def _consignment_block(db: AsyncSession, dispatch: m.Dispatch,
                             facts: dict[int, dict]) -> dict:
    to_wh = (await db.get(Warehouse, dispatch.to_warehouse_id)
             if dispatch.to_warehouse_id else None)
    to_address = (dispatch.delivery_address
                  or (await svc._resolve_warehouse_address(db, to_wh) if to_wh else None))
    by_package: dict[int | None, list[m.DispatchItem]] = {}
    for row in sorted(dispatch.items, key=lambda r: (r.line_no or 0, r.id)):
        by_package.setdefault(row.package_id, []).append(row)

    packages = []
    ordered = sorted(dispatch.packages, key=lambda p: (p.package_no or "", p.id))
    for index, package in enumerate(ordered, start=1):
        lines = _summarise_lines(by_package.pop(package.id, []), facts)
        packages.append({
            "id": package.id,
            "sequence": index,
            "package_no": package.package_no,
            "package_type": package.package_type,
            "weight_kg": package.weight_kg,
            "volume_cbm": _volume_cbm(package),
            "dimensions_cm": ([package.length_cm, package.width_cm, package.height_cm]
                              if _volume_cbm(package) is not None else None),
            "is_fragile": bool(package.is_fragile),
            "is_temp_controlled": bool(package.is_temp_controlled),
            "lines": lines,
            "total_qty": sum((line["quantity"] for line in lines), ZERO),
            "total_amount": sum((line["amount"] for line in lines), ZERO),
        })
    # Lines no package names (a consignment packed before packages were recorded)
    # still print, under their own heading, rather than vanish from the paper.
    loose = [row for rows in by_package.values() for row in rows]
    if loose:
        lines = _summarise_lines(loose, facts)
        packages.append({
            "id": None, "sequence": len(packages) + 1, "package_no": None,
            "package_type": "LOOSE", "weight_kg": None, "volume_cbm": None,
            "dimensions_cm": None, "is_fragile": False, "is_temp_controlled": False,
            "lines": lines,
            "total_qty": sum((line["quantity"] for line in lines), ZERO),
            "total_amount": sum((line["amount"] for line in lines), ZERO),
        })

    volumes = [p["volume_cbm"] for p in packages if p["volume_cbm"] is not None]
    weighed = [_d(p["weight_kg"]) for p in packages if p["weight_kg"] is not None]
    weight = _d(dispatch.total_weight_kg) or sum(weighed, ZERO)
    return {
        "dispatch_id": dispatch.id,
        "consignment_no": dispatch.dispatch_no,
        "consignment_date": dispatch.dispatch_date,
        "status": dispatch.status,
        "source": await _godown(db, dispatch.warehouse_id),
        "destination": {
            "id": dispatch.to_warehouse_id,
            "name": (getattr(to_wh, "name", None) or dispatch.to_warehouse_name
                     or getattr(dispatch, "destination_office_name", None)
                     or dispatch.customer_name or dispatch.vendor_name),
            "code": getattr(to_wh, "code", None),
            "address": to_address,
            "contact_person": dispatch.contact_person,
            "contact_phone": dispatch.contact_phone,
        },
        "project_name": dispatch.project_name,
        "expected_delivery_from": dispatch.expected_delivery_from,
        "expected_delivery": dispatch.expected_delivery,
        "package_count": dispatch.total_packages or len(dispatch.packages),
        "weight_kg": weight if weight > 0 else None,
        # Only a volume every package was measured for is a volume; a part-sum would
        # print a smaller load than the truck is carrying.
        "volume_cbm": (sum(volumes, ZERO) if volumes and len(volumes) == len(
            [p for p in packages if p["id"] is not None]) else None),
        "packages": packages,
        "total_qty": sum((p["total_qty"] for p in packages), ZERO),
        "total_amount": sum((p["total_amount"] for p in packages), ZERO),
    }


async def delivery_challan(db: AsyncSession, tr_id: int) -> dict:
    """The whole challan for one dispatch (shipment)."""
    tr = await db.get(TransportRequest, tr_id)
    if tr is None:
        raise NotFoundError(f"Shipment {tr_id} not found")

    dispatches = []
    for dispatch_id in await _dispatch_ids(db, tr):
        try:
            dispatches.append(await svc.get_dispatch(db, dispatch_id))
        except NotFoundError:
            continue
    item_ids = {row.item_id for d in dispatches for row in d.items}
    facts = await _item_facts(db, item_ids)
    blocks = [await _consignment_block(db, d, facts) for d in dispatches]
    # What the challan PRINTS (2026-11-20): one table for the whole load, the same item
    # and batch at the same price added up across every consignment and package, and
    # NO codes — no asset, consumable, serial or IMEI, no box or package numbers. The
    # per-consignment blocks above stay in the payload for any reader that wants them.
    every_row = sorted((row for d in dispatches for row in d.items),
                       key=lambda r: (r.dispatch_id, r.line_no or 0, r.id))
    lines = _summarise_lines(every_row, facts, with_codes=False)

    # The godown is the dispatch's own source: the shipment's, else the first
    # consignment's. One truck leaves one gate.
    godown = await _godown(db, tr.from_warehouse_id) if tr.from_warehouse_id else (
        blocks[0]["source"] if blocks else await _godown(db, None))
    destinations = OrderedDict()
    for block in blocks:
        name = block["destination"]["name"]
        if name:
            destinations.setdefault(name, block["destination"])
    return {
        "tr_id": tr.id,
        "tr_no": tr.tr_no,
        # The challan's number is the DISPATCH number — the gate pass. None until the
        # dispatch press issues it.
        "dc_no": (tr.gate_pass_no or "").strip() or None,
        "dc_date": (tr.dispatched_at.date() if tr.dispatched_at else tr.tr_date),
        "status": tr.status,
        "mode": tr.mode,
        "carriage_mode": getattr(tr, "carriage_mode", None),
        "is_trip": (tr.source_type or "").upper() == _TRIP,
        "trip_no": tr.source_no if (tr.source_type or "").upper() == _TRIP else None,
        "godown": godown,
        "ship_to": list(destinations.values()),
        "vehicle_number": tr.vehicle_number,
        "driver_name": tr.driver_name,
        "driver_phone": tr.driver_phone,
        "carrier_name": tr.carrier_name,
        "lr_no": tr.lr_no,
        "docket_no": tr.docket_no,
        "eway_bill_no": tr.eway_bill_no,
        "expected_delivery_from": tr.expected_delivery_from,
        "expected_delivery": tr.expected_delivery,
        # The day the load left; before it has, the planned dispatch date.
        "dispatch_date": (tr.dispatched_at.date() if tr.dispatched_at
                          else tr.expected_delivery_from),
        "vehicle_type_name": getattr(tr, "vehicle_type_name", None),
        "destination_sac": getattr(tr, "destination_sac", None),
        "project_name": tr.project_name,
        "remarks": tr.remarks,
        "consignments": blocks,
        "lines": lines,
        "totals": {
            "consignments": len(blocks),
            "packages": sum(b["package_count"] or 0 for b in blocks),
            "quantity": sum((b["total_qty"] for b in blocks), ZERO),
            "amount": sum((b["total_amount"] for b in blocks), ZERO),
            "weight_kg": (sum((_d(b["weight_kg"]) for b in blocks), ZERO)
                          if any(b["weight_kg"] for b in blocks) else None),
            "volume_cbm": (sum((_d(b["volume_cbm"]) for b in blocks), ZERO)
                           if blocks and all(b["volume_cbm"] is not None for b in blocks)
                           else None),
        },
    }
