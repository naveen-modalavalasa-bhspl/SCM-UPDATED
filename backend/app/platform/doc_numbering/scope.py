"""Whose paper a document is on: its organisation, department, project and year.

One rule, for every document that uses it: **each value is copied from the document
before it, or selected on this one.** It is chosen once, carried forward, and goes into
the number, so a document raised from now on never reads NA. The year is the exception:
it belongs to the day a document is raised, so it is today's unless a form picked another,
and a linked document does not inherit it.

Three kinds of document meet here, told apart by `uses_org`:

- **Organised**: carries an organisation. The rule above holds, the number follows the
  selection while it is a draft, and everything is locked once it is submitted.
- **Holding**: a requisition raised automatically the moment an MR is approved. Nobody
  is at a form then, so it has a holding reference instead of a number (`DRAFT-37-A1B2C3`),
  takes its real number when the buyer selects the organisation, and cannot be submitted
  before that. Nothing else can be raised from it, since that needs it approved.
- **Older**: raised before organisations existed, no organisation and a real number.
  Left exactly as it was: its fields, its number and its rules do not change here.

What fails silently if narrowed: `number_args` is the only place a number's scope is
decided. Draw a number from anywhere else and the number and the document can disagree.
"""
import secrets

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationError
from app.platform.settings.service import write_audit
from app.shared.enums import AuditAction
from app.shared.models.master import OrgDepartment, Organization
from app.shared.numbering import (
    SCOPE_SLUG_LEN, _fiscal_year, next_number, selectable_fiscal_years, slug,
)

#: The carried columns, all on `OrgScopeColumns`. Not the year: see the module docstring.
SCOPE_FIELDS = ("organization_id", "organization_code", "organization_name",
                "org_department_id", "org_department_name")
HOLDING_PREFIX = "DRAFT-"


class OrganisationRequired(ValidationError):
    """Nothing before this document named it, and nobody here selected it. Its own class
    so the award's automatic PO can leave an older RFQ to the buyer's dialog."""


def holding_number(source_id: int) -> str:
    """Unique, because a cancelled requisition keeps its reference and the same MR can be
    drafted again. Fits the narrowest number column (30)."""
    return f"{HOLDING_PREFIX}{source_id}-{secrets.token_hex(3).upper()}"


def is_holding(number: str | None) -> bool:
    return bool(number) and number.startswith(HOLDING_PREFIX)


def uses_org(document, number: str | None = None) -> bool:
    return bool(document.organization_id) or is_holding(number)


def assert_fiscal_year(fiscal_year: str | None, *, held: str | None = None) -> str:
    """The year to number in: the one picked, or today's. A draft may keep a year it
    already holds after that year has left the list (`held`)."""
    if not fiscal_year:
        return _fiscal_year()
    allowed = selectable_fiscal_years()
    if fiscal_year not in allowed and fiscal_year != held:
        raise ValidationError(f"{fiscal_year} cannot be used. Pick {' or '.join(allowed)}.")
    return fiscal_year


async def resolve(db: AsyncSession, organization_id: int | None,
                  org_department_id: int | None, *, keep=None,
                  fiscal_year: str | None = None) -> dict:
    """The scope a form selected, as snapshot values. An inactive row is refused unless
    the document already holds it (`keep`): the feed closing a company must not make a
    draft that names it impossible to save."""
    if not organization_id:
        raise OrganisationRequired("Select the organisation this document belongs to.")
    organisation = await db.get(Organization, organization_id)
    held_org = getattr(keep, "organization_id", None)
    if organisation is None or (not organisation.is_active and organization_id != held_org):
        raise ValidationError("That organisation is closed or does not exist. Pick an "
                              "active one from the list.")
    values = {"organization_id": organisation.id,
              "organization_code": organisation.code,
              "organization_name": organisation.name,
              "org_department_id": None, "org_department_name": None,
              "fiscal_year": assert_fiscal_year(
                  fiscal_year, held=getattr(keep, "fiscal_year", None))}
    if org_department_id:
        department = await db.get(OrgDepartment, org_department_id)
        held_dept = getattr(keep, "org_department_id", None)
        if department is None or (not department.is_active and org_department_id != held_dept):
            raise ValidationError("That department is closed or does not exist. Pick an "
                                  "active one from the list.")
        values["org_department_id"] = department.id
        values["org_department_name"] = department.name
    return values


def stamp(document, values: dict) -> None:
    for field, value in values.items():
        setattr(document, field, value)
    # Requisition and RFQ have carried this name since before organisations.
    if hasattr(document, "company_name"):
        document.company_name = values["organization_name"]


def carry(source, document, *, project: bool = False) -> None:
    """Copy the scope from the document before. `project` for the three documents that
    never held their own project until now."""
    stamp(document, {field: getattr(source, field, None) for field in SCOPE_FIELDS}
          | {"fiscal_year": _fiscal_year()})
    if project:
        document.project_id = getattr(source, "project_id", None)
        document.project_name = getattr(source, "project_name", None)


def number_args(document, *, carried: bool = False) -> dict:
    """What a document's number is drawn from. The project, or the department when it
    has none. An older document's HCM department still counts: its children have to
    be numbered from something. `carried`: `document` is the source of a new document
    that has no year of its own yet, so the source's year must not be used."""
    project_name = getattr(document, "project_name", None)
    return {
        "company": document.organization_name,
        "project": (project_name
                    or document.org_department_name
                    or getattr(document, "department_name", None)),
        "fiscal_year": None if carried else getattr(document, "fiscal_year", None),
        # The CODES the number prints (2026-11-11): the organisation's snapshot, and the
        # project — else the department — looked up by id when the number is drawn.
        "company_code": getattr(document, "organization_code", None),
        "project_id": getattr(document, "project_id", None) if project_name else None,
        "org_department_id": (None if project_name
                              else getattr(document, "org_department_id", None)),
    }


def assert_complete(document) -> None:
    """Refuse a document that would have to print NA, naming what is missing."""
    if not document.organization_id:
        raise OrganisationRequired("Select the organisation this document belongs to.")
    if not (getattr(document, "project_name", None) or document.org_department_name
            or getattr(document, "department_name", None)):
        raise OrganisationRequired("Select the project or the department this document "
                                   "is for.")


def assert_lockable(document, label: str, *, is_draft: bool, source_has_org: bool,
                    organization_id: int | None = None,
                    org_department_id: int | None = None,
                    project_id: int | None = None,
                    fiscal_year: str | None = None,
                    given: set[str] | None = None) -> None:
    """Refuse a change the document's stage does not allow. `given` is which of them the
    caller stated; anything else is not a change. Once submitted all of it is fixed,
    because approvers signed that number; on a linked draft the organisation is too, so
    one chain cannot change company halfway."""
    given = ({"organization_id", "org_department_id", "project_id", "fiscal_year"}
             if given is None else given)
    moved = [field for field, value in (
        ("organization_id", organization_id), ("org_department_id", org_department_id),
        ("project_id", project_id), ("fiscal_year", fiscal_year),
    ) if field in given and (value or None) != (getattr(document, field, None) or None)]
    if not moved:
        return
    if not is_draft:
        raise ValidationError(f"The organisation, department, project and year on {label} "
                              "are fixed once it has been submitted.")
    if source_has_org and "organization_id" in moved:
        raise ValidationError(f"The organisation on {label} comes from the document it "
                              "was raised from and cannot be changed here.")


def _as_printed(args: dict) -> tuple:
    """Whether two selections number alike: the same organisation, project or
    department and year — compared by what identifies them, not by printed letters."""
    return (args.get("company_code") or slug(args["company"], SCOPE_SLUG_LEN),
            args.get("project_id"), args.get("org_department_id"),
            slug(args["project"], SCOPE_SLUG_LEN),
            args.get("fiscal_year") or _fiscal_year())


async def renumber(db: AsyncSession, document, doc_type: str, number_attr: str,
                   entity: str, actor) -> None:
    """Give an organised DRAFT the number its current selection calls for.

    Only when the scope actually moved: compared as the number prints it, so re-saving a
    draft never burns a number. The old number is skipped and kept in the audit trail.
    """
    args = number_args(document)
    old = getattr(document, number_attr)
    if not is_holding(old):
        before = getattr(document, "_number_args_before", None)
        if before is None or _as_printed(before) == _as_printed(args):
            return
    setattr(document, number_attr, await next_number(db, doc_type, **args))
    await write_audit(
        db, entity=entity, entity_id=document.id,
        entity_no=getattr(document, number_attr), action=AuditAction.UPDATE, actor=actor,
        before={number_attr: old}, after={number_attr: getattr(document, number_attr)},
        summary=f"Numbered {getattr(document, number_attr)} from its selection (was {old})",
    )


def remember_number_args(document) -> None:
    """Call before changing a draft's selection, so `renumber` can tell it moved."""
    document._number_args_before = number_args(document)


# --------------------------------------------------------------------------- #
#  Indent, STR, monthly indent, STO and material issue (2026-11-09)
# --------------------------------------------------------------------------- #
# Procurement selects everything on the form. These documents are raised by people who
# ARE somewhere in HCM, so what HCM says about them is used, and fixed, before anything
# is offered to pick:
#
#   - the raiser's project (the post in hand, else the employee) is the project, locked;
#   - else their department, matched BY NAME to the organisation feed's departments
#     (the feed states no link to HCM, so a name is all there is), locked;
#   - else one of the two is picked on the form, and one is required.
#
# The organisation is the configured default (`ORG_DEFAULT_NAME`) and is locked when one
# is configured: nothing in HCM says which organisation a person is in. A direct STO and
# a direct material issue select all of it, opening on the same values.

def _norm(text: str | None) -> str:
    return " ".join((text or "").split()).casefold()


async def default_organisation(db: AsyncSession) -> Organization | None:
    """The configured default organisation, when it names an active one."""
    from app.core.config import settings
    from sqlalchemy import select

    wanted = _norm(settings.ORG_DEFAULT_NAME)
    if not wanted:
        return None
    rows = (await db.execute(
        select(Organization).where(Organization.is_active.is_(True)))).scalars().all()
    return next((row for row in rows if _norm(row.name) == wanted), None)


async def raiser_mapping(db: AsyncSession, user) -> dict:
    """What HCM says about the person raising the document: their project, else their
    department matched by name to the feed. Empty values where HCM says nothing usable.

    Read off the post in hand first, then the employee, the order `indents` reads its
    own context in, so the card and the save can never disagree about what is fixed."""
    from sqlalchemy import select
    from app.platform.hcm.models import HcmDepartment, HcmPosition
    from app.shared.models.master import Project

    position = None
    position_id = getattr(user, "active_position_id", None)
    if position_id is not None:
        position = await db.get(HcmPosition, position_id)
    out = {"project_id": None, "project_name": None,
           "org_department_id": None, "org_department_name": None}

    project_id = (getattr(position, "project_id", None) or getattr(user, "project_id", None))
    if project_id:
        project = await db.get(Project, project_id)
        if project is not None and project.is_active:
            out.update(project_id=project.id, project_name=project.name)
            return out

    department_id = (getattr(position, "department_id", None)
                     or getattr(user, "department_id", None))
    if department_id:
        department = await db.get(HcmDepartment, department_id)
        name = _norm(getattr(department, "name", None))
        if name:
            matches = [row for row in (await db.execute(
                select(OrgDepartment).where(OrgDepartment.is_active.is_(True))
            )).scalars().all() if _norm(row.name) == name]
            if len(matches) == 1:   # two of one name is not an answer
                out.update(org_department_id=matches[0].id,
                           org_department_name=matches[0].name)
    return out


async def _project(db: AsyncSession, project_id: int | None, keep=None):
    from app.shared.models.master import Project

    if not project_id:
        return None
    project = await db.get(Project, project_id)
    held = getattr(keep, "project_id", None)
    if project is None or (not project.is_active and project_id != held):
        raise ValidationError("That project is closed or does not exist. Pick an active "
                              "one from the list.")
    return project


async def resolve_selection(db: AsyncSession, *, organization_id: int | None,
                            org_department_id: int | None, project_id: int | None,
                            fiscal_year: str | None = None, keep=None) -> dict:
    """A form's free selection — direct STO, direct material issue — as snapshot values,
    with the project. Project OR department: both given keeps the project, the way the
    number reads it; neither is refused, so the number can never print NA."""
    project = await _project(db, project_id, keep)
    values = await resolve(db, organization_id,
                           None if project else org_department_id,
                           keep=keep, fiscal_year=fiscal_year)
    values["project_id"] = project.id if project else None
    values["project_name"] = project.name if project else None
    if not (values["project_name"] or values["org_department_name"]):
        raise OrganisationRequired("Select the project or the department this document "
                                   "is for.")
    return values


async def resolve_for_raiser(db: AsyncSession, user, *, organization_id: int | None,
                             org_department_id: int | None, project_id: int | None,
                             fiscal_year: str | None = None, keep=None) -> dict:
    """An indent / STR / monthly indent's selection, with what HCM fixes applied first.

    A value HCM fixes is used whatever was sent, and a DIFFERENT value sent for it is
    refused rather than silently replaced — a caller that sent it believed it would
    stick. `keep` is the saved draft, whose own values are never refused."""
    default_org = await default_organisation(db)
    if default_org is not None:
        held = getattr(keep, "organization_id", None)
        if organization_id and organization_id not in (default_org.id, held):
            raise ValidationError(
                f"Documents are raised under {default_org.name}. The organisation "
                "cannot be changed here.")
        organization_id = organization_id or held or default_org.id

    mapped = await raiser_mapping(db, user)
    if mapped["project_id"]:
        if project_id and project_id not in (mapped["project_id"],
                                             getattr(keep, "project_id", None)):
            raise ValidationError(
                f"Your project is {mapped['project_name']} in HCM, so this document is "
                "raised under it.")
        project_id, org_department_id = mapped["project_id"], None
    elif mapped["org_department_id"]:
        if org_department_id and org_department_id not in (
                mapped["org_department_id"], getattr(keep, "org_department_id", None)):
            raise ValidationError(
                f"Your department is {mapped['org_department_name']}, so this document "
                "is raised under it.")
        if project_id and project_id != getattr(keep, "project_id", None):
            raise ValidationError(
                f"Your department is {mapped['org_department_name']} and you hold no "
                "project in HCM, so this document is raised under the department.")
        project_id, org_department_id = None, mapped["org_department_id"]
    return await resolve_selection(
        db, organization_id=organization_id, org_department_id=org_department_id,
        project_id=project_id, fiscal_year=fiscal_year, keep=keep)


def stamp_with_project(document, values: dict) -> None:
    """`stamp`, plus the project, for a document whose project is part of its scope."""
    stamp(document, {k: v for k, v in values.items()
                     if k not in ("project_id", "project_name")})
    document.project_id = values.get("project_id")
    document.project_name = values.get("project_name")


async def resolve_free(db: AsyncSession, data, *, keep=None) -> dict | None:
    """A standalone document's organisation / project / department (2026-11-11) — a stock
    audit, a stock correction, a movement: nothing before it, so all of it is SELECTED,
    opening on the configured default organisation. None when the request names no
    organisation and none is configured: the caller keeps its old numbering, so a caller
    that predates the number card still gets a number."""
    default = await default_organisation(db)
    chosen = getattr(data, "organization_id", None) or getattr(keep, "organization_id", None)
    if not (chosen or default):
        return None
    return await resolve_selection(
        db, organization_id=chosen or default.id,
        org_department_id=getattr(data, "org_department_id", None),
        project_id=getattr(data, "project_id", None),
        fiscal_year=getattr(data, "fiscal_year", None), keep=keep)


def args_of(values: dict) -> dict:
    """`next_number` arguments for a resolved selection, read as `number_args` reads a
    document."""
    from types import SimpleNamespace
    return number_args(SimpleNamespace(department_name=None, **values))


async def carry_or_select(db: AsyncSession, data, source=None) -> tuple[dict | None, dict | None]:
    """Whose paper a document is on when it MAY have a document before it (2026-11-12) —
    a purchase return off a GRN / PO, an indent return off its indent, a transport
    request off its indent, a vendor payment off its PO. Returns (values to stamp with
    `stamp_with_project`, `next_number` arguments), or (None, None) for the old numbering.

    - A source that carries an organisation: COPIED from it — organisation, department,
      project — and fixed. The year is this document's own (picked, else today's),
      never the source's, which may be last year's.
    - Otherwise (no source, or an older one): what the number card SELECTED. A request
      that names no organisation is a caller with no card — an automatic path, an older
      client — and keeps the numbering it always had rather than being refused.
    """
    if source is not None and uses_org(source):
        values = {field: getattr(source, field, None) for field in SCOPE_FIELDS}
        values["fiscal_year"] = assert_fiscal_year(getattr(data, "fiscal_year", None))
        values["project_id"] = getattr(source, "project_id", None)
        values["project_name"] = getattr(source, "project_name", None)
        args = number_args(source, carried=True)
        args["fiscal_year"] = values["fiscal_year"]
        return values, args
    if not getattr(data, "organization_id", None):
        return None, None
    values = await resolve_free(db, data)
    return (values, args_of(values)) if values else (None, None)
