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


# ---------------- approval ladders (Settings > Approvals Config) ----------------

class LadderRungIn(BaseModel):
    """One rung: a position LEVEL, on or off. Never a person, never a position."""
    position_role_id: int
    name: str
    is_enabled: bool = True
    # None means a legacy role-wide rung. An explicit list restricts the role to
    # these exact HCM positions; [] intentionally disables every position.
    selected_position_ids: list[int] | None = None
    conditions: list[WorkflowConditionIn] = Field(default_factory=list)


class LadderPolicyMixin(BaseModel):
    """Who may approve a document raised by someone who is also ON this ladder.

    A property of the ladder, not of a role or a person, so a project where one person
    wears three hats can let them approve while another keeps segregation of duties.
    None means leave it at the default, INDEPENDENT — which is what every ladder saved
    before this setting existed did.
    """
    self_approval_policy: str | None = None
    # Where an INDEPENDENT ladder sends a document when every rung resolved to the
    # raiser himself. A POST, so it survives the person in the chair changing.
    fallback_position_id: int | None = None


class LadderIn(LadderPolicyMixin):
    project_id: int | None = None
    doc_type: str
    rungs: list[LadderRungIn] = Field(default_factory=list)


class CustomLadderStepIn(BaseModel):
    """One step of a hand-built ladder: a POST, not a rank and not a person."""
    position_id: int
    name: str


class CustomLadderIn(LadderPolicyMixin):
    project_id: int | None = None
    doc_type: str
    steps: list[CustomLadderStepIn] = Field(default_factory=list)


class LadderCopyIn(BaseModel):
    """Copy a saved ladder onto other projects, matched by level.

    Levels are global while positions are per-project, so this is the only portable
    key. A level the target project does not use is simply dropped.
    """
    from_project_id: int | None = None
    doc_type: str
    to_project_ids: list[int] = Field(min_length=1)
