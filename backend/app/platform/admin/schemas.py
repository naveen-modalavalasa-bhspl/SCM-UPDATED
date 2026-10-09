"""Request shapes for the admin module."""
from pydantic import BaseModel, Field

from app.shared.enums import NotificationChannel, ResetPolicy
from app.shared.limits import (  # request-size guards, see the module
    MAX_BATCH_IDS,
)


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
    role_ids: list[int] = Field(default_factory=list, max_length=MAX_BATCH_IDS)
    # Omit to have one generated and returned once.
    password: str | None = None


class SetRolesIn(BaseModel):
    role_ids: list[int] = Field(default_factory=list, max_length=MAX_BATCH_IDS)


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


class FrontendErrorIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    error_type: str | None = Field(default=None, max_length=200)
    status_code: int | None = Field(default=None, ge=0, le=599)
    http_method: str | None = Field(default=None, max_length=10)
    endpoint: str | None = Field(default=None, max_length=500)
    page_url: str | None = Field(default=None, max_length=1000)
    source_file: str | None = Field(default=None, max_length=500)
    function_name: str | None = Field(default=None, max_length=200)
    line_number: int | None = Field(default=None, ge=0)
    column_number: int | None = Field(default=None, ge=0)
    stack_trace: str | None = Field(default=None, max_length=30000)
    request_id: str | None = Field(default=None, max_length=64)
    context: dict | None = None
