"""AIMS push — the parts that would be worst to get wrong, without a database.

  * an event is signed exactly the way SCM's own webhook verifier checks one, so the
    AIMS side can use the same rule;
  * a failing stock-in hook can never refuse or unwind the stock movement it observes;
  * the hook does nothing (writes nothing, sends nothing) until the push is switched on,
    and nothing for a consumable item;
  * every console route is behind a permission, the sensitive ones behind keys.manage.
"""
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from app.modules.integrations import webhooks
from app.modules.integrations.adapters.aims import outbox, router
from app.modules.inventory import hooks
from app.platform.rbac import permissions as perms


class TestSigning:
    def test_signature_verifies_with_scms_own_webhook_rule(self):
        raw = "not-a-real-secret"
        body = b'{"event_id":"stk-000000000001"}'
        headers = outbox.signed_headers(raw.encode(), body, "stk-000000000001")
        doc = {"secret_hmac_key": raw.encode().hex(), "source": "aims-test"}
        # Raises on a bad signature or a stale timestamp; passing is the assertion.
        webhooks.verify(doc, body, headers[webhooks.SIGNATURE_HEADER],
                        headers[webhooks.TIMESTAMP_HEADER])
        assert headers[outbox.EVENT_HEADER] == "stk-000000000001"

    def test_a_tampered_body_is_refused(self):
        raw = "not-a-real-secret"
        headers = outbox.signed_headers(raw.encode(), b'{"a":1}', "e1")
        doc = {"secret_hmac_key": raw.encode().hex(), "source": "aims-test"}
        with pytest.raises(Exception):
            webhooks.verify(doc, b'{"a":2}', headers[webhooks.SIGNATURE_HEADER],
                            headers[webhooks.TIMESTAMP_HEADER])


class _FakeDb:
    """Just enough of an AsyncSession for `fire_stock_in`: a savepoint that records."""

    def __init__(self):
        self.savepoints = 0

    @asynccontextmanager
    async def begin_nested(self):
        self.savepoints += 1
        yield


class TestHookIsolation:
    async def test_a_failing_hook_never_fails_the_movement(self, monkeypatch):
        calls = []

        async def broken(db, movement, user):
            raise RuntimeError("AIMS is down")

        async def fine(db, movement, user):
            calls.append(movement.ref_no)

        monkeypatch.setattr(hooks, "ON_STOCK_IN", [broken, fine])
        db = _FakeDb()
        await hooks.fire_stock_in(db, SimpleNamespace(ref_type="RECEIPT", ref_no="GRN-1"),
                                  SimpleNamespace(id=1))
        assert calls == ["GRN-1"]          # the next hook still ran
        assert db.savepoints == 2          # each in its own savepoint

    def test_only_arrivals_are_observed(self):
        assert {"GRN", "RECEIPT", "DISPATCH", "TRANSFER", "STO"} == hooks.STOCK_IN_REF_TYPES
        assert "ISSUE" not in hooks.STOCK_IN_REF_TYPES
        assert "ADJUSTMENT" not in hooks.STOCK_IN_REF_TYPES

    def test_the_adapter_registers_itself_once(self):
        assert hooks.ON_STOCK_IN.count(outbox.on_stock_in) == 1


class TestSwitchedOff:
    async def test_nothing_is_recorded_until_the_push_is_on(self, monkeypatch):
        async def no_config(db):
            return {}

        async def must_not_write(*args, **kwargs):
            raise AssertionError("wrote an event while switched off")

        monkeypatch.setattr(outbox, "config", no_config)
        monkeypatch.setattr(outbox.store, "put", must_not_write)
        await outbox.on_stock_in(object(), SimpleNamespace(item_id=1), SimpleNamespace())

    async def test_a_consumable_is_never_pushed(self, monkeypatch):
        async def on(db):
            return {"enabled": True, "url": "https://aims.example/api"}

        class Db:
            async def get(self, model, key):
                return SimpleNamespace(id=key, is_asset=False, code="PAPER", name="A4")

        async def must_not_write(*args, **kwargs):
            raise AssertionError("pushed a consumable")

        monkeypatch.setattr(outbox, "config", on)
        monkeypatch.setattr(outbox.store, "put", must_not_write)
        await outbox.on_stock_in(Db(), SimpleNamespace(item_id=7, warehouse_id=1),
                                 SimpleNamespace())

    async def test_delivery_is_skipped_when_off(self, monkeypatch):
        async def off(db):
            return {"enabled": False}

        monkeypatch.setattr(outbox, "config", off)
        result = await outbox.deliver_with(object())
        assert result["sent"] == 0 and "skipped" in result


class TestConsoleGuards:
    def _guard(self, path: str, method: str) -> str | None:
        for route in router.console.routes:
            if route.path == path and method in route.methods:
                for dep in route.dependant.dependencies:
                    code = getattr(dep.call, "__closure__", None)
                    if code:
                        for cell in code:
                            if isinstance(cell.cell_contents, str):
                                return cell.cell_contents
        return None

    def test_every_console_route_needs_a_permission(self):
        for route in router.console.routes:
            names = [getattr(d.call, "__name__", "") for d in route.dependant.dependencies]
            assert "checker" in names, route.path

    def test_sensitive_actions_need_keys_manage(self):
        prefix = "/api/apis/aims"
        assert self._guard(f"{prefix}/config", "PUT") == perms.INTEGRATION_KEYS_MANAGE
        assert self._guard(f"{prefix}/secret", "POST") == perms.INTEGRATION_KEYS_MANAGE
        assert self._guard(f"{prefix}/deliver", "POST") == perms.INTEGRATION_MANAGE
        assert self._guard(f"{prefix}/status", "GET") == perms.INTEGRATION_VIEW
