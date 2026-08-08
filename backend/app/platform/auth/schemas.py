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


class PositionBrief(BaseModel):
    id: int
    name: str
    department_id: int | None = None
    department_name: str | None = None
    office_id: int | None = None
    office_name: str | None = None
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


MenuItem.model_rebuild()
