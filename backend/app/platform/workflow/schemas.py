"""Workflow action wire shapes."""
from datetime import date

from pydantic import BaseModel, Field


class WorkflowActionIn(BaseModel):
    comments: str = ""
    context: dict = Field(default_factory=dict)


class WorkflowActionOut(BaseModel):
    doc_type: str
    doc_id: int
    status: str
    current_sequence: int
    current_stage_name: str | None = None


class DelegationIn(BaseModel):
    to_employee_id: int
    doc_type: str | None = None
    valid_from: date
    valid_to: date
    reason: str | None = None


class DelegationOut(BaseModel):
    id: int
    from_employee_id: int
    from_employee_name: str | None = None
    to_employee_id: int
    to_employee_name: str | None = None
    doc_type: str | None = None
    valid_from: date
    valid_to: date
    reason: str | None = None
    is_active: bool


class DelegationEndIn(BaseModel):
    """Ending a delegation keeps its audit row; it is never deleted."""
    reason: str | None = None


class WorkflowConditionIn(BaseModel):
    field_name: str
    operator: str
    field_value: str
    logic: str = "AND"


class WorkflowStageIn(BaseModel):
    sequence: int = Field(ge=1)
    name: str
    approver_type: str
    position_id: int | None = None
    role_id: int | None = None
    employee_id: int | None = None
    approval_mode: str = "ANY_ONE"
    is_optional: bool = False
    can_edit_document: bool = False
    sla_hours: int | None = Field(default=None, ge=1)
    conditions: list[WorkflowConditionIn] = Field(default_factory=list)


class WorkflowIn(BaseModel):
    code: str
    name: str
    doc_type: str
    is_active: bool = True
    stages: list[WorkflowStageIn] = Field(default_factory=list)
