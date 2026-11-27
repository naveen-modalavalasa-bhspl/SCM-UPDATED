"""Returns — unit tests that need no database.

The DB-backed suite in this repo drops and recreates ~85 tables per test, so the rules
worth pinning here are the ones that do not need one: the remarks encoding (which is
how a return is told apart from a transfer at all), the status guards, and the shape of
the router. A broken encoding would make every return in the table invisible, which is
the worst failure this module has.
"""
import asyncio
from types import SimpleNamespace

import pytest
from decimal import Decimal
from fastapi import FastAPI

from app.core.exceptions import ValidationError
from app.modules.returns import router as returns_router
from app.modules.returns import service
from app.modules.returns.enums import (
    AWAITING_ACK, CHAPTER_BY_DOC_TYPE, CLOSED, EDITABLE, HOLDING_STOCK, PHASES,
    PHASES_APPROVAL_FIRST,
    PURCHASE_RETURN_SOURCE_LABELS, REASON_LABELS, SELECTABLE_REASONS, TRAIL_CHAPTERS,
    TRAIL_LABELS,
    TRAIL_ORDER, ReturnDocType, ReturnReason, ReturnStatus, TrailDocType,
)
from app.modules.returns.schemas import DecisionIn, ReturnLineIn, ReturnWrite


def _doc(**payload):
    """A stand-in `inv_sto` row carrying a marker payload. No database needed: every
    function under test reads the payload off `remarks` and nothing else."""
    import json

    return SimpleNamespace(
        id=payload.pop("id", 7),
        sto_no=payload.pop("sto_no", "RET-0007"),
        remarks=service.MARKER + json.dumps(payload),
    )


class TestStageOrder:
    """The order — the approval ladder first, then the decision desk, then the sign-off,
    then logistics. FIX 2026-09-07: this is now the order for EVERY return; `PHASES` is
    kept only to draw the tracker for rows raised under the 2026-09-05 order."""

    def test_the_ladder_runs_before_the_desk_and_logistics_after_both(self):
        # Reading the constants rather than the flow because the flow needs a database;
        # what this pins is the sequence every queue, guard and tracker keys off.
        keys = [key for key, _label in PHASES_APPROVAL_FIRST]
        assert keys.index("approvals") < keys.index("decision")
        assert keys.index("decision") < keys.index("endorsement")
        assert keys.index("endorsement") < keys.index("logistics")
        assert service.PHASE_DECISION == "DECISION"

    def test_the_old_order_is_still_drawable_for_rows_in_flight(self):
        # A return submitted before 2026-09-07 went to the desk first and its reporting
        # line last. Those rows keep travelling that way, so the tracker has to keep
        # being able to draw it.
        keys = [key for key, _label in PHASES]
        assert keys.index("decision") < keys.index("approvals")

    def test_a_legacy_row_in_the_field_chain_is_spotted(self):
        # Raised under the OLD order: sitting in the reporting line with no decision
        # taken. Under the new order that is unreachable, so it can only be a document
        # that was already in somebody's queue when the order changed — and its final
        # signature has to hand it on to the decision desk the way it always did.
        legacy = _doc(reason="EXPIRED", phase=service.PHASE_FIELD)
        assert service._is_legacy_field(legacy) is True

        # A row with no phase key at all is the oldest shape of the same thing.
        assert service._is_legacy_field(_doc(reason="EXPIRED")) is True

    def test_a_new_return_that_skipped_an_unconfigured_desk_is_not_legacy(self):
        # This is the case the marker exists for. With no receiving ladder configured the
        # decision desk is skipped and the return opens its reporting line directly,
        # landing in FIELD with no disposition — identical to a legacy row on every other
        # reading. Without the marker it would be sent back to a desk that does not
        # exist, which would open the field chain again, forever.
        skipped = _doc(reason="EXPIRED", phase=service.PHASE_FIELD,
                       field_chain_opened=True)
        assert service._is_legacy_field(skipped) is False

    def test_a_decided_return_in_the_field_chain_is_not_legacy(self):
        decided = _doc(reason="EXPIRED", phase=service.PHASE_FIELD,
                       disposition="SEND_TO_POINT")
        assert service._is_legacy_field(decided) is False

    def test_every_return_climbs_its_ladder_first(self):
        # ADDED 2026-09-07 for indent-linked returns, and widened to all of them the same
        # day: `submit_return` stamps this marker on every return it opens, and it is what
        # every ending reads to know the ladder has already had its say.
        first = _doc(reason="EXPIRED", phase=service.PHASE_FIELD,
                     field_chain_first=True, field_chain_opened=True)
        assert service._field_first(first) is True

        # Unstamped is a row raised under the 2026-09-05 order — desk, sign-off, ladder —
        # and it has to keep taking the path it was raised on.
        assert service._field_first(_doc(reason="EXPIRED")) is False

    def test_a_ladder_that_ran_first_is_remembered_once_it_has_signed(self):
        # Read at the far end of the receiving chain. Without it the endorsement's last
        # rung would open the reporting line again and ask the same people to approve the
        # same document twice — which is what the pre-2026-09-07 code did to a legacy row.
        signed = _doc(reason="EXPIRED", phase=service.PHASE_DECISION,
                      field_chain_first=True, field_chain_done=True)
        assert service._field_done(signed) is True
        assert service._field_done(_doc(reason="EXPIRED",
                                        field_chain_first=True)) is False

    def test_an_approval_first_return_is_not_mistaken_for_a_legacy_row(self):
        # Both sign before the desk sees them, so both hand on to it — but only the
        # legacy row predates the marker, and conflating them would let a modern return
        # take a path written for documents that were in flight in September 2026.
        first = _doc(reason="EXPIRED", phase=service.PHASE_FIELD,
                     field_chain_first=True, field_chain_opened=True)
        assert service._is_legacy_field(first) is False


class TestTheLeg:
    """Which returns travel, and what carries them."""

    def test_only_the_travelling_outcomes_have_a_leg(self):
        assert service._leg_of(_doc(disposition="SEND_TO_POINT")) == "STORE"
        assert service._leg_of(_doc(disposition="TO_VENDOR")) == "SUPPLIER"
        for settled_where_it_stands in ("SCRAP", "CONTROLLED_DISPOSAL",
                                        "USE_AT_SOURCE", "REJECT_UNECONOMIC"):
            assert service._leg_of(_doc(disposition=settled_where_it_stands)) is None
            assert service._travels(_doc(disposition=settled_where_it_stands)) is False
        # No decision yet: nothing knows whether it is going to a shelf or a vendor.
        assert service._leg_of(_doc(reason="EXPIRED")) is None

    def test_the_shipment_reference_is_absent_until_one_is_raised(self):
        assert service._transport_ref(_doc(disposition="TO_VENDOR")) is None
        carried = _doc(disposition="TO_VENDOR", leg="SUPPLIER",
                       transport_request_id=91, transport_request_no="TR-0091")
        assert service._transport_ref(carried) == {
            "transport_request_id": 91,
            "transport_request_no": "TR-0091",
            "leg": "SUPPLIER",
            "leg_label": "Supplier return",
        }

    def test_a_supplier_leg_is_addressed_to_the_vendor_not_the_warehouse(self):
        # `to_warehouse_id` still holds the point the return was ADDRESSED to when it was
        # raised. Printing that on a load going to a vendor is how a shipment ends up
        # labelled for a warehouse it will never reach.
        doc = _doc(disposition="TO_VENDOR", leg="SUPPLIER")
        doc.to_warehouse_name = "104 - BRANCH OFFICE - Hindupur - MDP"
        assert service._leg_destination(
            doc, {"disposition": "TO_VENDOR", "vendor_name": "Acme Pharma"}
        ) == "Acme Pharma"

    def test_a_store_leg_is_addressed_to_the_receiving_point(self):
        doc = _doc(disposition="SEND_TO_POINT", leg="STORE")
        doc.to_warehouse_name = "104 - BRANCH OFFICE - Hindupur - MDP"
        assert service._leg_destination(doc, {"disposition": "SEND_TO_POINT"}) == (
            "104 - BRANCH OFFICE - Hindupur - MDP")


class TestHooksSelfFilter:
    """A hook fires on EVERY transport request in the system, so the first thing each
    one does is establish the leg is ours and let go otherwise. Getting this wrong would
    debit a branch shelf because somebody dispatched an unrelated consignment."""

    def test_a_consignment_leg_is_not_ours(self):
        tr = SimpleNamespace(source_type="CONSIGNMENT", source_id=4, tr_no="TR-1")
        assert asyncio.run(service._return_behind(None, tr)) is None

    def test_an_issue_leg_is_not_ours(self):
        tr = SimpleNamespace(source_type="ISSUE", source_id=4, tr_no="TR-2")
        assert asyncio.run(service._return_behind(None, tr)) is None

    def test_a_return_leg_with_no_source_id_is_let_go(self):
        tr = SimpleNamespace(source_type="RETURN", source_id=None, tr_no="TR-3")
        assert asyncio.run(service._return_behind(None, tr)) is None

    def test_both_hooks_are_registered_with_logistics(self):
        # Registered at import, the same shape the warehouse uses — logistics may not
        # import returns (rule 5), so the direction is inverted.
        from app.modules.logistics import hooks as lgs_hooks

        assert service._transport_released in lgs_hooks.ON_RELEASE
        assert service._transport_acknowledged in lgs_hooks.ON_ACKNOWLEDGE

    def test_registering_twice_does_not_double_the_hooks(self):
        # A module imported twice would otherwise debit the shelf twice per release.
        from app.modules.logistics import hooks as lgs_hooks

        service._register_transport_hooks()
        service._register_transport_hooks()
        assert lgs_hooks.ON_RELEASE.count(service._transport_released) == 1
        assert lgs_hooks.ON_ACKNOWLEDGE.count(service._transport_acknowledged) == 1


class TestSendBack:
    """Sending the document home, from any of the three stages."""

    def test_every_stage_has_a_name_and_an_actor_flag(self):
        # `send_back` and `reject_at_stage` both read these. A stage missing from either
        # would raise a KeyError in front of an approver mid-press.
        for phase in (service.PHASE_DECISION, service.PHASE_ENDORSE,
                      service.PHASE_FIELD):
            assert phase in service.STAGE_LABELS
            assert phase in service._ACTOR_FLAG

    def test_the_actor_flag_is_the_live_task_never_a_permission(self):
        assert service._ACTOR_FLAG[service.PHASE_DECISION] == "can_decide"
        assert service._ACTOR_FLAG[service.PHASE_ENDORSE] == "can_endorse"
        assert service._ACTOR_FLAG[service.PHASE_FIELD] == "can_act"

    def test_a_fresh_draft_carries_no_send_back_note(self):
        assert service._send_back_note(_doc(reason="EXPIRED")) is None

    def test_a_returned_draft_says_who_sent_it_back_and_why(self):
        doc = _doc(reason="EXPIRED", send_backs=2,
                   sent_back_note="The quantity does not match the photo",
                   sent_back_by="R Prasad", sent_back_from="the decision desk")
        assert service._send_back_note(doc) == {
            "count": 2,
            "note": "The quantity does not match the photo",
            "by_name": "R Prasad",
            "from_stage": "the decision desk",
        }


class TestRemarksEncoding:
    """A return is found by its marker. If this breaks, the list empties."""

    def test_round_trips_everything_inv_sto_has_no_column_for(self):
        packed = service._pack("EXPIRED", "went off in the heat", "MMU Mustabad",
                               "HR-EMP-15392")
        assert packed.startswith(service.MARKER)
        assert service._unpack(packed) == {
            "reason": "EXPIRED",
            "note": "went off in the heat",
            "office_name": "MMU Mustabad",
            "raiser_code": "HR-EMP-15392",
            # Written even where they are the defaults, so a row never has to be read as
            # "the value in force when this was raised".
            "kind": "FIELD",
            "intent": "RETURN",
        }

    def test_a_real_transfer_is_not_read_as_a_return(self):
        # inv_sto holds genuine transfers too, and create_sto writes its own prose into
        # remarks. Reading one of those as a return would show a transfer on this screen.
        assert service._unpack("Cross-project, so the Inventory Manager approves") == {}
        assert service._unpack(None) == {}
        assert service._unpack("") == {}

    def test_a_hand_edited_payload_still_renders(self):
        # Someone fixing a row in MySQL must not make the screen raise. No reason is
        # better than a 500 on a list of forty documents.
        assert service._unpack(service.MARKER + "{not json") == {}
        assert service._unpack(service.MARKER + "[1,2,3]") == {}
        assert service._unpack(service.MARKER) == {}

    def test_an_empty_note_is_stored_as_nothing(self):
        assert service._unpack(service._pack("DAMAGED", "", None, None))["note"] is None

    def test_the_marker_leads_so_the_filter_is_a_prefix_match(self):
        # A prefix LIKE can use an index; '%…%' cannot.
        clause = str(service._is_return().compile(
            compile_kwargs={"literal_binds": True}))
        assert "[STOCK_RETURN]%" in clause
        assert "%[STOCK_RETURN]" not in clause


class TestVocabulary:
    def test_statuses_match_the_sto_column_they_are_written_to(self):
        # inv_sto.status is read by inventory's own screens; a value they have never
        # heard of renders as a blank pill on a page this module does not own.
        from app.modules.inventory.enums import STOStatus

        known = {member.value for member in STOStatus}
        assert {member.value for member in ReturnStatus} <= known

    def test_every_reason_has_a_label_for_the_dropdown(self):
        assert set(REASON_LABELS) == {member.value for member in ReturnReason}
        assert all(REASON_LABELS.values())

    def test_reasons_endpoint_returns_the_whole_list(self):
        rows = service.reasons()
        assert len(rows) == len(ReturnReason)
        assert {"value", "label"} == set(rows[0])

    def test_the_dropdown_order_is_stated_not_incidental(self):
        # dict order is insertion order, which would silently reshuffle the dropdown
        # the day someone tidies REASON_LABELS.
        values = [row["value"] for row in service.reasons()]
        assert values == [reason.value for reason in SELECTABLE_REASONS]
        assert values[0] == ReturnReason.EXPIRED.value
        # Free text is the last resort, so it sits at the bottom of the list.
        assert values[-1] == ReturnReason.OTHER.value

    def test_the_reasons_the_business_asked_for_are_all_offered(self):
        offered = {row["label"] for row in service.reasons()}
        for label in ("Expired", "Near expiry — cannot consume in time",
                      "Damaged (in transit or in store)", "Leaked / Spilled",
                      "Wrong item issued", "Excess issued / Excess supply",
                      "Quality issue / Failed QC",
                      "Batch recall / Manufacturer recall", "Unused / Surplus"):
            assert label in offered, label

    def test_the_doc_type_is_this_module_s_own(self):
        """The module names its own documents, and the engine takes them as strings.

        This used to assert the two values were ABSENT from `shared.enums.DocType`. They
        are not any more — the lead added both there, deliberately and with comments
        explaining each, so that the Approvals Config screen can offer a ladder against
        them. That is the point the assertion was protecting (a module can name a document
        without an edit to a file it does not own) surviving in a stronger form, so what
        is checked now is that the two spellings AGREE. Two enums naming the same document
        differently is the failure that would actually strand a return: the ladder would
        be configured against one string and the engine asked about the other.
        """
        from app.shared.enums import DocType

        shared = {d.value for d in DocType}
        for member in ReturnDocType:
            assert member.value in shared, (
                f"{member.value} is configurable on the Approvals screen only if "
                "shared.enums.DocType spells it the same way")

    def test_only_a_draft_is_editable_and_the_hold_lasts_until_the_load_goes(self):
        from app.modules.returns.enums import WITHDRAWABLE

        assert EDITABLE == {ReturnStatus.DRAFT.value}
        # APPROVED joined HOLDING_STOCK on 2026-09-05: a travelling return keeps its
        # reservation past the final approval, because the material is still on the branch
        # shelf waiting for a truck and must not be issued away in the meantime.
        assert HOLDING_STOCK == {ReturnStatus.PENDING_APPROVAL.value,
                                 ReturnStatus.APPROVED.value}
        # An approved return must still never be EDITED, nor taken back by the raiser.
        assert ReturnStatus.APPROVED.value not in EDITABLE
        assert ReturnStatus.APPROVED.value not in WITHDRAWABLE
        assert ReturnStatus.REJECTED.value not in EDITABLE | WITHDRAWABLE

    def test_a_return_is_acknowledgeable_once_it_has_settled_or_arrived(self):
        # Acknowledging anything else would close a document that never happened. The
        # phase is the other half of this gate — a travelling return is APPROVED from the
        # final signature until the truck goes, and `can_acknowledge` refuses it while the
        # phase still reads LOGISTICS.
        assert AWAITING_ACK == {ReturnStatus.APPROVED.value,
                                ReturnStatus.DISPATCHED.value}
        assert ReturnStatus.RECEIVED.value in CLOSED
        assert not AWAITING_ACK & CLOSED

    def test_the_legs_are_the_ones_the_stepper_draws(self):
        assert [key for key, _label in PHASES] == [
            "draft", "submitted", "decision", "endorsement", "approvals", "logistics",
            "movement", "acknowledged",
        ]

    def test_an_indent_linked_return_draws_its_ladder_before_the_desks(self):
        # ADDED 2026-09-07. The same eight legs, re-ordered — not a different tracker.
        # `journey` picks between the two on the document's own marker, so a raiser who
        # named an indent sees the chain he picked as leg three rather than leg five.
        from app.modules.returns.enums import PHASES_APPROVAL_FIRST

        assert ({key for key, _label in PHASES_APPROVAL_FIRST}
                == {key for key, _label in PHASES})
        keys = [key for key, _label in PHASES_APPROVAL_FIRST]
        assert (keys.index("approvals") < keys.index("decision")
                < keys.index("endorsement") < keys.index("logistics")
                < keys.index("movement"))

    def test_the_desks_decide_before_the_reporting_line_approves(self):
        # REORDERED 2026-09-05 to the sequence the business states. The decision desk
        # says where the material is worth the most, the floor signs that off, and the
        # raiser's own reporting line approves the finished document LAST — its final
        # rung being the approval that releases the material to logistics. Approving
        # first meant asking people to sign a document whose outcome was still blank.
        keys = [key for key, _label in PHASES]
        assert (keys.index("decision") < keys.index("endorsement")
                < keys.index("approvals") < keys.index("logistics")
                < keys.index("movement"))

    def test_only_the_two_travelling_outcomes_raise_a_leg(self):
        # Everything else settles where it already stands: two move nothing at all, and
        # scrap and controlled disposal are written off at the branch. Routing those
        # through logistics would book a truck for material that is not going anywhere.
        from app.modules.returns.enums import (
            LEG_BY_DISPOSITION, TRAVELS, Disposition, ReturnLeg,
        )

        assert TRAVELS == {Disposition.SEND_TO_POINT.value,
                           Disposition.TO_VENDOR.value}
        assert LEG_BY_DISPOSITION[Disposition.SEND_TO_POINT.value] == (
            ReturnLeg.STORE.value)
        assert LEG_BY_DISPOSITION[Disposition.TO_VENDOR.value] == (
            ReturnLeg.SUPPLIER.value)
        # Derived from the leg map, so the two can never disagree about which is which.
        assert TRAVELS == set(LEG_BY_DISPOSITION)

    def test_every_disposition_says_what_it_does_to_stock(self):
        # `_carry_out` reads the movement off this table rather than branching on the
        # disposition name, so a member missing from it would move nothing and say
        # nothing.
        from app.modules.returns.enums import (
            DISPOSITION_HINTS, DISPOSITION_LABELS, MOVEMENT_BY_DISPOSITION, Disposition,
        )

        values = {member.value for member in Disposition}
        assert set(MOVEMENT_BY_DISPOSITION) == values
        assert set(DISPOSITION_LABELS) == values
        assert set(DISPOSITION_HINTS) == values

    def test_two_of_the_six_outcomes_move_nothing_at_all(self):
        # The reason the decision desk exists: refusing to spend freight on stock worth
        # less than the freight is a call the business makes constantly.
        from app.modules.returns.enums import (
            MOVEMENT_BY_DISPOSITION, Disposition, Movement,
        )

        still = {value for value, movement in MOVEMENT_BY_DISPOSITION.items()
                 if movement is Movement.NONE}
        assert still == {Disposition.USE_AT_SOURCE.value,
                         Disposition.REJECT_UNECONOMIC.value}

    def test_a_hazardous_item_can_never_be_scrapped_at_a_branch(self):
        from app.modules.returns.enums import BLOCKED_WHEN_HAZARDOUS, Disposition

        assert BLOCKED_WHEN_HAZARDOUS == {Disposition.SCRAP.value}
        # Controlled disposal is the route that stays open, so the guard never leaves a
        # return with nowhere to go.
        assert Disposition.CONTROLLED_DISPOSAL.value not in BLOCKED_WHEN_HAZARDOUS

    def test_the_reason_pre_selects_an_outcome_except_for_other(self):
        from app.modules.returns.enums import (
            DEFAULT_DISPOSITION_BY_REASON, Disposition, ReturnReason,
        )

        known = {member.value for member in Disposition}
        assert set(DEFAULT_DISPOSITION_BY_REASON.values()) <= known
        # Nobody can guess what "Other" means, and a pre-selected button on a reason the
        # system does not understand is a wrong answer offered as a right one.
        assert ReturnReason.OTHER.value not in DEFAULT_DISPOSITION_BY_REASON
        assert set(DEFAULT_DISPOSITION_BY_REASON) == (
            {member.value for member in ReturnReason} - {ReturnReason.OTHER.value})

    def test_a_disposal_certificate_is_not_just_another_document(self):
        # The close is gated on this category. Sharing DOCUMENT_CATEGORY would let an
        # inward bill count as proof that regulated material was destroyed.
        from app.modules.returns.enums import NEEDS_AGENCY, Disposition

        assert service.CERTIFICATE_CATEGORY not in {
            service.DOCUMENT_CATEGORY, service.PHOTO_CATEGORY}
        # Only controlled disposal owes one — scrap at the branch does not.
        assert NEEDS_AGENCY == {Disposition.CONTROLLED_DISPOSAL.value}

    def test_an_out_only_movement_gets_its_own_ledger_ref_type(self):
        # "What did we write off" has to be answerable off stk_ledger.ref_type alone,
        # without reading the marker payload of every row.
        from app.modules.returns.enums import (
            LEDGER_REF_BY_DISPOSITION, MOVEMENT_BY_DISPOSITION, Movement,
        )

        out_only = {value for value, movement in MOVEMENT_BY_DISPOSITION.items()
                    if movement is Movement.OUT_ONLY}
        assert set(LEDGER_REF_BY_DISPOSITION) == out_only


class TestApprovalPhases:
    """Which chain a decision belongs to is read off the document, not guessed."""

    def _doc(self, remarks):
        return SimpleNamespace(remarks=remarks)

    def test_a_fresh_return_is_on_the_field_chain(self):
        packed = service._pack("EXPIRED", None, "MMU Mustabad", "HR-EMP-15392")
        assert service._phase_doc_type(self._doc(packed)) == \
            ReturnDocType.STOCK_RETURN.value

    def test_once_handed_over_it_is_on_the_receiving_chain(self):
        doc = self._doc(service._pack("EXPIRED", None, "MMU Mustabad", "HR-EMP-1"))
        # Both desks resolve to the receipt chain: the decision opens it, the endorsers
        # sign it, and a caller asking about a document on either desk is asking about
        # that chain and not about the reporting line that has already finished.
        for phase in (service.PHASE_DECISION, service.PHASE_ENDORSE):
            service._set_payload(doc, **{service.PHASE_KEY: phase})
            assert service._phase_doc_type(doc) == \
                ReturnDocType.STOCK_RETURN_RECEIPT.value

    def test_setting_the_phase_keeps_the_reason_and_the_office(self):
        doc = self._doc(service._pack("DAMAGED", "crushed", "MMU Mustabad", "HR-EMP-1"))
        service._set_payload(doc, **{service.PHASE_KEY: service.PHASE_DECISION})
        payload = service._unpack(doc.remarks)
        assert payload["reason"] == "DAMAGED"
        assert payload["note"] == "crushed"
        assert payload["office_name"] == "MMU Mustabad"
        assert payload["raiser_code"] == "HR-EMP-1"

    def test_clearing_the_phase_puts_it_back_on_the_field_chain(self):
        doc = self._doc(service._pack("EXPIRED", None, None, None))
        service._set_payload(doc, **{service.PHASE_KEY: service.PHASE_ENDORSE})
        service._set_payload(doc, **{service.PHASE_KEY: None})
        assert service.PHASE_KEY not in service._unpack(doc.remarks)
        assert service._phase_doc_type(doc) == ReturnDocType.STOCK_RETURN.value

    def test_an_objection_clears_the_decision_it_objected_to(self):
        # Leaving the old decision on the document would let the screen offer "endorse"
        # against a route the floor has already refused.
        doc = self._doc(service._pack("DAMAGED", None, None, None))
        service._set_payload(doc, **{
            service.PHASE_KEY: service.PHASE_ENDORSE,
            service.DECISION_KEY: "SCRAP",
            service.DECISION_NOTE_KEY: "beyond use",
        })
        assert service._decision_of(doc) is not None
        service._set_payload(doc, **{
            service.PHASE_KEY: service.PHASE_DECISION,
            service.DECISION_KEY: None, service.DECISION_NOTE_KEY: None,
            service.OBJECTIONS_KEY: 1,
        })
        assert service._decision_of(doc) is None
        assert service._unpack(doc.remarks)[service.OBJECTIONS_KEY] == 1
        assert service._unpack(doc.remarks)["reason"] == "DAMAGED"

    def test_the_receipt_chain_is_opened_on_behalf_of_the_raiser(self):
        # The regression this exists for: the receiving chain used to be opened with the
        # DECIDER as its requester, and a custom ladder strikes off the rung the requester
        # raised under — which is rung one, the decider's own. The chain opened at the
        # endorsers and the decision's own signature was then refused as "not a valid
        # approver", so every decision failed on every correctly configured ladder.
        doc = SimpleNamespace(
            remarks=service._pack("EXPIRED", None, None, None), requested_by_id=7)
        service._set_payload(doc, **{service.RAISER_POSITION_KEY: 4321})
        assert asyncio.run(service._raiser_position_id(None, doc)) == 4321

    def test_an_unknown_raiser_post_is_never_falsy(self):
        # `engine.start` reads a missing or zero `requester_position_id` as "use the
        # caller's own post", and the caller is the decision desk — the one value that
        # must not be used. So the stand-in has to be truthy and unmatchable.
        assert service.NO_POST
        assert service.NO_POST < 0

    def test_the_hat_the_return_was_raised_under_survives_the_decision(self):
        doc = SimpleNamespace(remarks=service._pack("DAMAGED", None, None, None))
        service._set_payload(doc, **{service.RAISER_POSITION_KEY: 99})
        service._set_payload(doc, **{service.PHASE_KEY: service.PHASE_DECISION})
        service._set_payload(doc, **{service.PHASE_KEY: None})
        assert service._unpack(doc.remarks)[service.RAISER_POSITION_KEY] == 99

    def test_the_two_chains_are_different_doc_types(self):
        # One frozen chain per (doc_type, doc_id) in the engine — sharing a doc type
        # would make the receiving desk's approval overwrite the field chain's.
        assert (ReturnDocType.STOCK_RETURN.value
                != ReturnDocType.STOCK_RETURN_RECEIPT.value)


class TestLinkedIndentApproval:
    """An indent return uses the return ladder, resolved from the indent context."""

    def test_linked_indent_changes_context_not_doc_type(self):
        doc = SimpleNamespace(
            sto_no="RET-7",
            from_warehouse_name="Branch",
            from_project_id=1,
            from_warehouse_id=10,
            to_warehouse_id=20,
            items=[],
            requested_by_id=7,
            remarks=service._pack(
                "EXPIRED", None, "Chilakaluripet", "EMP-7",
                indent={
                    service.INDENT_ID_KEY: 44,
                    service.INDENT_NO_KEY: "IND-44",
                    service.INDENT_POSITION_KEY: 606,
                    service.INDENT_PROJECT_KEY: 104,
                    service.RAISER_POSITION_KEY: 999,
                },
            ),
        )

        context = asyncio.run(service._field_chain_context(None, doc))

        assert service.engine.LADDER_DOC_TYPE_KEY not in context
        assert context["indent_id"] == 44
        assert context["requester_position_id"] == 606
        assert context["project_id"] == 104


class TestWhereItActuallyWent:
    """Only one of the six outcomes lands on another stocking point."""

    def _doc(self):
        return SimpleNamespace(to_warehouse_name="MDP Karimnagar")

    def test_a_send_to_a_point_names_the_point(self):
        assert service._went_to(
            self._doc(), {"disposition": "SEND_TO_POINT"}) == "MDP Karimnagar"

    def test_material_that_left_our_books_does_not_name_a_stocking_point(self):
        # `to_warehouse_id` still holds the point the return was ADDRESSED to when it was
        # raised, so printing it read as though a scrapped drum had arrived at the MDP.
        for decision, expected in (
            ({"disposition": "TO_VENDOR", "vendor_name": "Acme"}, "Acme"),
            ({"disposition": "SCRAP"}, "scrapped at the branch"),
            ({"disposition": "CONTROLLED_DISPOSAL", "disposal_agency": "Ramky"},
             "disposal by Ramky"),
        ):
            assert service._went_to(self._doc(), decision) == expected

    def test_no_decision_at_all_still_names_the_point_it_transferred_to(self):
        # No decision desk configured: the return settles as a plain transfer, exactly as
        # it did before that desk existed.
        assert service._went_to(self._doc(), None) == "MDP Karimnagar"


class TestOtherHasToSayWhatItMeans:
    def _check(self, reason, note=None):
        write = ReturnWrite(reason=reason, reason_note=note,
                            items=[ReturnLineIn(item_id=1, quantity="1")])
        total = service._total_qty(write.items)
        service._assert_reasons(service._reason_rows(write, total), total,
                                shorthand_note=write.reason_note)

    def test_other_without_a_note_is_refused(self):
        with pytest.raises(ValidationError):
            self._check(ReturnReason.OTHER)

    def test_other_with_a_note_is_fine(self):
        self._check(ReturnReason.OTHER, "chewed by rats")

    def test_every_other_reason_describes_itself(self):
        self._check(ReturnReason.EXPIRED)


class TestReasonRows:
    """A return holds several reasons, each with a quantity, and they cover every unit."""

    def _rows(self, *pairs):
        return [{"reason": reason.value, "quantity": float(qty), "note": None}
                for reason, qty in pairs]

    def test_reasons_that_cover_the_quantity_pass(self):
        service._assert_reasons(
            self._rows((ReturnReason.DAMAGED, 10), (ReturnReason.EXPIRED, 2)), Decimal("12"))

    def test_reasons_that_fall_short_or_run_over_are_refused(self):
        for given in (11, 13):
            with pytest.raises(ValidationError):
                service._assert_reasons(
                    self._rows((ReturnReason.DAMAGED, given - 2),
                               (ReturnReason.EXPIRED, 2)), Decimal("12"))

    def test_no_reason_is_refused_unless_the_caller_is_an_acknowledgement(self):
        with pytest.raises(ValidationError):
            service._assert_reasons([], Decimal("5"))
        service._assert_reasons([], Decimal("5"), allow_blank=True)

    def test_a_reason_cannot_be_listed_twice(self):
        with pytest.raises(ValidationError):
            service._assert_reasons(
                self._rows((ReturnReason.DAMAGED, 3), (ReturnReason.DAMAGED, 2)), Decimal("5"))

    def test_the_single_reason_shorthand_means_all_of_it(self):
        write = ReturnWrite(reason=ReturnReason.EXPIRED,
                            items=[ReturnLineIn(item_id=1, quantity="4")])
        assert service._reason_rows(write, Decimal("4")) == [
            {"reason": "EXPIRED", "quantity": 4.0, "note": None}]

    def test_the_main_reason_is_the_one_with_most_units(self):
        rows = self._rows((ReturnReason.EXPIRED, 2), (ReturnReason.DAMAGED, 10))
        assert service._main_reason(rows) == "DAMAGED"
        assert service._main_reason([]) is None

    def test_a_return_raised_before_reason_rows_reads_as_one_reason_for_all(self):
        assert service._reasons_of({"reason": "EXPIRED", "note": "n"}, Decimal("6")) == [
            {"reason": "EXPIRED", "quantity": 6.0, "note": "n"}]
        assert service._reasons_of({}, Decimal("6")) == []


class TestSchemas:
    def test_a_return_needs_at_least_one_line(self):
        with pytest.raises(ValueError):
            ReturnWrite(reason=ReturnReason.EXPIRED, items=[])

    def test_quantity_must_be_positive(self):
        with pytest.raises(ValueError):
            ReturnLineIn(item_id=1, quantity="0")
        with pytest.raises(ValueError):
            ReturnLineIn(item_id=1, quantity="-5")

    def test_quantity_finer_than_the_column_is_refused_not_rounded(self):
        # Numeric(16,3) would silently round 1.0004 to 1.000, so the returner would be
        # told they had sent a quantity they never typed.
        with pytest.raises(ValueError):
            ReturnLineIn(item_id=1, quantity="1.0004")
        assert ReturnLineIn(item_id=1, quantity="1.004").quantity is not None

    def test_a_blank_note_becomes_none(self):
        assert ReturnWrite(
            reason=ReturnReason.OTHER, reason_note="   ",
            items=[ReturnLineIn(item_id=1, quantity="1")],
        ).reason_note is None

    def test_the_raiser_cannot_post_who_they_are(self):
        # Identity and source are derived server-side. A field accepted here would let a
        # browser claim to be returning somebody else's stock from somebody else's office.
        for forbidden in ("from_warehouse_id", "raised_by_id", "office_name",
                          "raised_by_code"):
            assert forbidden not in ReturnWrite.model_fields


class TestRouter:
    def test_it_mounts_and_every_route_is_under_api_returns(self):
        app = FastAPI()
        app.include_router(returns_router.router)
        paths = {route.path for route in app.routes if hasattr(route, "path")}
        assert "/api/returns" in paths
        assert all(path.startswith("/api/returns") or path.startswith("/openapi")
                   or path.startswith("/docs") or path.startswith("/redoc")
                   for path in paths)

    def test_the_decision_and_movement_routes_exist(self):
        paths = {route.path for route in returns_router.router.routes}
        for expected in (
            "/api/returns",
            "/api/returns/summary",
            "/api/returns/my-stock",
            "/api/returns/options/reasons",
            "/api/returns/options/raiser",
            "/api/returns/{return_id}",
            "/api/returns/{return_id}/submit",
            "/api/returns/{return_id}/approve",
            "/api/returns/{return_id}/reject",
            "/api/returns/{return_id}/cancel",
            "/api/returns/{return_id}/history",
            "/api/returns/{return_id}/attachments",
            # The decision desk's own verbs. Deciding is not approving, so it is not the
            # approve endpoint with a different body.
            "/api/returns/{return_id}/decision-options",
            # The paper trail behind the item, and the purchase-return source catalogue
            # the register's filter reads (both 2026-09-08).
            "/api/returns/{return_id}/related-documents",
            "/api/returns/options/purchase-sources",
            "/api/returns/{return_id}/decide",
            "/api/returns/{return_id}/endorse",
            "/api/returns/{return_id}/object",
        ):
            assert expected in paths, expected

    def test_the_literal_segments_are_declared_before_the_int_catch_all(self):
        """`/purchase` and `/config/…` must be matched before `/{return_id}`, or
        FastAPI parses "purchase" as a return id and 422s."""
        paths = [route.path for route in returns_router.router.routes]
        catch_all = paths.index("/api/returns/{return_id}")
        for literal in ("/api/returns/purchase", "/api/returns/summary",
                        "/api/returns/my-stock", "/api/returns/config/receiving"):
            assert paths.index(literal) < catch_all, literal

    def test_every_route_but_the_static_reason_list_is_permission_gated(self):
        """Rule 6: hiding a button is not security — the backend check is.

        Asserted off the resolved dependency graph rather than off the source text, so
        a route that imports `require_permission` and then forgets to apply it still
        fails. `/options/reasons` is the one exception: it serves a hard-coded enum with
        no data in it, so it only needs a login.
        """
        ungated: list[str] = []
        for route in returns_router.router.routes:
            calls = {
                dependency.call
                for dependency in route.dependant.dependencies
                if dependency.call is not None
            }
            # require_permission builds its checker as a closure; the free variable is
            # the permission code, which is what proves a real code was bound.
            # PageParams is a plain class dependency and carries no closure, so the
            # lookup has to tolerate a callable that is not a function.
            codes = {
                cell.cell_contents
                for call in calls
                for cell in (getattr(call, "__closure__", None) or ())
                if isinstance(cell.cell_contents, str)
            }
            if not codes:
                ungated.append(f"{list(route.methods)[0]} {route.path}")
                continue
            # The module's OWN permission family, not borrowed inventory codes. Six
            # different people are involved and the codes say so: the storekeeper who
            # raises a return must never gain the ability to transfer stock sideways, the
            # desk that decides where material goes is making a commercial call rather
            # than signing an outward move, and the floor that signs that decision off is
            # neither. See the router's module docstring.
            assert codes <= {
                "return.view", "return.create", "return.approve",
                "return.decide", "return.endorse", "return.config.manage",
            }, f"{route.path} gates on an unexpected code: {codes}"

        assert ungated == ["GET /api/returns/options/reasons"], ungated

    def test_send_back_and_reject_are_gated_on_their_own_stage_s_code(self):
        """Each stage's verb carries that stage's permission, not a shared one.

        The whole reason this module has six codes is that six different people are
        involved. One `/send-back` endpoint would have had to gate on a single code,
        which would either hand the decision desk the approvers' code or hand the
        approvers the desk's — so there is one route per stage instead.
        """
        gates = {
            (sorted(route.methods)[0], route.path): {
                cell.cell_contents
                for dependency in route.dependant.dependencies
                for cell in (getattr(dependency.call, "__closure__", None) or ())
                if isinstance(cell.cell_contents, str)
            }
            for route in returns_router.router.routes
        }
        assert gates[("POST", "/api/returns/{return_id}/approval/send-back")] == {
            "return.approve"}
        assert gates[("POST", "/api/returns/{return_id}/decision/send-back")] == {
            "return.decide"}
        assert gates[("POST", "/api/returns/{return_id}/sign-off/send-back")] == {
            "return.endorse"}
        assert gates[("POST", "/api/returns/{return_id}/decision/reject")] == {
            "return.decide"}
        assert gates[("POST", "/api/returns/{return_id}/sign-off/reject")] == {
            "return.endorse"}

    def test_the_stage_routes_are_declared_before_the_catch_all(self):
        # `/{return_id}/decision/reject` has to be matched before `/{return_id}`, or
        # "decision" is parsed as part of the id and the route 422s.
        paths = [route.path for route in returns_router.router.routes]
        catch_all = paths.index("/api/returns/{return_id}")
        for literal in ("/api/returns/{return_id}/approval/send-back",
                        "/api/returns/{return_id}/decision/send-back",
                        "/api/returns/{return_id}/sign-off/send-back",
                        "/api/returns/{return_id}/decision/reject",
                        "/api/returns/{return_id}/sign-off/reject"):
            assert literal in paths, literal

    def test_only_an_approvals_admin_can_change_the_receiving_ladder(self):
        """Reading who signs is fine for anyone who can see stock; changing it is not."""
        # Keyed by method AND path: GET and PUT share `/config/receiving` and gate on
        # different codes, so keying on the path alone would hide one of them.
        writes = {
            (sorted(route.methods)[0], route.path): {
                cell.cell_contents
                for dependency in route.dependant.dependencies
                for cell in (getattr(dependency.call, "__closure__", None) or ())
                if isinstance(cell.cell_contents, str)
            }
            for route in returns_router.router.routes
            if route.path.startswith("/api/returns/config")
        }
        assert writes[("PUT", "/api/returns/config/receiving")] == {
            "return.config.manage"}
        assert writes[("GET", "/api/returns/config/receiving")] == {"return.view"}
        assert writes[("GET", "/api/returns/config/positions")] == {
            "return.config.manage"}


class TestTheOriginatingWarehouse:
    """Where the material CAME from, and why that is not where it is standing.

    ADDED 2026-09-08. The desk was shown `from_warehouse` under the name "originating
    warehouse" and that value was then pre-filled into the destination picker — which
    `decide` refuses outright, so the one pre-filled answer on the screen was the one
    answer the service would not take. These pin the resolution order and, above all,
    that the current point can never come out of it.
    """

    @staticmethod
    def _sto(from_id=30, to_id=None):
        return SimpleNamespace(from_warehouse_id=from_id, from_warehouse_name="LIP A",
                               to_warehouse_id=to_id, to_warehouse_name="MDP B",
                               items=[])

    @staticmethod
    def _issue(issue_id, warehouse_id, name):
        return SimpleNamespace(id=issue_id, issue_no=f"ISS-{issue_id:04d}",
                               warehouse_id=warehouse_id, warehouse_name=name,
                               status="ISSUED", issue_date=None)

    @staticmethod
    def _chain(issues=(), grn=None):
        return {"indent": None, "indent_no": None, "issues": list(issues), "po": None,
                "grn": grn, "qc": None, "qc_items": [], "qc_rejected": False,
                "item_ids": []}

    def test_the_issuing_warehouse_wins(self):
        # The point that served this branch is the point it goes back to.
        chain = self._chain(issues=[self._issue(4, 12, "Central WH")])
        answer = asyncio.run(
            service._originating_warehouse(None, self._sto(), chain))
        assert answer["warehouse_id"] == 12
        assert answer["warehouse_name"] == "Central WH"
        assert answer["is_resolved"] is True
        # Named, so the screen can say why it pre-filled what it pre-filled.
        assert answer["source_doc"] == "Material issue ISS-0004"

    def test_the_grn_answers_when_no_issue_does(self):
        grn = SimpleNamespace(id=9, grn_no="GRN-0009", warehouse_id=21,
                              warehouse_name="Inward WH", vendor_id=None,
                              vendor_name=None, po_id=None, status="POSTED",
                              grn_date=None)
        answer = asyncio.run(
            service._originating_warehouse(None, self._sto(), self._chain(grn=grn)))
        assert answer["warehouse_id"] == 21
        assert answer["source_doc"] == "GRN GRN-0009"

    def test_the_current_point_is_never_the_answer(self):
        """The whole reason this function exists.

        An issue raised BY the branch itself — a LIP issuing to a site — names the
        branch as its warehouse, and taking that would hand the picker the one value
        `decide` refuses. It has to fall through to the next candidate.
        """
        chain = self._chain(issues=[self._issue(4, 30, "LIP A"),
                                    self._issue(3, 12, "Central WH")])
        answer = asyncio.run(
            service._originating_warehouse(None, self._sto(from_id=30), chain))
        assert answer["warehouse_id"] == 12

    def test_with_nothing_behind_it_the_addressed_to_point_stands_and_says_so(self):
        # Unchanged behaviour for a return with no paper trail — but flagged as a
        # fallback, so the screen labels a guess as a guess rather than claiming a
        # document said it.
        answer = asyncio.run(
            service._originating_warehouse(None, self._sto(to_id=55), self._chain()))
        assert answer["warehouse_id"] == 55
        assert answer["is_resolved"] is False
        assert answer["source_doc"] is None


class TestThePurchaseReturnSource:
    """Which category a purchase return is filed under, and that QC wins.

    The buying desk chases our own upper-tier stock going back, a branch pushing
    material up the chain, and material that failed on the inspection bench as three
    different problems. Before 2026-09-08 the answer lived in free text on `reason`,
    which no filter could read.
    """

    def test_the_three_categories_are_the_only_ones_offered(self):
        values = [option["value"] for option in service.purchase_return_sources()]
        assert values == ["FROM_WAREHOUSE", "FROM_LIP_MDB", "QC_REJECTED_GRN"]
        # Every offered value has a label, because the register renders the label and a
        # missing one would print the raw enum at a buying desk.
        assert all(option["label"] for option in service.purchase_return_sources())

    def test_a_qc_rejection_beats_the_tier(self):
        """Material rejected after the GRN never reached a shelf.

        Asserted on the REASON path, which needs no database: a branch can raise a
        quality rejection on material whose GRN was never inspected at all, and the tier
        the goods sat in afterwards is not what the vendor is answerable for.
        """
        doc = _doc(reason=ReturnReason.QUALITY_REJECTION.value)
        doc.from_warehouse_id = None
        chain = {"qc_rejected": False}
        answer = asyncio.run(
            service._purchase_return_source(None, doc, chain))
        assert answer["category"] == "QC_REJECTED_GRN"
        assert answer["qc_rejected_after_grn"] is True

    def test_an_inspection_that_actually_failed_is_enough_on_its_own(self):
        # The reason says nothing about quality; the inspection line does.
        doc = _doc(reason=ReturnReason.EXPIRED.value)
        doc.from_warehouse_id = None
        answer = asyncio.run(
            service._purchase_return_source(None, doc, {"qc_rejected": True}))
        assert answer["category"] == "QC_REJECTED_GRN"

    def test_an_ordinary_return_off_a_branch_is_from_the_field(self):
        # No warehouse id to read a tier off, so it falls to LIP — which is the safe
        # end: a branch return mislabelled as warehouse stock would be chased with the
        # wrong desk.
        doc = _doc(reason=ReturnReason.EXPIRED.value)
        doc.from_warehouse_id = None
        answer = asyncio.run(
            service._purchase_return_source(None, doc, {"qc_rejected": False}))
        assert answer["category"] == "FROM_LIP_MDB"
        assert answer["qc_rejected_after_grn"] is False


class TestTheTrip:
    """The four standard methods, and whose vehicle.

    Both reused rather than relisted: the modes ARE `logistics.enums.MODE_RULES`, so a
    return leg is an ordinary shipment and every rule logistics enforces about carriers,
    quotes and required fields applies to it unchanged.
    """

    def test_the_modes_are_logistics_own_four(self):
        from app.modules.logistics.enums import MODE_RULES

        assert service.LOGISTICS_MODES == tuple(MODE_RULES)
        assert set(service.LOGISTICS_MODES) == {
            "DIRECT", "COURIER", "OWN_VEHICLE", "THIRD_PARTY"}

    def test_a_vehicle_arrangement_is_not_a_mode(self):
        """VENDOR_PICKUP is who turns up at the gate, not how the load travels.

        Kept as its own axis because a vendor collecting their own material can be any
        mode on paper, and what the distinction actually decides is whether the freight
        is ours to pay — and therefore whether there is anything to tender.
        """
        assert service.VEHICLE_TYPES == ("OWN_VEHICLE", "VENDOR_PICKUP")
        assert "VENDOR_PICKUP" not in service.LOGISTICS_MODES
        # OWN_VEHICLE is deliberately in BOTH, and means different things in each: a
        # mode says the company drove it, an arrangement says the vehicle was not the
        # vendor's. Collapsing them would lose the vendor-pickup case entirely.
        assert "OWN_VEHICLE" in service.LOGISTICS_MODES

    def test_an_unrecognised_mode_is_refused_rather_than_dropped(self):
        # Validated on the schema's own field so no database is needed. The service
        # refuses it too (`decide`), which is the check that matters — a silently
        # dropped mode told the desk its decision was recorded and then booked a hired
        # truck it had not asked for.
        body = DecisionIn(disposition="SEND_TO_POINT", note="Sending it back",
                          logistics_mode="HELICOPTER")
        assert body.logistics_mode == "HELICOPTER"
        assert body.logistics_mode not in service.LOGISTICS_MODES

class TestTheWholeTrail:
    """Every document the material touched, in the order the work happened.

    ADDED 2026-09-12. The section resolved five kinds of document and the desk was told
    that was the trail. It was not: an indent served from stock raises an ALLOCATION and
    never a PO, so the commonest return in the system showed three rows and stopped, and
    a dispatched issue named neither the CONSIGNMENT it left on nor the SHIPMENT that
    carried it. These pin the two things that fail silently — a document type that
    resolves but never reaches the screen, and rows arriving in the order the queries
    happened to run rather than in the order the material moved.

    No database: `_chain_documents` is a pure function over an already-resolved chain,
    which is the half that decides what a reviewer sees.
    """

    @staticmethod
    def _sto():
        return SimpleNamespace(from_warehouse_id=30, from_warehouse_name="LIP A",
                               to_warehouse_id=None, to_warehouse_name=None,
                               remarks=None, items=[])

    @staticmethod
    def _chain(**overrides):
        """An empty chain of every key the row builder reads, plus the overrides.

        Spelled out rather than built with `defaultdict`, because a key the resolver
        stops returning must break a test here rather than quietly render nothing.
        """
        chain = {
            "indent": None, "indent_no": None, "allocations": [], "mrs": [],
            "requisitions": [], "rfqs": [], "quotations": [], "despatch_notes": [],
            "putaways": [], "issues": [], "picklists": [], "outward_qcs": [],
            "consignments": [], "shipments": [], "return_transport_id": None,
            "pos": [], "grns": [], "qcs": [], "po": None, "grn": None, "qc": None,
            "qc_items": [], "qc_rejected": False, "item_ids": [],
        }
        chain.update(overrides)
        return chain

    def _rows(self, **overrides):
        return service._chain_documents(self._sto(), self._chain(**overrides),
                                        {"warehouse_id": None})

    def test_every_document_type_on_the_trail_is_named(self):
        """A type with no label renders as its own raw code on the screen.

        The label is SERVED on the row, so a gap here is not a cosmetic one — the
        frontend has nothing else to fall back to for a type it has never seen.
        """
        for doc_type in TrailDocType:
            assert TRAIL_LABELS.get(doc_type.value), doc_type.value
            assert doc_type.value in TRAIL_ORDER

    def test_the_order_is_the_order_the_work_happens(self):
        # The resolver walks outward from the indent in both directions, which is not a
        # story. This map is what turns it back into one, so its shape is the contract.
        order = [key for key, _ in sorted(TRAIL_ORDER.items(), key=lambda kv: kv[1])]
        assert order.index(TrailDocType.INDENT.value) < order.index(
            TrailDocType.ALLOCATION.value)
        assert order.index(TrailDocType.MATERIAL_REQUEST.value) < order.index(
            TrailDocType.PO.value)
        assert order.index(TrailDocType.PO.value) < order.index(
            TrailDocType.GRN.value) < order.index(TrailDocType.PUTAWAY.value)
        assert order.index(TrailDocType.MATERIAL_ISSUE.value) < order.index(
            TrailDocType.CONSIGNMENT.value) < order.index(TrailDocType.SHIPMENT.value)

    def test_a_stock_served_indent_still_has_a_trail(self):
        """The case the old resolver answered with three rows.

        Nothing was bought, so there is no PO, no GRN and no vendor anywhere — and the
        allocation is then the ONLY document that says why this branch got these units.
        """
        allocation = SimpleNamespace(id=7, allocation_no="ALL-0007", status="APPROVED",
                                     created_at=None, allocated_by_name="Store Keeper",
                                     indent_no="IND-0001")
        issue = SimpleNamespace(id=9, issue_no="WHI-0009", status="DISPATCHED",
                                issue_date=None, warehouse_name="Central WH",
                                warehouse_id=12, issued_to_name="A Anil Kumar")
        consignment = SimpleNamespace(
            id=3, dispatch_no="DSP-0003", status="DISPATCHED", dispatch_date=None,
            warehouse_name="Central WH", carrier_name=None, gate_pass_no="GP-3",
            lr_no=None)
        rows = self._rows(allocations=[allocation], issues=[issue],
                          consignments=[consignment])
        assert [row["doc_type"] for row in rows] == [
            TrailDocType.INTENT.value, TrailDocType.ALLOCATION.value,
            TrailDocType.MATERIAL_ISSUE.value, TrailDocType.CONSIGNMENT.value]
        assert rows[1]["doc_label"] == "Material Allocation"
        # The qualifier is what makes a row worth opening: who signed it.
        assert rows[1]["note"] == "Store Keeper"

    def test_the_returns_own_leg_says_so(self):
        """Both legs of one journey are rows of the same table.

        The one carrying the material back is the one the desk is deciding about, and
        the outward one is evidence — telling them apart by reading the lane is exactly
        what a reviewer should not have to do.
        """
        def shipment(shipment_id, lr=None):
            return SimpleNamespace(id=shipment_id, tr_no=f"TR-{shipment_id:04d}",
                                   status="IN_TRANSIT", tr_date=None,
                                   from_warehouse_name="Central WH",
                                   carrier_name="Blue Dart", lr_no=lr,
                                   freight_amount=None, mode="THIRD_PARTY",
                                   consignment_no=None)
        rows = self._rows(shipments=[shipment(31, lr="54ij"), shipment(39)],
                          return_transport_id=39)
        legs = {row["doc_no"]: row for row in rows
                if row["doc_type"] == TrailDocType.SHIPMENT.value}
        assert legs["TR-0039"]["extra"]["is_return_leg"] is True
        assert "This return's own leg" in legs["TR-0039"]["note"]
        assert legs["TR-0031"]["extra"]["is_return_leg"] is False
        assert legs["TR-0031"]["note"] == "LR 54ij"

    def test_a_quotation_carries_the_rfq_it_answers(self):
        """It has no screen of its own, so the row opens the comparison sheet.

        `rfq_id` on the row is what that link is built from — a quote opened alone says
        nothing, because its whole meaning is the prices it beat.
        """
        quotation = SimpleNamespace(id=23, quotation_no="QUO-0023", status="AWARDED",
                                    quotation_date=None, vendor_name="Acme",
                                    grand_total=1200, rfq_id=13, rfq_no="RFQ-0013")
        row = next(row for row in self._rows(quotations=[quotation])
                   if row["doc_type"] == TrailDocType.QUOTATION.value)
        assert row["extra"]["rfq_id"] == 13
        assert row["note"] == "Awarded · 1200"

    def test_a_qc_row_counts_only_the_lines_for_these_items(self):
        """"This GRN had a failure on it" is not "the item in front of me failed".

        An inspection covering eight lines can have failed one of them, and a row that
        reported the whole document's rejections would be answering a question nobody
        asked about material that is not coming back.
        """
        qc = SimpleNamespace(id=5, inspection_no="QC-0005", status="COMPLETED",
                             inspection_date=None, vendor_name="Acme",
                             warehouse_name="Central WH", receipt_id=4,
                             inspection_type="INCOMING")
        mine = SimpleNamespace(inspection_id=5, rejected_qty=3, result="FAILED")
        theirs = SimpleNamespace(inspection_id=6, rejected_qty=90, result="FAILED")
        row = next(row for row in self._rows(qcs=[qc], qc_items=[mine, theirs])
                   if row["doc_type"] == TrailDocType.QC.value)
        assert row["extra"]["rejected_qty"] == "3"
        assert row["note"] == "3 rejected on these items"


class TestWhoReadsTheTrail:
    """Who may read the history behind the returned MATERIAL, as opposed to the return.

    ADDED 2026-09-14. The trail is a dozen OTHER modules' documents — the purchase order,
    the vendor, the price, the GRN — and it was served to anybody holding `return.view`,
    which is everybody who can open a return at all. It is the decision desk's own code
    now: `return.decide`.

    Asserted off the route's resolved dependency graph rather than off the source text, so
    a route that imports `require_permission` and then stops applying it still fails here.
    Rule 6: the screen leaving the panel out is not the control.
    """

    def test_the_route_asks_for_the_deciding_code_not_the_viewing_one(self):
        route = next(r for r in returns_router.router.routes
                     if getattr(r, "path", None)
                     == "/api/returns/{return_id}/related-documents")
        codes = {value for dependency in route.dependant.dependencies
                 if dependency.call is not None
                 for cell in getattr(dependency.call, "__closure__", None) or ()
                 for value in [cell.cell_contents] if isinstance(value, str)}
        assert "return.decide" in codes, codes
        assert "return.view" not in codes, codes

    def test_a_request_with_no_user_at_all_reads_nothing(self):
        """The served flag is what the screen renders off, and its fail-closed default
        matters: a caller that cannot say who is asking is told no."""
        assert asyncio.run(service._may_read_trail(None, None)) is False


class TestTheTrailReadsAsChapters:
    """The six legs the trail is grouped under, and the two ways they fail silently.

    ADDED 2026-09-14. Eighteen document types in one flat list is a correct answer to
    "what is behind this item" and an unreadable one — the live desk was handed twenty-six
    numbered rows and had to know from each row's name whether a Requisition came before
    or after a GRN. The chapters are the question each run of documents answers.

    Both of these are silent in production if they drift. A doc type in no chapter
    vanishes off a screen that groups by chapter — the row is served, the heading it
    belongs under is not, and nobody is told a document went missing. And a chapter whose
    types are NOT contiguous in `TRAIL_ORDER` interleaves: the trail is sorted once, by
    trail order, and the screen relies on that sort to produce the chapters in blocks, so
    a stray type puts a second copy of a heading halfway down the list.
    """

    def test_every_document_type_on_the_trail_lands_in_a_chapter(self):
        assert set(CHAPTER_BY_DOC_TYPE) == set(TRAIL_LABELS)

    def test_no_document_type_is_claimed_by_two_chapters(self):
        claimed = [doc_type for chapter in TRAIL_CHAPTERS
                   for doc_type in chapter["doc_types"]]
        assert len(claimed) == len(set(claimed))

    def test_each_chapter_is_one_unbroken_run_of_the_trail_order(self):
        positions = [TRAIL_ORDER[doc_type] for chapter in TRAIL_CHAPTERS
                     for doc_type in chapter["doc_types"]]
        assert positions == list(range(len(TRAIL_ORDER)))

    def test_every_chapter_says_what_it_is_and_what_it_answers(self):
        """Wording is SERVED — the screen renders the heading it is sent and composes
        nothing — so an empty label is a blank heading on a live page."""
        for chapter in TRAIL_CHAPTERS:
            assert chapter["key"] and chapter["label"] and chapter["caption"], chapter


class TestTheRungIsNamedProperly:
    """What the desk is TOLD the material came off, against what it actually came off.

    ADDED 2026-09-12. The screen said "From LIP / MDB" and there is no such thing as an
    MDB in this system — `inventory.enums.LocationTier` has three rungs and they are
    WAREHOUSE, MDP and LIP. Worse than the misspelling: every MDP return is filed under
    `FROM_WAREHOUSE` by this function's own rule, so the bucket named for a distribution
    point never held one, and the bucket that holds all of them called itself "From
    warehouse" and said nothing about the rung at all. Both labels were wrong and a desk
    reading either was misinformed.

    The rule did not change — the stored categories are untouched and the register
    filters on them exactly as before. What changed is that the WORDS now match, and the
    rung actually resolved for the document is served beside the category, because two
    buckets cannot name three rungs no matter how they are spelled.
    """

    class _Result:
        def __init__(self, row):
            self._row = row

        def first(self):
            return self._row

    class _Db:
        """The one query `locations.describe_point` makes, answered from memory.

        A stub rather than a database because what is under test is the naming, and the
        naming must hold for a rung no fixture in this suite happens to have.
        """

        def __init__(self, warehouse_type, name):
            self._row = SimpleNamespace(warehouse_type=warehouse_type, name=name)

        async def execute(self, *_args, **_kwargs):
            return TestTheRungIsNamedProperly._Result(self._row)

    @staticmethod
    def _resolve(warehouse_type, name, *, qc=False):
        doc = _doc(reason=ReturnReason.EXPIRED.value)
        doc.from_warehouse_id = 12
        db = TestTheRungIsNamedProperly._Db(warehouse_type, name)
        return asyncio.run(service._purchase_return_source(db, doc, {"qc_rejected": qc}))

    def test_no_label_names_a_rung_the_system_does_not_have(self):
        """The misspelling itself, pinned so it cannot come back.

        MDB is not a warehouse type, not a `LocationTier`, and not a word anybody here
        uses for anything — it only ever existed in this one label.
        """
        for label in PURCHASE_RETURN_SOURCE_LABELS.values():
            assert "MDB" not in label.upper(), label

    def test_the_bucket_that_holds_mdp_returns_says_mdp(self):
        """An MDP return is filed under FROM_WAREHOUSE — so that label has to say so.

        This is the half that was wrong in the other direction: the rule sent every MDP
        return here, and the label mentioned only warehouses.
        """
        answer = self._resolve("MDP", "AP-104 Distribution Point")
        assert answer["category"] == "FROM_WAREHOUSE"
        assert "MDP" in answer["category_label"]
        # And the rung is still named exactly, because "warehouse / MDP" is two rungs.
        assert answer["source_tier"] == "MDP"
        assert answer["source_detail"] == (
            "AP-104 Distribution Point is a Material Distribution Point (MDP).")

    def test_the_lip_bucket_claims_only_lip(self):
        answer = self._resolve("LIP", "AP-104-MMU-Chilamathur")
        assert answer["category"] == "FROM_LIP_MDB"     # the stored string, unchanged
        assert answer["category_label"] == "From LIP"
        assert answer["source_tier"] == "LIP"
        assert answer["source_detail"] == (
            "AP-104-MMU-Chilamathur is a Local Inventory Point (LIP).")

    def test_a_main_warehouse_is_a_warehouse(self):
        answer = self._resolve("MAIN", "CENTRAL WAREHOUSE-1")
        assert answer["category"] == "FROM_WAREHOUSE"
        assert answer["source_tier"] == "WAREHOUSE"
        assert answer["source_is_resolved"] is True

    def test_the_words_come_from_inventory_not_from_here(self):
        """Rule: one place decides what a stocking point is called.

        A second copy of "LIP means Local Inventory Point" in this module is how a stock
        screen and a returns screen end up calling the same point two different things —
        which is the class of defect this whole test exists for.
        """
        from app.modules.inventory import locations
        from app.modules.inventory.enums import LocationTier

        answer = self._resolve("LIP", "Anywhere")
        assert answer["source_tier_label"] == locations.tier_label(LocationTier.LIP)
        assert answer["source_point_label"] == locations.POINT_LABEL["LIP"]

    def test_an_unidentifiable_point_reads_as_a_guess(self):
        """It is still filed as a branch return — the safe end — but it SAYS so.

        Unchanged behaviour, newly honest about itself: the category a desk acts on and
        the confidence behind it are two different facts, and stating the first without
        the second is what makes a fallback indistinguishable from a finding.
        """
        doc = _doc(reason=ReturnReason.EXPIRED.value)
        doc.from_warehouse_id = None
        answer = asyncio.run(
            service._purchase_return_source(None, doc, {"qc_rejected": False}))
        assert answer["category"] == "FROM_LIP_MDB"
        assert answer["source_is_resolved"] is False
        assert "could not be identified" in answer["source_detail"]

    def test_a_qc_rejection_says_why_the_rung_did_not_decide(self):
        # The material never reached a shelf, so naming the rung it would have sat on
        # would be describing a journey it never made.
        answer = self._resolve("LIP", "AP-104-MMU-Chilamathur", qc=True)
        assert answer["category"] == "QC_REJECTED_GRN"
        assert "does not decide this" in answer["source_detail"]


class TestTheTrailSaysWhereItStopped:
    """A capped list that admits it, against one that quietly ends.

    ADDED 2026-09-12 alongside raising the per-kind cap from 5 to 25. Five was chosen
    when the trail named one kind of document; with every kind on it, an indent served
    in rounds was being cut off mid-story with nothing said — and a reader cannot tell a
    complete trail from a truncated one by looking at it.
    """

    @staticmethod
    def _rows(doc_type, count):
        return [{"doc_type": doc_type, "doc_label": f"{doc_type} label"}
                for _ in range(count)]

    def test_a_short_trail_says_nothing(self):
        # The normal case. A permanent "there may be more" would read as one.
        assert service._cap_note(self._rows("MATERIAL_ISSUE", 3)) is None

    def test_a_kind_that_came_back_full_is_named(self):
        note = service._cap_note(self._rows("MATERIAL_ISSUE", service.CHAIN_LIMIT))
        assert note is not None
        assert str(service.CHAIN_LIMIT) in note
        assert "MATERIAL_ISSUE label" in note

    def test_only_the_kinds_that_filled_up_are_named(self):
        rows = (self._rows("MATERIAL_ISSUE", service.CHAIN_LIMIT)
                + self._rows("INDENT", 1))
        note = service._cap_note(rows)
        assert "MATERIAL_ISSUE label" in note
        assert "INDENT label" not in note


class TestReasonsPerItem:
    """SCM_0129: each item says why it is going back, and its rows add up to its quantity."""

    def _write(self, *lines):
        return ReturnWrite(items=[
            ReturnLineIn(item_id=item_id, quantity=str(qty),
                         reasons=[{"reason": r.value, "quantity": str(q), "note": note}
                                  for r, q, note in rows])
            for item_id, qty, rows in lines])

    def _check(self, write):
        total = service._total_qty(write.items)
        service._assert_reasons(service._reason_rows(write, total), total, lines=write.items)

    def test_each_item_covered_by_its_own_reasons_passes(self):
        self._check(self._write(
            (1, 5, [(ReturnReason.DAMAGED, 3, None), (ReturnReason.EXPIRED, 2, None)]),
            (2, 4, [(ReturnReason.DAMAGED, 4, None)])))

    def test_an_item_whose_reasons_fall_short_is_refused_and_named(self):
        write = self._write((1, 5, [(ReturnReason.DAMAGED, 3, None)]),
                            (2, 4, [(ReturnReason.DAMAGED, 4, None)]))
        with pytest.raises(ValidationError, match="add up to 3"):
            self._check(write)

    def test_an_item_with_no_reason_is_refused_when_another_has_one(self):
        write = self._write((1, 5, [(ReturnReason.DAMAGED, 5, None)]), (2, 4, []))
        with pytest.raises(ValidationError):
            self._check(write)

    def test_the_same_reason_on_two_items_is_fine(self):
        rows = service._reason_rows(self._write(
            (1, 2, [(ReturnReason.EXPIRED, 2, None)]),
            (2, 3, [(ReturnReason.EXPIRED, 3, None)])), Decimal("5"))
        assert {(r["item_id"], r["quantity"]) for r in rows} == {(1, 2.0), (2, 3.0)}

    def test_other_on_an_item_still_needs_a_note(self):
        with pytest.raises(ValidationError):
            self._check(self._write((1, 2, [(ReturnReason.OTHER, 2, None)])))
        self._check(self._write((1, 2, [(ReturnReason.OTHER, 2, "rats")])))

    def test_two_lines_of_one_item_merge_their_reasons(self):
        write = self._write((1, 2, [(ReturnReason.DAMAGED, 2, None)]),
                            (1, 3, [(ReturnReason.DAMAGED, 3, None)]))
        rows = service._reason_rows(write, Decimal("5"))
        assert rows == [{"reason": "DAMAGED", "quantity": 5.0, "note": None, "item_id": 1}]
        self._check(write)

    def test_the_main_reason_adds_units_across_items(self):
        rows = [{"reason": "DAMAGED", "quantity": 3, "item_id": 1},
                {"reason": "DAMAGED", "quantity": 3, "item_id": 2},
                {"reason": "EXPIRED", "quantity": 4, "item_id": 3}]
        assert service._main_reason(rows) == "DAMAGED"

    def test_stored_per_item_rows_validate_against_stored_lines(self):
        class Line:
            def __init__(self, item_id, qty):
                self.item_id, self.requested_qty, self.item_code = item_id, qty, f"IT{item_id}"
        lines = [Line(1, Decimal("5"))]
        rows = [{"reason": "DAMAGED", "quantity": 5.0, "note": None, "item_id": 1}]
        service._assert_reasons(rows, Decimal("5"), lines=lines)
        with pytest.raises(ValidationError, match="IT1"):
            service._assert_reasons([{**rows[0], "quantity": 4.0}], Decimal("5"), lines=lines)
