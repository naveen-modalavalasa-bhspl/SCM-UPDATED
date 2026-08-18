"""The consignment -> transport -> dispatch -> acknowledgement flow, end to end.

What is pinned here is the shape of the merged document: dispatch is a STAGE of a
transport request, an award is an offer until the carrier accepts it, and delivered is
the carrier's word while acknowledged is the site's. Each of those is a rule somebody
will be tempted to shortcut, and each one is a real-world failure if they do:

  * a shipment loaded against a carrier who never confirmed
  * an indent closed on a delivery nobody at the site ever signed for
  * a shortage reported by the site that never reaches the claims desk

Two carriers are set up in most tests on purpose: "this carrier can only see and act on
their own jobs" is the entire authorisation model of the portal, so it is tested rather
than assumed.
"""
import pytest

from app.core.exceptions import NotFoundError, ValidationError
from app.modules.logistics import transport
from app.modules.logistics.enums import (
    AckCondition, QuoteStatus, TransportMode, TransportStatus, flow_stages,
)
from app.modules.logistics.schemas import (
    AcknowledgeIn, AwardIn, CarrierAcceptIn, CarrierDeclineIn, CarrierTrackIn,
    DeliverIn, DispatchIn, InviteIn, QuoteIn, TRCreate, TRLineIn,
)
from app.platform.hcm.models import HcmEmployee
from app.platform.rbac.models import Role, UserRole
from app.shared.enums import ApprovalAction
from app.shared.models.base import utcnow
from app.shared.models.master import Vendor


class World:
    """The four parties in every one of these tests."""

    def __init__(self, desk, head, fast, cheap):
        self.desk, self.head, self.fast, self.cheap = desk, head, fast, cheap


async def _world(db) -> World:
    """A logistics desk, an approver, and two transport vendors.

    The approver holds ADMIN because no workflow is configured in a test database:
    the engine's fallback catches the document on the admin safety net rather than
    stranding it (rule 8), which is the same path a live database with a missing
    ladder takes. Approving as this person is therefore the REAL flow, not a shortcut
    around it.
    """
    desk = HcmEmployee(id=91, full_name="Logi Desk", emp_code="E91",
                       is_active=True, synced_at=utcnow())
    head = HcmEmployee(id=92, full_name="SCM Head", emp_code="E92",
                       is_active=True, synced_at=utcnow())
    admin = Role(code="ADMIN", name="Administrator", is_active=True)
    fast = Vendor(code="TR-1", name="Fast Freight", vendor_type="TRANSPORT",
                  is_active=True, is_blacklisted=False)
    cheap = Vendor(code="TR-2", name="Cheap Cartage", vendor_type="TRANSPORT",
                   is_active=True, is_blacklisted=False)
    db.add_all([desk, head, admin, fast, cheap])
    await db.flush()
    db.add(UserRole(employee_id=head.id, role_id=admin.id))
    await db.commit()
    return World(desk, head, fast, cheap)


def _payload(mode=TransportMode.THIRD_PARTY.value, **over):
    body = dict(
        mode=mode,
        dispatch_id=4242, consignment_no="CN/2026/0042",
        source_type="CONSIGNMENT", source_id=4242, source_no="CN/2026/0042",
        indent_no="IND/2026/0007",
        from_warehouse_name="Central WH", to_location_name="Kurnool LIP",
        lines=[TRLineIn(item_name="Gloves", quantity=5, package_count=2,
                        weight_kg=18, length_cm=40, width_cm=30, height_cm=20)],
    )
    body.update(over)
    return TRCreate(**body)


async def _approved(db, w: World, mode=TransportMode.THIRD_PARTY.value, **over):
    """A request raised, submitted and signed off.

    A tendered mode lands on QUOTING from here; every other mode lands on READY.
    """
    doc = await transport.create_tr(db, _payload(mode, **over), w.desk)
    doc = await transport.submit_tr(db, doc.id, w.desk)
    if doc.status == TransportStatus.PENDING_APPROVAL.value:
        doc = await transport.act_on_tr(
            db, doc.id, ApprovalAction.APPROVED.value, w.head)
    return doc


async def _awarded(db, w: World):
    """Tendered, quoted by both carriers, awarded to the cheaper one and signed off.

    The award has its own approval — it commits freight — so the sign-off here is a
    second, separate one and not a repeat of the movement's.
    """
    doc = await _approved(db, w)
    await transport.invite_carriers(
        db, doc.id, InviteIn(carrier_ids=[w.fast.id, w.cheap.id]), w.desk)
    await transport.record_quote(db, doc.id, w.fast.id,
                                 QuoteIn(freight_amount=9000, transit_days=2), w.desk)
    await transport.record_quote(db, doc.id, w.cheap.id,
                                 QuoteIn(freight_amount=6000, transit_days=4), w.desk)
    winner = next(q for q in doc.quotes if q.carrier_id == w.cheap.id)
    doc = await transport.award_carrier(db, doc.id, AwardIn(quote_id=winner.id), w.desk)
    if doc.status == TransportStatus.QUOTING.value:
        doc = await transport.act_on_award(
            db, doc.id, ApprovalAction.APPROVED.value, w.head)
    return doc


# --------------------------------------------------------------------------- #
#  The consignment link
# --------------------------------------------------------------------------- #

async def test_the_request_remembers_which_consignment_it_carries(db):
    w = await _world(db)
    doc = await transport.create_tr(db, _payload(), w.desk)

    assert doc.dispatch_id == 4242
    # Snapshotted, not joined: warehouse sits after logistics in the import chain, so
    # the register has to read without reaching into out_dispatches.
    assert doc.consignment_no == "CN/2026/0042"

    links = await transport.for_consignments(db, [4242, 9999])
    assert [link["dispatch_id"] for link in links] == [4242]
    assert links[0]["tr_no"] == doc.tr_no


async def test_a_reraised_leg_wins_over_the_cancelled_one(db):
    """A cancelled attempt followed by a re-raise must show the re-raise."""
    w = await _world(db)
    first = await transport.create_tr(db, _payload(), w.desk)
    await transport.cancel_tr(db, first.id, w.desk, "truck fell through")
    second = await transport.create_tr(db, _payload(), w.desk)

    links = await transport.for_consignments(db, [4242])
    assert len(links) == 1
    assert links[0]["tr_no"] == second.tr_no


async def test_asking_about_no_consignments_costs_no_query(db):
    await _world(db)
    assert await transport.for_consignments(db, []) == []


# --------------------------------------------------------------------------- #
#  The carrier's answer
# --------------------------------------------------------------------------- #

async def test_an_award_is_an_offer_until_the_carrier_accepts(db):
    w = await _world(db)
    doc = await _awarded(db, w)

    # Not READY: nothing may be loaded against a carrier who has not confirmed.
    assert doc.status == TransportStatus.AWAITING_CARRIER.value
    assert doc.carrier_name == "Cheap Cartage"
    assert doc.carrier_accepted_at is None

    with pytest.raises(ValidationError, match="not ready to leave"):
        await transport.dispatch_tr(db, doc.id, DispatchIn(lr_no="LR-1"), w.desk)


async def test_the_carrier_accepting_makes_it_ready(db):
    w = await _world(db)
    doc = await _awarded(db, w)

    doc = await transport.carrier_accept(
        db, w.cheap.id, doc.id, CarrierAcceptIn(carrier_reference="BK-77"))

    assert doc.status == TransportStatus.READY.value
    assert doc.carrier_accepted_at is not None
    assert doc.carrier_reference == "BK-77"
    # Nobody at the desk claimed this: it came from the carrier's own portal.
    assert doc.carrier_confirmed_by_name is None


async def test_another_carrier_cannot_touch_the_job_once_it_is_awarded(db):
    w = await _world(db)
    doc = await _awarded(db, w)

    # `fast` was invited to the tender, so it could read this request while it was out
    # to quote. The award ends that: past it the shipment belongs to whoever won it,
    # and the refusal is the same "does not exist to you" an uninvited carrier gets —
    # telling them apart tells an outsider whose truck is running which lane.
    for act in (
        transport.carrier_accept(db, w.fast.id, doc.id, CarrierAcceptIn()),
        transport.carrier_deliver(db, w.fast.id, doc.id, DeliverIn()),
    ):
        with pytest.raises(NotFoundError, match="not open to you"):
            await act


async def test_a_carrier_never_invited_cannot_see_the_job_at_all(db):
    w = await _world(db)
    doc = await _approved(db, w)
    await transport.invite_carriers(db, doc.id, InviteIn(carrier_ids=[w.fast.id]), w.desk)

    with pytest.raises(NotFoundError, match="not open to you"):
        await transport.carrier_get_request(db, w.cheap.id, doc.id)


async def test_declining_puts_it_back_out_to_the_others(db):
    w = await _world(db)
    doc = await _awarded(db, w)
    tr_id = doc.id

    view = await transport.carrier_decline(
        db, w.cheap.id, tr_id, CarrierDeclineIn(reason="No vehicle on that lane"))

    assert view.status == TransportStatus.QUOTING.value
    assert view.carrier_id is None and view.freight_amount is None
    assert view.carrier_decline_reason == "No vehicle on that lane"
    # What the PORTAL hands back is narrowed to the caller's own quote and nobody
    # else's (`_carrier_view`): a tender where every bidder can read what the others
    # bid is not a tender. So the decliner sees their row marked DECLINED and no more.
    assert [q.carrier_id for q in view.quotes] == [w.cheap.id]
    assert view.quotes[0].status == QuoteStatus.DECLINED.value

    # The DESK's read is the one that carries the whole sheet, and it is the one that
    # matters here: the loser's price survives as SUBMITTED — awarding requires a
    # SUBMITTED quote, so leaving it NOT_AWARDED would drop the shipment back into a
    # tender where not one price on file could be awarded to anybody — while the
    # decliner's is marked as what it is, so the next award does not hand it back.
    doc = await transport.get_tr(db, tr_id)
    by_carrier = {q.carrier_id: q.status for q in doc.quotes}
    assert by_carrier[w.cheap.id] == QuoteStatus.DECLINED.value
    assert by_carrier[w.fast.id] == QuoteStatus.SUBMITTED.value


async def test_the_desk_can_confirm_a_phone_call_but_it_is_recorded_as_one(db):
    w = await _world(db)
    doc = await _awarded(db, w)

    doc = await transport.accept_award(db, doc.id, None, "BK-88", w.desk,
                                       confirmed_by_desk="Suresh at Cheap Cartage")

    assert doc.status == TransportStatus.READY.value
    assert doc.carrier_confirmed_by_name == "Suresh at Cheap Cartage"


async def test_an_untendered_mode_never_waits_for_a_carrier(db):
    """A hand-over has nobody to hear back from. It must not sit in a queue for it."""
    w = await _world(db)
    doc = await _approved(db, w, mode=TransportMode.DIRECT.value,
                          handed_over_by_name="Ravi", received_by_name="Site")
    assert doc.status == TransportStatus.READY.value


# --------------------------------------------------------------------------- #
#  Dispatch — a stage, not a second document
# --------------------------------------------------------------------------- #

async def test_dispatch_records_the_gate_pass_on_the_same_document(db):
    w = await _world(db)
    doc = await _awarded(db, w)
    await transport.carrier_accept(db, w.cheap.id, doc.id, CarrierAcceptIn())

    doc = await transport.dispatch_tr(
        db, doc.id, DispatchIn(lr_no="LR-9001", gate_pass_no="GP-12",
                               eway_bill_no="EWB-5"), w.desk)

    assert doc.status == TransportStatus.IN_TRANSIT.value
    assert (doc.gate_pass_no, doc.lr_no, doc.eway_bill_no) == ("GP-12", "LR-9001", "EWB-5")
    assert doc.dispatched_by_name == "Logi Desk"
    assert doc.dispatched_at is not None
    # Leaving the yard is itself the first custody event.
    assert doc.events[0].event_type == "PICKED_UP"


async def test_a_hired_truck_cannot_leave_without_an_lr(db):
    w = await _world(db)
    doc = await _awarded(db, w)
    await transport.carrier_accept(db, w.cheap.id, doc.id, CarrierAcceptIn())

    with pytest.raises(ValidationError, match="LR or docket"):
        await transport.dispatch_tr(db, doc.id, DispatchIn(gate_pass_no="GP-1"), w.desk)


# --------------------------------------------------------------------------- #
#  Acknowledgement — the site's word, not the carrier's
# --------------------------------------------------------------------------- #

async def _delivered(db, w: World):
    doc = await _awarded(db, w)
    await transport.carrier_accept(db, w.cheap.id, doc.id, CarrierAcceptIn())
    await transport.dispatch_tr(db, doc.id, DispatchIn(lr_no="LR-1"), w.desk)
    return await transport.carrier_deliver(
        db, w.cheap.id, doc.id, DeliverIn(delivered_to_name="Gate"))


async def test_the_carrier_reports_delivered_and_stops_there(db):
    w = await _world(db)
    doc = await _delivered(db, w)

    # DELIVERED, never ACKNOWLEDGED: a carrier signing off its own delivery is the
    # signature a shortage claim would need to be missing.
    assert doc.status == TransportStatus.DELIVERED.value
    assert doc.acknowledged_at is None


async def test_the_site_signing_for_it_closes_the_loop(db):
    w = await _world(db)
    doc = await _delivered(db, w)

    doc = await transport.acknowledge_tr(
        db, doc.id, AcknowledgeIn(acknowledged_by_name="Site Nurse",
                                  condition=AckCondition.GOOD.value), w.desk)

    assert doc.status == TransportStatus.ACKNOWLEDGED.value
    assert doc.acknowledged_by_name == "Site Nurse"
    assert not [e for e in doc.events if e.is_exception]


async def test_a_short_delivery_raises_a_claim_on_the_same_timeline(db):
    w = await _world(db)
    doc = await _delivered(db, w)

    doc = await transport.acknowledge_tr(db, doc.id, AcknowledgeIn(
        condition=AckCondition.SHORT.value, remarks="One carton missing",
        affected_item_name="Gloves", affected_qty=2, claim_amount=1500), w.desk)

    claims = [e for e in doc.events if e.is_exception and e.resolved_at is None]
    assert len(claims) == 1
    assert claims[0].event_type == "MISSING"
    assert claims[0].affected_item_name == "Gloves"

    # And the open claim blocks the close, so a shortage cannot be filed away by
    # closing the shipment on top of it.
    with pytest.raises(ValidationError, match="open claim"):
        await transport.close_tr(db, doc.id, w.desk)


async def test_a_shortage_must_say_what_was_short(db):
    w = await _world(db)
    doc = await _delivered(db, w)

    with pytest.raises(ValidationError, match="short or damaged"):
        await transport.acknowledge_tr(
            db, doc.id, AcknowledgeIn(condition=AckCondition.SHORT.value), w.desk)


async def test_nothing_undelivered_can_be_acknowledged(db):
    w = await _world(db)
    doc = await _approved(db, w, mode=TransportMode.DIRECT.value,
                          handed_over_by_name="Ravi", received_by_name="Site")

    with pytest.raises(ValidationError, match="only a delivered"):
        await transport.acknowledge_tr(db, doc.id, AcknowledgeIn(), w.desk)


async def test_it_cannot_be_signed_for_twice(db):
    w = await _world(db)
    doc = await _delivered(db, w)
    await transport.acknowledge_tr(db, doc.id, AcknowledgeIn(), w.desk)

    with pytest.raises(ValidationError, match="already been acknowledged"):
        await transport.acknowledge_tr(db, doc.id, AcknowledgeIn(), w.desk)


async def test_an_acknowledged_shipment_closes(db):
    w = await _world(db)
    doc = await _delivered(db, w)
    await transport.acknowledge_tr(db, doc.id, AcknowledgeIn(), w.desk)

    doc = await transport.close_tr(db, doc.id, w.desk)
    assert doc.status == TransportStatus.CLOSED.value


async def test_a_shipment_that_has_landed_can_no_longer_be_cancelled(db):
    w = await _world(db)
    doc = await _delivered(db, w)
    await transport.acknowledge_tr(db, doc.id, AcknowledgeIn(), w.desk)

    with pytest.raises(ValidationError, match="already left"):
        await transport.cancel_tr(db, doc.id, w.desk, "changed our mind")


# --------------------------------------------------------------------------- #
#  The carrier's board
# --------------------------------------------------------------------------- #

async def test_a_carrier_sees_their_own_queues_and_only_theirs(db):
    w = await _world(db)
    doc = await _awarded(db, w)

    winner = await transport.carrier_summary(db, w.cheap.id)
    loser = await transport.carrier_summary(db, w.fast.id)

    assert winner["to_confirm"] == 1
    assert loser["to_confirm"] == 0
    # Both were invited and both answered, so neither has an open invitation left.
    assert winner["to_quote"] == loser["to_quote"] == 0

    await transport.carrier_accept(db, w.cheap.id, doc.id, CarrierAcceptIn())
    assert (await transport.carrier_summary(db, w.cheap.id))["to_pick_up"] == 1


async def test_a_carrier_filter_cannot_widen_what_the_portal_shows(db):
    """The status filter narrows a carrier's own board; it must never open a door."""
    from app.core.pagination import PageParams

    w = await _world(db)
    doc = await _approved(db, w)
    await transport.invite_carriers(db, doc.id, InviteIn(carrier_ids=[w.fast.id]), w.desk)

    page = await transport.carrier_open_requests(
        db, w.fast.id, PageParams(page=1, size=20), status="DRAFT,PENDING_APPROVAL")
    assert page["total"] == 0

    # The tender they WERE invited to is still theirs to see.
    open_board = await transport.carrier_open_requests(
        db, w.fast.id, PageParams(page=1, size=20))
    assert [row.id for row in open_board["items"]] == [doc.id]


async def test_a_carrier_scan_lands_on_the_same_timeline_as_the_desks(db):
    w = await _world(db)
    doc = await _awarded(db, w)
    await transport.carrier_accept(db, w.cheap.id, doc.id, CarrierAcceptIn())
    await transport.dispatch_tr(db, doc.id, DispatchIn(lr_no="LR-1"), w.desk)

    doc = await transport.carrier_track(db, w.cheap.id, doc.id, CarrierTrackIn(
        event_type="IN_TRANSIT", location_name="Guntur", description="Crossed Guntur"))

    types = [e.event_type for e in doc.events]
    assert types == ["PICKED_UP", "IN_TRANSIT"]
    # A carrier cannot raise a claim against itself.
    assert not any(e.is_exception for e in doc.events)


# --------------------------------------------------------------------------- #
#  The flow the screen draws
# --------------------------------------------------------------------------- #

def test_only_a_tendered_mode_has_a_tender_and_a_confirmation_stage():
    tendered = [s.key for s in flow_stages(TransportMode.THIRD_PARTY.value)]
    handover = [s.key for s in flow_stages(TransportMode.DIRECT.value)]

    assert tendered == ["PLAN", "APPROVE", "TENDER", "CONFIRM", "DISPATCH",
                        "TRANSIT", "DELIVERED", "ACKNOWLEDGE"]
    assert "TENDER" not in handover and "CONFIRM" not in handover
    # Both end at the signature: every mode is acknowledged by the receiving site.
    assert handover[-1] == "ACKNOWLEDGE"


def test_every_stage_names_a_status_the_flow_can_actually_be_in():
    known = {s.value for s in TransportStatus}
    for mode in (TransportMode.THIRD_PARTY.value, TransportMode.COURIER.value):
        for stage in flow_stages(mode):
            assert set(stage.statuses) <= known, stage.key


def test_the_stepper_covers_every_status_a_live_shipment_can_hold():
    """A status no stage claims is a shipment the stepper cannot draw."""
    covered = {s for stage in flow_stages(TransportMode.THIRD_PARTY.value)
               for s in stage.statuses}
    live = {s.value for s in TransportStatus} - {
        TransportStatus.REJECTED.value, TransportStatus.CANCELLED.value}
    assert live <= covered
