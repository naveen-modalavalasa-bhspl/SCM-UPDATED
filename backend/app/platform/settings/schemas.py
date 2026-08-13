"""Wire shapes for /api/settings.

The values are stored as rows in sys_settings; this file only gives the UI a stable
grouped contract so the screen does not know about individual setting keys.
"""
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class AttachmentRead(BaseModel):
    """One stored document. Lives here because `sys_attachments` does — the warehouse
    and indents both read it, and neither may import the other."""
    model_config = ConfigDict(from_attributes=True)

    id: int
    entity_type: str
    entity_id: int
    file_name: str
    file_path: str
    file_size: int | None = None
    mime_type: str | None = None
    doc_category: str | None = None
    uploaded_by_id: int | None = None
    uploaded_by_name: str | None = None
    created_at: datetime | None = None


class CompanySettings(BaseModel):
    name: str = ""
    legal_name: str = ""
    gstin: str = ""
    address: str = ""
    phone: str = ""
    email: str = ""


class RegionalSettings(BaseModel):
    fiscal_year: str = ""
    default_warehouse_id: int | None = None
    currency: str = "INR"
    date_format: str = "DD-MM-YYYY"
    timezone: str = "Asia/Kolkata"


class HcmSyncSettings(BaseModel):
    enabled: bool = False
    interval_minutes: int = Field(default=1440, ge=5)


class NumberingSettings(BaseModel):
    fiscal_year_prefix: str = "{FY}"
    default_pattern: str = "{PREFIX}/{FY}/{SEQ:5}"
    reset_policy: str = "YEARLY"


class NotificationSettings(BaseModel):
    channels: list[str] = Field(default_factory=lambda: ["IN_APP"])
    email_enabled: bool = False
    in_app_enabled: bool = True


class FallbackSettings(BaseModel):
    workflow_fallback_enabled: bool = True
    notify_admin_on_fallback: bool = True
    allow_auto_admin_fallback: bool = True


class CodeFormatSettings(BaseModel):
    """How an asset / consumable code is built at putaway.

    Configured because the shape of the code is a business decision that keeps
    changing, and it used to be an f-string in warehouse putaway — every change was a
    deploy. The templates are validated here so a bad one is rejected on the screen
    that typed it, never at the dock.
    """
    asset_format: str = "{item_code}-{new_flag}-{serial:8}"
    consumable_format: str = "{item_code}-{new_flag}-{serial:8}"
    # The serial minted for a unit that arrives without one. Cannot quote {serial} —
    # it IS the serial — so it is validated by its own rule, below.
    serial_format: str = "{item_code}-{seq:5}"
    # What {new_flag} renders as. Two strings rather than a hardcoded 1/0 so the next
    # request ("make it N and O") is a setting change, not another code change.
    new_flag: str = "1"
    legacy_flag: str = "0"
    # Items created before this date count as old and get `legacy_flag`. Empty means
    # nothing is old — the safe reading, since it cannot silently re-brand a catalogue.
    legacy_before: str = ""

    @field_validator("asset_format", "consumable_format")
    @classmethod
    def _check(cls, value: str) -> str:
        # Validated by the same function that renders at putaway, so the screen cannot
        # accept a template the dock would then reject.
        from app.platform.settings.codeformat import validate_format
        from app.core.exceptions import ValidationError
        try:
            return validate_format(value)
        except ValidationError as exc:
            raise ValueError(str(exc)) from exc

    @field_validator("serial_format")
    @classmethod
    def _check_serial(cls, value: str) -> str:
        from app.platform.settings.codeformat import validate_serial_format
        from app.core.exceptions import ValidationError
        try:
            return validate_serial_format(value)
        except ValidationError as exc:
            raise ValueError(str(exc)) from exc


class SettingsOut(BaseModel):
    company: CompanySettings = Field(default_factory=CompanySettings)
    regional: RegionalSettings = Field(default_factory=RegionalSettings)
    hcm_sync: HcmSyncSettings = Field(default_factory=HcmSyncSettings)
    numbering: NumberingSettings = Field(default_factory=NumberingSettings)
    notifications: NotificationSettings = Field(default_factory=NotificationSettings)
    fallback: FallbackSettings = Field(default_factory=FallbackSettings)
    # `codes` is deliberately NOT here. It has its own endpoints and its own
    # permission, so editing the company address cannot re-shape every asset code.


class SettingsIn(SettingsOut):
    pass
