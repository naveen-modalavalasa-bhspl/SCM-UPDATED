"""What a document's number card shows: the one reader of a series for every form.

`card` answers "what does this document ask for": the fields in the order its pattern
prints them, the dropdowns and the defaults. `preview` answers "what will that make",
part by part, taking nothing. Both read the series the save reads, so editing a pattern on
Settings > Document Numbering changes the card with no code change.

Organisation, project and department are always asked for, even on a pattern that does not
print them, because the next document copies them from this one. Such a field is marked
`in_number: false` rather than left out. The year is asked for only when it prints: it is
not carried, so nothing depends on it otherwise.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import ValidationError
from app.shared.models.master import OrgDepartment, Organization, Project
from app.shared.numbering import (
    SCOPE_SLUG_LEN, _fiscal_year, configured_series, describe_number, pattern_tokens,
    selectable_fiscal_years, slug,
)

_LABELS = {"organisation": "Organisation", "project": "Project",
           "department": "Department", "fiscal_year": "Financial year"}
#: Which card fields a pattern token asks for. {PROJECT} prints the project, or the
#: department when there is none, so it asks for both.
_FIELDS_OF_TOKEN = {"company": ("organisation",), "project": ("project", "department"),
                    "fy": ("fiscal_year",)}
_ALWAYS_ASKED = ("organisation", "project", "department")


def card_fields(pattern: str | None) -> list[dict]:
    """The fields in the order the pattern prints them, then any it does not print. Pure."""
    printed: list[str] = []
    for token in pattern_tokens(pattern):
        for field in _FIELDS_OF_TOKEN.get(token, ()):
            if field not in printed:
                printed.append(field)
    rest = [field for field in _ALWAYS_ASKED if field not in printed]
    return ([{"key": f, "label": _LABELS[f], "in_number": True} for f in printed]
            + [{"key": f, "label": _LABELS[f], "in_number": False} for f in rest])


def _default_organisation(rows: list) -> int | None:
    """`ORG_DEFAULT_NAME`, else nothing: the screen then falls back to the first in the
    list and says it is only a guess."""
    wanted = (settings.ORG_DEFAULT_NAME or "").strip().casefold()
    return next((row.id for row in rows if wanted and row.name.casefold() == wanted), None)


def _option(row) -> dict:
    return {"id": row.id, "code": row.code, "name": row.name}


async def _active(db: AsyncSession, model) -> list:
    return (await db.execute(
        select(model).where(model.is_active.is_(True)).order_by(model.name, model.id)
    )).scalars().all()


async def card(db: AsyncSession, doc_type: str, user) -> dict:
    pattern, prefix = await configured_series(db, doc_type)
    organisations = await _active(db, Organization)
    projects = await _active(db, Project)
    project_ids = {row.id for row in projects}
    own_project = getattr(user, "project_id", None)
    # What HCM fixes for the raiser (2026-11-09): the post's project, else the
    # employee's, else their department matched by name. A form that raises under
    # these (indent, STR, monthly indent) locks them; the save fixes the same values.
    from app.platform.doc_numbering import scope as org_scope
    mapped = await org_scope.raiser_mapping(db, user)
    fixed_org = await org_scope.default_organisation(db)
    return {
        "doc_type": doc_type, "pattern": pattern, "prefix": prefix,
        "fields": card_fields(pattern),
        "fiscal_years": selectable_fiscal_years(),
        "current_fiscal_year": _fiscal_year(),
        "organisations": [_option(row) for row in organisations],
        "departments": [_option(row) for row in await _active(db, OrgDepartment)],
        "projects": [_option(row) for row in projects],
        "default_organization_id": _default_organisation(organisations),
        "own_project_id": own_project if own_project in project_ids else None,
        "mapped_project_id": mapped["project_id"],
        "mapped_project_name": mapped["project_name"],
        "mapped_org_department_id": mapped["org_department_id"],
        "mapped_org_department_name": mapped["org_department_name"],
        "organisation_fixed": fixed_org is not None,
    }


async def preview(db: AsyncSession, doc_type: str, *, organization_id: int | None = None,
                  project_id: int | None = None, org_department_id: int | None = None,
                  project_name: str | None = None, fiscal_year: str | None = None) -> dict:
    """The number the selection makes. `project_name`: a project carried from a source
    document that has no master row. Project first, then department, as `number_args`."""
    if len(doc_type) > 30:
        raise ValidationError("Unknown document type")
    pattern, prefix = await configured_series(db, doc_type)
    organisation = await db.get(Organization, organization_id) if organization_id else None
    project = await db.get(Project, project_id) if project_id else None
    department = (await db.get(OrgDepartment, org_department_id)
                  if org_department_id else None)
    project_text = (project.name if project else project_name) or None
    scope = project_text or (department.name if department else None)
    # Held by a draft, so it may be last year's after the list has moved on: only the
    # save has the document to check that against, and a preview changes nothing.
    year = fiscal_year or _fiscal_year()

    parts = describe_number(
        pattern, prefix, year,
        company=slug(organisation.name, SCOPE_SLUG_LEN) if organisation else None,
        project=slug(scope, SCOPE_SLUG_LEN) if scope else None)
    scope_source = "project" if project_text else "department" if scope else None
    for part in parts:
        if part["kind"] == "company":
            part["field"] = "organisation"
        elif part["kind"] == "project":
            part["field"] = scope_source or "project"
        elif part["kind"] == "fy":
            part["field"] = "fiscal_year"
        else:
            part["field"] = None
    missing = sorted({part["field"] for part in parts if part["text"] is None})
    return {
        "number": None if missing else "".join(part["text"] for part in parts),
        "parts": parts, "missing": missing, "scope_source": scope_source,
    }

