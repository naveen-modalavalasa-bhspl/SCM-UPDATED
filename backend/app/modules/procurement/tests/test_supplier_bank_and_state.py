"""A supplier's bank details and same-state switch (2026-11-23) — the pure rules."""
from types import SimpleNamespace

from app.modules.procurement import suppliers
from app.modules.procurement.service import vendor_tax_region


def test_bank_details_are_required_and_checked():
    assert suppliers.bank_problems("SBI", "1234 5678 901", "sbin0001234") == []
    problems = " ".join(suppliers.bank_problems("", "12345", "SBIN1001234"))
    assert "bank name" in problems
    assert "9 to 18 digits" in problems
    assert "4 letters, a 0" in problems
    assert suppliers.bank_problems("SBI", "", "") == [
        "Give the supplier's bank account number.", "Give the branch's IFSC code."]
    assert suppliers.mask_account("123456789012") == "••••••••9012"


def test_the_switch_decides_and_an_unset_one_follows_the_gstins():
    ours = "37AAACB1234C1Z5"
    assert vendor_tax_region(SimpleNamespace(is_same_state=True, gstin="29XXX"), ours) == "INTRA"
    assert vendor_tax_region(SimpleNamespace(is_same_state=False, gstin="37XXX"), ours) == "INTER"
    # Never set: the GSTIN rule every older supplier was taxed by.
    assert vendor_tax_region(SimpleNamespace(is_same_state=None, gstin="37ABC"), ours) == "INTRA"
    assert vendor_tax_region(SimpleNamespace(is_same_state=None, gstin=None), ours) == "INTER"
