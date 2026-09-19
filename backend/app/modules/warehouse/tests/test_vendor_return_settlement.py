"""How a supplier settles a purchase return: money, goods, or refusal.

No database. Everything here is either a Pydantic validator or a pure wording function,
and both sit on the only path a supplier has to answer a return — so they are worth
pinning without a MySQL, exactly as `test_tracking_types` is.

THE RULE THESE GUARD: **a kept consignment always says what we get back for it.**
`ACCEPTED` used to mean "the supplier keeps the goods" and said nothing about whether
money or replacement goods were owed, so a return could sit settled with nobody owing
anything and the buyer found out by telephone. `REFUNDED` and `REPLACED` split that in
two, and the amount belongs to exactly one of them. If somebody ever relaxes the pairing
— an amount on a REPLACED answer, or a REFUNDED answer with no amount — the two
`test_an_amount_belongs_...` cases fail, which is the point of them.
"""
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.modules.warehouse import service, schemas as s
from app.modules.warehouse.enums import (
    VENDOR_RETURN_INBOUND_RESPONSES, VENDOR_RETURN_REFUND_RESPONSES,
    VendorReturnResponse,
)
from app.shared.time import today as ist_today

TOMORROW = ist_today() + timedelta(days=1)
YESTERDAY = ist_today() - timedelta(days=1)


def answer(response: str, **kw):
    return s.VendorReturnResponseIn(response=response, **kw)


def replacement(**kw):
    """A valid REPLACED answer on the DELIVERY leg — note, mode and arrival date."""
    kw.setdefault("remarks", "sending working ones")
    kw.setdefault("replacement_mode", "SUPPLIER_DELIVERS")
    kw.setdefault("replacement_expected_date", TOMORROW)
    return answer(VendorReturnResponse.REPLACED.value, **kw)


def collection(**kw):
    """A valid REPLACED answer on the COLLECTION leg — note, mode, address, ready date."""
    kw.setdefault("remarks", "ready on our dock, please collect")
    kw.setdefault("replacement_mode", "WE_COLLECT")
    kw.setdefault("replacement_pickup_address", "Plot 14, Phase II, Jeedimetla")
    kw.setdefault("replacement_ready_date", TOMORROW)
    return answer(VendorReturnResponse.REPLACED.value, **kw)


# --- what each outcome PRODUCES -------------------------------------------------------

def test_a_refund_raises_no_inbound_receipt():
    # The load-bearing half of the feature: a refund is money, and an expected delivery
    # raised for it would leave the store waiting on a lorry that is never coming.
    assert VendorReturnResponse.REFUNDED.value not in VENDOR_RETURN_INBOUND_RESPONSES


def test_the_answers_that_send_goods_back_still_raise_one():
    assert VendorReturnResponse.RETURNED.value in VENDOR_RETURN_INBOUND_RESPONSES
    assert VendorReturnResponse.REPLACED.value in VENDOR_RETURN_INBOUND_RESPONSES


def test_an_outcome_is_never_both_money_and_goods():
    # An outcome that both credits us and sends a lorry would be counted twice.
    assert not (VENDOR_RETURN_REFUND_RESPONSES & set(VENDOR_RETURN_INBOUND_RESPONSES))


def test_every_answer_can_be_worded_for_the_supplier():
    # `VENDOR_RETURN_RESPONSES` is the ONLY place an answer becomes a sentence, so a
    # value missing from it drops out of every screen at once. Legacy ACCEPTED included:
    # rows carry it and those rows must still read.
    worded = dict(s.VENDOR_RETURN_RESPONSES)
    for value in VendorReturnResponse:
        assert worded.get(value.value), f"{value.value} has no supplier-facing wording"


# --- the amount belongs to a refund, and only to a refund -----------------------------

def test_a_refund_carries_its_amount():
    body = answer(VendorReturnResponse.REFUNDED.value, refund_amount=Decimal("480.00"))
    assert body.refund_amount == Decimal("480.00")


def test_an_amount_is_required_on_a_refund():
    with pytest.raises(ValidationError):
        answer(VendorReturnResponse.REFUNDED.value)


def test_an_amount_belongs_to_a_refund_and_not_to_a_replacement():
    with pytest.raises(ValidationError):
        answer(VendorReturnResponse.REPLACED.value, remarks="sending new ones",
               refund_amount=Decimal("480.00"))


def test_an_amount_belongs_to_a_refund_and_not_to_a_refusal():
    with pytest.raises(ValidationError):
        answer(VendorReturnResponse.RETURNED.value, remarks="not ours",
               refund_amount=Decimal("480.00"))


def test_a_refund_of_nothing_is_not_a_refund():
    # 0.00 would render on screen as a paid credit of nothing. A supplier settling for
    # nothing is a replacement or a conversation with the buyer.
    with pytest.raises(ValidationError):
        answer(VendorReturnResponse.REFUNDED.value, refund_amount=Decimal("0"))


def test_a_negative_refund_is_refused():
    with pytest.raises(ValidationError):
        answer(VendorReturnResponse.REFUNDED.value, refund_amount=Decimal("-10"))


def test_a_refund_needs_no_note_but_a_returned_consignment_does():
    # Unchanged by this work, and re-pinned because the note rule and the amount rule now
    # sit in two validators on the same model: nothing travels on a refund, so there is
    # no store waiting to be told why.
    answer(VendorReturnResponse.REFUNDED.value, refund_amount=Decimal("1"))
    with pytest.raises(ValidationError):
        answer(VendorReturnResponse.RETURNED.value)


# --- the sentence the refund is read through ------------------------------------------

def row(*, refund, total):
    return SimpleNamespace(vendor_refund_amount=refund, total_value=total)


def test_a_full_credit_says_so():
    label = service._vendor_refund_label(row(refund=Decimal("520"), total=Decimal("520")))
    assert label == "the full value of the return"


def test_a_short_credit_states_the_shortfall():
    # The comparison is the whole point: a buyer must not have to subtract two numbers by
    # eye to find out a return was settled short.
    label = service._vendor_refund_label(row(refund=Decimal("480"), total=Decimal("520")))
    assert "40.00" in label
    assert "less than the full value" in label


def test_no_amount_means_no_sentence():
    # A REPLACED or RETURNED answer settles in goods, and a legacy ACCEPTED row never
    # captured a figure — none of them may render an empty refund strip.
    assert service._vendor_refund_label(row(refund=None, total=Decimal("520"))) is None


# --- how the replacement travels ------------------------------------------------------
#
# These guard the OTHER half of the same rule: a replacement that does not say when it
# arrives leaves the store knowing what to expect and not when, which is a storekeeper
# meeting a lorry at the gate with no paperwork. The date is written onto the draft
# inbound receipt, and it is the only thing telling the warehouse a vehicle is coming.

def test_a_replacement_must_say_when_it_arrives():
    with pytest.raises(ValidationError):
        answer(VendorReturnResponse.REPLACED.value, remarks="sending working ones")


def test_a_replacement_arriving_in_the_past_is_refused():
    # Always a typo, and a date behind today sorts to the top of the receiving queue and
    # reads as already overdue on the day it is entered.
    with pytest.raises(ValidationError):
        replacement(replacement_expected_date=YESTERDAY)


def test_a_replacement_needs_only_the_date():
    # The carrier is frequently not booked when the promise is made. Refusing the answer
    # for want of a vehicle number would push the supplier back to the telephone.
    body = replacement()
    assert body.replacement_expected_date == TOMORROW
    assert body.replacement_transporter_name is None
    assert body.replacement_vehicle_no is None
    assert body.replacement_lr_no is None


def test_a_replacement_carries_the_carrier_when_it_is_known():
    body = replacement(replacement_transporter_name="VRL Logistics",
                       replacement_vehicle_no="TS09AB1234",
                       replacement_lr_no="884512")
    assert body.replacement_transporter_name == "VRL Logistics"
    assert body.replacement_vehicle_no == "TS09AB1234"
    assert body.replacement_lr_no == "884512"


@pytest.mark.parametrize("field", [
    "replacement_expected_date", "replacement_transporter_name",
    "replacement_vehicle_no", "replacement_lr_no",
])
def test_shipment_details_are_refused_on_a_refund(field):
    # A vehicle stored against a refund would show on the store's receiving screen as an
    # expected delivery that is never coming.
    value = TOMORROW if field == "replacement_expected_date" else "X"
    with pytest.raises(ValidationError):
        answer(VendorReturnResponse.REFUNDED.value, refund_amount=Decimal("1"),
               **{field: value})


def test_shipment_details_are_refused_on_a_refusal():
    # Those are the goods WE despatched on the leg WE booked; `out_dispatches` holds that
    # lorry, and the supplier's guess must not overwrite what we know.
    with pytest.raises(ValidationError):
        answer(VendorReturnResponse.RETURNED.value, remarks="not ours",
               replacement_expected_date=TOMORROW)


# --- who moves it: delivered to us, or collected by us --------------------------------
#
# The axis that was missing. A supplier frequently does NOT send the replacement — it is
# ready on their dock and they ask us to fetch it. Recorded as a delivery, that is a
# storekeeper waiting at a gate nobody is driving to. These pin the two legs apart, and
# in particular pin that NEITHER leg accepts the other's fields: the whole point is that
# the store can tell "wait for it" from "go and get it" without reading a remark.

def test_a_replacement_must_say_who_is_moving_it():
    with pytest.raises(ValidationError):
        answer(VendorReturnResponse.REPLACED.value, remarks="sending working ones",
               replacement_expected_date=TOMORROW)


def test_an_unknown_mode_is_refused():
    with pytest.raises(ValidationError):
        replacement(replacement_mode="BY_DRONE")


def test_the_mode_is_normalised_to_upper_case():
    # Posted by hand or by an older client, the value still has to match the catalogue
    # the store's screen branches on.
    assert replacement(replacement_mode="supplier_delivers").replacement_mode \
        == "SUPPLIER_DELIVERS"


def test_a_mode_belongs_only_to_a_replacement():
    with pytest.raises(ValidationError):
        answer(VendorReturnResponse.REFUNDED.value, refund_amount=Decimal("1"),
               replacement_mode="WE_COLLECT")


def test_a_collection_carries_its_address_and_ready_date():
    body = collection()
    assert body.replacement_mode == "WE_COLLECT"
    assert body.replacement_ready_date == TOMORROW
    assert body.replacement_pickup_address == "Plot 14, Phase II, Jeedimetla"
    # And promises NO arrival: nothing is due at our gate until a vehicle is scheduled.
    assert body.replacement_expected_date is None


def test_a_collection_needs_an_address():
    # "Come and collect it" with no address is not an instruction anybody can act on.
    with pytest.raises(ValidationError):
        collection(replacement_pickup_address="   ")


def test_a_collection_needs_a_ready_date():
    with pytest.raises(ValidationError):
        collection(replacement_ready_date=None)


def test_a_collection_ready_in_the_past_is_refused():
    with pytest.raises(ValidationError):
        collection(replacement_ready_date=YESTERDAY)


def test_a_collection_may_not_promise_an_arrival():
    # The supplier cannot promise when goods they are not moving reach us, and the
    # receiving queue would wait at the gate for the date if it were stored.
    with pytest.raises(ValidationError):
        collection(replacement_expected_date=TOMORROW)


def test_a_collection_may_not_name_a_carrier():
    # The vehicle is ours to assign, and not theirs to declare.
    with pytest.raises(ValidationError):
        collection(replacement_vehicle_no="TS09AB1234")


def test_a_delivery_may_not_carry_pickup_details():
    # It would send a vehicle to fetch something already on its way here.
    with pytest.raises(ValidationError):
        replacement(replacement_pickup_address="Plot 14")


def test_a_delivery_may_not_carry_a_ready_date():
    with pytest.raises(ValidationError):
        replacement(replacement_ready_date=TOMORROW)


# --- the sentence each leg is read through --------------------------------------------

def leg_row(**kw):
    kw.setdefault("expected_delivery", None)
    kw.setdefault("transporter_name", None)
    kw.setdefault("vehicle_no", None)
    kw.setdefault("lr_no", None)
    kw.setdefault("goods_ready_date", None)
    kw.setdefault("pickup_address", None)
    return SimpleNamespace(**kw)


def test_a_collection_reads_as_a_collection():
    # The assurance a supplier asking us to collect actually wants is that we took the
    # job on — so the sentence has to lead with that, not with a date.
    receipt = leg_row(inbound_transport_mode="WE_COLLECT",
                      goods_ready_date=TOMORROW,
                      pickup_address="Plot 14, Jeedimetla")
    row = SimpleNamespace(vendor_response=VendorReturnResponse.REPLACED.value,
                          vendor_followup_receipt_id=1,
                          # The receipt exists, so the collection columns are not the
                          # ones read — but a real row always carries them.
                          collection_tr_id=None, collection_tr_no=None,
                          collection_pickup_address=None, collection_ready_date=None)
    label = _label_for(receipt, row)
    assert label.startswith("we will collect")
    assert "Plot 14, Jeedimetla" in label


def test_a_delivery_reads_as_an_arrival():
    receipt = leg_row(inbound_transport_mode="SUPPLIER_DELIVERS",
                      expected_delivery=TOMORROW,
                      transporter_name="VRL Logistics")
    row = SimpleNamespace(vendor_response=VendorReturnResponse.REPLACED.value,
                          vendor_followup_receipt_id=1,
                          # The receipt exists, so the collection columns are not the
                          # ones read — but a real row always carries them.
                          collection_tr_id=None, collection_tr_no=None,
                          collection_pickup_address=None, collection_ready_date=None)
    label = _label_for(receipt, row)
    assert label.startswith("expected ")
    assert "VRL Logistics" in label


def test_a_collection_still_reads_before_its_receipt_exists():
    """The stretch when somebody is actually chasing the collection.

    A collection raises no receipt when the supplier answers — the trip goes to the
    logistics desk and the receipt follows when our vehicle gets back. Reading the
    wording only off the receipt left the screen blank for exactly that stretch, which
    is the one period anybody needs it.
    """
    row = SimpleNamespace(vendor_response=VendorReturnResponse.REPLACED.value,
                          vendor_followup_receipt_id=None,
                          collection_tr_id=77, collection_tr_no="TR/2026-27/00044",
                          collection_pickup_address="Plot 14, Jeedimetla",
                          collection_ready_date=TOMORROW)
    label = _label_for(None, row)
    assert label.startswith("we will collect")
    assert "Plot 14, Jeedimetla" in label
    # The leg is named, because "which shipment is fetching it" is the next question.
    assert "TR/2026-27/00044" in label


def _label_for(receipt, row):
    """Run just the wording half of `_apply_vendor_replacement_leg`, with no database.

    The function reads the receipt by id, which needs a session; the branch worth pinning
    is the wording, so the receipt is handed in directly.
    """
    import asyncio

    class _Db:
        async def get(self, _model, _pk):
            return receipt

    asyncio.run(service._apply_vendor_replacement_leg(_Db(), row))
    return row.replacement_label
