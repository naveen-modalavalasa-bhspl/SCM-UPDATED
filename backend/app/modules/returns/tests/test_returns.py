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
from fastapi import FastAPI

from app.core.exceptions import ValidationError
from app.modules.returns import router as returns_router
from app.modules.returns import service
from app.modules.returns.enums import (
    AWAITING_ACK, CLOSED, EDITABLE, HOLDING_STOCK, PHASES, REASON_LABELS,
    SELECTABLE_REASONS, ReturnDocType, ReturnReason, ReturnStatus,
)
from app.modules.returns.schemas import ReturnLineIn, ReturnWrite


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
        # Declared here, not in shared/enums.py: the engine takes a string, so naming a
        # document needs no edit to a file this module does not own.
        from app.shared.enums import DocType

        assert ReturnDocType.STOCK_RETURN.value not in {d.value for d in DocType}

    def test_only_a_draft_is_editable_and_only_approval_holds_stock(self):
        assert EDITABLE == {ReturnStatus.DRAFT.value}
        assert HOLDING_STOCK == {ReturnStatus.PENDING_APPROVAL.value}
        # An approved or rejected return must never be edited or re-released.
        assert ReturnStatus.APPROVED.value not in EDITABLE | HOLDING_STOCK
        assert ReturnStatus.REJECTED.value not in EDITABLE | HOLDING_STOCK

    def test_only_an_approved_return_is_waiting_to_be_acknowledged(self):
        # The stock has moved but nobody has confirmed it. Acknowledging anything else
        # would close a document that never happened.
        assert AWAITING_ACK == {ReturnStatus.APPROVED.value}
        assert ReturnStatus.RECEIVED.value in CLOSED
        assert not AWAITING_ACK & CLOSED

    def test_the_legs_are_the_ones_the_stepper_draws(self):
        assert [key for key, _label in PHASES] == [
            "draft", "submitted", "approvals", "decision", "endorsement", "movement",
            "acknowledged",
        ]

    def test_the_two_desks_sit_between_the_field_chain_and_the_stock_moving(self):
        # The whole point of the legs: the decision desk and the floor look at the return
        # BEFORE the material moves, exactly as inventory and the warehouse do on an
        # indent. Collapsing the two was what made the tracker unable to say who was
        # holding it.
        keys = [key for key, _label in PHASES]
        assert (keys.index("approvals") < keys.index("decision")
                < keys.index("endorsement") < keys.index("movement"))

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
    def _write(self, reason, note=None):
        return ReturnWrite(reason=reason, reason_note=note,
                           items=[ReturnLineIn(item_id=1, quantity="1")])

    def test_other_without_a_note_is_refused(self):
        with pytest.raises(ValidationError):
            service._assert_reason_stated(self._write(ReturnReason.OTHER))

    def test_other_with_a_note_is_fine(self):
        service._assert_reason_stated(
            self._write(ReturnReason.OTHER, "chewed by rats"))

    def test_every_other_reason_describes_itself(self):
        service._assert_reason_stated(self._write(ReturnReason.EXPIRED))


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
            assert codes <= {
                "stock.view", "stock.transfer", "stock.transfer.approve",
                # Configuring who signs after the reporting line is an approvals-config
                # job, not a stock one — same code the Approvals Config screen uses.
                "admin.workflow.manage",
            }, f"{route.path} gates on an unexpected code: {codes}"

        assert ungated == ["GET /api/returns/options/reasons"], ungated

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
            "admin.workflow.manage"}
        assert writes[("GET", "/api/returns/config/receiving")] == {"stock.view"}
        assert writes[("GET", "/api/returns/config/positions")] == {
            "admin.workflow.manage"}
