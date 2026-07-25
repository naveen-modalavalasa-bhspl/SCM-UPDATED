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


MenuItem.model_rebuild()
