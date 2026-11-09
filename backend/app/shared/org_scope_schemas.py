"""Whose paper a document is on — the request and response fields every document that
uses `platform/doc_numbering/scope.py` carries. One definition so procurement, indents,
STOs and material issues cannot drift apart on a field name."""
from pydantic import BaseModel


class OrgScopeOut(BaseModel):
    """All null on a document raised before organisations."""
    organization_id: int | None = None
    organization_code: str | None = None
    organization_name: str | None = None
    org_department_id: int | None = None
    org_department_name: str | None = None
    fiscal_year: str | None = None


class OrgScopeIn(BaseModel):
    """What a form selects. Project OR department; the server applies what HCM fixes for
    the raiser before it reads any of these (`scope.resolve_for_raiser`)."""
    organization_id: int | None = None
    org_department_id: int | None = None
    project_id: int | None = None
    fiscal_year: str | None = None
