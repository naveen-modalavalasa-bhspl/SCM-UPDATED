"""The Smart Load Planner's arithmetic and the trip roll-up — pure, no database.

Real Andhra Pradesh geography, because "is it on the way" is the whole question: the
origin is Vijayawada; Guntur, Ongole and Nellore run south down NH16; Kakinada and
Visakhapatnam run north-east; Kurnool is out west on its own.
"""
from types import SimpleNamespace

from app.modules.logistics.enums import TripStatus, TripStopStatus
from app.modules.warehouse import trips
from app.modules.warehouse.enums import DispatchStatus
from app.modules.warehouse.geocoding import locality_from_warehouse

VIJAYAWADA = (16.5062, 80.6480)
PLACES = {
    "Guntur": (16.3067, 80.4365),
    "Ongole": (15.5057, 80.0499),
    "Nellore": (14.4426, 79.9865),
    "Kakinada": (16.9891, 82.2475),
    "Visakhapatnam": (17.6868, 83.2185),
    "Kurnool": (15.8281, 78.0373),
}
DEST_IDS = {name: index for index, name in enumerate(PLACES, 1)}


def drop(dispatch_id, place, weight=100.0, packages=2, policy=None):
    lat, lon = PLACES[place]
    road = (policy or POLICY).road_factor
    return trips.Drop(
        dispatch_id=dispatch_id, consignment_no=f"CON-{dispatch_id}",
        destination_id=DEST_IDS[place], destination_name=place, lat=lat, lon=lon,
        packages=packages, weight_kg=weight,
        direct_km=trips.geo_km(*VIJAYAWADA, lat, lon, road))


POLICY = trips.build_policy({})


def trip_places(plan):
    return {frozenset(stop["destination_name"] for stop in trip["stops"])
            for trip in plan["trips"]}


def test_operational_warehouse_label_yields_locality_without_vehicle_or_type():
    assert locality_from_warehouse(
        "AP-104-MMU-Phc-nimmanapalli-AP39TL9449 - LIP") == "nimmanapalli"


def test_distance_is_zero_at_one_point_and_scaled_by_the_road_factor():
    assert trips.geo_km(*VIJAYAWADA, *VIJAYAWADA, 1.22) == 0
    straight = trips.geo_km(*VIJAYAWADA, *PLACES["Guntur"], 1.0)
    assert 28 < straight < 33                      # Vijayawada–Guntur, as the crow flies
    assert abs(trips.geo_km(*VIJAYAWADA, *PLACES["Guntur"], 1.22) - straight * 1.22) < 1e-6


def test_the_ten_dispatch_morning_becomes_one_truck_per_road():
    drops = [drop(1, "Guntur"), drop(2, "Ongole"), drop(3, "Nellore"),
             drop(4, "Kakinada"), drop(5, "Visakhapatnam"), drop(6, "Kurnool")]
    plan = trips.recommend(VIJAYAWADA, drops, POLICY)

    assert frozenset({"Guntur", "Ongole", "Nellore"}) in trip_places(plan)
    assert frozenset({"Kakinada", "Visakhapatnam"}) in trip_places(plan)
    # Kurnool shares no road with anything else — sent on its own, and told why.
    assert [row["destination_name"] for row in plan["singles"]] == ["Kurnool"]
    assert "on the way" in plan["singles"][0]["reason"]
    totals = plan["totals"]
    assert totals["vehicles_before"] == 6 and totals["vehicles_after"] == 3
    assert totals["planned_distance_km"] < totals["separate_distance_km"]
    assert totals["saving_amount"] > 0


def test_the_south_run_visits_its_stops_in_road_order():
    plan = trips.evaluate_trip(VIJAYAWADA, [drop(3, "Nellore"), drop(1, "Guntur"),
                                            drop(2, "Ongole")], POLICY)
    assert [stop["destination_name"] for stop in plan["stops"]] == \
        ["Guntur", "Ongole", "Nellore"]
    assert plan["stops"][0]["reason"].startswith(("Directly", "On the way"))
    assert plan["stops"][-1]["reason"].startswith("Farthest")
    assert plan["estimated_saving_km"] > 0
    assert plan["estimated_distance_km"] < plan["separate_distance_km"]


def test_the_vehicle_limits_split_a_road_that_does_not_fit_one_truck():
    small = trips.build_policy({"capacity_kg": 250})
    drops = [drop(1, "Guntur", 200, policy=small), drop(2, "Ongole", 200, policy=small),
             drop(3, "Nellore", 200, policy=small)]
    plan = trips.recommend(VIJAYAWADA, drops, small)
    for trip in plan["trips"]:
        assert trip["total_weight_kg"] <= 250
    assert plan["totals"]["vehicles_after"] == 3


def test_a_consignment_heavier_than_the_vehicle_is_never_planned():
    tiny = trips.build_policy({"capacity_kg": 100})
    plan = trips.recommend(VIJAYAWADA, [drop(1, "Guntur", 500, policy=tiny)], tiny)
    assert plan["trips"] == []
    assert "Too big" in plan["singles"][0]["reason"]


def test_the_stop_limit_is_a_hard_limit():
    two = trips.build_policy({"max_stops": 2})
    plan = trips.recommend(VIJAYAWADA, [drop(1, "Guntur", policy=two),
                                        drop(2, "Ongole", policy=two),
                                        drop(3, "Nellore", policy=two)], two)
    assert all(len(trip["stops"]) <= 2 for trip in plan["trips"])


def test_consignments_for_the_same_stop_ride_together_and_cost_nothing_extra():
    plan = trips.recommend(VIJAYAWADA, [drop(1, "Kurnool"), drop(2, "Kurnool"),
                                        drop(3, "Kurnool")], POLICY)
    assert len(plan["trips"]) == 1 and plan["singles"] == []
    only = plan["trips"][0]
    assert only["kind"] == "SAME_STOP"
    assert len(only["stops"]) == 1 and len(only["stops"][0]["consignments"]) == 3
    assert only["vehicles_saved"] == 2


def test_a_pinned_stop_order_is_honoured_and_the_rest_optimised():
    members = [drop(1, "Guntur"), drop(2, "Ongole"), drop(3, "Nellore")]
    plan = trips.evaluate_trip(VIJAYAWADA, members, POLICY,
                               stop_order=[DEST_IDS["Nellore"]])
    assert plan["stops"][0]["destination_name"] == "Nellore"
    assert {stop["destination_name"] for stop in plan["stops"][1:]} == {"Guntur", "Ongole"}


def test_a_stop_is_read_by_its_village_not_its_operational_label():
    assert trips.place_name("AP-104-MMU-Badangi-AP39UH4792 - LIP") == "Badangi"
    assert trips.place_name("AP-104-MMU-Chilamathur -phc-AP39TL9499 - LIP") == "Chilamathur"
    assert trips.place_name("AP-104-MMU-Bapulapadu Phc-AP39TL9222 - LIP") == "Bapulapadu"
    # Not an MMU label: its own name, less the rung — never an empty string.
    assert trips.place_name("Central Warehouse Vijayawada - MAIN") == "Central Warehouse Vijayawada"
    assert trips.place_name("Guntur") == "Guntur"
    assert trips.place_name(None) == ""


def test_a_hand_set_order_is_driven_and_the_shorter_one_is_stated_beside_it():
    members = [drop(1, "Guntur"), drop(2, "Ongole"), drop(3, "Nellore")]
    ids = [DEST_IDS[name] for name in ("Nellore", "Guntur", "Ongole")]
    plan = trips.evaluate_trip(VIJAYAWADA, members, POLICY, stop_order=ids)
    assert [stop["destination_warehouse_id"] for stop in plan["stops"]] == ids
    assert plan["order_is_optimal"] is False
    assert plan["optimal_distance_km"] < plan["estimated_distance_km"]
    assert plan["optimal_order"] == [DEST_IDS[name] for name in ("Guntur", "Ongole", "Nellore")]

    shortest = trips.evaluate_trip(VIJAYAWADA, members, POLICY,
                                   stop_order=plan["optimal_order"])
    assert shortest["order_is_optimal"] is True
    assert shortest["estimated_distance_km"] == plan["optimal_distance_km"]


def test_the_next_stop_is_measured_from_the_last_stop_one_row_per_place():
    members = [drop(1, "Guntur")]
    pool = [*members, drop(2, "Ongole"), drop(3, "Ongole"), drop(4, "Kakinada"),
            drop(5, "Guntur")]
    rows = trips.next_stop_options(VIJAYAWADA, members, [DEST_IDS["Guntur"]], pool, POLICY)
    # The place already on the route comes first, for nothing.
    assert rows[0]["destination_place"] == "Guntur" and rows[0]["already_a_stop"]
    assert rows[0]["dispatch_ids"] == [5] and rows[0]["adds_km"] == 0
    # Two consignments for Ongole are ONE stop; it is nearer Guntur than Kakinada is.
    ongole, kakinada = rows[1], rows[2]
    assert ongole["destination_place"] == "Ongole" and ongole["dispatch_ids"] == [2, 3]
    assert ongole["from_place"] == "Guntur"
    assert ongole["from_last_km"] < kakinada["from_last_km"]
    assert ongole["saves_km"] > kakinada["saves_km"]


def test_a_next_stop_that_would_overload_the_truck_says_why():
    small = trips.build_policy({"capacity_kg": 250})
    members = [drop(1, "Guntur", 200, policy=small)]
    rows = trips.next_stop_options(VIJAYAWADA, members, [DEST_IDS["Guntur"]],
                                   [drop(2, "Ongole", 100, policy=small)], small)
    assert rows[0]["fits"] is False and "kg" in rows[0]["blocked_reason"]


def test_warnings_name_overload_and_unrecorded_weight():
    tiny = trips.build_policy({"capacity_kg": 150})
    plan = trips.evaluate_trip(VIJAYAWADA, [drop(1, "Guntur", 200, policy=tiny),
                                            drop(2, "Ongole", 0, policy=tiny)], tiny)
    assert any(text.startswith("Over capacity") for text in plan["warnings"])
    assert any("no recorded weight" in text for text in plan["warnings"])


def test_combining_opposite_directions_is_flagged_as_saving_nothing():
    plan = trips.evaluate_trip(VIJAYAWADA, [drop(1, "Kurnool"), drop(2, "Visakhapatnam")],
                               POLICY)
    assert any("longer than going straight" in text for text in plan["warnings"])


def test_additions_rank_what_is_on_the_way_first():
    members = [drop(3, "Nellore")]
    pool = [drop(4, "Kakinada"), drop(1, "Guntur"), drop(6, "Kurnool"), drop(2, "Ongole")]
    rows = trips.suggest_additions(VIJAYAWADA, members, pool, POLICY)
    assert {row["destination_name"] for row in rows[:2]} == {"Guntur", "Ongole"}
    assert all(row["on_the_way"] for row in rows[:2])
    assert not next(row for row in rows if row["destination_name"] == "Kakinada")["on_the_way"]


def test_the_policy_is_clamped_and_reads_settings_text():
    policy = trips.build_policy({"capacity_kg": "0", "return_to_origin": "false",
                                 "road_factor": "9"}, {"max_stops": 80})
    assert policy.capacity_kg == 1 and policy.road_factor == 3
    assert policy.max_stops == 25 and policy.return_to_origin is False


def test_a_consignment_on_a_trip_reads_from_its_own_document():
    assert trips._link_state(DispatchStatus.ACKNOWLEDGED.value, "IN_TRANSIT") == \
        TripStopStatus.ACKNOWLEDGED.value
    assert trips._link_state(DispatchStatus.DELIVERED.value, "IN_TRANSIT") == \
        TripStopStatus.DELIVERED.value
    # The desk marked the stop while the document still reads on the road: kept.
    assert trips._link_state(DispatchStatus.DISPATCHED.value, "DELIVERED") == \
        TripStopStatus.DELIVERED.value
    assert trips._link_state(DispatchStatus.ACKNOWLEDGED.value, "CANCELLED") == "CANCELLED"


def _trip(*stop_states, status=TripStatus.IN_TRANSIT.value):
    stops = []
    for sequence, states in enumerate(stop_states, 1):
        links = [SimpleNamespace(status=state) for state in states]
        stops.append(SimpleNamespace(sequence=sequence, destination_name=f"S{sequence}",
                                     status=TripStopStatus.IN_TRANSIT.value,
                                     consignments=links, delivered_at=None,
                                     acknowledged_at=None))
    return SimpleNamespace(status=status, stops=stops, completed_at=None)


def test_the_trip_rolls_up_from_its_consignments_stop_by_stop():
    ack, dlv, road = (TripStopStatus.ACKNOWLEDGED.value, TripStopStatus.DELIVERED.value,
                      TripStopStatus.IN_TRANSIT.value)
    trip = _trip([ack, ack], [dlv], [road])
    trips._roll_up(trip)
    assert [stop.status for stop in trip.stops] == [ack, dlv, road]
    assert trip.status == TripStatus.PARTIALLY_DELIVERED.value

    trip = _trip([ack], [dlv, ack])
    trips._roll_up(trip)
    assert trip.status == TripStatus.DELIVERED.value      # all down, one site to sign

    trip = _trip([ack], [ack, ack])
    trips._roll_up(trip)
    assert trip.status == TripStatus.COMPLETED.value and trip.completed_at is not None


def test_a_planned_trip_never_rolls_forward_on_its_own():
    trip = _trip([TripStopStatus.PLANNED.value], status=TripStatus.PLANNED.value)
    trips._roll_up(trip)
    assert trip.status == TripStatus.PLANNED.value


# --------------------------------------------------------------------------- #
#  Road km, load volume, and how sure the planner is of each
# --------------------------------------------------------------------------- #

from decimal import Decimal  # noqa: E402

from app.modules.logistics import routing  # noqa: E402
from app.modules.warehouse import geocoding  # noqa: E402


def test_routed_road_km_replace_the_estimate_and_the_plan_says_so():
    here = routing.point_key(VIJAYAWADA)
    guntur, ongole = routing.point_key(PLACES["Guntur"]), routing.point_key(PLACES["Ongole"])
    road = {(here, guntur): 34.0, (guntur, ongole): 98.0, (ongole, here): 132.0,
            (here, ongole): 132.0, (guntur, here): 34.0, (ongole, guntur): 98.0}
    matrix = routing.DistanceMatrix(road_factor=1.22, road=road)
    members = [drop(1, "Guntur"), drop(2, "Ongole")]
    for row in members:
        row.direct_km = matrix(VIJAYAWADA, row.point)
    plan = trips.evaluate_trip(VIJAYAWADA, members, POLICY, km=matrix)
    assert plan["distance_basis"] == "ROAD"
    assert plan["estimated_distance_km"] == 34.0 + 98.0 + 132.0
    assert [stop["distance_basis"] for stop in plan["stops"]] == ["ROAD", "ROAD"]


def test_only_firm_figures_refuse_a_trip_and_estimates_warn():
    small = trips.build_policy({"capacity_kg": 150, "capacity_cbm": 0})
    weighed = [drop(1, "Guntur", 200, policy=small), drop(2, "Ongole", 10, policy=small)]
    plan = trips.evaluate_trip(VIJAYAWADA, weighed, small)
    assert plan["blockers"] and plan["blockers"][0].startswith("Over capacity")

    guessed = [drop(1, "Guntur", 200, policy=small), drop(2, "Ongole", 10, policy=small)]
    for row in guessed:
        row.weight_basis = trips.ASSUMED
    plan = trips.evaluate_trip(VIJAYAWADA, guessed, small)
    assert plan["blockers"] == []
    assert any(text.startswith("May be over capacity") for text in plan["warnings"])


def test_volume_is_a_capacity_of_its_own():
    box = trips.build_policy({"capacity_cbm": 2, "volume_fill_pct": 50})   # 1 m3 usable
    members = [drop(1, "Guntur", 10, policy=box), drop(2, "Ongole", 10, policy=box)]
    for row in members:
        row.volume_cbm, row.volume_basis = 0.8, trips.FIRM_VOLUME
    assert trips._fits(members[:1], members[1], box).startswith("the load would take")
    plan = trips.evaluate_trip(VIJAYAWADA, members, box)
    assert any(text.startswith("Over volume") for text in plan["blockers"])
    assert plan["volume_utilisation_pct"] == 160.0
    # The recommendation never proposes a truck its own figures say is full.
    assert trips.recommend(VIJAYAWADA, members, box)["trips"] == []


def _package(weight=None, sides=(None, None, None)):
    return SimpleNamespace(weight_kg=weight, length_cm=sides[0], width_cm=sides[1],
                           height_cm=sides[2])


def _doc(packages=0, weight=0):
    return SimpleNamespace(total_packages=packages, total_weight_kg=Decimal(weight))


def test_a_consignment_is_measured_estimated_or_assumed_and_says_which():
    policy = trips.build_policy({"default_package_kg": 12, "default_package_cbm": 0.06})
    full = [_package(Decimal("20"), (Decimal("50"), Decimal("40"), Decimal("30")))] * 2
    size = trips.measure_consignment(_doc(2, 40), full, [], {}, policy)
    assert size["weight_basis"] == "WEIGHED" and size["weight_kg"] == 40
    assert size["volume_basis"] == "MEASURED" and abs(size["volume_cbm"] - 0.12) < 1e-9

    half = [full[0], _package()]
    size = trips.measure_consignment(_doc(2, 20), half, [], {}, policy)
    # One weighed, one not: the real carton at its real figure, the other assumed.
    assert size["weight_basis"] == "ASSUMED" and size["weight_kg"] == 32
    assert size["volume_basis"] == "ASSUMED" and abs(size["volume_cbm"] - 0.12) < 1e-9

    off = trips.build_policy({"default_package_kg": 0, "default_package_cbm": 0})
    size = trips.measure_consignment(_doc(2, 0), [_package(), _package()], [], {}, off)
    assert size["weight_basis"] is None and size["volume_basis"] is None


def test_the_phonetic_key_folds_telugu_transliterations_together():
    same = [("Cheedikada", "Chīdikāda"), ("Gouravaram", "Gauravaram"),
            ("Atchutapuram", "Achutāpuram"), ("Kotha Kota", "Kottakota"),
            ("Baireddypalli", "Baireddipalle"), ("Pandillapalli", "Pandillapalle"),
            ("Dronadhula", "Dronadula")]
    for left, right in same:
        assert geocoding.phonetic_key(left) == geocoding.phonetic_key(right), (left, right)
    assert geocoding.phonetic_key("Guntur") != geocoding.phonetic_key("Guntakal")


def test_hcm_districts_accept_their_parent_districts():
    assert geocoding.canonical_district("SRI POTTI SRIRAMULU NELLORE") == "nellore"
    assert geocoding.canonical_district("YSR KADAPA") == \
        geocoding.canonical_district("ysr district") == \
        geocoding.canonical_district("Cuddapah") == "kadapa"
    assert geocoding.canonical_district("DR.B.R.AMBEDKAR KONASEEMA") == "konaseema"
    assert "east godavari" in geocoding.accepted_districts("KAKINADA")
    assert geocoding.accepted_districts("MARKAPURAM") == {"markapuram", "prakasam"}
    assert geocoding.accepted_districts("") is None


def _gazetteer(monkeypatch, *places):
    monkeypatch.setattr(geocoding, "_places", list(places))
    names, keys = {}, {}
    for at, place in enumerate(places):
        names.setdefault(place.normalized, []).append(at)
        keys.setdefault(place.key, []).append(at)
    monkeypatch.setattr(geocoding, "_names", names)
    monkeypatch.setattr(geocoding, "_keys", keys)
    monkeypatch.setattr(geocoding, "_trigrams", {})


def _place(name, district, lat, lon, source="GEONAMES", population=0, accuracy=4):
    norm = geocoding.normalize(name)
    return geocoding.Place(name, norm, geocoding.phonetic_key(norm), lat, lon, population,
                           name, geocoding.canonical_district(district), district,
                           source, accuracy)


def test_the_district_is_a_constraint_not_a_hint(monkeypatch):
    # Etcherla exists — in the wrong district. The old matcher took it anyway.
    _gazetteer(monkeypatch, _place("Etcherla", "Prakasam", 15.5, 80.0))
    assert geocoding._resolve_sync("AP-104-MMU-Etcherla-AP39TL1 - LIP", "SRIKAKULAM") is None
    _gazetteer(monkeypatch, _place("Echcherla", "Srikakulam", 18.35, 83.8),
               _place("Etcherla", "Prakasam", 15.5, 80.0))
    match = geocoding._resolve_sync("AP-104-MMU-Etcherla-AP39TL1 - LIP", "SRIKAKULAM")
    assert match is not None and round(match.latitude, 2) == 18.35


def test_one_village_listed_twice_is_one_place_and_two_villages_are_not(monkeypatch):
    _gazetteer(monkeypatch, _place("Bondapalle", "Vizianagaram", 18.30, 83.30),
               _place("Bondapalle", "Vizianagaram", 18.32, 83.31))
    assert geocoding._resolve_sync("AP-104-MMU-Bondapalle-AP39TL1234 - LIP", "VIZIANAGARAM")
    _gazetteer(monkeypatch, _place("Bondapalle", "Vizianagaram", 18.30, 83.30),
               _place("Bondapalle", "Vizianagaram", 18.90, 83.60))
    assert geocoding._resolve_sync("AP-104-MMU-Bondapalle-AP39TL1234 - LIP", "VIZIANAGARAM") is None
    # ...unless one is clearly the better attested: a gazetteer place AND a post office.
    _gazetteer(monkeypatch, _place("Bondapalle", "Vizianagaram", 18.30, 83.30),
               _place("Bondapalle", "Vizianagaram", 18.31, 83.30, source="POSTAL"),
               _place("Bondapalle", "Vizianagaram", 18.90, 83.60))
    match = geocoding._resolve_sync("AP-104-MMU-Bondapalle-AP39TL1234 - LIP", "VIZIANAGARAM")
    assert match is not None and round(match.latitude, 1) == 18.3


def test_a_postcode_centroid_is_offered_never_applied(monkeypatch):
    _gazetteer(monkeypatch, _place("Duggudurru", "East Godavari", 17.0, 82.0,
                                   source="POSTAL", accuracy=1))
    assert geocoding._resolve_sync("AP-104-MMU-Duggudurru-AP39TL1234 - LIP", "KAKINADA") is None
    offered = geocoding._candidates_sync("AP-104-MMU-Duggudurru-AP39TL1234 - LIP", "KAKINADA")
    assert offered and offered[0].in_district and not offered[0].as_dict()["precise"]


# --------------------------------------------------------------------------- #
#  HCM's own GPS, and the mandal as evidence
# --------------------------------------------------------------------------- #

from app.modules.inventory.locations import apply_hcm_coordinates, hcm_point  # noqa: E402
from app.platform.hcm.mappers import office_geo  # noqa: E402


def test_hcm_gps_is_read_off_the_raw_office():
    geo = office_geo({"latitude": "16.674200000", "longitude": "80.618900000",
                      "location": "Ainavilli", "mandal_name": "AINAVILLI",
                      "district_name": "DR.B.R.AMBEDKAR KONASEEMA"})
    assert geo["latitude"] == 16.6742 and geo["mandal"] == "AINAVILLI"
    assert office_geo({"latitude": "", "longitude": None})["latitude"] is None
    assert office_geo(None)["location"] is None


def test_hcm_gps_outside_andhra_pradesh_is_refused_and_a_swap_is_put_right():
    assert hcm_point({"latitude": 16.67, "longitude": 80.61}) == (16.67, 80.61)
    assert hcm_point({"latitude": 80.61, "longitude": 16.67}) == (16.67, 80.61)
    assert hcm_point({"latitude": 0.0, "longitude": 0.0}) is None
    assert hcm_point({"latitude": 28.6, "longitude": 77.2}) is None      # Delhi


def _warehouse(source=None, lat=None, lon=None):
    return SimpleNamespace(coordinate_source=source, latitude=lat, longitude=lon,
                           coordinate_label=None, coordinate_confidence=None)


def test_hcm_gps_beats_a_name_match_and_never_a_manual_pin():
    gps = {"latitude": 16.67, "longitude": 80.61}
    matched = _warehouse("GEONAMES_LOCALITY", Decimal("16.5"), Decimal("80.5"))
    assert apply_hcm_coordinates(matched, gps) == "SET"
    assert matched.coordinate_source == "HCM" and matched.latitude == Decimal("16.67")
    assert apply_hcm_coordinates(matched, gps) is None                   # idempotent

    pinned = _warehouse("MANUAL", Decimal("16.1"), Decimal("80.1"))
    assert apply_hcm_coordinates(pinned, gps) is None
    assert pinned.latitude == Decimal("16.1")

    # HCM withdrew its reading: the point goes back to being matched by name.
    assert apply_hcm_coordinates(matched, {}) == "CLEARED"
    assert matched.latitude is None and matched.coordinate_source is None


def _mandal_place(name, district, lat, lon, mandal, source="GEONAMES"):
    norm = geocoding.normalize(name)
    return geocoding.Place(name, norm, geocoding.phonetic_key(norm), lat, lon, 0, name,
                           geocoding.canonical_district(district), district, source, 4,
                           geocoding.mandal_key(mandal), mandal)


def test_the_mandal_picks_between_two_villages_of_one_name(monkeypatch):
    _gazetteer(monkeypatch,
               _mandal_place("Ananthagiri", "Alluri Sitharama Raju", 17.57, 82.14, "Rajavommangi"),
               _mandal_place("Ananthagiri", "Alluri Sitharama Raju", 18.23, 83.00, "Ananthagiri"))
    assert geocoding._resolve_sync("AP-104-MMU-X-AP39TL1 - LIP", "ALLURI SITHARAMA RAJU") is None
    match = geocoding._resolve_sync("AP-104-MMU-X-AP39TL1 - LIP", "ALLURI SITHARAMA RAJU",
                                    locality="Ananthagiri", mandal="ANANTHAGIRI")
    assert match is not None and round(match.latitude, 2) == 18.23


def test_a_mandal_never_carries_a_match_far_across_a_district_line(monkeypatch):
    # Gudur mandal exists in Kurnool AND in Tirupati. HCM says Kurnool.
    _gazetteer(monkeypatch, _mandal_place("Gudur", "Tirupati", 14.15, 79.85, "Gudur"))
    assert geocoding._resolve_sync("AP-104-MMU-Gudur Phc-AP39TL1 - LIP", "KURNOOL",
                                   locality="Gudur Phc", mandal="GUDUR") is None


def test_a_near_spelling_in_another_mandal_is_another_village(monkeypatch):
    _gazetteer(monkeypatch, _mandal_place("Dangara", "West Godavari", 16.8, 81.5,
                                          "Tadepalligudem"))
    monkeypatch.setattr(geocoding, "_scored", lambda query: [(0.92, 0)])
    assert geocoding._resolve_sync("AP-104-MMU-Angara-AP39TL1 - LIP", "WEST GODAVARI",
                                   locality="Angara", mandal="TANUKU") is None


def test_the_committed_snapshot_places_only_unplaced_points(monkeypatch):
    """A fresh checkout draws the exporter's map, and never over a pin of its own."""
    snapshot = {code: {"latitude": 16.5, "longitude": 80.6, "source": "GEONAMES_LOCALITY",
                       "label": "Vijayawada", "confidence": 0.95}
                for code in ("LIP-1", "LIP-2", "LIP-3", "LIP-4")}
    monkeypatch.setattr(trips.geocoding, "load_snapshot", lambda: snapshot)

    def point(code, source=None, lat=None, lon=None):
        return SimpleNamespace(code=code, coordinate_source=source, latitude=lat,
                               longitude=lon, coordinate_label=None,
                               coordinate_confidence=None)

    unplaced = point("LIP-1", "GAZETTEER_UNRESOLVED")
    pinned = point("LIP-2", "MANUAL", 15.0, 79.0)
    placed = point("LIP-3", "GEONAMES_LOCALITY", 14.0, 78.0)
    fresh = point("LIP-4")
    unknown = point("LIP-9")

    assert trips._apply_snapshot([unplaced, pinned, placed, fresh, unknown]) == 2
    assert (float(unplaced.latitude), unplaced.coordinate_source) == (16.5, "GEONAMES_LOCALITY")
    assert float(fresh.longitude) == 80.6
    assert (pinned.latitude, placed.latitude) == (15.0, 14.0)
    assert unknown.latitude is None
