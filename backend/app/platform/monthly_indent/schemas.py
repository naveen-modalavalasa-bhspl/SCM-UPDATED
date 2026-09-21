"""Wire shapes for Monthly Indent settings."""
from datetime import date, datetime, time

from pydantic import BaseModel, ConfigDict, Field, field_validator


class MonthlyIndentCycle(BaseModel):
    is_enabled: bool = True
    approval_flow_enabled: bool = False
    cycle_month_offset: int = Field(default=0, ge=0, le=12)
    start_day: int = Field(default=1, ge=1, le=31)
    end_day: int = Field(default=31, ge=1, le=31)
    timezone: str = "Asia/Kolkata"
    scheduler_enabled: bool = True
    scheduler_interval_minutes: int = Field(default=30, ge=5, le=1440)


class MonthlyIndentCycleOut(MonthlyIndentCycle):
    cycle_start: date
    cycle_end: date
    cycle_key: str


class MonthlyIndentRuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    is_active: bool = True
    trigger_day: int = Field(ge=1, le=31)
    trigger_time: time
    target_type: str
    target_ref_id: int
    condition: str
    message_template: str = Field(min_length=1)
    escalation_enabled: bool = False
    escalation_day: int | None = Field(default=None, ge=1, le=31)
    escalation_time: time | None = None
    escalation_target_type: str | None = None
    escalation_target_ref_id: int | None = None
    escalation_message_template: str | None = None

    @field_validator("target_type")
    @classmethod
    def _target_type(cls, value: str) -> str:
        value = value.upper()
        if value not in {"HCM_ROLE", "POSITION", "EMPLOYEE"}:
            raise ValueError("target_type must be HCM_ROLE, POSITION, or EMPLOYEE")
        return value

    @field_validator("condition")
    @classmethod
    def _condition(cls, value: str) -> str:
        value = value.upper()
        if value not in {"NOT_SUBMITTED", "PENDING_APPROVAL", "NOT_RESPONDED"}:
            raise ValueError("condition must be NOT_SUBMITTED, PENDING_APPROVAL, or NOT_RESPONDED")
        return value

    @field_validator("escalation_target_type")
    @classmethod
    def _escalation_target_type(cls, value: str | None) -> str | None:
        if value is None or value == "":
            return None
        value = value.upper()
        if value not in {"REPORTING_MANAGER", "HCM_ROLE", "EMPLOYEE"}:
            raise ValueError(
                "escalation_target_type must be REPORTING_MANAGER, HCM_ROLE, or EMPLOYEE")
        return value


class MonthlyIndentRuleOut(MonthlyIndentRuleIn):
    model_config = ConfigDict(from_attributes=True)

    id: int
    target_name: str | None = None
    escalation_target_name: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class MonthlyIndentLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    rule_id: int
    cycle_key: str
    kind: str
    target_employee_id: int
    target_employee_name: str | None = None
    recipient_employee_id: int
    recipient_employee_name: str | None = None
    status: str
    reason: str | None = None
    title: str | None = None
    message: str | None = None
    sent_at: datetime


class MonthlyIndentPreviewIn(BaseModel):
    template: str
    employee_name: str = "A Store Keeper"
    role: str = "Store Keeper"
    month: str = "September 2026"
    cycle_start: str = "2026-09-01"
    cycle_end: str = "2026-09-30"
    pending_since: str = "2026-09-21 10:00"
    approval_level: str = "OE Review"


class MonthlyIndentPreviewOut(BaseModel):
    message: str


class MonthlyIndentSettingsOut(BaseModel):
    cycle: MonthlyIndentCycleOut
    rules: list[MonthlyIndentRuleOut]
    logs: list[MonthlyIndentLogOut] = Field(default_factory=list)
    next_run: str | None = None


class MonthlyIndentRunOut(BaseModel):
    checked: int
    sent: int
    skipped: int
