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
    return {
        "company": document.organization_name,
        "project": (getattr(document, "project_name", None)
                    or document.org_department_name
                    or getattr(document, "department_name", None)),
        "fiscal_year": None if carried else getattr(document, "fiscal_year", None),
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


def _as_printed(args: dict) -> tuple[str, str, str]:
    return (slug(args["company"], SCOPE_SLUG_LEN), slug(args["project"], SCOPE_SLUG_LEN),
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
