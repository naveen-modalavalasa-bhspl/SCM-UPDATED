"""Own vehicle: the crew the desk names must agree with the count it gave, and the
odometer may only go forward (2026-11-20). Pure — no database."""
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.core.exceptions import ValidationError
from app.modules.logistics import own_vehicle
from app.modules.logistics.models import TransportRequest


def person(name="Ravi", phone="9493746163", role="HELPER"):
    return SimpleNamespace(name=name, phone=phone, role=role, id_number=None, employee_id=None)


def test_a_full_crew_with_one_driver_passes():
    assert own_vehicle.crew_problems(2, [person(role="DRIVER"), person("Anil", "9876543210")]) == []


def test_the_count_and_the_names_must_agree():
    problems = own_vehicle.crew_problems(3, [person(role="DRIVER")])
    assert any("3 people are going but 1 is filled in" in p for p in problems)


def test_every_person_needs_a_name_and_a_mobile_and_one_driver():
    problems = own_vehicle.crew_problems(2, [person(name=" ", phone="12345"), person(phone="9876543210")])
    assert "Person 1: enter the name." in problems
    assert "Person 1: enter a 10-digit mobile number." in problems
    assert "Mark one person as the driver." in problems


def test_two_drivers_or_a_repeated_phone_are_refused():
    problems = own_vehicle.crew_problems(2, [person(role="DRIVER"), person("Anil", role="DRIVER")])
    assert "Only one person can be the driver." in problems
    assert any("already given" in p for p in problems)


def test_no_count_asks_for_one():
    assert own_vehicle.crew_problems(None, [])[0].startswith("Enter how many people")


def test_release_lists_what_an_own_vehicle_still_needs():
    doc = TransportRequest(mode="OWN_VEHICLE", status="READY", tr_no="TR-1")
    problems = own_vehicle.release_problems(doc, has_start_photo=False)
    assert problems == ["pick the vehicle type", "add everyone travelling with the vehicle",
                        "record the odometer start reading"]
    assert own_vehicle.release_problems(TransportRequest(mode="COURIER"), False) == []


@pytest.mark.asyncio
async def test_the_end_reading_cannot_be_below_the_start():
    doc = TransportRequest(mode="OWN_VEHICLE", status="IN_TRANSIT", tr_no="TR-1",
                           odometer_start=Decimal("1200"))
    with pytest.raises(ValidationError, match="cannot be less than the start"):
        await own_vehicle.record_odometer(None, doc, "END", Decimal("1100"), None, None)


def test_distance_is_end_minus_start():
    doc = TransportRequest(odometer_start=Decimal("1200.5"), odometer_end=Decimal("1310"))
    assert own_vehicle.distance_km(doc) == 109.5
    assert own_vehicle.distance_km(TransportRequest()) is None


@pytest.mark.asyncio
async def test_the_end_reading_is_fixed_once_the_site_has_signed():
    doc = TransportRequest(mode="OWN_VEHICLE", status="ACKNOWLEDGED", tr_no="TR-1",
                           odometer_start=Decimal("1200"), odometer_end=Decimal("1300"))
    with pytest.raises(ValidationError, match="signed for"):
        await own_vehicle.record_odometer(None, doc, "END", Decimal("1350"), None, None)
