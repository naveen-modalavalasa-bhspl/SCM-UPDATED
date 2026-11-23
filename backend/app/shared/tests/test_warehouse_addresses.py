"""A warehouse's shipping addresses (2026-11-23) — the pure save rules."""
from types import SimpleNamespace

import pytest

from app.core.exceptions import ValidationError
from app.shared.masters import warehouse_addresses as wa
from app.shared.models.warehouse import address_text


def test_one_default_and_a_label_for_each():
    rows = wa.plan([{"address": "Plot 224, Kanuru"}, {"label": "Dock 2", "address": "Rear gate"}])
    assert [r["label"] for r in rows] == ["Address 1", "Dock 2"]
    assert [r["is_default"] for r in rows] == [True, False]   # none ticked: the first


def test_what_cannot_be_saved_is_named():
    with pytest.raises(ValidationError, match="give the address itself"):
        wa.plan([{"label": "Gate", "address": "  "}])
    with pytest.raises(ValidationError, match="Only one shipping address can be the default"):
        wa.plan([{"address": "A", "is_default": True}, {"address": "B", "is_default": True}])
    with pytest.raises(ValidationError, match="both called"):
        wa.plan([{"label": "Gate", "address": "A"}, {"label": "gate", "address": "B"}])
    with pytest.raises(ValidationError, match="pincode is 6 digits"):
        wa.plan([{"address": "A", "pincode": "5200"}])


def test_printed_text_reads_like_an_address():
    row = SimpleNamespace(address="Plot 224, Kanuru", city="Vijayawada", pincode="520007",
                          state="Andhra Pradesh", contact_name="Ravi", contact_phone="9876543210")
    assert address_text(row) == ("Plot 224, Kanuru\nVijayawada – 520007, Andhra Pradesh\n"
                                 "Contact: Ravi · 9876543210")
