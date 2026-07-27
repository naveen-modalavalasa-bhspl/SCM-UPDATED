from pydantic import BaseModel, Field


class RolePageAccessIn(BaseModel):
    page_codes: list[str] = Field(default_factory=list)


class RoleFeatureAccessIn(BaseModel):
    permission_codes: list[str] = Field(default_factory=list)


class UserGroupIn(BaseModel):
    code: str
    name: str
    description: str | None = None
    parent_id: int | None = None
    group_type: str
    role_id: int | None = None
    position_id: int | None = None
    location_id: int | None = None
    is_active: bool = True


class RoleIn(BaseModel):
    code: str
    name: str
    description: str | None = None
    is_active: bool = True


class RolePermissionsIn(BaseModel):
    permission_codes: list[str] = Field(default_factory=list)


class RoleCloneIn(BaseModel):
    code: str
    name: str
