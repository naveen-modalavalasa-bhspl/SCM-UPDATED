"""Job Profiles — the grant unit RBAC should have been built on.

An HCM role is too coarse to grant against. Live mirror, role 29 "MANAGER",
fifteen positions, one grant: Inventory Manager, Chief Procurement Officer,
Head SCM, Logistics Executive, IndentApplicant and four Senior Executives all
hold it. Tick Inventory for "MANAGER" and every one of them gets Inventory.
Meanwhile role 12 "DISTRICT MANAGER" spans 28 positions that really are one
job in 28 districts, and must NOT be split. One role, two opposite needs.

A job profile is the real job, and it is DERIVED, never typed:

    key = hcm role_name               "FLOOR INCHARGE" -> "FLOOR INCHARGE"
          else hcm job_name           (empty on all 4,023 live posts)
          else position.code          (fallbacks, for an HCM with no role)
          else position.name
          minus a trailing serial     SE1 SE2 SE3 -> SE

The ROLE is the job. It is the one field in the mirror that states what a
person does, and the same field the approval ladder ranks on (rule 8). A
position NAME is only a label and is allowed to disagree with it — the live
mirror has posts named "FLOOR INCHARGE-001" whose role is Inventory manager.
On the live data this turns 4,023 positions into 20 profiles: Store Keeper's
2,001 collapse to one, DEO's 948 collapse to one, District Manager's 28
collapse to one.

Until 2026-08-18 the chain led with the position CODE before "@"
("IVM@MALLAVALLI-1-AP-104-MMUS" -> "IVM"), written for the pre-cutover HCM
whose codes carried a job prefix. The rebuilt HCM carries none, so that rule
fired on 5 of 4,023 posts and every hit was a stray "@" rather than a job —
"WH-01@-SCM" put one FLOOR INCHARGE post in a profile of its own, called "WH".
Restoring it means restoring two lines in `derive_key`; see git history.

No new tables. A profile's grants live on an ordinary rbac_roles row tagged in
its description ("PROFILE:IVM"), the same trick that already marks HCM-mirrored
roles ("HCM role ID: 29"). The row is created the first time an admin saves
access for that profile, so until this screen is used nothing resolves
differently and behaviour is byte-identical to today.

Fail-closed is the point. A position HCM invents tomorrow derives a key nobody
has granted, finds no profile row, and inherits nothing.
"""
import json
import re
from collections import Counter

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.platform.hcm.models import HcmEmployee, HcmPosition, HcmPositionAssignment
from app.platform.rbac.models import Page, Permission, Role, RolePermission
from app.platform.rbac.permissions import PAGE_RESOURCE
from app.platform.settings.service import write_audit
from app.shared.enums import AuditAction, ScopeRung

PROFILE_PREFIX = "PROFILE:"
SCOPE_PREFIX = "SCOPE:"

# HCM's office_level, which is the only ready-made "how wide is this job" signal in
# the mirror. Anything unrecognised lands on SELF, because guessing wide is the
# failure mode that leaks.
OFFICE_LEVEL_SCOPE = {
    "HEAD OFFICE": ScopeRung.ALL,
    "REGIONAL OFFICE": ScopeRung.SUBTREE,
    "REGIONAL1 OFFICE": ScopeRung.SUBTREE,
    "DISTRICT OFFICE": ScopeRung.SUBTREE,
    "BRANCH OFFICE": ScopeRung.OFFICE,
    "FACILITATE": ScopeRung.SELF,
}


def derive_key(code: str | None, job_name: str | None, name: str | None,
               role_name: str | None = None) -> str:
    """The profile key for one position. Pure function — no DB, no config.

    THE ROLE IS THE JOB. `role_name` is HCM's org role — the same field the approval
    ladder treats as a rank (CLAUDE.md rule 8) — and it is the only field in the mirror
    that actually states what somebody does. Everything else is a label: a position is
    NAMED "FLOOR INCHARGE-001" while its role says Inventory manager, and the two are
    allowed to disagree.

    The old chain tried the position CODE before "@" first, then job_name, then the
    role. That was written for the pre-cutover HCM, where codes carried a job prefix
    ("IVM@MALLAVALLI-1-AP-104-MMUS"). The rebuilt HCM writes no job prefix and no
    job_name at all, so on the live mirror the code rule fires on exactly 5 of 4,023
    positions — and every one of those five is a stray "@" rather than a job:
    "WH-01@-SCM" split one FLOOR INCHARGE post into its own "WH" profile, away from the
    two it does the same job as. Reverting is a matter of restoring the two lines below
    (see git history for this file); the fallbacks under the role are kept for exactly
    that reason, and because a future HCM row with no role must still land somewhere.

    Known cost, accepted: role 'MANAGER' covers both WM@SCM ("Ware House Manager") and
    WSK@SCM ("Inventory Manager"), so those two become one grant unit. Both posts are
    held by the same person today. If they ever diverge, the answer is a separate role
    in HCM, not a job encoded in a position code.
    """
    raw = role_name or job_name or code or name or ""
    key = re.sub(r"[^A-Z0-9 ]+", " ", raw.upper())
    key = re.sub(r"\s+", " ", key).strip()
    # "SE1"/"SE2"/"SE3" are three people doing one job, not three jobs. A trailing
    # serial is a person counter everywhere it appears in the live mirror.
    key = re.sub(r"\d+$", "", key).strip()
    return key or (job_name or "UNCLASSIFIED").upper()


# A profile belongs to ONE project. "DEO" in AP-104 and "DEO" in a project taken on
# next year are different jobs run by different people under different managers, and
# giving them one grant row means one admin's edit silently moves the other project.
# So the stored key is "<project id>:<job>" — "4:DEO".
#
# HCM does not put the project on the position: hcm_positions.project_id is NULL on
# all 3,733 live rows (raw.project_name is a name, not an id). The project of a
# position is therefore the project of the people assigned to it, which is where
# CLAUDE.md rule 8 already says it lives.
UNASSIGNED_PROJECT = 0

# There is deliberately NO default profile.
#
# One existed until 2026-08-19: a reserved job ("*") per project plus a company-wide
# row, which any unconfigured position fell through to. It was removed because its
# blast radius could not be seen from the screen that offered it — a profile REPLACES
# the personal grants on rbac_user_roles (see rbac.service.get_user_roles), and the
# company-wide default matched EVERY position, so one Save revoked every hand-made
# grant in the company at once. Nothing was ever saved against it on the live
# database, so removing it changed no one's access.
#
# A job nobody has configured therefore falls through to its HCM role, exactly as it
# did before defaults existed. That is fail-safe rather than fail-closed on purpose:
# an admin who has not reached a job yet must not have silently locked its people out.


def profile_key(project_id: int | None, job: str) -> str:
    return f"{project_id or UNASSIGNED_PROJECT}:{job}"


def default_profile_name(key: str, bucket: dict | None = None) -> str:
    """Display name for a profile nobody has saved yet — the job, title-cased."""
    return (bucket["job"] if bucket else split_key(key)[1]).title()


def split_key(key: str) -> tuple[int, str]:
    """('4:DEO') -> (4, 'DEO'). An old unqualified key reads as unassigned."""
    head, sep, tail = key.partition(":")
    if sep and head.isdigit():
        return int(head), tail
    return UNASSIGNED_PROJECT, key


def profile_description(key: str, scope: str = ScopeRung.SELF.value) -> str:
    return f"{PROFILE_PREFIX}{key}|{SCOPE_PREFIX}{scope}"


# An approval post's role is NOT a PROFILE: row — the post owns it, and `_profile_roles`
# must not pick it up — but its scope still has to be stored somewhere and read back,
# or the Data scope dropdown on those rows is decoration. Same `|SCOPE:` suffix, its
# own prefix.
POST_DESCRIPTION_PREFIX = "Approval post: "


def post_description(post_name: str, scope: str) -> str:
    return f"{POST_DESCRIPTION_PREFIX}{post_name}|{SCOPE_PREFIX}{scope}"


def parse_post_scope(description: str | None) -> str | None:
    """The scope saved on an approval post's role, or None for one saved before this.

    None reads as ALL at the call site — that is what every post row reported before
    the dropdown did anything, and a scope change must be something an admin asked for.
    """
    if not description or not description.startswith(POST_DESCRIPTION_PREFIX):
        return None
    _name, _, rest = description.partition("|")
    return rest[len(SCOPE_PREFIX):] or None if rest.startswith(SCOPE_PREFIX) else None


def parse_description(description: str | None) -> tuple[str | None, str | None]:
    """('IVM', 'SUBTREE') from a profile role's description, else (None, None)."""
    if not description or not description.startswith(PROFILE_PREFIX):
        return None, None
    key, _, rest = description[len(PROFILE_PREFIX):].partition("|")
    scope = rest[len(SCOPE_PREFIX):] if rest.startswith(SCOPE_PREFIX) else None
    return key.strip() or None, (scope or None)


def profile_code(key: str) -> str:
    code = re.sub(r"[^a-z0-9]+", "_", key.strip().lower()).strip("_")
    return f"jp_{code}"[:50] or "jp_unclassified"


async def position_projects(db: AsyncSession) -> dict[int, tuple[int | None, str | None]]:
    """position id -> (project id, project name).

    Taken from the employees assigned to the post. Where a post has nobody in it,
    raw.project_name is matched back to an id through the employee mirror, so an
    empty post still lands in the right project instead of a limbo bucket.
    """
    # ORDER BY, not incidental row order. A post held by people from two projects has
    # two right answers, and MySQL is free to return either — so the list screen could
    # bucket it under one project while `profile_role_for_position` (its own one-row
    # lookup, ordered the same way below) resolved the grant under the other. Lowest
    # employee id wins, which is arbitrary but STABLE, and stable is the whole point:
    # a position must not change which profile grants it between two requests.
    rows = (await db.execute(
        select(HcmPositionAssignment.position_id, HcmEmployee.project_id,
               HcmEmployee.project_name)
        .join(HcmEmployee, HcmEmployee.id == HcmPositionAssignment.employee_id)
        .where(HcmPositionAssignment.is_active.is_(True))
        .order_by(HcmEmployee.id)
    )).all()
    out: dict[int, tuple[int | None, str | None]] = {}
    by_name: dict[str, int] = {}
    for position_id, project_id, project_name in rows:
        if project_id is None:
            continue
        out.setdefault(position_id, (project_id, project_name))
        if project_name:
            by_name.setdefault(project_name, project_id)
    return out, by_name


def _raw_project_name(raw) -> str | None:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return None
    return (raw or {}).get("project_name") if isinstance(raw, dict) else None


def _office_level(raw) -> str | None:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return None
    return (raw or {}).get("office_level") if isinstance(raw, dict) else None


def _page_gate(page: Page, defined_page_perms: set[str]) -> str | None:
    """The one permission that decides whether this page is on for a profile.

    Its own `page.<code>.view` when that permission exists, else the legacy
    `required_permission`. Identical to the rule `rbac.service.get_user_menu` uses to
    build the rail — the tick-box and the menu MUST agree on what turns a page on, or
    an admin ticks a box and nothing happens, which is exactly what used to occur.
    """
    own = f"{PAGE_RESOURCE}.{page.code}.view"
    return own if own in defined_page_perms else page.required_permission


SCOPE_ORDER = [ScopeRung.SELF, ScopeRung.OFFICE, ScopeRung.SUBTREE,
               ScopeRung.PROJECT, ScopeRung.ALL]


def default_scope(office_levels: Counter) -> str:
    """A profile's suggested rung: the level MOST of its positions sit at.

    Not the widest. DEO has 957 positions, all but a handful at FACILITATE — one
    stray branch-office post must not lift 856 data entry operators to seeing a
    whole office. Ties break narrow, for the same reason.
    """
    ranked = sorted(
        ((lvl, n) for lvl, n in office_levels.items()
         if OFFICE_LEVEL_SCOPE.get((lvl or "").upper())),
        key=lambda kv: (-kv[1], SCOPE_ORDER.index(OFFICE_LEVEL_SCOPE[kv[0].upper()])),
    )
    if not ranked:
        return ScopeRung.SELF.value
    return OFFICE_LEVEL_SCOPE[ranked[0][0].upper()].value


# --------------------------------------------------------------------------- #
#  Derivation over the live mirror
# --------------------------------------------------------------------------- #
async def _derive(db: AsyncSession) -> dict[str, dict]:
    """Every active position bucketed by derived key. The whole model, in one pass."""
    rows = (await db.execute(
        select(
            HcmPosition.id, HcmPosition.name, HcmPosition.code, HcmPosition.role_id,
            HcmPosition.role_name, HcmPosition.job_name, HcmPosition.department_id,
            HcmPosition.raw,
        ).where(HcmPosition.is_active.is_(True))
    )).all()
    holders = dict((await db.execute(
        select(HcmPositionAssignment.position_id,
               func.count(func.distinct(HcmPositionAssignment.employee_id)))
        .where(HcmPositionAssignment.is_active.is_(True))
        .group_by(HcmPositionAssignment.position_id)
    )).all())

    by_position, project_id_by_name = await position_projects(db)

    profiles: dict[str, dict] = {}
    for row in rows:
        job = derive_key(row.code, row.job_name, row.name, row.role_name)
        project_id, project_name = by_position.get(row.id, (None, None))
        if project_id is None:
            # Nobody in the post: fall back to the project name HCM stamps on it.
            raw_name = _raw_project_name(row.raw)
            project_id = project_id_by_name.get(raw_name or "")
            project_name = raw_name if project_id else None
        key = profile_key(project_id, job)
        bucket = profiles.setdefault(key, {
            "key": key, "job": job,
            "project_id": project_id or UNASSIGNED_PROJECT,
            "project_name": project_name or "Unassigned",
            "positions": [], "position_ids": [],
            "holders": 0, "hcm_roles": set(), "hcm_role_ids": set(),
            "office_levels": Counter(),
        })
        level = _office_level(row.raw)
        bucket["position_ids"].append(row.id)
        bucket["holders"] += holders.get(row.id, 0)
        if row.role_name:
            bucket["hcm_roles"].add(row.role_name)
        if row.role_id is not None:
            bucket["hcm_role_ids"].add(int(row.role_id))
        if level:
            bucket["office_levels"][level] += 1
        # The list screen shows a handful; sending 956 position names is pointless.
        if len(bucket["positions"]) < 25:
            bucket["positions"].append({
                "id": row.id, "name": row.name, "code": row.code,
                "hcm_role": row.role_name, "office_level": level,
                "holders": holders.get(row.id, 0),
            })

    return profiles


async def _profile_roles(db: AsyncSession) -> dict[str, Role]:
    """The LIVE profile roles, keyed by profile key.

    `is_active` matters. reset_profile deactivates the row rather than deleting it (the
    grants have to stay auditable), and `profile_role_for_position` — which decides what
    the person can actually do — has always filtered on it. Without the same filter here
    the screen went on showing a reset profile as "Set up here" with a role behind it,
    while its people were already back on their HCM role.
    """
    roles = (await db.execute(
        select(Role).where(Role.description.startswith(PROFILE_PREFIX),
                           Role.is_active.is_(True))
    )).scalars().all()
    out: dict[str, Role] = {}
    for role in roles:
        key, _ = parse_description(role.description)
        if key:
            out[key] = role
    return out


async def profile_keys_for_position(db: AsyncSession, position_id: int) -> list[str]:
    """The profile keys one position answers to, most specific first.

    The same three-rung chain `profile_role_for_position` resolves a ROLE through —
    the job's own profile, the project's default, the company-wide one — returned as
    keys so a caller that pairs something WITH a profile (BOM groups) narrows on
    exactly the profile the position would have been granted through.
    """
    row = (await db.execute(
        select(HcmPosition.name, HcmPosition.code, HcmPosition.job_name,
               HcmPosition.role_name, HcmPosition.raw)
        .where(HcmPosition.id == position_id)
    )).first()
    if row is None:
        return []
    job = derive_key(row.code, row.job_name, row.name, row.role_name)
    project_id = await db.scalar(
        select(HcmEmployee.project_id)
        .join(HcmPositionAssignment,
              HcmPositionAssignment.employee_id == HcmEmployee.id)
        .where(HcmPositionAssignment.position_id == position_id,
               HcmPositionAssignment.is_active.is_(True),
               HcmEmployee.project_id.isnot(None))
        # Same tie-break as position_projects(), so this agrees with the list screen.
        .order_by(HcmEmployee.id)
        .limit(1)
    )
    if project_id is None:
        raw_name = _raw_project_name(row.raw)
        if raw_name:
            project_id = await db.scalar(
                select(HcmEmployee.project_id)
                .where(HcmEmployee.project_name == raw_name,
                       HcmEmployee.project_id.isnot(None))
                .order_by(HcmEmployee.id)
                .limit(1)
            )
    return [profile_key(project_id, job)]


async def profile_keys_for_user(db: AsyncSession, user) -> list[str]:
    """The profile keys the signed-in employee's ACTIVE position answers to.

    The active hat, not every position they hold: the rest of the system already
    reasons in the hat the session is wearing (permissions, data scope, whose turn it
    is to sign), and a kit handed to one job must not follow the person into another.
    """
    position_id = getattr(user, "active_position_id", None)
    if not position_id:
        return []
    return await profile_keys_for_position(db, position_id)


async def profile_role_for_position(db: AsyncSession, position_id: int) -> Role | None:
    """The saved profile role for one position, or None if nobody has granted it yet."""
    row = (await db.execute(
        select(HcmPosition.name, HcmPosition.code, HcmPosition.job_name,
               HcmPosition.role_name, HcmPosition.raw)
        .where(HcmPosition.id == position_id)
    )).first()
    if row is None:
        return None
    job = derive_key(row.code, row.job_name, row.name, row.role_name)
    # Targeted, NOT the whole-mirror position_projects() map. This runs on every
    # scoped query — the indent list, the dashboard KPIs, the Home tile, every
    # detail read — and building a 3,400-row dictionary each time to look up one
    # position made every one of those pay for the entire org chart.
    project_id = await db.scalar(
        select(HcmEmployee.project_id)
        .join(HcmPositionAssignment,
              HcmPositionAssignment.employee_id == HcmEmployee.id)
        .where(HcmPositionAssignment.position_id == position_id,
               HcmPositionAssignment.is_active.is_(True),
               HcmEmployee.project_id.isnot(None))
        # Same tie-break as position_projects(), so this agrees with the list screen.
        .order_by(HcmEmployee.id)
        .limit(1)
    )
    if project_id is None:
        # Empty post: match HCM's project NAME back to an id.
        raw_name = _raw_project_name(row.raw)
        if raw_name:
            project_id = await db.scalar(
                select(HcmEmployee.project_id)
                .where(HcmEmployee.project_name == raw_name,
                       HcmEmployee.project_id.isnot(None))
                .order_by(HcmEmployee.id)
                .limit(1)
            )
    # The job's own profile, and nothing else. A miss falls through to the HCM role,
    # exactly as it did before job profiles existed — see the note on defaults above.
    key = profile_key(project_id, job)
    return (await db.execute(
        select(Role).where(
            Role.description.startswith(f"{PROFILE_PREFIX}{key}|"),
            Role.is_active.is_(True),
        )
    )).scalars().first()


# --------------------------------------------------------------------------- #
#  Read
# --------------------------------------------------------------------------- #
# ---------------- approval posts, shown here as profiles ----------------
#
# A profile is normally DERIVED from the HCM positions that share a job. The SCM roles
# have no HCM positions at all — that is the whole reason approval posts exist — so
# they would never appear on this screen, and the one place an admin configures access
# had nothing to say about SCM Head, Indent Team, Logistics, Director or Accounts.
#
# They are listed here as rows of their own, keyed `post:<id>` so nothing can collide
# with a derived key, and saved straight onto the role the post already carries. When
# HCM finally sends the real positions the posts retire and these rows go with them.
POST_KEY_PREFIX = "post:"


def is_post_key(key: str) -> bool:
    return (key or "").startswith(POST_KEY_PREFIX)


def post_key(post_id: int) -> str:
    return f"{POST_KEY_PREFIX}{post_id}"


def post_id_of(key: str) -> int:
    return int(key[len(POST_KEY_PREFIX):])


async def _post_profile_rows(db: AsyncSession, pages, held: dict,
                             defined_page_perms: set[str]) -> list[dict]:
    """One row per approval post, in the same shape the derived rows use."""
    from app.platform.workflow import posts as approval_posts
    from app.platform.workflow.models import ApprovalPost

    rows = (await db.execute(
        select(ApprovalPost).where(ApprovalPost.is_active.is_(True))
        .order_by(ApprovalPost.department, ApprovalPost.name)
    )).scalars().all()
    if not rows:
        return []
    seated = await approval_posts.members_of(db, [row.id for row in rows])
    post_roles = {
        role.id: role for role in (await db.execute(
            select(Role).where(Role.id.in_(
                [row.rbac_role_id for row in rows if row.rbac_role_id]))
        )).scalars().all()
    } if any(row.rbac_role_id for row in rows) else {}

    items = []
    for post in rows:
        codes = held.get(post.rbac_role_id, set()) if post.rbac_role_id else set()
        people = seated.get(post.id, [])
        role = post_roles.get(post.rbac_role_id)
        scope = parse_post_scope(role.description if role else None) or ScopeRung.ALL.value
        items.append({
            "key": post_key(post.id),
            "job": post.name,
            # Flagged so the screen can say where the row came from: this is a chair we
            # created, not a job derived from HCM.
            "is_approval_post": True,
            "project_id": None,
            "project_name": post.department or "SCM",
            "name": post.name,
            "role_id": post.rbac_role_id,
            "configured": post.rbac_role_id is not None,
            "scope": scope,
            # A chair this system owns serves every project by construction — SCM Head
            # signs for all of them — so ALL is what it is suggested at, whatever the
            # admin has since narrowed it to.
            "suggested_scope": ScopeRung.ALL.value,
            "position_count": 1,
            "holder_count": len(people),
            "hcm_roles": [],
            "office_levels": [],
            # The seated people, shaped like the derived rows' `positions` so the
            # screen's holder list needs no special case.
            "positions": [{"id": post.id, "name": post.name,
                           "holders": [p["name"] for p in people]}],
            "page_codes": sorted(
                p.code for p in pages if _page_gate(p, defined_page_perms) in codes
                or _page_gate(p, defined_page_perms) is None
            ),
            "permission_codes": sorted(codes - defined_page_perms),
        })
    return items


async def _set_post_access(db: AsyncSession, key: str, page_codes: list[str],
                           permission_codes: list[str], scope: str, name: str | None,
                           actor) -> dict:
    """Save ticks for an approval post, onto the role the post carries.

    Creates that role the first time somebody configures the post, and binds it, so an
    admin never has to know a separate profile exists behind the chair.
    """
    from app.platform.workflow.models import ApprovalPost

    post = await db.get(ApprovalPost, post_id_of(key))
    if post is None or not post.is_active:
        raise ValidationError(f"Unknown approval post: {key}")
    if scope not in {r.value for r in ScopeRung}:
        raise ValidationError(f"Unknown scope: {scope}")

    pages = (await db.execute(
        select(Page).where(Page.is_active.is_(True)))).scalars().all()
    all_permissions = (await db.execute(select(Permission))).scalars().all()
    defined_page_perms = {
        p.code for p in all_permissions if p.code.startswith(f"{PAGE_RESOURCE}.")
    }
    unknown_pages = set(page_codes) - {p.code for p in pages}
    if unknown_pages:
        raise ValidationError(f"Unknown page code(s): {', '.join(sorted(unknown_pages))}")
    unknown_features = set(permission_codes) - {p.code for p in all_permissions}
    if unknown_features:
        raise ValidationError(
            f"Unknown permission(s): {', '.join(sorted(unknown_features))}")

    wanted_codes = {
        gate for gate in (
            _page_gate(p, defined_page_perms)
            for p in pages if p.code in set(page_codes)
        ) if gate
    } | set(permission_codes)

    role = await db.get(Role, post.rbac_role_id) if post.rbac_role_id else None
    if role is None:
        role = Role(
            code=await _free_code(db, f"post_{post.code.lower()}"[:40]),
            name=name or post.name,
            description=post_description(post.name, scope),
            is_system=True, is_active=True,
        )
        db.add(role)
        await db.flush()
        post.rbac_role_id = role.id
    else:
        role.name = name or role.name
        role.description = post_description(post.name, scope)
        role.is_active = True

    permissions = (await db.execute(
        select(Permission).where(Permission.code.in_(wanted_codes))
    )).scalars().all() if wanted_codes else []
    wanted_ids = {p.id for p in permissions}
    current = (await db.execute(
        select(RolePermission).where(RolePermission.role_id == role.id)
    )).scalars().all()
    before = sorted(
        code for _rid, code in (await db.execute(
            select(RolePermission.role_id, Permission.code)
            .join(Permission, Permission.id == RolePermission.permission_id)
            .where(RolePermission.role_id == role.id)
        )).all()
    )
    for row in current:
        if row.permission_id not in wanted_ids:
            await db.delete(row)
    have = {row.permission_id for row in current}
    for permission_id in wanted_ids - have:
        db.add(RolePermission(role_id=role.id, permission_id=permission_id))

    await write_audit(
        db, entity="rbac_job_profile", entity_id=role.id,
        action=AuditAction.UPDATE, actor=actor,
        before={"permissions": before},
        after={"permissions": sorted(p.code for p in permissions)},
        entity_no=key[:50],
        summary=f"Access updated for approval post {post.name}",
    )
    await db.commit()
    return {"success": True, "key": key, "role_id": role.id, "scope": scope,
            "permission_codes": sorted(p.code for p in permissions)}


async def list_profiles(db: AsyncSession) -> dict:
    derived = await _derive(db)
    saved = await _profile_roles(db)

    pages = (await db.execute(
        select(Page).where(Page.is_active.is_(True)).order_by(Page.sort_order, Page.name)
    )).scalars().all()
    permissions = (await db.execute(select(Permission))).scalars().all()
    # Only page permissions that exist may represent a tick-box. A page without one
    # (`home`, and a few newer screens) still falls back to required_permission, the
    # same rule rbac.service.get_user_menu applies when it builds the rail.
    defined_page_perms = {
        p.code for p in permissions if p.code.startswith(f"{PAGE_RESOURCE}.")
    }
    held: dict[int, set[str]] = {}
    for role_id, code in (await db.execute(
        select(RolePermission.role_id, Permission.code)
        .join(Permission, Permission.id == RolePermission.permission_id)
    )).all():
        held.setdefault(role_id, set()).add(code)

    items = []
    for key, bucket in sorted(
        derived.items(),
        key=lambda kv: (kv[1]["project_name"], -len(kv[1]["position_ids"])),
    ):
        role = saved.get(key)
        _, saved_scope = parse_description(role.description if role else None)
        codes = held.get(role.id, set()) if role else set()
        items.append({
            "key": key,
            "job": bucket["job"],
            "project_id": bucket["project_id"],
            "project_name": bucket["project_name"],
            "name": role.name if role else default_profile_name(key, bucket),
            "role_id": role.id if role else None,
            "configured": role is not None,
            "scope": saved_scope or default_scope(bucket["office_levels"]),
            "suggested_scope": default_scope(bucket["office_levels"]),
            "position_count": len(bucket["position_ids"]),
            "holder_count": bucket["holders"],
            "hcm_roles": sorted(bucket["hcm_roles"]),
            "office_levels": [lvl for lvl, _ in bucket["office_levels"].most_common()],
            "positions": bucket["positions"],
            # Exactly the pages ticked, nothing inferred. This used to report every
            # page whose required_permission the profile happened to hold, so ticking
            # Approvals (gated on indent.view) lit up all ten indent pages with it and
            # unticking one was impossible without unticking its siblings.
            "page_codes": sorted(
                p.code for p in pages if _page_gate(p, defined_page_perms) in codes
                or _page_gate(p, defined_page_perms) is None
            ),
            # Every action, including the ones that double as a page's
            # required_permission. Those used to be subtracted out and shown only as
            # page ticks, which is why `indent.view` could not be granted or revoked
            # on its own.
            "permission_codes": sorted(codes - defined_page_perms),
        })

    # The chairs this system owns. Appended rather than merged into the derived
    # buckets: they come from a different place and the screen says so.
    items.extend(await _post_profile_rows(db, pages, held, defined_page_perms))

    return {
        "items": items,
        "total": len(items),
        "projects": sorted({
            (b["project_id"], b["project_name"]) for b in derived.values()
        }),
        "position_total": sum(len(b["position_ids"]) for b in derived.values()),
        "pages": [{
            "code": p.code, "name": p.name, "module": p.module,
            "parent_id": p.parent_id, "id": p.id,
            "always_on": p.required_permission is None,
            "required_permission": p.required_permission,
        } for p in pages],
        # Actions only. Screens are granted in the Pages block above, so a `page.*`
        # permission has no business here — and, conversely, an action is still an
        # action even when some screen is gated on it. Filtering on "is this code a
        # page's required_permission" got both halves wrong: it let through every
        # page nobody claims, and hid real actions like Adjust stock.
        "features": [{
            "code": f.code, "module": f.module,
            "description": f.description or f.code,
        } for f in sorted(permissions, key=lambda f: (f.module, f.code))
            if f.resource != PAGE_RESOURCE],
        "scopes": [r.value for r in ScopeRung],
    }


async def find_people(db: AsyncSession, search: str, limit: int = 25) -> dict:
    """Which profile a PERSON lands in — looked up by employee code or name.

    The profile list can only be searched by what a profile is made of: the job, the
    project, the HCM role, the position names. That is the wrong end of the telescope
    when the question is "why can Ramesh see this?" or "where is EMP1043 configured?",
    which is how an access question actually arrives.

    Returns one row per active seat, naming the profile key the position resolves
    through, so the screen can jump straight to it. Capped, and it refuses to run on a
    fragment — an unbounded scan of 2,787 people is not a search box.
    """
    term = (search or "").strip()
    if len(term) < 2:
        return {"items": [], "total": 0}

    like = f"%{term}%"
    rows = (await db.execute(
        select(HcmEmployee.id, HcmEmployee.full_name, HcmEmployee.emp_code,
               HcmEmployee.project_id, HcmEmployee.project_name,
               HcmPosition.id.label("position_id"), HcmPosition.name.label("position_name"),
               HcmPosition.code.label("position_code"), HcmPosition.job_name,
               HcmPosition.role_name)
        .join(HcmPositionAssignment,
              HcmPositionAssignment.employee_id == HcmEmployee.id)
        .join(HcmPosition, HcmPosition.id == HcmPositionAssignment.position_id)
        .where(HcmEmployee.is_active.is_(True),
               HcmPositionAssignment.is_active.is_(True),
               HcmPosition.is_active.is_(True),
               or_(HcmEmployee.emp_code.like(like), HcmEmployee.full_name.like(like)))
        .order_by(HcmEmployee.full_name, HcmPosition.id)
        .limit(limit)
    )).all()

    saved = await _profile_roles(db)
    items = []
    for row in rows:
        job = derive_key(row.position_code, row.job_name, row.position_name,
                         row.role_name)
        key = profile_key(row.project_id, job)
        role = saved.get(key)
        items.append({
            "employee_id": row.id, "name": row.full_name, "emp_code": row.emp_code,
            "position_id": row.position_id, "position_name": row.position_name,
            "project_name": row.project_name or "Unassigned",
            "key": key, "job": job,
            "profile_name": role.name if role else job.title(),
            "configured": role is not None,
        })
    return {"items": items, "total": len(items)}


async def profile_options(db: AsyncSession, user=None) -> list[dict]:
    """Every job profile this caller may point AT, named — the lookup a screen needs.

    `list_profiles` above answers the RBAC editor's question (which pages, which
    actions, which scope) and reads the whole permission matrix to do it. A screen
    that only has to name the job — Masters > BOM Groups — should not pay for that.

    Passing `user` narrows the list to that login's own scope rung, and every caller
    that serves a request MUST pass it. Naming a profile is a read of the org chart:
    without the narrowing a district login browses every project's jobs, and — worse —
    could hand a kit to a profile in a project it has no business touching, since this
    same list is what `apply_bom_group` validates writes against.
    """
    from app.shared.scope import rung_for

    derived = await _derive(db)
    saved = await _profile_roles(db)
    # Until a job profile is saved, access resolves through its mirrored HCM role.
    # Item Eligibility must therefore expose every HCM job profile, not only saved ones.
    from app.platform.rbac.service import hcm_role_description
    hcm_ids = {role_id for bucket in derived.values() for role_id in bucket["hcm_role_ids"]}
    hcm_roles = (await db.execute(select(Role).where(
        Role.description.in_([hcm_role_description(role_id) for role_id in hcm_ids]),
        Role.is_active.is_(True),
    ))).scalars().all() if hcm_ids else []
    hcm_role_by_hcm_id = {
        int((role.description or "").removeprefix("HCM role ID: ")): role
        for role in hcm_roles
    }
    options = [
        {
            "key": key,
            "role_id": (saved[key].id if key in saved else next(
                (hcm_role_by_hcm_id[role_id].id for role_id in bucket["hcm_role_ids"]
                 if role_id in hcm_role_by_hcm_id), None)),
            "job": bucket["job"],
            "name": (saved[key].name if key in saved
                     else default_profile_name(key, bucket)),
            "project_id": bucket["project_id"],
            "project_name": bucket["project_name"],
            "position_count": len(bucket["position_ids"]),
            "holder_count": bucket["holders"],
            "configured": key in saved,
        }
        for key, bucket in derived.items()
    ]
    if user is not None and await rung_for(db, user) is not ScopeRung.ALL:
        # Mirrors shared.scope.project_condition, in Python because these rows are
        # derived from the HCM mirror rather than selected from a table.
        project_id = getattr(user, "project_id", None)
        options = [o for o in options
                   if o["project_id"] is None or o["project_id"] == project_id]
    options.sort(key=lambda p: (p["project_name"] or "", p["name"] or ""))
    return options


# --------------------------------------------------------------------------- #
#  Write
# --------------------------------------------------------------------------- #
async def set_profile_access(
    db: AsyncSession, key: str, page_codes: list[str],
    permission_codes: list[str], scope: str, name: str | None, actor,
) -> dict:
    if is_post_key(key):
        return await _set_post_access(
            db, key, page_codes, permission_codes, scope, name, actor)
    derived = await _derive(db)
    if key not in derived:
        raise ValidationError(f"Unknown job profile: {key}")
    if scope not in {r.value for r in ScopeRung}:
        raise ValidationError(f"Unknown scope: {scope}")

    pages = (await db.execute(
        select(Page).where(Page.is_active.is_(True))
    )).scalars().all()
    unknown_pages = set(page_codes) - {p.code for p in pages}
    if unknown_pages:
        raise ValidationError(f"Unknown page code(s): {', '.join(sorted(unknown_pages))}")

    all_permissions = (await db.execute(select(Permission))).scalars().all()
    defined_page_perms = {
        p.code for p in all_permissions if p.code.startswith(f"{PAGE_RESOURCE}.")
    }
    # One tick-box, one permission. A page grants its OWN `page.<code>.view` and
    # nothing else, so ticking Approvals no longer drags along the ten other pages
    # that happen to share `indent.view` — and unticking it no longer requires
    # unticking its siblings first.
    #
    # A page with no permission of its own still grants required_permission, because
    # that is the only handle it has; those are the four the catalogue never got.
    wanted_codes = {
        gate for gate in (
            _page_gate(p, defined_page_perms)
            for p in pages if p.code in set(page_codes)
        ) if gate
    }
    unknown_features = set(permission_codes) - {p.code for p in all_permissions}
    if unknown_features:
        raise ValidationError(
            f"Unknown permission(s): {', '.join(sorted(unknown_features))}"
        )
    wanted_codes |= set(permission_codes)

    saved = await _profile_roles(db)
    role = saved.get(key)
    if role is None:
        role = Role(
            code=await _free_code(db, profile_code(key)),
            name=name or default_profile_name(key),
            description=profile_description(key, scope),
            is_system=True, is_active=True,
        )
        db.add(role)
        await db.flush()
    else:
        role.name = name or role.name
        role.description = profile_description(key, scope)
        role.is_active = True

    permissions = (await db.execute(
        select(Permission).where(Permission.code.in_(wanted_codes))
    )).scalars().all() if wanted_codes else []
    wanted_ids = {p.id for p in permissions}
    current = (await db.execute(
        select(RolePermission).where(RolePermission.role_id == role.id)
    )).scalars().all()
    before = sorted(
        code for rid, code in (await db.execute(
            select(RolePermission.role_id, Permission.code)
            .join(Permission, Permission.id == RolePermission.permission_id)
            .where(RolePermission.role_id == role.id)
        )).all()
    )
    for row in current:
        if row.permission_id not in wanted_ids:
            await db.delete(row)
    have = {row.permission_id for row in current}
    for permission_id in wanted_ids - have:
        db.add(RolePermission(role_id=role.id, permission_id=permission_id))

    await write_audit(
        db, entity="rbac_job_profile", entity_id=role.id,
        action=AuditAction.UPDATE, actor=actor,
        before={"permissions": before},
        after={"permissions": sorted(p.code for p in permissions), "scope": scope},
        # entity_no is String(50) and defaults to the summary, so it is set here
        # explicitly — a long profile name would otherwise overflow the column.
        entity_no=key[:50],
        summary=f"Job profile access updated for {role.name}",
    )
    await db.commit()
    return {"success": True, "key": key, "role_id": role.id, "scope": scope,
            "permission_codes": sorted(p.code for p in permissions)}


async def _free_code(db: AsyncSession, base: str) -> str:
    taken = {c.lower() for c in (await db.execute(select(Role.code))).scalars().all()}
    if base.lower() not in taken:
        return base
    for n in range(2, 200):
        candidate = f"{base[:47]}_{n}"
        if candidate.lower() not in taken:
            return candidate
    raise ValidationError("Cannot allocate a profile code")


async def reset_profile(db: AsyncSession, key: str, actor) -> dict:
    """Drop a profile's grants entirely, so its positions fall back to the HCM role."""
    if is_post_key(key):
        return await _reset_post(db, key, actor)
    role = (await _profile_roles(db)).get(key)
    if role is None:
        return {"success": True, "key": key, "role_id": None}
    for row in (await db.execute(
        select(RolePermission).where(RolePermission.role_id == role.id)
    )).scalars().all():
        await db.delete(row)
    role.is_active = False
    await write_audit(
        db, entity="rbac_job_profile", entity_id=role.id,
        action=AuditAction.ACCESS_REVOKED, actor=actor, before=None, after=None,
        entity_no=key[:50],
        summary=f"Job profile {role.name} reset to its HCM role",
    )
    await db.commit()
    return {"success": True, "key": key, "role_id": role.id}


async def _reset_post(db: AsyncSession, key: str, actor) -> dict:
    """Take an approval post's chair back to granting nothing.

    Its grants do NOT live on a `PROFILE:` role, so the ordinary reset above looked the
    key up, found nothing, and returned success without touching anything — the screen
    said the chair had been handed back while everyone seated in it kept every
    permission. The post keeps its role (retiring it would unbind the chair from the
    ladder); what is dropped is what the role grants.
    """
    from app.platform.workflow.models import ApprovalPost

    post = await db.get(ApprovalPost, post_id_of(key))
    if post is None:
        raise ValidationError(f"Unknown approval post: {key}")
    if not post.rbac_role_id:
        return {"success": True, "key": key, "role_id": None}
    role = await db.get(Role, post.rbac_role_id)
    before = sorted(code for _rid, code in (await db.execute(
        select(RolePermission.role_id, Permission.code)
        .join(Permission, Permission.id == RolePermission.permission_id)
        .where(RolePermission.role_id == post.rbac_role_id)
    )).all())
    for row in (await db.execute(
        select(RolePermission).where(RolePermission.role_id == post.rbac_role_id)
    )).scalars().all():
        await db.delete(row)
    await write_audit(
        db, entity="rbac_job_profile", entity_id=post.rbac_role_id,
        action=AuditAction.ACCESS_REVOKED, actor=actor,
        before={"permissions": before}, after={"permissions": []},
        entity_no=key[:50],
        summary=f"Approval post {post.name} reset — its chair now grants nothing",
    )
    await db.commit()
    return {"success": True, "key": key,
            "role_id": role.id if role else post.rbac_role_id}


async def _post_holders(db: AsyncSession, key: str) -> dict:
    """Who is seated in an approval post, in the same shape preview_profile returns."""
    from app.platform.workflow import posts as approval_posts
    from app.platform.workflow.models import ApprovalPost

    post = await db.get(ApprovalPost, post_id_of(key))
    if post is None:
        raise ValidationError(f"Unknown approval post: {key}")
    seated = (await approval_posts.members_of(db, [post.id])).get(post.id, [])
    return {"key": key, "items": [{
        "employee_id": person["id"], "name": person.get("name"),
        "emp_code": person.get("code"), "office_name": None,
        "position_name": post.name,
    } for person in seated], "total": len(seated)}


async def preview_profile(db: AsyncSession, key: str) -> dict:
    """Who actually lands on this profile, with their names — the 'view as' answer."""
    # An approval post is a chair this system owns, not a bucket of HCM positions, so
    # it is not in `_derive` and used to come back as "Unknown job profile" — which is
    # what the "Who is this?" button showed on every SCM chair.
    if is_post_key(key):
        return await _post_holders(db, key)
    derived = await _derive(db)
    if key not in derived:
        raise ValidationError(f"Unknown job profile: {key}")
    position_ids = derived[key]["position_ids"]
    rows = (await db.execute(
        select(HcmEmployee.id, HcmEmployee.full_name, HcmEmployee.emp_code,
               HcmEmployee.office_name, HcmPosition.name.label("position_name"))
        .join(HcmPositionAssignment,
              HcmPositionAssignment.employee_id == HcmEmployee.id)
        .join(HcmPosition, HcmPosition.id == HcmPositionAssignment.position_id)
        .where(
            HcmPositionAssignment.position_id.in_(position_ids),
            HcmPositionAssignment.is_active.is_(True),
        )
        .order_by(HcmEmployee.full_name)
        .limit(200)
    )).all()
    return {"key": key, "items": [{
        "employee_id": r.id, "name": r.full_name, "emp_code": r.emp_code,
        "office_name": r.office_name, "position_name": r.position_name,
    } for r in rows], "total": len(rows)}
