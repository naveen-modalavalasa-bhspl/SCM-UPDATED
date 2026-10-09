"""Local approval posts — the chairs HCM does not have.

A ladder rung has always had to be something in the HCM mirror: a rank to climb to, or
a `hcm_positions` row to name. For the SCM flow that is a dead end. HCM has no SCM
Head, no Indent Team, no Logistics, no Director and no Accounts, the team that owns
HCM has not created them, and the six warehouse posts that DO exist come across with
`project_id` and `parent_position_id` both NULL — so nothing climbs to them and no
project scope shows them.

This module gives the admin a third kind of rung: a post created here, seated with real
employees, tickable in a ladder beside the HCM ones. Deliberately still a POST — the
rung is a chair, so when the person in it changes the ladder does not.

Nothing here touches `hcm_*`; those tables stay read-only (rule 10). The link back is
`ApprovalPost.hcm_position_id`, set on the day HCM finally creates the real position,
which lets a saved ladder switch over without being rebuilt.
"""
import logging
import re

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.platform.hcm.models import HcmEmployee
from app.platform.settings.service import write_audit
from app.platform.workflow.models import ApprovalPost, ApprovalPostMember, Stage
from app.shared.enums import AuditAction

logger = logging.getLogger(__name__)


def _code_from(name: str) -> str:
    """A stable, readable code. Uniqueness is settled by the caller, not here."""
    slug = re.sub(r"[^A-Z0-9]+", "-", (name or "").upper()).strip("-")
    return (slug or "POST")[:40]


async def _unique_code(db: AsyncSession, name: str, exclude_id: int | None = None) -> str:
    base = _code_from(name)
    stmt = select(ApprovalPost.code).where(ApprovalPost.code.like(f"{base}%"))
    if exclude_id is not None:
        stmt = stmt.where(ApprovalPost.id != exclude_id)
    taken = {row[0] for row in (await db.execute(stmt)).all()}
    if base not in taken:
        return base
    for suffix in range(2, 100):
        candidate = f"{base}-{suffix}"
        if candidate not in taken:
            return candidate
    raise ValidationError(f"Too many posts named like {name!r}")


async def members_of(db: AsyncSession, post_ids: list[int]) -> dict[int, list[dict]]:
    """Seated employees per post, in one query rather than one per post."""
    if not post_ids:
        return {}
    rows = (await db.execute(
        select(ApprovalPostMember)
        .where(ApprovalPostMember.post_id.in_(post_ids),
               ApprovalPostMember.is_active.is_(True))
    )).scalars().all()
    employee_ids = {row.employee_id for row in rows}
    live: dict[int, HcmEmployee] = {}
    if employee_ids:
        live = {e.id: e for e in (await db.execute(
            select(HcmEmployee).where(HcmEmployee.id.in_(employee_ids))
        )).scalars().unique().all()}

    out: dict[int, list[dict]] = {}
    for row in rows:
        employee = live.get(row.employee_id)
        out.setdefault(row.post_id, []).append({
            "id": row.employee_id,
            # The snapshot is the fallback, not the source: a live name is the current
            # one, and only a person the mirror has dropped falls back to what was
            # recorded when they were seated.
            "name": (employee.full_name if employee else None) or row.employee_name
                     or f"Employee {row.employee_id}",
            "code": employee.emp_code if employee else None,
            # An employee HCM has since retired still holds the chair on paper. Said out
            # loud so the admin can reseat it rather than discovering it at submit time.
            "is_stale": employee is None or not employee.is_active,
        })
    return out


async def holders(db: AsyncSession, post_id: int,
                  exclude_employee_id: int | None = None) -> list[HcmEmployee]:
    """The live employees who may act on a rung that names this post.

    Mirrors `ladder._position_holders`: inactive employees are not approvers, and a
    post nobody fills returns [] so the rung is skipped rather than stranding the
    document.
    """
    employee_ids = [
        row[0] for row in (await db.execute(
            select(ApprovalPostMember.employee_id).where(
                ApprovalPostMember.post_id == post_id,
                ApprovalPostMember.is_active.is_(True),
            )
        )).all()
        if row[0] is not None and row[0] != exclude_employee_id
    ]
    if not employee_ids:
        return []
    return list((await db.execute(
        select(HcmEmployee).where(
            HcmEmployee.id.in_(employee_ids), HcmEmployee.is_active.is_(True))
    )).scalars().unique().all())


async def list_posts(db: AsyncSession, include_inactive: bool = False) -> dict:
    stmt = select(ApprovalPost)
    if not include_inactive:
        stmt = stmt.where(ApprovalPost.is_active.is_(True))
    rows = list((await db.execute(
        stmt.order_by(ApprovalPost.department, ApprovalPost.name))).scalars().all())
    seated = await members_of(db, [row.id for row in rows])
    used = await _usage(db, [row.id for row in rows])
    return {"items": [{
        "id": row.id,
        "code": row.code,
        "name": row.name,
        "department": row.department,
        "hcm_position_id": row.hcm_position_id,
        "rbac_role_id": row.rbac_role_id,
        "is_active": row.is_active,
        "members": seated.get(row.id, []),
        # How many saved ladders name this post, so deactivating it is an informed
        # choice rather than a surprise.
        "used_in_ladders": used.get(row.id, 0),
    } for row in rows]}


async def _usage(db: AsyncSession, post_ids: list[int]) -> dict[int, int]:
    if not post_ids:
        return {}
    rows = (await db.execute(
        select(Stage.post_id, func.count(func.distinct(Stage.workflow_id)))
        .where(Stage.post_id.in_(post_ids)).group_by(Stage.post_id)
    )).all()
    return {row[0]: row[1] for row in rows}


async def save_post(db: AsyncSession, data, user, post_id: int | None = None) -> dict:
    """Create or update a post and replace its seating in one go."""
    name = (data.name or "").strip()
    if not name:
        raise ValidationError("Name is required")

    if post_id is None:
        post = ApprovalPost(code=await _unique_code(db, name), name=name,
                            department=(data.department or "").strip() or None,
                            hcm_position_id=data.hcm_position_id,
                            rbac_role_id=data.rbac_role_id, is_active=True)
        db.add(post)
        await db.flush()
        action = AuditAction.CREATE
    else:
        post = await db.get(ApprovalPost, post_id)
        if post is None:
            raise NotFoundError(f"Approval post {post_id} not found")
        post.name = name
        post.department = (data.department or "").strip() or None
        post.hcm_position_id = data.hcm_position_id
        post.rbac_role_id = data.rbac_role_id
        if data.is_active is not None:
            post.is_active = data.is_active
        action = AuditAction.UPDATE

    await _reseat(db, post.id, data.employee_ids or [])
    await write_audit(
        db, entity="wf_approval_posts", entity_id=post.id, entity_no=post.code[:50],
        action=action, actor=user,
        after={"name": post.name, "department": post.department,
               "rbac_role_id": post.rbac_role_id,
               "employee_ids": data.employee_ids or []},
        summary=f"Approval post {post.name} saved with "
                f"{len(data.employee_ids or [])} member(s)",
    )
    await db.commit()
    logger.info("Approval post %s (%s) saved by %s", post.name, post.code,
                getattr(user, "full_name", user))
    return await get_post(db, post.id)


async def _reseat(db: AsyncSession, post_id: int, employee_ids: list[int]) -> None:
    """Set the seating to exactly `employee_ids`.

    Rows are deactivated rather than deleted, and reactivated if the same person comes
    back, so the audit trail of who sat where survives (rule 9).
    """
    wanted = {int(value) for value in employee_ids}
    if wanted:
        known = {row[0] for row in (await db.execute(
            select(HcmEmployee.id).where(HcmEmployee.id.in_(wanted))
        )).all()}
        missing = sorted(wanted - known)
        if missing:
            raise ValidationError(f"Unknown employee {missing[0]}")

    names = {}
    if wanted:
        names = {e.id: e.full_name for e in (await db.execute(
            select(HcmEmployee).where(HcmEmployee.id.in_(wanted))
        )).scalars().unique().all()}

    existing = list((await db.execute(
        select(ApprovalPostMember).where(ApprovalPostMember.post_id == post_id)
    )).scalars().all())
    seen: set[int] = set()
    for row in existing:
        row.is_active = row.employee_id in wanted
        if row.is_active:
            row.employee_name = names.get(row.employee_id, row.employee_name)
            seen.add(row.employee_id)
    for employee_id in sorted(wanted - seen):
        db.add(ApprovalPostMember(
            post_id=post_id, employee_id=employee_id,
            employee_name=names.get(employee_id), is_active=True))


async def get_post(db: AsyncSession, post_id: int) -> dict:
    post = await db.get(ApprovalPost, post_id)
    if post is None:
        raise NotFoundError(f"Approval post {post_id} not found")
    seated = await members_of(db, [post.id])
    used = await _usage(db, [post.id])
    return {"id": post.id, "code": post.code, "name": post.name,
            "department": post.department, "hcm_position_id": post.hcm_position_id,
            "rbac_role_id": post.rbac_role_id,
            "is_active": post.is_active, "members": seated.get(post.id, []),
            "used_in_ladders": used.get(post.id, 0)}


async def deactivate_post(db: AsyncSession, post_id: int, user) -> dict:
    """Retire a post. Never deleted — saved ladders still name it.

    A retired post makes its rung resolve to nobody, which the engine skips rather than
    stranding the document. Loud in the log because that silently shortens a ladder.
    """
    post = await db.get(ApprovalPost, post_id)
    if post is None:
        raise NotFoundError(f"Approval post {post_id} not found")
    post.is_active = False
    used = (await _usage(db, [post.id])).get(post.id, 0)
    await write_audit(
        db, entity="wf_approval_posts", entity_id=post.id, entity_no=post.code[:50],
        action=AuditAction.DEACTIVATE, actor=user, before={"name": post.name},
        summary=f"Approval post {post.name} retired ({used} ladder(s) name it)",
    )
    await db.commit()
    if used:
        logger.warning("Approval post %s retired while %s ladder(s) still name it — "
                       "those rungs will now be skipped", post.name, used)
    return {"id": post.id, "is_active": False, "used_in_ladders": used}


async def search_employees(db: AsyncSession, term: str, limit: int = 20) -> dict:
    """People to seat in a post. A name or an employee code, never a whole dump."""
    term = (term or "").strip()
    if len(term) < 2:
        return {"items": []}
    like = f"%{term}%"
    rows = (await db.execute(
        select(HcmEmployee)
        .where(HcmEmployee.is_active.is_(True),
               (HcmEmployee.full_name.like(like)) | (HcmEmployee.emp_code.like(like)))
        .order_by(HcmEmployee.full_name).limit(limit)
    )).scalars().unique().all()
    return {"items": [{"id": e.id, "name": e.full_name, "code": e.emp_code,
                       "project_name": e.project_name} for e in rows]}
