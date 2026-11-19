"""An own-vehicle load: what kind of vehicle, who travels with it, and its odometer
(2026-11-20).

Three facts a company vehicle carries that a courier or a hired truck does not:

- **Vehicle type** — picked from Logistics › Masters › Vehicle Types
  (`mst_vehicle_types`), the name snapshotted on the shipment (rule 10).
- **Crew** — the desk says HOW MANY people go, then names each of them; the count
  and the names must agree, everyone has a name and a 10-digit phone, and exactly
  one of them drives. `lgs_shipment_crew`, rewritten whole on each save while the
  load has not left. The driver is copied onto `driver_name` / `driver_phone`, which
  the gate pass and the mode's required fields already read.
- **Odometer** — a START reading before the vehicle leaves and an END reading when it
  is done, each with a photo of the dial. END can never be below START. The photos are
  shipment attachments (`ODOMETER_START` / `ODOMETER_END`), so no table learns about
  files. Distance is END − START, derived on the way out.

The gates: releasing an own-vehicle load ("it has left") needs the vehicle type, the
crew and the START reading; the desk marking it delivered needs the END reading. Both
say exactly what is missing.
"""
from __future__ import annotations

import re
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.modules.logistics.enums import (
    CrewRole, OdometerReading, TransportMode, TransportStatus,
)
from app.modules.logistics.models import ShipmentCrew, TransportRequest
from app.platform.settings import attachments
from app.shared.models.base import utcnow
from app.shared.models.master import VehicleType

DOC_ENTITY_TYPE = "TRANSPORT_REQUEST"
ODOMETER_CATEGORY = {OdometerReading.START.value: "ODOMETER_START",
                     OdometerReading.END.value: "ODOMETER_END"}
ODOMETER_CATEGORIES = tuple(ODOMETER_CATEGORY.values())
MAX_CREW = 20
PHONE = re.compile(r"^[6-9]\d{9}$")

# Before the vehicle leaves, the crew and the vehicle may still change.
_NOT_LEFT = {TransportStatus.DRAFT.value, TransportStatus.PENDING_APPROVAL.value,
             TransportStatus.QUOTING.value, TransportStatus.AWAITING_CARRIER.value,
             TransportStatus.READY.value}


def is_own_vehicle(doc: TransportRequest) -> bool:
    return (doc.mode or "").upper() == TransportMode.OWN_VEHICLE.value


def crew_problems(count: int | None, crew: list) -> list[str]:
    """Everything wrong with a crew, as sentences — pure, so it is tested without a
    database and the screen can be held to the same words."""
    problems: list[str] = []
    if count is None or count < 1:
        return ["Enter how many people are going with the vehicle (at least 1, the driver)."]
    if count > MAX_CREW:
        return [f"At most {MAX_CREW} people can travel on one vehicle."]
    if len(crew) != count:
        problems.append(
            f"You said {count} {'person is' if count == 1 else 'people are'} going but "
            f"{len(crew)} {'is' if len(crew) == 1 else 'are'} filled in.")
    drivers = 0
    phones: set[str] = set()
    for index, person in enumerate(crew, start=1):
        label = f"Person {index}"
        name = (getattr(person, "name", None) or "").strip()
        phone = re.sub(r"\D", "", getattr(person, "phone", None) or "")
        if not name:
            problems.append(f"{label}: enter the name.")
        if not PHONE.match(phone):
            problems.append(f"{label}: enter a 10-digit mobile number.")
        elif phone in phones:
            problems.append(f"{label}: {phone} is already given for someone else.")
        phones.add(phone)
        if (getattr(person, "role", None) or "").upper() == CrewRole.DRIVER.value:
            drivers += 1
    if crew and drivers == 0:
        problems.append("Mark one person as the driver.")
    elif drivers > 1:
        problems.append("Only one person can be the driver.")
    return problems


async def apply_vehicle_type(db: AsyncSession, doc: TransportRequest,
                             vehicle_type_id: int | None) -> None:
    if not vehicle_type_id:
        doc.vehicle_type_id = None
        doc.vehicle_type_name = None
        return
    row = await db.get(VehicleType, vehicle_type_id)
    if row is None or not row.is_active:
        raise ValidationError(
            "That vehicle type is not in Logistics › Masters › Vehicle Types, or has "
            "been switched off. Pick another.")
    doc.vehicle_type_id = row.id
    doc.vehicle_type_name = row.name


def apply_crew(doc: TransportRequest, count: int | None, crew: list) -> None:
    """Replace the crew with what was sent, after checking it."""
    if doc.status not in _NOT_LEFT:
        raise ValidationError(f"{doc.tr_no} has left — its crew can no longer be changed.")
    problems = crew_problems(count, crew)
    if problems:
        raise ValidationError(" ".join(problems))
    doc.crew_count = count
    doc.crew.clear()
    for index, person in enumerate(crew, start=1):
        role = (person.role or CrewRole.HELPER.value).upper()
        doc.crew.append(ShipmentCrew(
            sequence=index, role=role, name=person.name.strip(),
            phone=re.sub(r"\D", "", person.phone),
            id_number=(person.id_number or "").strip() or None,
            employee_id=person.employee_id,
        ))
        if role == CrewRole.DRIVER.value:
            # The gate pass and the mode's required fields read these two.
            doc.driver_name = person.name.strip()
            doc.driver_phone = re.sub(r"\D", "", person.phone)


async def apply_arrangement(db: AsyncSession, doc: TransportRequest, data) -> None:
    """What a dispatch / edit carries for an own vehicle. Only on that mode; on any
    other the three facts are cleared, so a leg switched to courier carries no crew."""
    fields = getattr(data, "model_fields_set", set())
    if not is_own_vehicle(doc):
        if doc.crew or doc.vehicle_type_id or doc.crew_count:
            doc.crew.clear()
            doc.crew_count = None
            doc.vehicle_type_id = doc.vehicle_type_name = None
        return
    if "vehicle_type_id" in fields:
        await apply_vehicle_type(db, doc, data.vehicle_type_id)
    if "crew" in fields or "crew_count" in fields:
        apply_crew(doc, data.crew_count, list(data.crew or []))


async def _photos(db: AsyncSession, tr_id: int) -> dict[str, list]:
    rows = await attachments.list_attachments(db, DOC_ENTITY_TYPE, tr_id)
    out: dict[str, list] = {category: [] for category in ODOMETER_CATEGORIES}
    for row in rows:
        if row.doc_category in out:
            out[row.doc_category].append(row)
    return out


def release_problems(doc: TransportRequest, has_start_photo: bool) -> list[str]:
    if not is_own_vehicle(doc):
        return []
    problems: list[str] = []
    if not doc.vehicle_type_id:
        problems.append("pick the vehicle type")
    if not doc.crew_count or len(doc.crew) != doc.crew_count:
        problems.append("add everyone travelling with the vehicle")
    if doc.odometer_start is None:
        problems.append("record the odometer start reading")
    elif not has_start_photo:
        problems.append("attach the photo of the odometer start reading")
    return problems


async def assert_can_release(db: AsyncSession, doc: TransportRequest) -> None:
    if not is_own_vehicle(doc):
        return
    photos = await _photos(db, doc.id)
    problems = release_problems(doc, bool(photos["ODOMETER_START"]))
    if problems:
        raise ValidationError(
            f"Before {doc.tr_no} leaves in your own vehicle, " + ", ".join(problems) + ".")


async def assert_can_deliver(db: AsyncSession, doc: TransportRequest) -> None:
    if not is_own_vehicle(doc):
        return
    if doc.odometer_end is None:
        raise ValidationError(
            f"Record the odometer end reading (with its photo) before marking "
            f"{doc.tr_no} delivered.")
    photos = await _photos(db, doc.id)
    if not photos["ODOMETER_END"]:
        raise ValidationError(
            f"Attach the photo of the odometer end reading before marking {doc.tr_no} delivered.")


async def record_odometer(db: AsyncSession, doc: TransportRequest, reading: str,
                          value: Decimal, upload, user) -> None:
    """One odometer reading, with its photo. A photo already filed for that reading
    may stand in for a new one when only the figure is being corrected."""
    reading = (reading or "").upper()
    if reading not in ODOMETER_CATEGORY:
        raise ValidationError("An odometer reading is either START or END.")
    if not is_own_vehicle(doc):
        raise ValidationError("Odometer readings are recorded for an own-vehicle dispatch only.")
    if value is None or value < 0:
        raise ValidationError("Enter the odometer reading in km (0 or more).")
    if reading == OdometerReading.START.value:
        if doc.status not in _NOT_LEFT:
            raise ValidationError(
                f"{doc.tr_no} has already left — the start reading can no longer change.")
        if doc.odometer_end is not None and value > doc.odometer_end:
            raise ValidationError(
                f"The start reading cannot be more than the end reading ({doc.odometer_end} km).")
    else:
        if doc.status in _NOT_LEFT:
            raise ValidationError(
                f"{doc.tr_no} has not left yet — record the end reading once the trip is done.")
        if doc.odometer_start is None:
            raise ValidationError("Record the start reading first.")
        if value < doc.odometer_start:
            raise ValidationError(
                f"The end reading ({value} km) cannot be less than the start reading "
                f"({doc.odometer_start} km).")
    category = ODOMETER_CATEGORY[reading]
    if upload is not None:
        await attachments.add_attachment(
            db, entity_type=DOC_ENTITY_TYPE, entity_id=doc.id, upload=upload,
            doc_category=category, user=user)
    elif not (await _photos(db, doc.id))[category]:
        raise ValidationError(
            f"Attach a photo of the odometer showing the {reading.lower()} reading.")
    who = getattr(user, "full_name", None)
    if reading == OdometerReading.START.value:
        doc.odometer_start, doc.odometer_start_at, doc.odometer_start_by_name = value, utcnow(), who
    else:
        doc.odometer_end, doc.odometer_end_at, doc.odometer_end_by_name = value, utcnow(), who


async def odometer_photos(db: AsyncSession, tr_id: int) -> dict[str, list[dict]]:
    """The photos per reading, newest first, for the shipment page."""
    photos = await _photos(db, tr_id)
    return {category: [{"id": row.id, "file_name": row.file_name,
                        "uploaded_at": getattr(row, "uploaded_at", None)
                        or getattr(row, "created_at", None)}
                       for row in sorted(rows, key=lambda r: r.id, reverse=True)]
            for category, rows in photos.items()}


def distance_km(doc: TransportRequest) -> float | None:
    if doc.odometer_start is None or doc.odometer_end is None:
        return None
    return float(doc.odometer_end - doc.odometer_start)


async def active_vehicle_types(db: AsyncSession) -> list[dict]:
    rows = (await db.execute(
        select(VehicleType).where(VehicleType.is_active.is_(True)).order_by(VehicleType.name)
    )).scalars().all()
    return [{"id": r.id, "code": r.code, "name": r.name,
             "capacity_kg": float(r.capacity_kg) if r.capacity_kg is not None else None,
             "capacity_cbm": float(r.capacity_cbm) if r.capacity_cbm is not None else None}
            for r in rows]
