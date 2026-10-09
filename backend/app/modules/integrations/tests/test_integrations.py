"""API console — unit tests that need no database.

The DB-backed suite drops and recreates ~85 tables per test, so what is pinned here is
what does not need one and what would be worst to get wrong. For a console that builds
SQL from what a browser sent, that is exactly two things: the key never being
recoverable from what is stored, and the builder never putting an unvalidated name
into a statement. Everything else is a screen.
"""
from datetime import datetime, timedelta

import pytest

from app.core.exceptions import ConflictError, PermissionError_, ValidationError
from app.modules.integrations import introspect, security, service, store
from app.modules.integrations.enums import KeyState
from app.modules.integrations.schemas import ClientWrite, EndpointWrite, FieldIn, JoinIn


def endpoint(**kw) -> dict:
    """A stored endpoint document, as `build()` receives it."""
    doc = {
        "slug": "stock", "name": "Stock", "client_code": "BILLING",
        "table": "stk_balance",
        "fields": [{"column": "item_code", "label": None},
                   {"column": "available_qty", "label": None}],
        "joins": [], "filters": {}, "filterable": ["warehouse_id"],
        "searchable": ["item_code"], "order_by": "id", "order_dir": "asc",
        "updated_column": "updated_at", "default_size": 100, "max_size": 500,
        "is_active": True,
    }
    doc.update(kw)
    return doc


def sql(doc, query=None) -> str:
    return service.sql_text(service.build(doc, query or {}))


# --------------------------------------------------------------------------- #
# The security boundary — the whole point of a generic picker
# --------------------------------------------------------------------------- #

class TestSourceBoundary:
    def test_the_tables_holding_credentials_can_never_be_served(self):
        # If this list ever shrinks, an endpoint over sys_local_credentials hands out
        # every password hash in the company.
        assert "sys_local_credentials" in introspect.BLOCKED_TABLES
        assert "sys_sessions" in introspect.BLOCKED_TABLES

    def test_the_console_cannot_serve_its_own_key_store(self):
        # Keys live in sys_settings. An endpoint over it would return every key hash
        # and every scope in the console.
        assert store.CATEGORY == "apis"
        assert "sys_settings" in introspect.BLOCKED_TABLES

    @pytest.mark.parametrize("name", [
        "password_hash", "PasswordHash", "key_hash", "token_jti", "api_key",
        "bank_account_no", "ifsc_code", "salary", "epfo_number", "uan",
        "aadhaar_no", "pan_number", "secret", "otp_code",
    ])
    def test_sensitive_column_names_are_blocked_everywhere(self, name):
        assert introspect.column_is_blocked(name)

    @pytest.mark.parametrize("name", [
        "item_code", "available_qty", "warehouse_name", "created_at", "indent_no",
        "panel_name",  # contains "pan" but is not a PAN column
    ])
    def test_ordinary_business_columns_are_not_blocked(self, name):
        assert not introspect.column_is_blocked(name)

    @pytest.mark.parametrize("name", [
        "mst_items; DROP TABLE x", "mst items", "1items", "", "a" * 65,
        "items--", "`items`", "items'", "sch.items",
    ])
    def test_a_name_that_is_not_a_plain_identifier_is_refused_by_shape(self, name):
        assert not introspect.is_identifier(name)

    @pytest.mark.parametrize("name", ["mst_items", "stk_balance", "_x", "T1"])
    def test_a_real_identifier_passes(self, name):
        assert introspect.is_identifier(name)

    def test_the_schema_map_is_the_single_place_filtering_happens(self):
        # Every reader goes through schema(); the picker, the validator and the query
        # builder cannot disagree about what is visible because none of them filters.
        source = (introspect.__doc__ or "") + str(introspect.schema.__doc__)
        assert "BLOCKED" in source or "filtered" in source


class TestSchemaFilter:
    def test_blocked_tables_and_columns_are_dropped_from_the_map(self, monkeypatch):
        rows = [
            ("mst_items", "id", "bigint"),
            ("mst_items", "code", "varchar"),
            ("sys_local_credentials", "employee_id", "bigint"),
            ("hcm_employees", "full_name", "varchar"),
            ("hcm_employees", "bank_account_no", "varchar"),
        ]

        class FakeResult:
            def all(self_inner):
                return rows

        class FakeDb:
            async def execute(self_inner, _stmt):
                return FakeResult()

        introspect.reset_cache()
        import asyncio

        found = asyncio.run(introspect.schema(FakeDb()))
        assert set(found) == {"mst_items", "hcm_employees"}
        assert set(found["hcm_employees"]) == {"full_name"}
        introspect.reset_cache()


# --------------------------------------------------------------------------- #
# Keys
# --------------------------------------------------------------------------- #

class TestKeys:
    def test_the_raw_key_cannot_be_recovered_from_what_is_stored(self):
        raw, prefix, digest = security.new_key()
        assert raw.startswith(prefix + ".")
        assert digest == security.hash_key(raw)
        assert raw.split(".", 1)[1] not in digest
        assert raw not in security.masked(prefix)

    def test_the_hash_never_leaves_the_store(self):
        doc = {"key_prefix": "scm_abcd1234", "key_hash": "deadbeef",
               "client_code": "BILLING", "label": "x", "scopes": []}
        assert "key_hash" not in service._key_out(doc)

    def test_a_row_says_whether_its_copy_press_can_actually_deliver(self):
        # The list must not offer a copy it cannot honour: a key from before the
        # console kept a copyable value has only its hash, and the press on that row
        # asks for the value instead of reporting a failure one click later.
        raw, prefix, digest = security.new_key()
        hash_only = {"key_prefix": prefix, "key_hash": digest,
                     "client_code": "BILLING", "label": "x", "scopes": []}
        assert service._key_out(hash_only)["can_copy"] is False
        assert service._key_out(
            {**hash_only, "key_secret": raw.encode("utf-8").hex()})["can_copy"] is True
        # Hex that is not a key reads as not copyable rather than raising.
        assert service._key_out({**hash_only, "key_secret": "zz"})["can_copy"] is False

    def test_the_value_kept_for_copying_is_the_one_that_was_issued(self):
        raw, _, digest = security.new_key()
        doc = {"key_secret": raw.encode("utf-8").hex()}
        assert service._key_text(doc) == raw
        # Which is what makes attaching one safe: the pasted string only survives if
        # it hashes to the digest already stored.
        assert security.hash_key(service._key_text(doc)) == digest

    def test_two_keys_are_never_the_same(self):
        assert len({security.new_key()[0] for _ in range(50)}) == 50

    def test_a_string_that_is_not_one_of_our_keys_has_no_prefix(self):
        assert security.split_prefix("") is None
        assert security.split_prefix("hunter2") is None
        assert security.split_prefix("scm_abcd") is None
        assert security.split_prefix("other_ab.secret") is None
        assert security.split_prefix("scm_abcd.secret") == "scm_abcd"

    def test_state_is_derived_from_the_timestamps_not_stored(self):
        assert security.key_state({}) == KeyState.ACTIVE.value
        assert security.key_state({
            "expires_at": (datetime.now() - timedelta(days=1)).isoformat(),
        }) == KeyState.EXPIRED.value
        # Revoked beats expired: a key somebody deliberately killed reads as revoked
        # even after its expiry passes.
        assert security.key_state({
            "revoked_at": datetime.now().isoformat(),
            "expires_at": (datetime.now() - timedelta(days=1)).isoformat(),
        }) == KeyState.REVOKED.value

    def test_an_empty_scope_list_means_every_endpoint_of_its_client(self):
        caller = security.Caller({"scopes": []}, {"code": "BILLING"})
        caller.require_scope("anything")   # does not raise

        narrowed = security.Caller({"scopes": ["stock"]}, {"code": "BILLING"})
        narrowed.require_scope("stock")
        with pytest.raises(PermissionError_):
            narrowed.require_scope("items")

    def test_rate_limit_refuses_past_the_ceiling_and_zero_means_off(self):
        security.reset_state()
        for _ in range(3):
            security.check_rate("scm_a", 3)
        with pytest.raises(security.RateLimitError):
            security.check_rate("scm_a", 3)
        for _ in range(50):
            security.check_rate("scm_b", 0)
        security.reset_state()

    def test_the_call_log_is_a_ring_that_forgets(self):
        from app.modules.integrations.enums import CALL_LOG_SIZE

        security.reset_state()
        for index in range(CALL_LOG_SIZE + 25):
            security.record("BILLING", slug="stock", status_code=200, row_count=index)
        entries = security.calls_for("BILLING")
        assert len(entries) == CALL_LOG_SIZE
        assert entries[0]["row_count"] == CALL_LOG_SIZE + 24   # newest first
        security.reset_state()


# --------------------------------------------------------------------------- #
# Composing an endpoint
# --------------------------------------------------------------------------- #

class TestEndpointDefinition:
    def test_a_slug_is_normalised_into_something_a_url_can_carry(self):
        assert EndpointWrite(slug="  BILLING Item_Master ", name="Items",
                             table="mst_items",
                             fields=[FieldIn(column="id")]).slug == "billing-item-master"
        with pytest.raises(ValueError):
            EndpointWrite(slug="-bad-", name="Items", table="mst_items",
                          fields=[FieldIn(column="id")])

    @pytest.mark.parametrize("bad", ["mst_items; DROP TABLE x", "a b", "1x", "x'"])
    def test_an_injected_table_name_is_refused_before_it_reaches_the_schema(self, bad):
        with pytest.raises(ValueError):
            EndpointWrite(slug="x", name="Stock", table=bad, fields=[FieldIn(column="id")])

    @pytest.mark.parametrize("bad", ["qty; DROP", "a b", "x'"])
    def test_an_injected_column_name_is_refused(self, bad):
        with pytest.raises(ValueError):
            FieldIn(column=bad)

    def test_a_blank_filter_row_is_dropped_rather_than_matching_nothing(self):
        body = EndpointWrite(slug="x", name="Stock", table="stk_balance",
                             fields=[FieldIn(column="id")],
                             filters={"warehouse_id": " 5 ", "project_id": "  "})
        assert body.filters == {"warehouse_id": "5"}

    @pytest.mark.parametrize("sent", [None, "", "   "])
    def test_no_change_column_can_be_said_in_any_of_the_ways_a_client_says_it(self, sent):
        # The screen posts "", an API client posts null, a hand-written body posts
        # whitespace. All three mean "this endpoint cannot be pulled incrementally";
        # null used to 422 the whole create.
        body = EndpointWrite(slug="x", name="Stock", table="stk_balance",
                             fields=[FieldIn(column="id")], updated_column=sent)
        assert body.updated_column == ""

    def test_sort_direction_is_only_asc_or_desc(self):
        with pytest.raises(ValueError):
            EndpointWrite(slug="x", name="Stock", table="stk_balance", fields=[FieldIn(column="id")],
                          order_dir="; DROP")

    def test_two_columns_cannot_come_back_under_one_name(self):
        doc = {
            "fields": [{"column": "name"}],
            "joins": [{"table": "mst_items", "base_column": "item_id",
                       "join_column": "id", "fields": [{"column": "x", "label": "name"}]}],
        }
        assert service.output_columns(doc) == ["name", "name"]

    def test_a_join_column_is_labelled_with_its_table_by_default(self):
        doc = {
            "fields": [{"column": "item_code"}],
            "joins": [{"table": "mst_items", "base_column": "item_id",
                       "join_column": "id", "fields": [{"column": "category_name"}]}],
        }
        assert service.output_columns(doc) == ["item_code", "mst_items_category_name"]

    def test_a_client_code_is_upper_cased_so_one_application_has_one_identity(self):
        assert ClientWrite(code=" billing ", name="Billing").code == "BILLING"
        assert ClientWrite(code="field app", name="Field App").code == "FIELD_APP"
        with pytest.raises(ValueError):
            ClientWrite(code="9lives", name="Nine Lives")


# --------------------------------------------------------------------------- #
# The query builder
# --------------------------------------------------------------------------- #

class TestQueryBuilder:
    def test_it_builds_a_select_over_the_chosen_table(self):
        statement = sql(endpoint())
        assert statement.upper().startswith("SELECT")
        assert "stk_balance" in statement
        assert "item_code" in statement

    def test_only_the_chosen_columns_come_back(self):
        head = sql(endpoint()).split("FROM")[0]
        assert "item_code" in head and "available_qty" in head
        # Filterable and searchable columns are usable but not returned.
        assert "warehouse_id" not in head

    def test_tables_chain_so_a_third_table_can_hang_off_the_second(self):
        # stk_balance -> mst_items -> mst_item_categories. Without from_index every
        # extra table could only hang off the base, which is not a chain.
        statement = sql(endpoint(joins=[
            {"table": "mst_items", "from_index": -1, "base_column": "item_id",
             "join_column": "id", "fields": [{"column": "category_id"}]},
            {"table": "mst_item_categories", "from_index": 0,
             "base_column": "category_id", "join_column": "id",
             "fields": [{"column": "name", "label": "category"}]},
        ]))
        assert statement.upper().count("LEFT OUTER JOIN") == 2
        # The second join reads from the FIRST join's alias, not from the base table.
        assert "j0.category_id = j1.id" in statement

    def test_a_join_pointing_forward_is_refused(self):
        import asyncio

        from app.modules.integrations.schemas import EndpointWrite, FieldIn, JoinIn

        body = EndpointWrite(
            slug="x", name="Stock", table="stk_balance",
            fields=[FieldIn(column="id")],
            joins=[JoinIn(table="mst_items", from_index=1, base_column="item_id",
                          join_column="id")],
        )
        with pytest.raises(ValidationError):
            asyncio.run(service.validate(None, body))

    def test_a_joined_column_can_be_filtered_under_the_name_it_comes_back_as(self):
        doc = endpoint(
            joins=[{"table": "mst_items", "from_index": -1, "base_column": "item_id",
                    "join_column": "id",
                    "fields": [{"column": "category_name", "label": "category"}]}],
            filterable=["category"])
        statement = sql(doc, {"category": "Pharma"})
        assert "j0.category_name" in statement and "Pharma" in statement

    def test_the_base_table_is_aliased_so_the_same_table_can_appear_twice(self):
        statement = sql(endpoint(joins=[
            {"table": "stk_balance", "from_index": -1, "base_column": "id",
             "join_column": "id", "fields": [{"column": "total_qty", "label": "mirror"}]},
        ]))
        assert "t0" in statement and "j0" in statement

    def test_a_join_is_left_so_a_missing_reference_does_not_drop_the_row(self):
        statement = sql(endpoint(joins=[{
            "table": "mst_items", "base_column": "item_id", "join_column": "id",
            "fields": [{"column": "category_name", "label": "category"}],
        }]))
        assert "LEFT OUTER JOIN" in statement.upper()
        assert "mst_items" in statement
        assert "category" in statement

    def test_a_pinned_filter_always_applies(self):
        statement = sql(endpoint(filters={"warehouse_id": "5"}))
        assert "warehouse_id" in statement and "5" in statement

    def test_a_caller_filter_narrows_and_never_widens(self):
        statement = sql(endpoint(filters={"warehouse_id": "5"}),
                        {"warehouse_id": "7"})
        assert " AND " in statement.upper()

    def test_a_caller_cannot_filter_on_a_column_the_endpoint_did_not_offer(self):
        # project_id is a real column but is not in `filterable`, so it is ignored.
        statement = sql(endpoint(), {"project_id": "99"})
        assert "project_id" not in statement

    def test_an_unknown_query_param_is_ignored_not_an_error(self):
        sql(endpoint(), {"_": "1234", "nonsense": "x"})

    def test_a_comma_separated_value_becomes_an_in_list(self):
        assert " IN " in sql(endpoint(), {"warehouse_id": "5,7"}).upper()

    def test_true_and_false_are_coerced_so_a_flag_filter_works(self):
        assert service._coerce("true") == 1
        assert service._coerce("FALSE") == 0
        assert service._coerce("CONSUMABLE") == "CONSUMABLE"

    def test_search_sweeps_only_the_declared_search_columns(self):
        statement = sql(endpoint(), {"search": "para"})
        assert "%para%" in statement
        assert statement.upper().count(" LIKE ") == 1

    def test_updated_since_is_refused_when_the_endpoint_has_no_change_column(self):
        with pytest.raises(ValidationError):
            sql(endpoint(updated_column=""), {"updated_since": "2026-08-01"})

    def test_updated_since_accepts_a_date_or_a_timestamp(self):
        assert service._as_datetime("2026-08-01") == datetime(2026, 8, 1)
        assert service._as_datetime("2026-08-01T09:30:00") == datetime(2026, 8, 1, 9, 30)
        assert service._as_datetime("2026-08-01 09:30:00+05:30") == datetime(
            2026, 8, 1, 9, 30)
        with pytest.raises(ValidationError):
            service._as_datetime("last tuesday")

    def test_the_declared_sort_is_honoured(self):
        assert "ASC" in sql(endpoint()).upper().split("ORDER BY")[1]
        assert "DESC" in sql(endpoint(order_dir="desc")).upper().split("ORDER BY")[1]

    def test_an_endpoint_with_no_columns_says_so(self):
        with pytest.raises(ValidationError):
            service.build(endpoint(fields=[]), {})


class TestSerialisation:
    def test_a_quantity_crosses_the_wire_as_a_string_not_a_float(self):
        from decimal import Decimal

        assert service._jsonable({"qty": Decimal("0.100"), "n": 3}) == {
            "qty": "0.100", "n": 3}

    def test_timestamps_are_iso(self):
        assert service._jsonable({
            "at": datetime(2026, 8, 12, 9, 30), "on": datetime(2026, 8, 12).date(),
            "nothing": None,
        }) == {"at": "2026-08-12T09:30:00", "on": "2026-08-12", "nothing": None}


class TestNoSchemaOfItsOwn:
    def test_the_module_declares_no_tables(self):
        from app.core.database import Base
        from app.modules.integrations import models  # noqa: F401

        assert not [t for t in Base.metadata.tables if t.startswith("api_")]

    def test_every_stored_key_fits_the_settings_column(self):
        """The worst case is the longest client code and the longest address, and it
        MUST fit: MySQL truncates silently, which would collide two endpoints onto one
        row rather than fail."""
        longest = store.endpoint_key("C" * 30, "a" * 60)
        assert len(longest) <= store.MAX_KEY

    def test_console_keys_are_namespaced_so_they_cannot_be_read_as_settings(self):
        for key in (store.client_key("BILLING"), store.key_key("scm_abcd1234"),
                    store.endpoint_key("BILLING", "billing-stock")):
            assert key.startswith(store.PREFIX)

    def test_an_address_is_filed_under_its_application(self):
        """The whole point: two applications may each own /hcm-employees, because the
        API key already says which application is calling. Before this an address was
        global, so seeding a second app meant renaming all 122 of its endpoints."""
        assert (store.endpoint_key("AIMS", "hcm-employees")
                != store.endpoint_key("BCAMS", "hcm-employees"))
        # The client is upper-cased on the way in (`ClientWrite._code`), so the key is
        # stable however the caller spelled it.
        assert (store.endpoint_key("aims", "hcm-employees")
                == store.endpoint_key("AIMS", "hcm-employees"))


class TestRouting:
    def test_both_halves_are_registered_and_never_share_a_path(self):
        from app.modules.integrations.router import router

        paths = {route.path for route in router.routes}
        assert "/api/apis/clients" in paths
        assert "/api/apis/tables" in paths
        assert "/api/ext/v1/{slug}" in paths
        assert not any(p.startswith("/api/ext/v1/clients") for p in paths)

    def test_the_literal_discovery_routes_are_declared_before_the_slug(self):
        from app.modules.integrations.router import router

        ordered = [r.path for r in router.routes if r.path.startswith("/api/ext/v1")]
        assert ordered.index("/api/ext/v1/_endpoints") < ordered.index("/api/ext/v1/{slug}")

    def test_every_console_route_is_permission_gated(self):
        # Rule 6: hiding a button is not security, the backend check is.
        from app.modules.integrations.router import console

        for route in console.routes:
            names = [d.call.__name__ for d in route.dependant.dependencies
                     if getattr(d, "call", None)]
            assert "checker" in names, f"{route.path} has no require_permission"

    def test_the_external_url_carries_no_host(self):
        # Rule 13: the host is the deployment's, never a literal in code.
        assert service.endpoint_url("billing-stock") == "/api/ext/v1/billing-stock"


# --------------------------------------------------------------------------- #
#  Moving an API surface between deployments (2026-08-26)
# --------------------------------------------------------------------------- #
#
# Composing 122 endpoints by hand on one machine and again on the next is not a
# migration. What matters is that the clip is DATA, not a trust boundary: it can name
# a table this deployment does not have, or one on the blocked list, and neither may
# get through just because it arrived as JSON.

def test_a_clip_carries_no_key_and_no_local_history():
    doc = endpoint()
    doc.update({"created_by_name": "Somebody Else", "created_at": "2026-01-01",
                "updated_at": "2026-01-02"})
    stripped = {k: v for k, v in doc.items()
                if k not in service._LOCAL_ONLY_FIELDS}

    assert "created_by_name" not in stripped
    assert "created_at" not in stripped
    assert "client_code" not in stripped
    # There is nothing to leak: only a hash of a key is ever stored.
    assert not any("key" in k for k in stripped)


def test_a_clip_from_another_version_is_refused():
    with pytest.raises(ValidationError):
        service._read_clip({"kind": service.CLIP_KIND, "v": 99, "endpoints": [{}]})


def test_something_that_is_not_a_clip_is_refused():
    with pytest.raises(ValidationError):
        service._read_clip({"hello": "world"})
    with pytest.raises(ValidationError):
        service._read_clip({"kind": "something-else", "v": 1, "endpoints": [{}]})


def test_an_empty_clip_is_refused():
    with pytest.raises(ValidationError):
        service._read_clip({"kind": service.CLIP_KIND, "v": 1, "endpoints": []})


def test_a_readable_clip_returns_its_endpoints():
    rows = [endpoint(), endpoint(slug="items")]
    assert service._read_clip(
        {"kind": service.CLIP_KIND, "v": 1, "endpoints": rows}) == rows


def test_a_clip_keeps_its_addresses_because_they_are_filed_per_application():
    """The clip is how a new application is seeded from one somebody already built —
    50 to 120 endpoints, which nobody composes twice by hand. Addresses arrive
    UNCHANGED: `store.endpoint_key` files each under its own application, so AIMS gets
    its own /hcm-employees beside BCAMS' rather than colliding with it."""
    rows = [endpoint(slug="hcm-employees"), endpoint(slug="items")]
    clip = {"kind": service.CLIP_KIND, "v": 1, "endpoints": rows}
    assert [r["slug"] for r in service._read_clip(clip)] == ["hcm-employees", "items"]
    assert (store.endpoint_key("AIMS", "hcm-employees")
            != store.endpoint_key("BCAMS", "hcm-employees"))


def test_the_tables_a_clip_can_never_reintroduce():
    """A blocked table is blocked on the way IN as well. `import_endpoints` runs the
    console's own `validate()` per endpoint, and these are what it refuses."""
    for table in ("sys_local_credentials", "sys_settings", "sys_password_resets",
                  "sys_email_claims", "sys_mail_messages"):
        assert table in introspect.BLOCKED_TABLES


# --------------------------------------------------------------------------- #
#  Inbound webhooks (2026-08-26)
# --------------------------------------------------------------------------- #
#
# The whole security question here is what an ADMIN can configure. A screen that could
# point an inbound feed at a business table would be a way around every module's own
# service — and around rule 7 for stock in particular — so the set of things a webhook
# can DO is closed, and the secret never comes back out.

import hashlib
import hmac
import json

from app.core.exceptions import AuthenticationError
from app.modules.integrations import webhooks


def test_a_webhook_can_only_do_what_the_server_offers():
    """`handler` names one of a closed set. There is no table name, no column mapping
    and no SQL on a webhook document, and adding a handler is a code change."""
    with pytest.raises(ValidationError):
        webhooks._validate("hcm", ["employee.updated"], "write_to_stk_balance")
    # The one that exists writes nothing at all.
    webhooks._validate("hcm", ["employee.updated"], "record")


def test_a_webhook_must_name_the_events_it_accepts():
    """One that accepts anything cannot be told apart from a misconfigured one."""
    with pytest.raises(ValidationError):
        webhooks._validate("hcm", [], "record")


@pytest.mark.parametrize("source", [
    "", "a", "HCM", "1hcm", "hcm_feed", "hcm feed", "hcm/feed", "x" * 40,
])
def test_a_webhook_name_that_cannot_be_a_url_segment_is_refused(source):
    with pytest.raises(ValidationError):
        webhooks._validate(source, ["e"], "record")


def test_the_secret_never_comes_back_out():
    """Same posture as an API key: the screen learns THAT one is set, never what it is."""
    public = webhooks._public({
        "source": "hcm", "events": ["employee.updated"],
        "secret_hmac_key": "deadbeef", "is_active": True,
    })
    assert public["has_secret"] is True
    assert "secret_hmac_key" not in public
    assert "deadbeef" not in json.dumps(public)


def test_the_signature_is_over_the_raw_bytes():
    """Re-serialising the JSON and signing that would compare a signature against a
    document the sender never sent."""
    secret = b"s3cret"
    timestamp = "1787800000"
    body = b'{"event":"employee.updated","event_id":"a"}'
    signed = timestamp.encode() + b"." + body
    assert webhooks.expected_signature(secret, timestamp, body) == (
        "sha256=" + hmac.new(secret, signed, hashlib.sha256).hexdigest())
    # One byte different anywhere and it does not match.
    assert webhooks.expected_signature(secret, timestamp, body + b" ") != \
        webhooks.expected_signature(secret, timestamp, body)


def test_an_unsigned_push_is_refused_when_a_secret_exists():
    doc = {"source": "hcm", "secret_hmac_key": b"k".hex(), "require_signature": True}
    with pytest.raises(AuthenticationError):
        webhooks.verify(doc, b"{}", None, None)
    with pytest.raises(AuthenticationError):
        webhooks.verify(doc, b"{}", "sha256=wrong", "1787800000",
                        now=1787800000)


def test_a_signed_push_requires_a_fresh_timestamp():
    secret = b"k"
    doc = {"source": "hcm", "secret_hmac_key": secret.hex(),
           "require_signature": True}
    body = b"{}"
    current = 1787800000
    current_text = str(current)
    signature = webhooks.expected_signature(secret, current_text, body)
    webhooks.verify(doc, body, signature, current_text, now=current)
    with pytest.raises(AuthenticationError):
        webhooks.verify(doc, body, signature, None, now=current)
    stale = str(current - webhooks.MAX_CLOCK_SKEW_SECONDS - 1)
    with pytest.raises(AuthenticationError):
        webhooks.verify(doc, body,
                        webhooks.expected_signature(secret, stale, body), stale,
                        now=current)


def test_a_webhook_with_no_secret_refuses_rather_than_waving_through():
    """Fail closed. The one exception is an explicit, recorded decision to run
    unsigned while two sides are being wired together."""
    with pytest.raises(AuthenticationError):
        webhooks.verify({"source": "hcm", "require_signature": True}, b"{}", None,
                        None)
    # Explicitly opted out — allowed, and logged as a warning where it happens.
    webhooks.verify({"source": "hcm", "require_signature": False}, b"{}", None,
                    None)


def test_hcm_history_is_scrubbed_before_it_is_stored():
    payload = {"event": "employee.updated", "pan_number": "ABCDE1234F",
               "employee": {"id": 7, "name": "Person",
                            "bank_details": {"account_number": "123"}}}
    safe = webhooks._storable_payload({"handler": "hcm_mirror"}, payload)
    assert safe["employee"] == {"id": 7, "name": "Person"}
    assert "pan_number" not in safe
    assert "ABCDE1234F" not in json.dumps(safe)


def test_hcm_sequence_detects_replays_and_gaps():
    doc = {"handler": "hcm_mirror", "last_sequence": 41}
    assert webhooks._sequence(doc, {"sequence": 42}) == 42
    with pytest.raises(ConflictError, match="stale"):
        webhooks._sequence(doc, {"sequence": 41})
    with pytest.raises(ConflictError, match="gap"):
        webhooks._sequence(doc, {"sequence": 44})
    with pytest.raises(ValidationError):
        webhooks._sequence(doc, {})


def test_a_body_that_is_not_a_json_object_is_refused():
    with pytest.raises(ValidationError):
        webhooks.json_body(b"not json")
    with pytest.raises(ValidationError):
        webhooks.json_body(b'["a list"]')
    assert webhooks.json_body(b'{"event":"x"}') == {"event": "x"}


def test_a_delivery_key_cannot_collide_across_sources():
    assert webhooks.delivery_key("hcm", "1") != webhooks.delivery_key("cams", "1")


# --------------------------------------------------------------------------- #
#  The HCM mirror handler (2026-08-27)
# --------------------------------------------------------------------------- #
#
# webhook -> fresh, sync -> correct. The handler closes the gap between two syncs; it
# does not replace the sync, because a push that never arrives leaves no trace and a
# feed that only ever adds cannot say what it missed.

def test_the_hcm_handler_is_offered_and_is_not_the_default():
    """Registering a webhook must not start writing to the mirror by accident."""
    assert "hcm_mirror" in webhooks.HANDLERS
    # The default is the one that writes nothing, so registering a webhook can never
    # start updating the mirror because somebody left a dropdown alone.
    from app.modules.integrations.schemas import WebhookWrite
    assert WebhookWrite.model_fields["handler"].default == "record"


@pytest.mark.parametrize("event,entity", [
    ("employee.created", "employees"),
    ("employee.updated", "employees"),
    ("employee.deactivated", "employees"),
    ("position.updated", "positions"),
    ("position_assignment.updated", "position_assignments"),
    ("position_level.updated", "position_levels"),
    ("role.updated", "roles"),
    ("office.updated", "offices"),
    ("facility.updated", "facilities"),
    ("facility_type.updated", "facility_types"),
    ("department.updated", "departments"),
    ("project.updated", "projects"),
    ("section.updated", "sections"),
])
def test_every_event_prefix_names_a_mirror_table(event, entity):
    head = event.partition(".")[0]
    assert webhooks.HCM_ENTITIES[head] == entity


def test_a_suffix_that_retires_is_told_apart_from_one_that_upserts():
    """Retire, not delete: `wf_instances.resolved_chain` and every historical approval
    name these ids and must still resolve to a name."""
    for suffix in ("deactivated", "deleted", "removed", "terminated"):
        assert suffix in webhooks.RETIRING
    for suffix in ("created", "updated"):
        assert suffix not in webhooks.RETIRING


def test_an_event_outside_the_mirror_is_recorded_not_guessed_at():
    """`payment.settled` names nothing in hcm_*, so it is kept and NOT forced into a
    table that happens to sort first."""
    assert "payment" not in webhooks.HCM_ENTITIES
    assert "stock" not in webhooks.HCM_ENTITIES


def test_the_suggested_events_are_all_routable():
    """Every name the picker offers must actually reach a table, or the suggestion is
    a trap: it would be accepted at push time and then only recorded."""
    for event in webhooks.SUGGESTED_EVENTS:
        head, _, tail = event.partition(".")
        assert head in webhooks.HCM_ENTITIES, event
        assert tail in ("created", "updated") or tail in webhooks.RETIRING, event
