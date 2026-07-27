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
