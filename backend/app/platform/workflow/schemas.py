"""Workflow action wire shapes."""
from datetime import date

from pydantic import BaseModel, Field, model_validator
from app.shared.limits import (  # request-size guards, see the module
    Annotated, BatchIds, MAX_BATCH_IDS, MAX_CONFIG_ENTRIES,
)


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
    conditions: list[WorkflowConditionIn] = Field(default_factory=list, max_length=MAX_CONFIG_ENTRIES)


class WorkflowIn(BaseModel):
    code: str
    name: str
    doc_type: str
    is_active: bool = True
    stages: list[WorkflowStageIn] = Field(default_factory=list, max_length=MAX_CONFIG_ENTRIES)


# ---------------- approval ladders (Settings > Approvals Config) ----------------

class LadderRungIn(BaseModel):
    """One rung: a position LEVEL, on or off. Never a person, never a position."""
    position_role_id: int
    name: str
    is_enabled: bool = True
    # None means a legacy role-wide rung. An explicit list restricts the role to
    # these exact HCM positions; [] intentionally disables every position.
    selected_position_ids: Annotated[list[int], BatchIds] | None = None
    conditions: list[WorkflowConditionIn] = Field(default_factory=list, max_length=MAX_CONFIG_ENTRIES)


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
    rungs: list[LadderRungIn] = Field(default_factory=list, max_length=MAX_CONFIG_ENTRIES)


class CustomLadderStepIn(BaseModel):
    """One step of a hand-built ladder — exactly one of three kinds of chair.

    `position_id` is an HCM post, `post_id` a post this system owns (for the steps HCM
    has no position for), and `position_role_id` a RANK climbed from the raiser's own
    reporting line. A ladder may mix them: the SCM indent climbs the field line and then
    hands to two fixed SCM chairs.
    """
    position_id: int | None = None
    post_id: int | None = None
    position_role_id: int | None = None
    name: str

    @model_validator(mode="after")
    def _exactly_one_kind(self):
        kinds = [self.position_id, self.post_id, self.position_role_id]
        if sum(1 for value in kinds if value is not None) != 1:
            raise ValueError(
                "A step names exactly one of position_id, post_id or position_role_id")
        return self


class CustomLadderIn(LadderPolicyMixin):
    project_id: int | None = None
    doc_type: str
    # The RANK of raiser this chain serves (hcm_positions.role_id). None is the chain
    # everybody else uses, and is what every chain saved before this existed carries.
    raiser_role_id: int | None = None
    steps: list[CustomLadderStepIn] = Field(default_factory=list, max_length=MAX_CONFIG_ENTRIES)


class FlowMoveDocumentIn(BaseModel):
    """Move one document already in approval onto another version of its chain.

    `instance_id`, not the document id: the admin is looking at the version history,
    which lists approvals, and the same document may have had more than one cycle.
    """
    instance_id: int
    workflow_id: int
    reason: str | None = None


class FlowCopyIn(BaseModel):
    """Copy one saved chain onto other projects, other raiser ranks, or both.

    Separate from `LadderCopyIn` because the Approval Flow screen copies a chain
    verbatim (its steps are already portable) while the rank ladder's copy matches by
    level. `drop_steps_at_or_below` is what makes a copy across ranks meaningful: an
    OE's ladder should not contain the Store Keeper step it was copied from, because
    the OE is above it.
    """
    from_project_id: int | None = None
    from_raiser_role_id: int | None = None
    doc_type: str
    to_project_ids: list[int] = Field(default_factory=list, max_length=MAX_BATCH_IDS)
    to_raiser_role_ids: list[int] = Field(default_factory=list, max_length=MAX_BATCH_IDS)
    drop_steps_at_or_below: bool = True

    @model_validator(mode="after")
    def _somewhere_to_copy_to(self):
        if not self.to_project_ids and not self.to_raiser_role_ids:
            raise ValueError("Pick at least one project or rank to copy to")
        return self


class ApprovalPostIn(BaseModel):
    """A chair this system owns, and who currently sits in it.

    `employee_ids` is the WHOLE seating, not an addition: saving replaces it, which is
    what "these are the people in this post" means on a form.
    """
    name: str
    department: str | None = None
    hcm_position_id: int | None = None
    # The job profile this chair carries. Seating someone grants it; None leaves the
    # post as a ladder rung only, which is what every post is until an admin picks one.
    rbac_role_id: int | None = None
    employee_ids: list[int] = Field(default_factory=list, max_length=MAX_BATCH_IDS)
    is_active: bool | None = None


class LadderCopyIn(BaseModel):
    """Copy a saved ladder onto other projects, matched by level.

    Levels are global while positions are per-project, so this is the only portable
    key. A level the target project does not use is simply dropped.
    """
    from_project_id: int | None = None
    doc_type: str
    to_project_ids: list[int] = Field(min_length=1, max_length=MAX_BATCH_IDS)


class ReminderConfigIn(BaseModel):
    """The overdue-approval chase settings.

    `max_reminders` may be 0 — that means escalate on the first sweep with no reminder
    first, which is a legitimate policy for an urgent document type.
    """
    enabled: bool = False
    interval_minutes: int = Field(default=60, ge=0, le=1440)
    max_reminders: int = Field(default=2, ge=0, le=10)
    gap_hours: int = Field(default=24, ge=0, le=720)
    # Used only when wf_pending.due_at is NULL, which today is every row.
    overdue_after_days: int = Field(default=3, ge=0, le=90)
