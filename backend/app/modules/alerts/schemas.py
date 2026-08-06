"""Shapes for the alert catalog.

`AlertVariant` and `AlertMode` are module-local enums, not additions to
`app/shared/enums.py`: they describe how a dialog looks and behaves, never the
status of a document. CLAUDE.md rule 3 (no raw status strings) is about document
status — these never touch one.
"""
from enum import Enum

from pydantic import BaseModel, Field


class AlertVariant(str, Enum):
    """Tone of the dialog. Drives icon, tint and button colour on the frontend."""

    SUCCESS = "success"
    INFO = "info"
    WARNING = "warning"
    DANGER = "danger"
    ERROR = "error"


class AlertMode(str, Enum):
    ALERT = "alert"      # tells the user something; may close itself
    CONFIRM = "confirm"  # asks a question; waits for an answer, never self-closes


class AlertDef(BaseModel):
    """One catalog entry. `message` may carry `{placeholders}` filled at call time."""

    code: str
    variant: AlertVariant
    mode: AlertMode
    title: str
    message: str
    confirm_label: str | None = None
    cancel_label: str | None = None
    # None = stays until dismissed. A confirm is always None: a question that
    # answers itself after three seconds is a bug, not a feature.
    auto_close_ms: int | None = None


class AlertCatalog(BaseModel):
    items: dict[str, AlertDef] = Field(default_factory=dict)
    total: int = 0
