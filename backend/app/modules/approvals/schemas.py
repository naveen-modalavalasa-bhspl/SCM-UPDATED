"""Wire shapes for the operational approvals module."""
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator


def _utc_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat().replace("+00:00", "Z")


class ApprovalQuantityIn(BaseModel):
    line_id: int = Field(gt=0)
    approved_quantity: float = Field(ge=0)


class IndentApprovalActionIn(BaseModel):
    comments: str = ""
    items: list[ApprovalQuantityIn] = Field(min_length=1)


class IndentRejectionIn(BaseModel):
    comments: str = Field(min_length=1, max_length=2000)

    @field_validator("comments")
    @classmethod
    def rejection_reason_required(cls, value: str) -> str:
        reason = value.strip()
        if not reason:
            raise ValueError("Rejection reason is required")
        return reason


class IndentReturnIn(BaseModel):
    comments: str = Field(min_length=1, max_length=2000)

    @field_validator("comments")
    @classmethod
    def correction_reason_required(cls, value: str) -> str:
        reason = value.strip()
        if not reason:
            raise ValueError("Correction instructions are required")
        return reason


class ApprovalActionIn(BaseModel):
    comments: str = Field(default="", max_length=2000)


class ApprovalRejectionIn(BaseModel):
    comments: str = Field(min_length=1, max_length=2000)

    @field_validator("comments")
    @classmethod
    def reason_required(cls, value: str) -> str:
        reason = value.strip()
        if not reason:
            raise ValueError("Rejection reason is required")
        return reason


class ApprovalActionOut(BaseModel):
    doc_type: str
    doc_id: int
    action: str


class ApprovalReportOut(BaseModel):
    total_decisions: int
    approved: int
    rejected: int
    returned: int
    pending: int
    overdue: int
    average_decision_hours: float


class ReminderOut(BaseModel):
    approver_id: int
    pending_count: int
    notifications_created: int


class ApprovalIndentLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    item_id: int
    item_code: str | None = None
    item_name: str | None = None
    uom_code: str | None = None
    requested_quantity: float
    approved_quantity: float
    remarks: str | None = None


class ApprovalIndentOut(BaseModel):
    id: int
    indent_no: str
    status: str
    priority: str
    requested_by_name: str | None = None
    position_name: str | None = None
    department_name: str | None = None
    office_name: str | None = None
    current_stage_name: str | None = None
    current_approver_name: str | None = None
    created_at: datetime
    items: list[ApprovalIndentLineOut]

    @field_serializer("created_at", when_used="json")
    def serialize_datetime(self, value: datetime):
        return _utc_iso(value)
