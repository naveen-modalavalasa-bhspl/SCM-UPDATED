from pydantic import BaseModel


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


class EmployeeBrief(BaseModel):
    id: int
    name: str
    code: str | None = None
    email: str | None = None


class PositionBrief(BaseModel):
    id: int
    name: str


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
    permissions: list[str]
    menu: list[MenuItem]


MenuItem.model_rebuild()
