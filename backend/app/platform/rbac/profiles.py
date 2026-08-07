"""Job Profiles — the grant unit RBAC should have been built on.

An HCM role is too coarse to grant against. Live mirror, role 29 "MANAGER",
fifteen positions, one grant: Inventory Manager, Chief Procurement Officer,
Head SCM, Logistics Executive, IndentApplicant and four Senior Executives all
hold it. Tick Inventory for "MANAGER" and every one of them gets Inventory.
Meanwhile role 12 "DISTRICT MANAGER" spans 28 positions that really are one
job in 28 districts, and must NOT be split. One role, two opposite needs.

A job profile is the real job, and it is DERIVED, never typed:

    key = position.code before "@"    "IVM@MALLAVALLI-1-AP-104-MMUS" -> "IVM"
          else hcm job_name           (populated on 3,729 of 3,733 live posts)
          else position.name          (last resort)
          minus a trailing serial     SE1 SE2 SE3 -> SE

That chain is a fallback over fields every HCM carries, not a rule tuned to
this project. On the live data it turns 3,733 positions into ~45 profiles:
DEO's 956 collapse to one, District Manager's 28 collapse to one, and MANAGER
splits into the twelve jobs it always was. A project whose HCM has no "@"
convention simply falls through to job_name; the worst case is more profiles
than needed, which an admin MERGES — always safer than having to split.

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

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.platform.hcm.models import HcmEmployee, HcmPosition, HcmPositionAssignment
from app.platform.rbac.models import Page, Permission, Role, RolePermission
from app.platform.rbac.permissions import PAGE_RESOURCE
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


def derive_key(code: str | None, job_name: str | None, name: str | None) -> str:
    """The profile key for one position. Pure function — no DB, no config."""
    raw = ""
    if code and "@" in code:
        raw = code.split("@")[0]
    if not raw.strip():
        raw = job_name or code or name or ""
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

# A default profile: what a job gets when nobody has configured it yet.
#
# Without one, an unconfigured position resolves through its HCM role — the exact
# leak this screen exists to close, since role 29 "MANAGER" covers fifteen unrelated
# jobs. A default is a normal profile row with a reserved job, so it saves, resets,
# lists and audits through the same code as every other profile.
#
# Resolution walks outward, the same order the approval ladders use (CLAUDE.md rule
# 8): the project's own default, then the company-wide one, then — only if neither
# has ever been configured — the old HCM behaviour, unchanged.
DEFAULT_JOB = "*"
COMPANY_DEFAULT_KEY = "ALL:*"   # deliberately not "0:*", which is Unassigned's own


def profile_key(project_id: int | None, job: str) -> str:
    return f"{project_id or UNASSIGNED_PROJECT}:{job}"


def is_default_key(key: str) -> bool:
    return key == COMPANY_DEFAULT_KEY or key.endswith(f":{DEFAULT_JOB}")


def default_profile_name(key: str, bucket: dict | None = None) -> str:
    """Display name for an unsaved profile. A default reads as what it does."""
    if key == COMPANY_DEFAULT_KEY:
        return "Default — every project"
    if is_default_key(key):
        name = (bucket or {}).get("project_name") or "this project"
        return f"Default — {name}"
    return (bucket["job"] if bucket else split_key(key)[1]).title()


def split_key(key: str) -> tuple[int, str]:
    """('4:DEO') -> (4, 'DEO'). An old unqualified key reads as unassigned."""
    head, sep, tail = key.partition(":")
    if sep and head.isdigit():
        return int(head), tail
    return UNASSIGNED_PROJECT, key


def profile_description(key: str, scope: str = ScopeRung.SELF.value) -> str:
    return f"{PROFILE_PREFIX}{key}|{SCOPE_PREFIX}{scope}"


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
    rows = (await db.execute(
        select(HcmPositionAssignment.position_id, HcmEmployee.project_id,
               HcmEmployee.project_name)
        .join(HcmEmployee, HcmEmployee.id == HcmPositionAssignment.employee_id)
        .where(HcmPositionAssignment.is_active.is_(True))
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
        job = derive_key(row.code, row.job_name, row.name)
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
            "holders": 0, "hcm_roles": set(), "office_levels": Counter(),
        })
        level = _office_level(row.raw)
        bucket["position_ids"].append(row.id)
        bucket["holders"] += holders.get(row.id, 0)
        if row.role_name:
            bucket["hcm_roles"].add(row.role_name)
        if level:
            bucket["office_levels"][level] += 1
        # The list screen shows a handful; sending 956 position names is pointless.
        if len(bucket["positions"]) < 25:
            bucket["positions"].append({
                "id": row.id, "name": row.name, "code": row.code,
                "hcm_role": row.role_name, "office_level": level,
                "holders": holders.get(row.id, 0),
            })

    # One default bucket per project, plus the company-wide one. Synthetic: they hold
    # no positions of their own, because they stand for the jobs that do not exist
    # yet. Adding them here rather than only in list_profiles is what lets
    # set_profile_access, reset_profile and preview_profile accept them without
    # knowing defaults exist — they all validate against this dict.
    seen = {(b["project_id"], b["project_name"]) for b in profiles.values()}
    for project_id, project_name in sorted(seen, key=lambda pair: pair[0]):
        key = profile_key(project_id, DEFAULT_JOB)
        profiles.setdefault(key, _default_bucket(key, project_id, project_name))
    profiles.setdefault(
        COMPANY_DEFAULT_KEY,
        _default_bucket(COMPANY_DEFAULT_KEY, UNASSIGNED_PROJECT, "Every project"),
    )
    return profiles


def _default_bucket(key: str, project_id: int, project_name: str) -> dict:
    return {
        "key": key, "job": DEFAULT_JOB,
        "project_id": project_id, "project_name": project_name,
        "positions": [], "position_ids": [],
        "holders": 0, "hcm_roles": set(), "office_levels": Counter(),
    }


async def _profile_roles(db: AsyncSession) -> dict[str, Role]:
    roles = (await db.execute(
        select(Role).where(Role.description.startswith(PROFILE_PREFIX))
    )).scalars().all()
    out: dict[str, Role] = {}
    for role in roles:
        key, _ = parse_description(role.description)
        if key:
            out[key] = role
    return out


async def profile_role_for_position(db: AsyncSession, position_id: int) -> Role | None:
    """The saved profile role for one position, or None if nobody has granted it yet."""
    row = (await db.execute(
        select(HcmPosition.name, HcmPosition.code, HcmPosition.job_name, HcmPosition.raw)
        .where(HcmPosition.id == position_id)
    )).first()
    if row is None:
        return None
    job = derive_key(row.code, row.job_name, row.name)
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
                .limit(1)
            )
    # The job's own profile, then the project's default, then the company-wide one.
    # First hit wins, so configuring a job always beats a default, and a project
    # default always beats the company-wide one. All three miss -> None, and the
    # caller falls through to the HCM role exactly as it did before defaults existed.
    for key in (profile_key(project_id, job),
                profile_key(project_id, DEFAULT_JOB),
                COMPANY_DEFAULT_KEY):
        role = (await db.execute(
            select(Role).where(
                Role.description.startswith(f"{PROFILE_PREFIX}{key}|"),
                Role.is_active.is_(True),
            )
        )).scalars().first()
        if role is not None:
            return role
    return None


# --------------------------------------------------------------------------- #
#  Read
# --------------------------------------------------------------------------- #
async def list_profiles(db: AsyncSession) -> dict:
    derived = await _derive(db)
    saved = await _profile_roles(db)

    pages = (await db.execute(
        select(Page).where(Page.is_active.is_(True)).order_by(Page.sort_order, Page.name)
    )).scalars().all()
    page_permission_codes = {p.required_permission for p in pages if p.required_permission}
    permissions = (await db.execute(select(Permission))).scalars().all()
    held: dict[int, set[str]] = {}
    for role_id, code in (await db.execute(
        select(RolePermission.role_id, Permission.code)
        .join(Permission, Permission.id == RolePermission.permission_id)
    )).all():
        held.setdefault(role_id, set()).add(code)

    items = []
    for key, bucket in sorted(
        derived.items(),
        # Defaults sort to the top of their project: they are the thing that decides
        # every row below them, so burying them under 35 jobs would hide the setting
        # that matters most.
        key=lambda kv: (kv[1]["project_name"], not is_default_key(kv[0]),
                        -len(kv[1]["position_ids"])),
    ):
        role = saved.get(key)
        _, saved_scope = parse_description(role.description if role else None)
        codes = held.get(role.id, set()) if role else set()
        items.append({
            "key": key,
            "job": bucket["job"],
            "is_default": is_default_key(key),
            "is_company_default": key == COMPANY_DEFAULT_KEY,
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
            "page_codes": sorted(
                p.code for p in pages
                if p.required_permission is None or p.required_permission in codes
            ),
            "permission_codes": sorted(codes - page_permission_codes),
        })
    return {
        "items": items,
        # Real jobs only: the header reads "N real jobs derived from M positions",
        # and a default is neither derived nor a job.
        "total": sum(1 for i in items if not i["is_default"]),
        # Real projects only. The company-wide default's bucket carries the label
        # "Every project", which is not a project and must never reach the filter.
        "projects": sorted({
            (b["project_id"], b["project_name"])
            for k, b in derived.items() if not is_default_key(k)
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


# --------------------------------------------------------------------------- #
#  Write
# --------------------------------------------------------------------------- #
async def set_profile_access(
    db: AsyncSession, key: str, page_codes: list[str],
    permission_codes: list[str], scope: str, name: str | None, actor,
) -> dict:
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

    # A page grant is really a grant of the page's required_permission. Several pages
    # share one (indent.view covers ten), so asking for one of them grants its
    # siblings — the honest answer is computed back from the permissions, never
    # echoed from the request.
    wanted_codes = {
        p.required_permission for p in pages
        if p.code in set(page_codes) and p.required_permission
    }
    unknown_features = set(permission_codes) - {
        p.code for p in (await db.execute(select(Permission))).scalars().all()
    }
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


async def preview_profile(db: AsyncSession, key: str) -> dict:
    """Who actually lands on this profile, with their names — the 'view as' answer."""
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
