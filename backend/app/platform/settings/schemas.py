"""Wire shapes for /api/settings.

The values are stored as rows in sys_settings; this file only gives the UI a stable
grouped contract so the screen does not know about individual setting keys.
"""
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


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


class SettingsOut(BaseModel):
    company: CompanySettings = Field(default_factory=CompanySettings)
    regional: RegionalSettings = Field(default_factory=RegionalSettings)
    hcm_sync: HcmSyncSettings = Field(default_factory=HcmSyncSettings)
    numbering: NumberingSettings = Field(default_factory=NumberingSettings)
    notifications: NotificationSettings = Field(default_factory=NotificationSettings)
    fallback: FallbackSettings = Field(default_factory=FallbackSettings)


class SettingsIn(SettingsOut):
    pass
