"""Road distances for the load planner, and the trip views logistics serves.

Pure: no database, no network. The routing service is an `httpx.MockTransport`, and
the trip rows are plain namespaces shaped like the ORM rows.
"""
from datetime import datetime
from types import SimpleNamespace

import httpx
import pytest

from app.modules.logistics import routing, transport
from app.modules.logistics.enums import ShipmentEventType, TripStopStatus

VIJAYAWADA = (16.5062, 80.6480)
GUNTUR = (16.3067, 80.4365)
ONGOLE = (15.5057, 80.0499)


def test_an_estimate_is_straight_line_times_the_factor_and_says_so():
    matrix = routing.estimate_matrix(1.3)
    straight = routing.straight_km(VIJAYAWADA, GUNTUR)
    assert abs(matrix(VIJAYAWADA, GUNTUR) - straight * 1.3) < 1e-9
    assert matrix(VIJAYAWADA, VIJAYAWADA) == 0
    assert matrix.leg_basis(VIJAYAWADA, GUNTUR) == "ESTIMATE"
    assert matrix.basis_of([VIJAYAWADA, GUNTUR, VIJAYAWADA]) == "ESTIMATE"
    assert "Estimated" in matrix.describe()["text"]


def test_a_routed_leg_wins_and_its_reverse_stands_in_for_the_road_back():
    here, there = routing.point_key(VIJAYAWADA), routing.point_key(GUNTUR)
    matrix = routing.DistanceMatrix(road_factor=1.22, road={(here, there): 36.4})
    assert matrix(VIJAYAWADA, GUNTUR) == 36.4
    # No answer for the way back: the road there is a better guess than a straight line.
    assert matrix(GUNTUR, VIJAYAWADA) == 36.4
    assert matrix.basis_of([VIJAYAWADA, GUNTUR, VIJAYAWADA]) == "ROAD"
    assert matrix.basis_of([VIJAYAWADA, GUNTUR, ONGOLE]) == "MIXED"


def test_pairs_are_keyed_to_five_decimals():
    assert routing.pair_key((16.5062001, 80.64800049), (1, 2)) == \
        "16.50620,80.64800>1.00000,2.00000"


def _osrm(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_the_osrm_table_is_read_in_kilometres_and_no_route_is_not_zero(monkeypatch):
    monkeypatch.setattr(routing.settings, "ROUTING_OSRM_URL", "http://osrm.test")
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        # sources: V ; destinations: G, O. O is unreachable (null).
        return httpx.Response(200, json={"code": "Ok", "distances": [[36400.0, None]],
                                         "durations": [[2700.0, None]]})

    async with _osrm(handler) as client:
        found = await routing._osrm_block(client, [VIJAYAWADA], [GUNTUR, ONGOLE])
    assert "/table/v1/driving/80.64800,16.50620;80.43650,16.30670;80.04990,15.50570" in seen["url"]
    assert found == {(VIJAYAWADA, GUNTUR): (36.4, 45.0)}   # Ongole left out, not 0 km


@pytest.mark.asyncio
async def test_a_service_error_is_an_error_and_opens_the_breaker(monkeypatch):
    monkeypatch.setattr(routing.settings, "ROUTING_OSRM_URL", "http://osrm.test")
    monkeypatch.setattr(routing, "_breaker_open_until", 0.0)

    async def broken(client, sources, targets):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(routing, "_osrm_block", broken)
    missing = {(routing.point_key(VIJAYAWADA), routing.point_key(GUNTUR))}
    found, error = await routing._fetch(missing)
    assert found == {} and error == "unreachable"
    # The next request does not wait on a service that just failed.
    found, error = await routing._fetch(missing)
    assert found == {} and "recent failure" in error


@pytest.mark.asyncio
async def test_nothing_is_asked_when_no_service_is_configured(monkeypatch):
    monkeypatch.setattr(routing.settings, "ROUTING_OSRM_URL", None)
    assert await routing._fetch({(VIJAYAWADA, GUNTUR)}) == ({}, None)


# --------------------------------------------------------------------------- #
#  The trip, as the raiser and the carrier read it
# --------------------------------------------------------------------------- #

def _stop(stop_id, sequence, name, status):
    return SimpleNamespace(id=stop_id, sequence=sequence, destination_name=name,
                           destination_code=f"LIP-{stop_id}", delivery_address=f"{name} PHC",
                           contact_person=None, contact_phone="9000000000",
                           latitude=1, longitude=2, status=status,
                           distance_from_previous_km=10, total_packages=2,
                           total_weight_kg=20, delivered_at=None, received_by_name=None,
                           delivered_via=None, pod_url=None, consignments=[])


def _trip(*stops):
    return SimpleNamespace(id=7, trip_no="TRIP-0007", status="PARTIALLY_DELIVERED",
                           total_stops=len(stops), stops=list(stops),
                           from_warehouse_name="Central", departure_date=None,
                           distance_basis="ROAD")


def _view(status="IN_TRANSIT", events=()):
    return {"status": status, "delivered_at": None, "events": list(events)}


def test_the_raiser_reads_their_own_stop_not_the_whole_truck():
    first = _stop(1, 1, "Guntur", TripStopStatus.DELIVERED.value)
    mine = _stop(2, 2, "Ongole", TripStopStatus.IN_TRANSIT.value)
    last = _stop(3, 3, "Nellore", TripStopStatus.IN_TRANSIT.value)
    link = SimpleNamespace(stop_id=2, status=TripStopStatus.IN_TRANSIT.value,
                           dispatch_id=11, consignment_no="DSP-11",
                           destination_name="Ongole", delivered_at=None,
                           acknowledged_at=None, ack_condition=None)
    events = [
        {"event_type": ShipmentEventType.STOP_DELIVERED.value, "location_name": "Guntur"},
        {"event_type": "IN_TRANSIT", "location_name": "NH16"},
    ]
    view = transport.trip_raiser_view(_view(events=events), link, _trip(first, mine, last))
    assert view["stop_sequence"] == 2 and view["total_stops"] == 3
    assert view["stops_before_yours"] == 0          # Guntur is done: they are next
    assert view["next_stop_name"] == "Ongole"
    # Another site's delivery is not on their timeline.
    assert [e["location_name"] for e in view["events"]] == ["NH16"]

    # Their stop put down while the truck runs on: the card says delivered.
    link.status = TripStopStatus.DELIVERED.value
    mine.status = TripStopStatus.DELIVERED.value
    view = transport.trip_raiser_view(_view(), link, _trip(first, mine, last))
    assert view["status"] == "DELIVERED" and view["shipment_status"] == "IN_TRANSIT"


def test_a_stop_still_behind_others_counts_them():
    stops = [_stop(i, i, f"S{i}", TripStopStatus.IN_TRANSIT.value) for i in (1, 2, 3)]
    link = SimpleNamespace(stop_id=3, status=TripStopStatus.IN_TRANSIT.value,
                           dispatch_id=1, consignment_no="DSP-1", destination_name="S3",
                           delivered_at=None, acknowledged_at=None, ack_condition=None)
    view = transport.trip_raiser_view(_view(), link, _trip(*stops))
    assert view["stops_before_yours"] == 2 and view["next_stop_name"] == "S1"


def test_the_carrier_brief_lists_stops_in_order_with_the_next_one_named():
    delivered = _stop(5, 1, "Guntur", TripStopStatus.DELIVERED.value)
    delivered.delivered_at = datetime(2026, 9, 27, 10, 0)
    ahead = _stop(6, 2, "Ongole", TripStopStatus.IN_TRANSIT.value)
    brief = transport.trip_brief(_trip(ahead, delivered))
    assert [row["sequence"] for row in brief["stops"]] == [1, 2]
    assert brief["next_stop_id"] == 6 and brief["stops_delivered"] == 1
    assert brief["stops"][1]["contact_phone"] == "9000000000"
