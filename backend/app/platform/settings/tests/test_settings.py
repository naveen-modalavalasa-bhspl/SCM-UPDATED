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
