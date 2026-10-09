"""Database-backed coverage for the inbound HCM webhook transaction."""
import json
import time
from types import SimpleNamespace

import pytest

from app.core.exceptions import PermissionError_
from app.modules.integrations import store, webhooks
from app.modules.integrations.schemas import WebhookWrite
from app.platform.hcm.models import (
    HcmEmployee, HcmFacility, HcmPosition, HcmPositionAssignment,
    HcmPositionLevel, HcmRole,
)


EVENTS = [
    "employee.updated", "position.updated", "position_assignment.updated",
    "position_level.updated", "role.updated", "facility.updated",
]


async def _registered(db):
    actor = SimpleNamespace(full_name="Integration Admin")
    await webhooks.create_hook(db, WebhookWrite(
        source="hcm", name="HCM", events=EVENTS, handler="hcm_mirror",
        client_code="hcm",          # lower case on purpose: it is upper-cased for us
    ), actor)
    hook = await store.get(db, webhooks.hook_key("hcm"))
    assert hook["client_code"] == "HCM"
    secret = (await webhooks.rotate_secret(db, "hcm", actor))["shared_secret"]
    return secret.encode()


async def _send(db, secret: bytes, sequence: int, event: str, record: dict,
                client_code: str = "HCM"):
    payload = {"event": event, "event_id": f"hcm-{sequence}",
               "sequence": sequence, "data": record}
    body = json.dumps(payload, separators=(",", ":")).encode()
    timestamp = str(int(time.time()))
    signature = webhooks.expected_signature(secret, timestamp, body)
    return await webhooks.receive(
        db, "hcm", body, signature, timestamp, payload, client_code,
    )


@pytest.mark.asyncio
async def test_employee_delivery_is_atomic_and_history_is_scrubbed(db, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "NEW_USER_DEFAULT_PASSWORD", "")
    secret = await _registered(db)
    with pytest.raises(PermissionError_):
        await _send(db, secret, 1, "employee.updated", {
            "id": 17099, "name": "Wrong caller", "status": "Active",
        }, client_code="OTHER")
    result = await _send(db, secret, 1, "employee.updated", {
        "id": 17099, "employee_code": "HR-EMP-17099", "name": "New Joiner",
        "status": "Active", "pan_number": "ABCDE1234F",
        "bank_details": {"account_number": "123456"},
    })

    assert result["ok"] is True
    assert (await db.get(HcmEmployee, 17099)).full_name == "New Joiner"
    receipt = await store.get(db, webhooks.delivery_key("hcm", "hcm-1"))
    assert "ABCDE1234F" not in json.dumps(receipt["payload"])
    assert "bank_details" not in json.dumps(receipt["payload"])
    hook = await store.get(db, webhooks.hook_key("hcm"))
    assert hook["last_sequence"] == 1

    duplicate = await _send(db, secret, 1, "employee.updated", {
        "id": 17099, "name": "Must Not Replace", "status": "Active",
    })
    assert duplicate["duplicate"] is True
    assert (await db.get(HcmEmployee, 17099)).full_name == "New Joiner"


@pytest.mark.asyncio
async def test_position_events_seat_and_release_the_employee(db, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "NEW_USER_DEFAULT_PASSWORD", "")
    secret = await _registered(db)
    await _send(db, secret, 1, "employee.updated", {
        "id": 7, "employee_code": "EMP-7", "name": "Holder", "status": "Active",
    })
    await _send(db, secret, 2, "position.updated", {
        "id": 81, "code": "P-81", "name": "Store Keeper", "status": "Active",
        "assigned_employee": {"id": 7, "name": "Holder"},
    })
    assert (await db.get(HcmPosition, 81)).name == "Store Keeper"
    seat = await db.get(HcmPositionAssignment, 81)
    assert seat.employee_id == 7 and seat.is_active is True

    await _send(db, secret, 3, "position.updated", {
        "id": 81, "code": "P-81", "name": "Store Keeper", "status": "Active",
        "assigned_employee": None,
    })
    await db.refresh(seat)
    assert seat.is_active is False


@pytest.mark.asyncio
async def test_remaining_hcm_catalogue_events_reach_their_models(db, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "NEW_USER_DEFAULT_PASSWORD", "")
    secret = await _registered(db)
    await _send(db, secret, 1, "position_level.updated",
                {"id": 3, "name": "District", "rank": 3})
    await _send(db, secret, 2, "role.updated",
                {"id": 186, "code": "SCM", "name": "SCM Head", "status": "Active"})
    await _send(db, secret, 3, "facility.updated",
                {"id": 44, "name": "Warehouse", "office_id": 9,
                 "facility_type_id": 2, "status": "Active"})
    await _send(db, secret, 4, "position_assignment.updated",
                {"id": 900, "employee_id": 7, "position_id": 81,
                 "status": "Active"})

    assert (await db.get(HcmPositionLevel, 3)).name == "District"
    assert (await db.get(HcmRole, 186)).name == "SCM Head"
    assert (await db.get(HcmFacility, 44)).name == "Warehouse"
    # Assignment rows are keyed by position to share the safe derived-seat path.
    assert (await db.get(HcmPositionAssignment, 81)).employee_id == 7


@pytest.mark.asyncio
async def test_a_reset_reopens_a_stream_a_refused_push_wedged(db, monkeypatch):
    """The gap SCM itself creates is the one the sender cannot close.

    A push SCM refuses never consumes its number, so every later push reads as a gap
    and 409s for good. Nothing the sender does clears that — which is why the reset
    exists, and why it is an admin act rather than the endpoint forgiving itself.
    """
    from app.core.config import settings
    from app.core.exceptions import ConflictError, ValidationError

    monkeypatch.setattr(settings, "NEW_USER_DEFAULT_PASSWORD", "")
    secret = await _registered(db)
    await _send(db, secret, 1, "employee.updated",
                {"id": 21, "name": "First", "status": "Active"})

    # 2 is refused for an event this webhook does not accept, so it is never consumed.
    with pytest.raises(ValidationError):
        await _send(db, secret, 2, "office.updated", {"id": 5, "name": "Office"})
    with pytest.raises(ConflictError):
        await _send(db, secret, 3, "employee.updated",
                    {"id": 22, "name": "Stuck", "status": "Active"})
    assert await db.get(HcmEmployee, 22) is None

    hook = await store.get(db, webhooks.hook_key("hcm"))
    assert hook["last_sequence"] == 1

    reopened = await webhooks.reset_sequence(db, "hcm", SimpleNamespace(
        full_name="Integration Admin"))
    assert reopened["last_sequence"] is None

    # Any number starts the stream again, and the cursor follows it from there.
    await _send(db, secret, 3, "employee.updated",
                {"id": 22, "name": "Unstuck", "status": "Active"})
    assert (await db.get(HcmEmployee, 22)).full_name == "Unstuck"
    hook = await store.get(db, webhooks.hook_key("hcm"))
    assert hook["last_sequence"] == 3
    with pytest.raises(ConflictError):
        await _send(db, secret, 9, "employee.updated",
                    {"id": 23, "name": "Gap again", "status": "Active"})
