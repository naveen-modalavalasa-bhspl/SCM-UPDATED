"""Request shapes for the admin module."""
from pydantic import BaseModel, Field

from app.shared.enums import NotificationChannel, ResetPolicy


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


class GrantAccessIn(BaseModel):
    employee_id: int
    role_ids: list[int] = Field(default_factory=list)
    # Omit to have one generated and returned once.
    password: str | None = None


class SetRolesIn(BaseModel):
    role_ids: list[int] = Field(default_factory=list)


class DocSeriesIn(BaseModel):
    doc_type: str
    fiscal_year: str
    prefix: str
    pattern: str = "{prefix}/{fy}/{num:04d}"
    reset_policy: str = ResetPolicy.NEVER.value
    is_active: bool = True


class NotificationRuleIn(BaseModel):
    event_code: str
    stage: str | None = None
    recipient_type: str
    recipient_id: int | None = None
    channel: str = NotificationChannel.IN_APP.value
    template: str | None = None
    is_active: bool = True


class HcmScheduleIn(BaseModel):
    enabled: bool
    interval_minutes: int = Field(ge=5, le=10080)
