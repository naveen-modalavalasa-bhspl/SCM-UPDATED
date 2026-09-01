"""B-CAMS integration — the parts that would be worst to get wrong, no database.

The DB-backed suite drops and recreates ~85 tables per test, so what is pinned here is
what does not need one:

  * the contract B-CAMS wrote down (the response shape, the paging keys, `is_active`
    filtering the right way round, ids that are never re-issued as zero);
  * the signature and the replay guard, which are the whole of the write boundary;
  * that every feed compiles to real SQL against the live models — a renamed column
    anywhere in masters, inventory, indents or warehouse fails here rather than at
    06:30 on their sync.
"""
import hashlib
import hmac
import json
from datetime import date, datetime
from decimal import Decimal

import pytest
from sqlalchemy.dialects import mysql

from app.core.exceptions import AuthenticationError, ValidationError
from app.modules.integrations.adapters.cams import docs as cams_docs
from app.modules.integrations.adapters.cams import ingest, reads, router
from app.modules.integrations.adapters.cams.enums import MAX_EVENT_ID, Tier
from app.modules.integrations.adapters.cams.schemas import (
    AckIn, ConsumptionIn, StockBalanceIn, StockTransferIn, WastageIn,
)
from app.shared.enums import WarehouseType

SECRET = "test-secret-not-a-real-one"


def signed(body: bytes, secret: str = SECRET) -> str:
    return f"sha256={hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()}"


# --------------------------------------------------------------------------- #
# Every feed is real SQL over the real models
# --------------------------------------------------------------------------- #

FEEDS = [
    ("items", lambda: reads.items("consumable", True, "2026-08-01")),
    ("item-categories", lambda: reads.item_categories(True)),
    ("uom", lambda: reads.uoms(None)),
    ("warehouses", lambda: reads.warehouses(True, "LIP,MDP,WH")),
    ("batches", lambda: reads.batches("1,2", "2026-08-01T06:30:00")),
    ("stock-balance", lambda: reads.stock_balance("44", "1042", "2026-08-01")),
    ("material-issues", lambda: reads.material_issues("44", "dispatched", "3", None)),
    ("material-issue-items", lambda: reads.material_issue_items("7712")),
    ("user-warehouses", lambda: reads.user_warehouses("44", True)),
    ("users", lambda: reads.users(True, "HR-EMP-15086")),
    ("indents", lambda: reads.indents("44", "APPROVED", "2026-01-01")),
    ("indent-items", lambda: reads.indent_items("5580")),
    ("vehicles", lambda: reads.vehicles("44")),
    ("serial-numbers", lambda: reads.serial_numbers("C-1", "1", "44", "2026-01-01")),
]


class TestFeedsCompile:
    @pytest.mark.parametrize("name,feed", FEEDS, ids=[n for n, _ in FEEDS])
    def test_every_feed_compiles_against_the_live_models(self, name, feed):
        stmt, mapper = feed()
        stmt.compile(dialect=mysql.dialect(), compile_kwargs={"literal_binds": True})
        assert callable(mapper)

    @pytest.mark.parametrize("name,feed", FEEDS, ids=[n for n, _ in FEEDS])
    def test_every_feed_is_ordered(self, name, feed):
        # Rule 8 of the ask is about stable ids; unordered paging breaks it just as
        # surely, by handing them page 2 with rows page 1 already carried.
        stmt, _ = feed()
        assert stmt._order_by_clauses, f"{name} pages without an ORDER BY"


# --------------------------------------------------------------------------- #
# §3 — the response and behaviour rules they said are not preferences
# --------------------------------------------------------------------------- #

class TestContract:
    def test_page_size_is_read_from_either_name(self):
        assert reads.page_of({"page": "3", "page_size": "500"}) == (3, 500)
        assert reads.page_of({"size": "500"}) == (1, 500)

    def test_page_size_is_capped_and_never_zero(self):
        _, size = reads.page_of({"page_size": "999999"})
        assert size == 2000            # MAX_EXT_PAGE_SIZE
        assert reads.page_of({"page_size": "0"})[1] == 1
        assert reads.page_of({"page": "0"})[0] == 1

    def test_a_page_that_is_not_a_number_is_refused_not_guessed(self):
        with pytest.raises(ValidationError):
            reads.page_of({"page_size": "lots"})

    @pytest.mark.parametrize("word,expected", [
        ("true", True), ("TRUE", True), ("1", True), ("yes", True),
        ("false", False), ("0", False), ("no", False),
        ("", None), (None, None),
    ])
    def test_is_active_is_read_the_right_way_round(self, word, expected):
        # Rule 6: the previous system returned INACTIVE rows for is_active=true, so
        # B-CAMS now filters client-side. This is the pin that lets them stop.
        assert reads.flag(word) is expected

    def test_an_unreadable_is_active_is_an_error_not_a_silent_false(self):
        with pytest.raises(ValidationError):
            reads.flag("maybe")

    def test_names_never_carry_a_newline_or_tab(self):
        # Rule 10: "Alkaline phosphatase \nSmall System Pack" broke their item search.
        assert reads.clean("Alkaline phosphatase \nSmall System Pack") == \
            "Alkaline phosphatase Small System Pack"
        assert reads.clean("a\tb\r\nc") == "a b c"
        assert reads.clean(None) is None

    def test_a_no_batch_sentinel_leaves_as_null_not_zero(self):
        # stk_balance.batch_id is NOT NULL and uses 0 for "no batch". Outside SCM, 0 is
        # an id someone will try to join on.
        assert reads._nullable_id(0) is None
        assert reads._nullable_id(9911) == 9911

    def test_quantities_go_out_as_numbers(self):
        assert reads.num(Decimal("980.000")) == 980.0
        assert isinstance(reads.num(Decimal("145.5000")), float)
        assert reads.num(None) is None

    def test_updated_since_accepts_a_date_or_a_timestamp(self):
        assert reads.since("2026-08-07") == datetime(2026, 8, 7, 0, 0)
        assert reads.since("2026-08-07T18:30:00Z") == datetime(2026, 8, 7, 18, 30)
        # An offset is dropped, not converted: the columns store naive IST.
        assert reads.since("2026-08-07T18:30:00+05:30") == datetime(2026, 8, 7, 18, 30)
        assert reads.since("") is None

    def test_a_malformed_updated_since_is_refused(self):
        with pytest.raises(ValidationError):
            reads.since("last tuesday")

    def test_an_id_list_is_accepted_and_a_word_is_not(self):
        assert reads.ids("1,2, 3") == [1, 2, 3]
        assert reads.ids("") == []
        with pytest.raises(ValidationError):
            reads.ids("1,alpha")


# --------------------------------------------------------------------------- #
# Q1 — the tier they currently infer
# --------------------------------------------------------------------------- #

class TestTier:
    def test_the_two_rungs_are_named_and_everything_else_is_a_warehouse(self):
        assert reads.tier_of(WarehouseType.LIP.value) == Tier.LIP.value
        assert reads.tier_of(WarehouseType.MDP.value) == Tier.MDP.value
        assert reads.tier_of("MAIN") == Tier.WH.value
        assert reads.tier_of("REGIONAL") == Tier.WH.value
        assert reads.tier_of(None) == Tier.WH.value

    def test_tier_is_read_case_insensitively(self):
        assert reads.tier_of("lip") == Tier.LIP.value


# --------------------------------------------------------------------------- #
# Row shaping — the fields they pinned as "must never be NULL"
# --------------------------------------------------------------------------- #

class TestShapes:
    def test_a_warehouse_row_carries_tier_and_the_hcm_office(self):
        row = reads._warehouse_out({
            "id": 44, "code": "WH-MMU-AP-MENTADA", "name": "104-MMU-AP Mentada",
            "warehouse_type": "LIP", "office_id": 3081, "facility_id": None,
            "is_active": True, "city": "Vizianagaram", "state": "Andhra Pradesh",
        })
        assert row["tier"] == "LIP"
        assert row["hcm_office_id"] == 3081
        assert row["parent_id"] is None      # present, not omitted

    def _item(self, **kw):
        row = {
            "id": 2011, "code": "120010-0007", "name": "HDL Cholesterol with Calibrator",
            "item_type": "reagent", "category_id": 31, "category_name": "Lipid",
            "uom_id": 9, "uom_code": "ml", "is_batch_tracked": True, "has_expiry": True,
            "reorder_level": Decimal("50.000"), "safety_stock": Decimal("20.000"),
            "purchase_price": Decimal("1200.0000"), "mrp": Decimal("0.0000"),
            "shelf_life_days": 540, "is_active": True,
            "updated_at": datetime(2026, 8, 1), "pack_size": Decimal("30.000"),
            "specifications": {"PACK_SIZE_TEXT": "4 x 30 ml / 4 x 10 ml",
                               "pack_volume_ml": 160, "Tests per kit": "548"},
            "spec_shelf_life": None,
        }
        row.update(kw)
        return reads._item_out(row)

    def test_the_kit_sheet_fields_come_through(self):
        # Q6: pack_size_text, pack_volume_ml and tests_per_kit are what the norms engine
        # converts tests -> mL -> packs with.
        row = self._item()
        assert row["pack_size_text"] == "4 x 30 ml / 4 x 10 ml"
        assert row["pack_volume_ml"] == 160
        assert row["tests_per_kit"] == 548
        assert row["shelf_life_days"] == 540

    def test_a_kit_field_typed_with_its_unit_still_reads_as_a_number(self):
        row = self._item(specifications={"pack_volume_ml": "160 ml",
                                         "tests_per_kit": "548 tests"})
        assert row["pack_volume_ml"] == 160
        assert row["tests_per_kit"] == 548

    def test_an_untagged_item_reports_null_rather_than_a_guess(self):
        row = self._item(specifications=None)
        assert row["pack_size_text"] is None
        assert row["pack_volume_ml"] is None
        assert row["tests_per_kit"] is None

    @pytest.mark.parametrize("stored,sent", [
        ("consumable", "Consumable"), ("CONSUMABLE", "Consumable"),
        ("Consumable", "Consumable"), ("reagent", "Reagent"), ("Reagent", "Reagent"),
    ])
    def test_item_type_goes_out_in_exactly_the_two_spellings_they_pinned(self, stored, sent):
        # Rule 7: an item missing from ?item_type=consumable is deactivated on their
        # side, so the spelling is load-bearing.
        assert self._item(item_type=stored)["item_type"] == sent

    def test_shelf_life_falls_back_to_the_spec_row_when_the_master_says_zero(self):
        # The master column is NOT NULL DEFAULT 0, so 0 means "never set" rather than
        # "expires immediately".
        row = self._item(shelf_life_days=0, spec_shelf_life=730)
        assert row["shelf_life_days"] == 730

    def test_assets_can_never_reach_this_feed(self):
        # Q6c: an analyser, a centrifuge or a printer belongs to AIMS. Two gates, because
        # the live master has items typed ASSET whose is_asset flag was never set.
        stmt, _ = reads.items(None, None, None)
        sql = str(stmt.compile(dialect=mysql.dialect(),
                               compile_kwargs={"literal_binds": True})).lower()
        assert "is_asset" in sql
        assert "'consumable'" in sql and "'reagent'" in sql
        for leaked in ("'asset'", "'material'", "'acessories'", "'testclass'"):
            assert leaked not in sql

    @pytest.mark.parametrize("asked", ["", "consumable", "reagent",
                                       "consumable,reagent", "asset", "material"])
    def test_no_item_type_filter_can_widen_past_the_two_classes(self, asked):
        # An `?item_type=asset` must return nothing, not assets.
        stmt, _ = reads.items(asked or None, None, None)
        sql = str(stmt.compile(dialect=mysql.dialect(),
                               compile_kwargs={"literal_binds": True})).lower()
        assert "'asset'" not in sql and "'material'" not in sql

    def test_a_stock_row_keeps_batch_and_expiry_inline(self):
        # Q8. Both are columns on stk_balance itself, so they cost no join.
        row = reads._stock_out({
            "id": 55201, "item_id": 1042, "warehouse_id": 44, "batch_id": 9911,
            "batch_no": "B-2026-0417", "expiry_date": date(2027, 1, 14),
            "available_qty": Decimal("980.000"), "reserved_qty": Decimal("0.000"),
            "total_qty": Decimal("980.000"), "valuation_rate": Decimal("145.5000"),
            "stock_value": Decimal("142590.00"), "updated_at": datetime(2026, 8, 7, 18, 30),
            "uom_code": "g", "uom_id": 7,
        })
        assert row["batch_number"] == "B-2026-0417"
        assert row["expiry_date"] == "2027-01-14"
        assert row["available_qty"] == 980.0
        assert row["last_updated"] == "2026-08-07T18:30:00"

    def test_a_user_row_carries_the_employee_code_that_joins_all_three_systems(self):
        row = reads._user_out({
            "id": 219, "emp_code": "HR-EMP-15086", "full_name": "Ramesh Kumar",
            "is_active": True, "role_name": "Store Keeper", "position_name": "SK VZM",
        })
        assert row["employee_code"] == "HR-EMP-15086"
        assert (row["first_name"], row["last_name"]) == ("Ramesh", "Kumar")
        assert row["user_type"] == "Store Keeper"

    def test_a_one_word_name_still_produces_a_first_name(self):
        row = reads._user_out({"id": 1, "emp_code": "E1", "full_name": "Ramesh",
                               "is_active": True, "role_name": None,
                               "position_name": None})
        assert row["first_name"] == "Ramesh" and row["last_name"] is None

    def test_an_issue_falls_back_to_the_consignment_date_when_the_gate_recorded_none(self):
        row = reads._issue_out({
            "id": 7712, "issue_no": "MI-2026-000431", "indent_id": 5580,
            "warehouse_id": 3, "issue_date": date(2026, 8, 6), "issued_to_id": 219,
            "issued_by_id": 44, "status": "DISPATCHED", "vehicle_number": None,
            "acknowledged_at": None, "destination_warehouse_id": 44,
            "gate_out_at": None, "dispatch_date": date(2026, 8, 6),
            "d_vehicle": "AP31TD4417",
        })
        assert row["dispatched_at"] == "2026-08-06"
        assert row["vehicle_number"] == "AP31TD4417"
        assert row["destination_warehouse_id"] == 44


# --------------------------------------------------------------------------- #
# §4 — the write boundary
# --------------------------------------------------------------------------- #

ACK = {
    "event": "material_issue.acknowledged",
    "event_id": "ack-20260808T101200-5b19ac30",
    "generated_at": "2026-08-08T10:12:00Z",
    "issue_id": 7712, "issue_number": "MI-2026-000431", "warehouse_id": 44,
    "sac": "VZM-MEN-01", "acknowledged_by_employee_code": "HR-EMP-15086",
    "acknowledged_at": "2026-08-08T10:11:45Z", "status": "received",
    "items": [{"item_id": 1042, "batch_number": "B-2026-0417", "issued_qty": 200.0,
               "received_qty": 198.0, "shortage_qty": 2.0, "damaged_qty": 0.0,
               "remarks": "2 packs torn"}],
}


class TestSignature:
    def test_a_body_signed_with_the_shared_secret_verifies(self):
        body = json.dumps(ACK).encode()
        assert ingest.expected_signature(SECRET.encode(), body) == signed(body)

    def test_one_changed_byte_changes_the_signature(self):
        body = json.dumps(ACK).encode()
        tampered = body.replace(b"198.0", b"200.0")
        assert ingest.expected_signature(SECRET.encode(), tampered) != signed(body)

    def test_the_secret_round_trips_but_is_never_stored_in_the_clear(self):
        stored = ingest.hmac_storable(SECRET)
        assert SECRET not in stored
        assert bytes.fromhex(stored) == SECRET.encode()


WASTAGE = {
    "event": "facility.wastage",
    "event_id": "waste-20260814T065756-3f00a232",
    "generated_at": "2026-08-14T06:57:56.654416Z",
    "scope": "full", "wastage_date": "2026-08-14", "record_count": 1,
    "records": [{"sac": None, "warehouse_id": 78, "item_code": "141010-0002",
                 "employee_code": "HR-EMP-15828", "uom": "ml", "wastage_qty": 1.0,
                 "reason": "Spillage", "remarks": "verify run 2", "rate": 99.0,
                 "wastage_value": 99.0}],
}

# The movement-driven stock-balance push, exactly as captured on 14-Aug-2026. Kept
# verbatim: every field B-CAMS added since the nightly-only days is in here.
LIVE_BALANCE = {
    "event": "facility.stock_balance",
    "event_id": "bal-20260814T065331-7b895b6a",
    "generated_at": "2026-08-14T06:53:31.283434Z",
    "source": "B-CAMS", "basis": "stock_balance", "scope": "partial",
    "facility_count": 1, "item_count": 49,
    "facilities": [{
        "warehouse_id": 78, "warehouse_code": "MOBILE UNIT @RAMABHADRAPURAM",
        "facility_name": "MOBILE UNIT @RAMABHADRAPURAM-AP-104-MMUS",
        "tier": "LIP", "sac": None, "hcm_office_id": None, "vehicle_number": None,
        "is_vehicle": True, "as_of": "2026-08-14T06:52:20",
        "items": [{"item_code": "131111-0001", "item_name": "Tourniquet", "uom": "nos",
                   "on_hand_qty": 5.0, "closing_qty": 5.0, "rate": 99.0, "value": 495.0,
                   "batches": [{"batch_number": "07-July-2026",
                                "expiry_date": "2026-10-31", "qty": 5.0}],
                   "lt_drawn_qty": 0.0, "sk_held_qty": 5.0}],
    }],
}


class TestTheRealTimeFeed:
    """14-Aug-2026: B-CAMS moved from a nightly batch to a push every ~60 seconds, and
    the payloads grew a timestamped `as_of`, a `scope`/`basis` pair and the SK/LT split.
    """

    def test_the_captured_real_time_balance_push_is_accepted_whole(self):
        parsed = ingest.parse(json.dumps(LIVE_BALANCE).encode(), StockBalanceIn)
        facility = parsed.facilities[0]
        assert parsed.basis == "stock_balance" and parsed.scope == "partial"
        assert facility.tier == "LIP" and facility.is_vehicle is True
        line = facility.items[0]
        assert line.on_hand_qty == Decimal("5") == line.closing_qty
        assert line.lt_drawn_qty + line.sk_held_qty == line.on_hand_qty
        assert line.batches[0].expiry_date == date(2026, 10, 31)

    def test_a_date_field_stamped_with_a_time_is_the_day_it_names(self):
        # The whole point: `as_of` used to be `2026-08-14`, and pydantic refuses
        # `2026-08-14T06:52:20` for a plain date field. Every real-time push would 422.
        parsed = ingest.parse(json.dumps(LIVE_BALANCE).encode(), StockBalanceIn)
        assert parsed.facilities[0].as_of == date(2026, 8, 14)

    @pytest.mark.parametrize("sent,expected", [
        ("2026-08-14", date(2026, 8, 14)),
        ("2026-08-14T06:52:20", date(2026, 8, 14)),
        ("2026-08-14T06:52:20Z", date(2026, 8, 14)),
        ("2026-08-14 06:52:20", date(2026, 8, 14)),
        # 19:00 UTC is 00:30 the next morning in IST, and IST is the clock this
        # business runs on — so the day this names is the 15th, not the 14th.
        ("2026-08-14T19:00:00Z", date(2026, 8, 15)),
    ])
    def test_every_spelling_of_a_day_lands_on_the_right_day(self, sent, expected):
        body = {**LIVE_BALANCE}
        body["facilities"] = [{**LIVE_BALANCE["facilities"][0], "as_of": sent}]
        parsed = ingest.parse(json.dumps(body).encode(), StockBalanceIn)
        assert parsed.facilities[0].as_of == expected

    def test_a_day_that_is_not_a_day_is_still_refused(self):
        body = {**LIVE_BALANCE}
        body["facilities"] = [{**LIVE_BALANCE["facilities"][0], "as_of": "yesterday"}]
        with pytest.raises(ValidationError):
            ingest.parse(json.dumps(body).encode(), StockBalanceIn)

    def test_a_utc_generated_at_is_stored_on_the_clock_the_rest_of_scm_reads(self):
        # Everything in SCM is naive IST (`shared/time.py`). 06:53:31Z is 12:23:31 here.
        parsed = ingest.parse(json.dumps(LIVE_BALANCE).encode(), StockBalanceIn)
        assert parsed.generated_at == datetime(2026, 8, 14, 12, 23, 31, 283434)
        assert parsed.generated_at.tzinfo is None

    @pytest.mark.parametrize("sent", [0.0, 5.0, 42, 12.5])
    def test_tests_done_survives_being_sent_as_a_float(self, sent):
        # B-CAMS sends this as a JSON number; `"tests_done": 0.0` is in their capture.
        body = {"event": "facility.consumption", "event_id": "cons-20260814-a77de6f2",
                "scope": "partial", "consumption_date": "2026-08-14",
                "records": [{"warehouse_id": 78, "item_code": "141010-0002",
                             "uom": "ml", "consumed_qty": 5.0, "tests_done": sent}]}
        parsed = ingest.parse(json.dumps(body).encode(), ConsumptionIn)
        assert parsed.records[0].tests_done == Decimal(str(sent))


class TestWastage:
    def test_the_captured_wastage_push_is_accepted_whole(self):
        parsed = ingest.parse(json.dumps(WASTAGE).encode(), WastageIn)
        row = parsed.records[0]
        assert parsed.wastage_date == date(2026, 8, 14) and parsed.scope == "full"
        assert row.wastage_qty == Decimal("1") and row.reason == "Spillage"
        assert row.wastage_value == Decimal("99")

    def test_wastage_is_registered_as_its_own_write_endpoint(self):
        # It was a 404 until 14-Aug-2026, so B-CAMS's pushes went nowhere.
        paths = {r.path for r in router.feeds.routes if "POST" in getattr(r, "methods", ())}
        assert "/api/ext/v1/cams/wastage" in paths
        assert "/api/ext/v1/cams/cams/wastage" in paths

    def test_a_wastage_row_with_no_quantity_is_refused(self):
        # A write-off that says nothing about how much was written off is not a record.
        body = {**WASTAGE, "records": [{"item_code": "141010-0002",
                                        "reason": "Expired"}]}
        with pytest.raises(ValidationError):
            ingest.parse(json.dumps(body).encode(), WastageIn)

    def test_an_expiry_write_off_needs_no_second_feed(self):
        body = {**WASTAGE, "records": [{**WASTAGE["records"][0], "reason": "Expired",
                                        "expiry_date": "2026-07-31"}]}
        parsed = ingest.parse(json.dumps(body).encode(), WastageIn)
        assert parsed.records[0].expiry_date == date(2026, 7, 31)


class TestPayloads:
    def test_the_five_documented_payloads_are_accepted_as_written(self):
        for body, model in [
            (ACK, AckIn),
            ({"event": "facility.consumption", "event_id": "cons-20260808-71bd0e93",
              "consumption_date": "2026-08-07",
              "records": [{"sac": "VZM-MEN-01", "warehouse_id": 44,
                           "item_code": "101010-0004", "batch_number": "B-2026-0417",
                           "uom": "g", "opening_qty": 980.0, "consumed_qty": 200.0,
                           "closing_qty": 780.0, "rate": 145.50,
                           "consumed_value": 29100.00, "tests_done": 42}]},
             ConsumptionIn),
            ({"event": "facility.stock_balance", "event_id": "facbal-20260808-9a1f4c22",
              "source": "B-CAMS",
              "facilities": [{"sac": "VZM-MEN-01", "hcm_office_id": 3081,
                              "warehouse_id": 44, "as_of": "2026-08-07",
                              "items": [{"item_code": "101010-0004",
                                         "closing_qty": 780.0, "rate": 145.50}]}]},
             StockBalanceIn),
            ({"event": "facility.stock_transfer", "event_id": "swap-20260808-c40b7712",
              "transfer_date": "2026-08-08", "reason": "vehicle_breakdown",
              "from": {"sac": "VZM-MEN-01", "warehouse_id": 44},
              "to": {"sac": "VZM-MEN-01", "warehouse_id": 91},
              "items": [{"item_code": "101010-0004", "qty": 780.0, "uom": "g"}]},
             StockTransferIn),
            (WASTAGE, WastageIn),
        ]:
            parsed = ingest.parse(json.dumps(body).encode(), model)
            assert parsed.event_id == body["event_id"]

    def test_an_unknown_event_name_is_refused(self):
        bad = {**ACK, "event": "facility.something_else"}
        with pytest.raises(ValidationError):
            ingest.parse(json.dumps(bad).encode(), AckIn)

    def test_a_body_that_is_not_json_is_a_422_not_a_500(self):
        with pytest.raises(ValidationError):
            ingest.parse(b"<html>gateway timeout</html>", AckIn)

    def test_an_acknowledgement_must_point_at_an_issue(self):
        orphan = {k: v for k, v in ACK.items()
                  if k not in ("issue_id", "issue_number")}
        with pytest.raises(ValidationError):
            ingest.parse(json.dumps(orphan).encode(), AckIn)

    def test_an_event_id_can_never_outgrow_the_key_it_becomes(self):
        # `apis.cams.evt.` + the id must fit sys_settings.setting_key (VARCHAR(100)),
        # or two events collide onto one row and the second is answered "duplicate".
        assert len(ingest.event_key("x" * MAX_EVENT_ID)) <= 100
        with pytest.raises(ValidationError):
            ingest.parse(json.dumps({**ACK, "event_id": "e" * 200}).encode(), AckIn)

    def test_an_event_id_that_is_not_key_shaped_is_refused(self):
        for bad in ["evt with spaces", "../../etc/passwd", "a", "evt%2fx"]:
            with pytest.raises(ValidationError):
                ingest.parse(json.dumps({**ACK, "event_id": bad}).encode(), AckIn)

    def test_a_field_b_cams_adds_later_does_not_reject_the_batch(self):
        parsed = ingest.parse(
            json.dumps({**ACK, "district": "Vizianagaram"}).encode(), AckIn)
        assert parsed.event_id == ACK["event_id"]


class TestReplies:
    def test_the_success_shape_echoes_the_event_id(self):
        receipt = {"event_id": "ack-1", "received_at": "2026-08-08T06:30:01"}
        assert ingest.ok(receipt) == {"ok": True, "event_id": "ack-1",
                                      "received_at": "2026-08-08T06:30:01"}

    def test_a_replay_is_answered_duplicate_and_changes_nothing(self):
        receipt = {"event_id": "ack-1", "received_at": "2026-08-08T06:30:01"}
        answer = ingest.duplicate(receipt)
        assert answer["ok"] is True and answer["duplicate"] is True
        assert answer["event_id"] == "ack-1"


# --------------------------------------------------------------------------- #
#  Posting a field event onto the shelf (2026-08-26)
# --------------------------------------------------------------------------- #
#
# The feed used to be recorded and never applied, so nothing the field consumed came
# off SCM's balance. It posts now. Two things are worth pinning: WHICH quantity each
# event takes, and that a line nobody can post is kept with its reason rather than
# lost. No database — `apply_event` reaches one only to look an item code up, and a
# stub says "no such item" faster than the suite can build 85 tables.

from types import SimpleNamespace

from app.modules.integrations.adapters.cams import apply as cams_apply
from app.modules.integrations.adapters.cams.enums import EventType
from app.shared.enums import RefType


class _NoSuchItem:
    """A database in which no item code resolves. Enough for every path below: the
    only query `apply_event` makes on its own is the item lookup, and a line that
    fails it never reaches `move_stock_out`."""
    async def scalar(self, *args, **kwargs):
        return None


def _line(**kw):
    base = {"item_code": "101010-0004", "warehouse_id": 78,
            "consumed_qty": Decimal("0"), "wastage_qty": Decimal("0")}
    return SimpleNamespace(**{**base, **kw})


def test_consumption_and_wastage_post_different_quantities():
    """THE double-count guard. A consumption record repeats its wastage for reporting
    and the same units arrive again on the wastage feed with a reason attached, so
    each event takes its own field and never the sum. Getting this wrong deducts every
    spoiled unit twice, and it would read as theft rather than as a bug."""
    assert cams_apply.POSTING[EventType.CONSUMPTION.value] == (
        "consumed_qty", RefType.CONSUMPTION.value)
    assert cams_apply.POSTING[EventType.WASTAGE.value] == (
        "wastage_qty", RefType.WASTAGE.value)


def test_the_three_events_that_must_not_move_stock():
    """An issue's status belongs to the warehouse module (rule 9) and a field
    stock-balance report is a statement about somebody else's shelf, not a movement
    of ours."""
    for event in (EventType.ACK.value, EventType.STOCK_BALANCE.value,
                  EventType.STOCK_TRANSFER.value):
        assert event not in cams_apply.POSTING


async def test_an_event_type_that_does_not_post_is_a_no_op():
    out = await cams_apply.apply_event(
        _NoSuchItem(), EventType.STOCK_BALANCE.value,
        SimpleNamespace(records=[_line(consumed_qty=Decimal("9"))]), "evt-1")
    assert out == {"posted": 0, "skipped": 0, "problems": []}


async def test_a_line_with_no_warehouse_is_kept_with_its_reason():
    """`warehouse_id` is the only key SCM matches a point on — `facility_name` is free
    text and matches nothing."""
    payload = SimpleNamespace(records=[_line(warehouse_id=None,
                                             consumed_qty=Decimal("5"))])
    out = await cams_apply.apply_event(
        _NoSuchItem(), EventType.CONSUMPTION.value, payload, "evt-2")

    assert out["posted"] == 0 and out["skipped"] == 1
    assert "no warehouse_id" in out["problems"][0]


async def test_an_unknown_item_code_is_kept_with_its_reason():
    payload = SimpleNamespace(records=[_line(item_code="NOT-AN-ITEM",
                                             consumed_qty=Decimal("5"))])
    out = await cams_apply.apply_event(
        _NoSuchItem(), EventType.CONSUMPTION.value, payload, "evt-3")

    assert out["posted"] == 0 and out["skipped"] == 1
    assert "item master" in out["problems"][0]


async def test_a_zero_line_is_neither_posted_nor_a_problem():
    """A zero row is how the field says 'this item was stocked and untouched today'."""
    payload = SimpleNamespace(records=[_line(consumed_qty=Decimal("0"))])
    out = await cams_apply.apply_event(
        _NoSuchItem(), EventType.CONSUMPTION.value, payload, "evt-4")

    assert out["posted"] == 0 and out["skipped"] == 0 and out["problems"] == []


async def test_wastage_reads_its_own_field_not_the_consumption_one():
    """A wastage event carrying consumed_qty must post the WASTAGE quantity."""
    payload = SimpleNamespace(records=[_line(item_code="NOT-AN-ITEM",
                                             consumed_qty=Decimal("99"),
                                             wastage_qty=Decimal("3"))])
    out = await cams_apply.apply_event(
        _NoSuchItem(), EventType.WASTAGE.value, payload, "evt-5")
    # It got as far as the item lookup, which means it read a non-zero wastage_qty
    # rather than skipping the line as empty.
    assert out["skipped"] == 1 and "item master" in out["problems"][0]


async def test_one_bad_line_does_not_sink_the_rest_of_the_batch():
    payload = SimpleNamespace(records=[
        _line(warehouse_id=None, consumed_qty=Decimal("1")),
        _line(item_code="NOT-AN-ITEM", consumed_qty=Decimal("1")),
        _line(consumed_qty=Decimal("0")),
    ])
    out = await cams_apply.apply_event(
        _NoSuchItem(), EventType.CONSUMPTION.value, payload, "evt-6")

    assert out["skipped"] == 2 and len(out["problems"]) == 2


def test_the_field_feed_never_claims_an_scm_identity():
    """The person named on a B-CAMS record is a user SCM has never authenticated, so
    the ledger says where the movement came from, not who they say they are."""
    assert cams_apply.ACTOR.id is None
    assert "B-CAMS" in cams_apply.ACTOR.full_name


# --------------------------------------------------------------------------- #
# The connection document
# --------------------------------------------------------------------------- #
# A doc a partner integrates against is a promise, and the two ways it goes wrong are
# an example that no longer validates and a URL that was never registered. Both are
# mechanical, so both are checked here rather than discovered by B-CAMS.

class TestConnectionDocs:
    def test_every_sample_validates_against_the_model_it_documents(self):
        for write in cams_docs.WRITES:
            payload = write.model.model_validate(write.sample)
            assert payload.event == write.event
            assert write.count(payload) >= 1

    def test_every_documented_url_is_a_registered_route(self):
        registered = {route.path for route in router.feeds.routes}
        doc = cams_docs.connection_docs("http://scm.example")
        for entry in doc["writes"]:
            path = entry["url"].removeprefix("http://scm.example")
            assert path in registered, f"{path} is documented but not registered"

    def test_the_host_comes_from_the_caller_not_from_source(self):
        """Rule 13: the address is never a literal. Whoever opens the screen reached
        SCM on some host, and that is the host the partner is handed."""
        doc = cams_docs.connection_docs("http://103.174.161.68:8023/")
        assert doc["base_url"] == "http://103.174.161.68:8023/api/ext/v1/cams"

    def test_the_two_events_that_move_stock_say_so(self):
        deducting = {w["event"] for w in cams_docs.connection_docs()["writes"]
                     if w["deducts_stock"]}
        assert deducting == {"facility.consumption", "facility.wastage"}
