"""The mode rules — the table that decides what a transport request must carry.

No database: `MODE_RULES` is data, and the whole point of holding it as data is that
the service, the API and the form all read the same copy. These tests pin the contract
the frontend relies on, so a rule cannot change shape without a failure here.
"""
import pytest

from app.modules.logistics import transport
from app.modules.logistics.enums import (
    EXCEPTION_EVENT_TYPES, MODE_RULES, QuoteStatus, ShipmentEventType,
    TERMINAL_STATUSES, TransportMode, TransportStatus, mode_rule,
)
from app.modules.logistics.models import TransportRequest


def test_every_mode_has_a_rule():
    assert set(MODE_RULES) == {m.value for m in TransportMode}


def test_mode_rule_rejects_an_unknown_mode():
    with pytest.raises(KeyError):
        mode_rule("TELEPORT")


def test_courier_and_third_party_are_tendered():
    """Courier and third-party both collect provider quotes before one is awarded."""
    quoted = {value for value, rule in MODE_RULES.items() if rule.needs_quotes}
    assert quoted == {TransportMode.COURIER.value, TransportMode.THIRD_PARTY.value}


def test_a_tendered_mode_also_needs_a_carrier():
    """You cannot award a shipment to nobody — needs_quotes implies needs_carrier."""
    for value, rule in MODE_RULES.items():
        if rule.needs_quotes:
            assert rule.needs_carrier, value


def test_carrier_modes_require_a_carrier_field_and_others_do_not():
    for value, rule in MODE_RULES.items():
        has_field = "carrier_id" in rule.required_fields
        assert has_field == rule.needs_carrier, value


def test_hand_over_records_both_people_and_hires_nobody():
    rule = mode_rule(TransportMode.DIRECT.value)
    assert not rule.needs_carrier and not rule.needs_quotes
    assert set(rule.required_fields) == {"handed_over_by_name"}


def test_own_vehicle_records_the_vehicle_and_hires_nobody():
    rule = mode_rule(TransportMode.OWN_VEHICLE.value)
    assert not rule.needs_carrier and not rule.needs_quotes
    assert set(rule.required_fields) == {"vehicle_number", "driver_name"}


def test_mode_catalogue_serves_every_rule_field_the_form_reads():
    rows = transport.mode_catalogue()
    assert {row["value"] for row in rows} == set(MODE_RULES)
    for row in rows:
        assert set(row) == {"value", "label", "help", "needs_carrier",
                            "needs_quotes", "required_fields"}
        assert isinstance(row["required_fields"], list)
        assert row["label"] and row["help"]


def test_exception_events_are_the_three_that_open_a_claim():
    assert EXCEPTION_EVENT_TYPES == {
        ShipmentEventType.DAMAGED.value,
        ShipmentEventType.MISSING.value,
        ShipmentEventType.DELAYED.value,
    }
    # A progress scan must never open a claim.
    assert ShipmentEventType.DELIVERED.value not in EXCEPTION_EVENT_TYPES
    assert ShipmentEventType.IN_TRANSIT.value not in EXCEPTION_EVENT_TYPES


def test_terminal_statuses_cannot_be_reopened():
    assert TERMINAL_STATUSES == {
        TransportStatus.CLOSED.value,
        TransportStatus.REJECTED.value,
        TransportStatus.CANCELLED.value,
    }
    # In-transit is emphatically not terminal — events still arrive against it.
    assert TransportStatus.IN_TRANSIT.value not in TERMINAL_STATUSES


@pytest.mark.parametrize("mode,expected", [
    (TransportMode.THIRD_PARTY.value, TransportStatus.QUOTING.value),
    (TransportMode.COURIER.value, TransportStatus.QUOTING.value),
    (TransportMode.OWN_VEHICLE.value, TransportStatus.READY.value),
    (TransportMode.DIRECT.value, TransportStatus.READY.value),
])
def test_approval_sends_a_quoted_mode_to_tender_and_the_rest_to_ready(mode, expected):
    """A hand-over must never land in a QUOTING queue nobody works."""
    # A real (unsaved) row, not a bare stub: where the request goes next is read off
    # the invitations and the carrier on it as well as the mode, and a stub with only
    # a mode on it tests a narrower rule than the one the service applies.
    doc = TransportRequest(mode=mode)
    transport._advance_after_approval(doc)
    assert doc.status == expected


def test_a_courier_picked_on_the_register_is_asked_before_it_is_booked():
    """The Shipments form has one provider picker, so an approved courier leg arrives
    here with a carrier and no invitation. That pick is the first invitation — booking
    it outright is a leg on the road at a price nobody agreed."""
    doc = TransportRequest(mode=TransportMode.COURIER.value,
                           carrier_id=7, carrier_name="Amazon")

    transport._advance_after_approval(doc)

    assert doc.status == TransportStatus.QUOTING.value
    assert (doc.carrier_id, doc.carrier_name) == (None, None)
    assert [(q.carrier_id, q.carrier_name, q.status) for q in doc.quotes] == [
        (7, "Amazon", QuoteStatus.INVITED.value)]


def test_a_courier_written_down_at_the_desk_is_never_sent_to_a_portal():
    """A manual courier has no vendor row and no login. Nobody is there to answer."""
    doc = TransportRequest(mode=TransportMode.COURIER.value,
                           carrier_name="Counter Courier")

    transport._advance_after_approval(doc)

    assert doc.status == TransportStatus.READY.value
    assert doc.quotes == []
