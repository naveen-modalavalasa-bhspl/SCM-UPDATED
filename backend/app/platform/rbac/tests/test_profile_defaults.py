"""Default job profiles: what an unconfigured job resolves to.

Without a default, an unconfigured position falls through to its HCM role — which is
the leak the Job Profiles screen exists to close, since one HCM role covers many
unrelated jobs. A default lets an admin say "until someone configures this job, show
it these screens" instead.

The order under test is the one the approval ladders already use: the job's own
profile, then its project's default, then the company-wide default, then the old HCM
behaviour. Each rung must beat the one after it.
"""
import pytest

from sqlalchemy import select

from app.platform.hcm.models import (
    HcmEmployee, HcmPosition, HcmPositionAssignment,
)
from app.platform.rbac import profiles as P
from app.platform.rbac.models import Role
from app.shared.models.base import utcnow

PROJECT_ID = 41
OTHER_PROJECT_ID = 42
POSITION_ID = 9101
EMPLOYEE_ID = 9201


@pytest.fixture
async def position(db):
    """Two projects, one active position each.

    The second project has to carry a real position: a default bucket only exists for
    a project `_derive` can see, and it derives projects from the people holding
    posts. A project with nobody in it has no jobs, so it has nothing to default.
    """
    for emp_id, pos_id, assign_id, project_id, code in (
        (EMPLOYEE_ID, POSITION_ID, 9301, PROJECT_ID, "SK-TEST-1"),
        (EMPLOYEE_ID + 1, POSITION_ID + 1, 9302, OTHER_PROJECT_ID, "SK-TEST-2"),
    ):
        db.add(HcmEmployee(
            id=emp_id, full_name=f"Default Tester {emp_id}", emp_code=f"DEF-{emp_id}",
            is_active=True, synced_at=utcnow(),
            project_id=project_id, project_name=f"Test Project {project_id}",
        ))
        db.add(HcmPosition(
            id=pos_id, name="STORE KEEPER", code=code,
            job_name="STORE KEEPER", is_active=True, synced_at=utcnow(),
        ))
        db.add(HcmPositionAssignment(
            # Mirrored from HCM, so the id is supplied rather than generated.
            id=assign_id, position_id=pos_id, employee_id=emp_id,
            is_active=True, synced_at=utcnow(),
        ))
    await db.commit()
    return POSITION_ID


async def grant(db, key: str, name: str):
    """Save a profile the way the screen does, so the test exercises the real path."""
    await P.set_profile_access(
        db, key, page_codes=[], permission_codes=[], scope="SELF", name=name, actor=None,
    )
    await db.commit()


async def resolved_name(db, position_id: int) -> str | None:
    role = await P.profile_role_for_position(db, position_id)
    return role.name if role else None


async def test_no_default_falls_through_to_hcm_role(db, position):
    """Nothing configured: unchanged behaviour, so deploying this changes nobody."""
    assert await resolved_name(db, position) is None


async def test_company_default_applies_when_nothing_else_is_set(db, position):
    await grant(db, P.COMPANY_DEFAULT_KEY, "Company default")
    assert await resolved_name(db, position) == "Company default"


async def test_project_default_beats_the_company_default(db, position):
    await grant(db, P.COMPANY_DEFAULT_KEY, "Company default")
    await grant(db, P.profile_key(PROJECT_ID, P.DEFAULT_JOB), "Project default")
    assert await resolved_name(db, position) == "Project default"


async def test_the_jobs_own_profile_beats_every_default(db, position):
    await grant(db, P.COMPANY_DEFAULT_KEY, "Company default")
    await grant(db, P.profile_key(PROJECT_ID, P.DEFAULT_JOB), "Project default")

    derived = await P._derive(db)
    own_key = next(
        k for k, b in derived.items()
        if not P.is_default_key(k) and POSITION_ID in b["position_ids"]
    )
    await grant(db, own_key, "The job itself")

    assert await resolved_name(db, position) == "The job itself"


async def test_another_projects_default_does_not_leak(db, position):
    """A default is scoped to its project. This is the whole point of keying on it.

    Both projects hold the same job name, so if the key were the job alone this would
    resolve to the other project's default instead of falling through.
    """
    await grant(db, P.profile_key(OTHER_PROJECT_ID, P.DEFAULT_JOB), "Other project")

    assert await resolved_name(db, position) is None
    assert await resolved_name(db, POSITION_ID + 1) == "Other project"


async def test_defaults_are_offered_for_every_project_and_company_wide(db, position):
    data = await P.list_profiles(db)
    keys = {item["key"] for item in data["items"] if item["is_default"]}

    assert P.COMPANY_DEFAULT_KEY in keys
    assert P.profile_key(PROJECT_ID, P.DEFAULT_JOB) in keys


async def test_defaults_are_excluded_from_the_project_filter_and_the_job_count(
    db, position,
):
    """"Every project" is a label on the company default, not a project to filter by."""
    data = await P.list_profiles(db)

    assert "Every project" not in {name for _, name in data["projects"]}
    assert data["total"] == sum(1 for i in data["items"] if not i["is_default"])


async def test_resetting_a_default_restores_the_hcm_fallback(db, position):
    await grant(db, P.COMPANY_DEFAULT_KEY, "Company default")
    assert await resolved_name(db, position) == "Company default"

    await P.reset_profile(db, P.COMPANY_DEFAULT_KEY, actor=None)
    await db.commit()

    assert await resolved_name(db, position) is None
    assert (await db.execute(select(Role).where(
        Role.description.startswith(f"{P.PROFILE_PREFIX}{P.COMPANY_DEFAULT_KEY}|"),
        Role.is_active.is_(True),
    ))).scalars().first() is None
