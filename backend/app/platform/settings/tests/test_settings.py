"""Settings service + HCM schedule storage."""
from app.platform.settings import service


async def test_setting_get_set_and_default(db):
    assert await service.get_setting(db, "missing", "fallback") == "fallback"
    await service.set_setting(db, "k", "v")
    assert await service.get_setting(db, "k") == "v"
    await service.set_setting(db, "k", "v2")     # update path
    assert await service.get_setting(db, "k") == "v2"


async def test_hcm_schedule_roundtrip(db):
    enabled, interval = await service.get_hcm_schedule(db)
    assert enabled is False and interval == 1440   # defaults

    await service.set_hcm_schedule(db, True, 60)
    enabled, interval = await service.get_hcm_schedule(db)
    assert enabled is True and interval == 60


def test_audit_values_that_json_cannot_write_are_coerced():
    """`changed_fields` is a JSON column, so a `time` in a before/after dict used to
    fail the INSERT and with it the caller's own save — a monthly-indent reminder
    carries `trigger_time`, and saving one 500'd. Coercion lives in the writer so a
    new caller cannot forget it."""
    import json
    from datetime import date, datetime, time
    from decimal import Decimal

    from app.shared.enums import AuditAction

    safe = service.audit_safe({
        "trigger_time": time(17, 0),
        "required_date": date(2026, 9, 21),
        "created_at": datetime(2026, 9, 21, 17, 0, 30),
        "total_qty": Decimal("5.000"),
        "action": AuditAction.CREATE,
        "lines": [{"at": time(9, 30)}],
        "name": "reminder", "day": 21, "on": True, "nothing": None,
    })

    assert safe["trigger_time"] == "17:00:00"
    assert safe["required_date"] == "2026-09-21"
    assert safe["created_at"] == "2026-09-21T17:00:30"
    assert safe["total_qty"] == 5.0
    assert safe["action"] == AuditAction.CREATE.value
    assert safe["lines"] == [{"at": "09:30:00"}]
    # Already-JSON-native values pass through untouched, so no existing caller moves.
    assert safe["name"] == "reminder" and safe["day"] == 21
    assert safe["on"] is True and safe["nothing"] is None
    json.dumps(safe)   # what the driver does; it used to raise here


def test_a_diff_over_coerced_values_still_sees_only_real_changes():
    """Coercing before diffing must not invent a change: a `date` and its ISO string
    compare equal only because both sides go through the same door."""
    from datetime import date

    before = {"required_date": date(2026, 9, 21), "remarks": "a"}
    after = {"required_date": date(2026, 9, 21), "remarks": "b"}
    changed = service.diff_fields(service.audit_safe(before), service.audit_safe(after))
    assert changed == {"remarks": {"from": "a", "to": "b"}}
