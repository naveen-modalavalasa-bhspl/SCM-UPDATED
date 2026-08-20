from datetime import date, datetime

from pydantic import BaseModel


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


class EmployeeBrief(BaseModel):
    id: int
    name: str
    code: str | None = None
    email: str | None = None
    office_id: int | None = None
    office_name: str | None = None
    # HCM's service area code for that office, read from the mirror on every /me
    # rather than stored: no column holds it and a re-coded office must show its
    # current code. None for offices HCM holds no SAC for.
    office_sac: str | None = None


class PositionBrief(BaseModel):
    id: int
    name: str
    department_id: int | None = None
    department_name: str | None = None
    office_id: int | None = None
    office_name: str | None = None
    office_sac: str | None = None
    is_primary: bool = False


class PositionSwitchIn(BaseModel):
    position_id: int


class MenuItem(BaseModel):
    code: str
    path: str
    name: str
    icon: str | None = None
    module: str | None = None
    children: list["MenuItem"] = []


class MeOut(BaseModel):
    employee: EmployeeBrief
    roles: list[str]
    positions: list[PositionBrief]
    active_position: PositionBrief | None = None
    permissions: list[str]
    menu: list[MenuItem]
    # What this login calls the warehouse module: MDP, LIP or Warehouse. Carried on
    # /me rather than fetched per screen so the rail and every page header say the
    # same word at the same moment — a second request resolved a beat later and the
    # header visibly flipped from "Warehouse" to "MDP".
    warehouse_label: str = "Warehouse"
    # Every page path that exists, granted or not — the client route guard needs the
    # ungranted ones to tell a detail screen (/indents/42, no rbac_pages row) from a
    # page it was not given (/indents/reports).
    page_paths: list[str] = []
    # The company this ERP belongs to. Served here so a form can name it without
    # asking /api/settings, which requires the permission to EDIT settings. Defaults
    # to "" so an older client and an unconfigured install both behave as before.
    company_name: str = ""


MenuItem.model_rebuild()


class RoleBrief(BaseModel):
    code: str
    name: str | None = None


class ProfilePosition(BaseModel):
    """One HCM position assignment, with the position's own detail flattened in."""
    id: int
    name: str
    code: str | None = None
    is_primary: bool = False
    is_active: bool = True
    department_id: int | None = None
    department_name: str | None = None
    office_id: int | None = None
    office_name: str | None = None
    level_id: int | None = None
    level_name: str | None = None
    role_id: int | None = None
    role_name: str | None = None
    job_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    parent_position_id: int | None = None
    parent_position_name: str | None = None
    valid_from: date | None = None
    valid_to: date | None = None


class ProfileOffice(BaseModel):
    id: int
    name: str
    code: str | None = None
    office_type: str | None = None
    address: str | None = None
    city: str | None = None
    state: str | None = None


class ProfileAccount(BaseModel):
    """The local login row — never the hash, only what the owner may see about it."""
    last_login_at: datetime | None = None
    must_change_password: bool = False
    is_locked: bool = False
    created_at: datetime | None = None


class ProfileOut(BaseModel):
    """Everything SCM holds about the signed-in employee.

    Read-only by construction: `hcm_*` is a mirror (rule 10), so there is nothing here
    the app is allowed to write back. Bank/salary/EPFO/health/PAN/DOB are never stored,
    so they cannot appear.
    """
    id: int
    name: str
    code: str | None = None
    email: str | None = None
    mobile: str | None = None
    is_active: bool = True
    department_id: int | None = None
    department_name: str | None = None
    section_id: int | None = None
    section_name: str | None = None
    office: ProfileOffice | None = None
    project_id: int | None = None
    project_name: str | None = None
    synced_at: datetime | None = None
    positions: list[ProfilePosition] = []
    active_position_id: int | None = None
    roles: list[RoleBrief] = []
    permissions: list[str] = []
    warehouse_label: str = "Warehouse"
    account: ProfileAccount | None = None


class PasswordChangeIn(BaseModel):
    """Self-service password change. The caller is always the subject, so there is
    no employee id here — it comes from the token."""
    current_password: str
    new_password: str
