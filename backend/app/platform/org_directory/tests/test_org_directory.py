"""The organisation directory: two unlinked lists, and a bad answer changes nothing."""
import pytest
from sqlalchemy import select

from app.platform.hcm.models import HcmDepartment
from app.platform.org_directory import service
from app.platform.settings.models import HcmSyncLog
from app.shared.models.base import utcnow
from app.shared.models.master import OrgDepartment, Organization
from app.shared.numbering import preview_number

FEED = {
    "status": "success",
    "organizations": [{"id": 2, "name": "BAVYA", "code": "B-01"},
                      {"id": 1, "name": "Sample Org", "code": "S-ORG-01"}],
    "departments": [{"id": 2, "name": "HUMAN RESOURCES", "code": "HR-01"},
                    {"id": 1, "name": "Sample Dept", "code": "S-DEP-01"}],
}


def test_parse_reads_the_two_lists_independently():
    organisations, departments = service.parse_feed(FEED)
    assert [row["name"] for row in organisations] == ["BAVYA", "Sample Org"]
    assert [row["code"] for row in departments] == ["HR-01", "S-DEP-01"]
    assert "organization" not in departments[0]


@pytest.mark.parametrize("payload", [
    {"status": "failed", "organizations": FEED["organizations"],
     "departments": FEED["departments"]},
    {"status": "success", "departments": FEED["departments"]},
    {"status": "success", "organizations": [], "departments": FEED["departments"]},
    {"status": "success", "organizations": FEED["organizations"], "departments": []},
    {"status": "success", "organizations": [{"name": "No id"}],
     "departments": FEED["departments"]},
    {"status": "success", "organizations": [{"id": 1, "name": "A"}, {"id": 1, "name": "B"}],
     "departments": FEED["departments"]},
    ["not", "a", "dict"],
])
def test_parse_refuses_a_bad_answer(payload):
    with pytest.raises(service.FeedError):
        service.parse_feed(payload)


@pytest.mark.asyncio
async def test_sync_is_repeatable_follows_renames_and_retires(db):
    db.add(HcmDepartment(id=2, name="HCM dept with the same id", synced_at=utcnow()))
    await db.commit()

    assert await service.sync(db, FEED) == {"organisations": 2, "departments": 2}
    assert await service.sync(db, FEED) == {"organisations": 2, "departments": 2}
    assert len((await db.execute(select(Organization))).scalars().all()) == 2

    await service.sync(db, {
        "status": "success",
        "organizations": [{"id": 2, "name": "BAVYA HEALTH", "code": "B-02"}],
        "departments": FEED["departments"],
    })
    db.expire_all()
    renamed = await db.get(Organization, 2)
    assert (renamed.name, renamed.code, renamed.is_active) == ("BAVYA HEALTH", "B-02", True)
    assert (await db.get(Organization, 1)).is_active is False
    # Departments stay out of HCM's table, even on a matching id.
    assert (await db.get(HcmDepartment, 2)).name == "HCM dept with the same id"
    assert (await db.get(OrgDepartment, 2)).name == "HUMAN RESOURCES"

    active = await service.list_organisations(db)
    everything = await service.list_organisations(db, include_inactive=True)
    assert [row["id"] for row in active["items"]] == [2]
    assert everything["total"] == 2


@pytest.mark.asyncio
async def test_a_bad_answer_changes_nothing_and_is_logged(db):
    await service.sync(db, FEED)
    with pytest.raises(service.FeedError):
        await service.sync(db, {"status": "success", "organizations": [],
                                "departments": []})
    db.expire_all()
    assert (await db.get(Organization, 2)).is_active is True
    status = await service.sync_status(db)
    assert status["last_status"] == "FAILED"
    assert status["last_error"]
    assert status["last_success_at"] is not None
    rows = (await db.execute(select(HcmSyncLog).where(
        HcmSyncLog.source == service.LOG_SOURCE))).scalars().all()
    assert [row.status for row in rows] == ["SUCCESS", "FAILED"]


@pytest.mark.asyncio
async def test_preview_takes_no_number(db):
    number = await preview_number(db, "po", company="BAVYA", project="104")
    assert number.startswith("BAV/104/") and number.endswith("####")
    again = await preview_number(db, "po", company="BAVYA", project="104")
    assert again == number
