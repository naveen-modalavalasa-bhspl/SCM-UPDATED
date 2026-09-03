from pydantic import BaseModel, Field
from app.shared.limits import (  # request-size guards, see the module
    Annotated, ConfigEntries, MAX_CONFIG_ENTRIES,
)


class RolePageAccessIn(BaseModel):
    page_codes: list[str] = Field(default_factory=list, max_length=MAX_CONFIG_ENTRIES)


class RoleFeatureAccessIn(BaseModel):
    permission_codes: list[str] = Field(default_factory=list, max_length=MAX_CONFIG_ENTRIES)


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
    permission_codes: list[str] = Field(default_factory=list, max_length=MAX_CONFIG_ENTRIES)


class RoleCloneIn(BaseModel):
    code: str
    name: str


class JobProfileAccessIn(BaseModel):
    """A job profile's whole grant, saved in one shot (profiles.py)."""
    page_codes: Annotated[list[str], ConfigEntries] = []
    permission_codes: Annotated[list[str], ConfigEntries] = []
    scope: str = "SELF"
    name: str | None = None
