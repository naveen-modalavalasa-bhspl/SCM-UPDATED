from pydantic import BaseModel, Field


class RolePageAccessIn(BaseModel):
    page_codes: list[str] = Field(default_factory=list)


class RoleFeatureAccessIn(BaseModel):
    permission_codes: list[str] = Field(default_factory=list)
