"""The mode rules — the table that decides what a transport request must carry.

No database: `MODE_RULES` is data, and the whole point of holding it as data is that
the service, the API and the form all read the same copy. These tests pin the contract
the frontend relies on, so a rule cannot change shape without a failure here.
"""
import pytest

from app.modules.logistics import transport
from app.modules.logistics.enums import (
    EXCEPTION_EVENT_TYPES, MODE_RULES, ShipmentEventType, TERMINAL_STATUSES,
    TransportMode, TransportStatus, mode_rule,
)


def test_every_mode_has_a_rule():
    assert set(MODE_RULES) == {m.value for m in TransportMode}


def test_mode_rule_rejects_an_unknown_mode():
    with pytest.raises(KeyError):
        mode_rule("TELEPORT")


def test_only_third_party_is_tendered():
    """Quoting is what separates a hired truck from every other way of moving goods."""
    quoted = {value for value, rule in MODE_RULES.items() if rule.needs_quotes}
    assert quoted == {TransportMode.THIRD_PARTY.value}


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
    (TransportMode.COURIER.value, TransportStatus.READY.value),
    (TransportMode.OWN_VEHICLE.value, TransportStatus.READY.value),
    (TransportMode.DIRECT.value, TransportStatus.READY.value),
])
def test_approval_sends_a_quoted_mode_to_tender_and_the_rest_to_ready(mode, expected):
    """A hand-over must never land in a QUOTING queue nobody works."""
    class Doc:
        pass

    doc = Doc()
    doc.mode = mode
    transport._advance_after_approval(doc)
    assert doc.status == expected
