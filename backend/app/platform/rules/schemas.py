"""Request/response shapes for the rules engine."""
from datetime import date

from pydantic import BaseModel, Field
from app.shared.limits import (  # request-size guards, see the module
    MAX_CONFIG_ENTRIES,
)


class ConditionIn(BaseModel):
    field_name: str
    operator: str
    field_value: str
    logic: str = "AND"


class ActionIn(BaseModel):
    action_type: str
    params: dict = Field(default_factory=dict)
    seq: int = 1


class RuleIn(BaseModel):
    event_code: str
    name: str
    description: str | None = None
    priority: int = 100
    stop_on_match: bool = False
    is_active: bool = True
    effective_from: date | None = None
    effective_to: date | None = None
    conditions: list[ConditionIn] = Field(default_factory=list, max_length=MAX_CONFIG_ENTRIES)
    actions: list[ActionIn] = Field(default_factory=list, max_length=MAX_CONFIG_ENTRIES)
    # Saving with a same-priority conflict is refused unless this is set, so the
    # override is a deliberate choice rather than a dialog someone clicked past.
    force: bool = False


class FireIn(BaseModel):
    event_code: str
    context: dict = Field(default_factory=dict)
    doc_type: str | None = None
    doc_id: int | None = None


class SimulateIn(BaseModel):
    """Dry run: which rules would match, without recording an execution."""
    event_code: str
    context: dict = Field(default_factory=dict)
