"""sys_settings key-value helpers, the HCM sync schedule, and the audit log."""
import json
from datetime import date, time
from decimal import Decimal
from enum import Enum

from sqlalchemy import desc, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.pagination import PageParams, paginate
from app.platform.settings.clientinfo import get_client_info
from app.platform.settings.models import AuditLog, Setting
from app.platform.settings.schemas import (
    CodeFormatSettings, CompanySettings, FallbackSettings, HcmSyncSettings,
    LogisticsSettings, NotificationSettings, NumberingSettings, RegionalSettings,
    SecuritySettings, SettingsIn, SettingsOut, WarehouseSettings,
)
from app.shared.enums import AuditAction

HCM_ENABLED_KEY = "hcm_sync_enabled"
HCM_INTERVAL_KEY = "hcm_sync_interval_minutes"
DEFAULT_INTERVAL = 1440  # daily

SETTINGS_SPEC = {
    "company": (CompanySettings, {
        "name": ("company.name", "string"),
        "legal_name": ("company.legal_name", "string"),
        "gstin": ("company.gstin", "string"),
        "address": ("company.address", "string"),
        "phone": ("company.phone", "string"),
        "email": ("company.email", "string"),
    }),
    "regional": (RegionalSettings, {
        "fiscal_year": ("regional.fiscal_year", "string"),
        "default_warehouse_id": ("regional.default_warehouse_id", "int"),
        "currency": ("regional.currency", "string"),
        "date_format": ("regional.date_format", "string"),
        "timezone": ("regional.timezone", "string"),
    }),
    "hcm_sync": (HcmSyncSettings, {
        "enabled": (HCM_ENABLED_KEY, "bool"),
        "interval_minutes": (HCM_INTERVAL_KEY, "int"),
    }),
    "numbering": (NumberingSettings, {
        "fiscal_year_prefix": ("numbering.fiscal_year_prefix", "string"),
        "default_pattern": ("numbering.default_pattern", "string"),
        "reset_policy": ("numbering.reset_policy", "string"),
    }),
    "notifications": (NotificationSettings, {
        "channels": ("notifications.channels", "json"),
        "email_enabled": ("notifications.email_enabled", "bool"),
        "in_app_enabled": ("notifications.in_app_enabled", "bool"),
    }),
    "fallback": (FallbackSettings, {
        "workflow_fallback_enabled": ("fallback.workflow_enabled", "bool"),
        "notify_admin_on_fallback": ("fallback.notify_admin", "bool"),
        "allow_auto_admin_fallback": ("fallback.allow_auto_admin", "bool"),
    }),
    "warehouse": (WarehouseSettings, {
        # Read by warehouse.service.requires_inward for any stocking point that has
        # not answered for itself. Same key name the migration seeds — two spellings
        # of one setting is two settings.
        "requires_inward_default": ("warehouse.requires_inward_default", "bool"),
        # Loaded into shared.limits.RUNTIME_LIMITS by load_unit_limits. 0 = no limit.
        "max_serials_per_line": ("warehouse.max_serials_per_line", "int"),
        "max_serials_per_request": ("warehouse.max_serials_per_request", "int"),
        "max_units_per_code_mint": ("warehouse.max_units_per_code_mint", "int"),
    }),
    "logistics": (LogisticsSettings, {
        "manual_courier_dispatch": ("logistics.manual_courier_dispatch", "bool"),
    }),
    "security": (SecuritySettings, {
        # The SAME key `procurement.quote_otp.SETTING_KEY` reads at verification
        # time. Two spellings of one setting is two settings, and the one the
        # admin can see would be the one that does nothing.
        "vendor_quote_otp_seconds": ("security.vendor_quote_otp_seconds", "int"),
        # Read by `mail.service._reset_minutes`. Same key on both sides, same reason.
        "password_reset_minutes": ("security.password_reset_minutes", "int"),
    }),
}

# The code formula is kept out of SETTINGS_SPEC and off the general settings PUT: it
# has its own permission, because it decides what every unit received from now on is
# labelled with. Same key names codeformat.code_settings() reads at putaway — two
# spellings of one setting is two settings.
CODE_FORMAT_FIELDS = {
    "asset_format": "codes.asset_format",
    "consumable_format": "codes.consumable_format",
    "serial_format": "codes.serial_format",
    "new_flag": "codes.new_flag",
    "legacy_flag": "codes.legacy_flag",
    "legacy_before": "codes.legacy_before",
}


async def get_code_formats(db: AsyncSession) -> CodeFormatSettings:
    """The configured formula, falling back to the shipped default per field."""
    defaults = CodeFormatSettings().model_dump()
    values = {}
    for field, key in CODE_FORMAT_FIELDS.items():
        raw = await get_setting(db, key)
        # An empty string is a real answer for legacy_before ("nothing is old yet"),
        # but for a template it means "never set", so the default stands.
        values[field] = defaults[field] if raw is None else raw
    return CodeFormatSettings(**values)


async def update_code_formats(db: AsyncSession, data: CodeFormatSettings,
                              user) -> CodeFormatSettings:
    """Save the formula. Audited like every other state change — "who changed the
    asset code shape, and to what" is the first question asked when labels change."""
    before = (await get_code_formats(db)).model_dump()
    for field, key in CODE_FORMAT_FIELDS.items():
        await set_setting(db, key, getattr(data, field), "string", "codes")
    after = (await get_code_formats(db)).model_dump()
    await write_audit(
        db, entity="sys_settings", entity_id=0, action=AuditAction.UPDATE,
        actor=user, before=before, after=after,
        summary="Asset / consumable code formula updated",
    )
    await db.commit()
    return await get_code_formats(db)


async def get_setting(db: AsyncSession, key: str, default: str | None = None) -> str | None:
    row = (await db.execute(select(Setting).where(Setting.setting_key == key))).scalar_one_or_none()
    return row.setting_value if row else default


async def set_setting(db: AsyncSession, key: str, value, value_type: str = "string",
                      category: str | None = None) -> None:
    row = (await db.execute(select(Setting).where(Setting.setting_key == key))).scalar_one_or_none()
    if row:
        row.setting_value = str(value)
    else:
        db.add(Setting(setting_key=key, setting_value=str(value), value_type=value_type,
                       category=category, is_editable=True))
    await db.commit()


def _decode(value: str | None, value_type: str):
    if value is None:
        return None
    if value_type == "bool":
        return value.lower() == "true"
    if value_type == "int":
        return int(value) if value != "" else None
    if value_type == "json":
        return json.loads(value or "null")
    return value


def _encode(value, value_type: str) -> str:
    if value_type == "bool":
        return "true" if bool(value) else "false"
    if value_type == "json":
        return json.dumps(value)
    return "" if value is None else str(value)


async def get_app_settings(db: AsyncSession) -> SettingsOut:
    settings = SettingsOut()
    for group, (model, fields) in SETTINGS_SPEC.items():
        defaults = getattr(settings, group).model_dump()
        values = {}
        for field, (key, value_type) in fields.items():
            raw = await get_setting(db, key)
            values[field] = defaults[field] if raw is None else _decode(raw, value_type)
        setattr(settings, group, model(**values))
    return settings


async def get_company_letterhead(db: AsyncSession) -> CompanySettings:
    """The company block alone, for the print templates every module renders."""
    return (await get_app_settings(db)).company


async def update_app_settings(db: AsyncSession, data: SettingsIn, user) -> SettingsOut:
    before = (await get_app_settings(db)).model_dump()
    for group, (_model, fields) in SETTINGS_SPEC.items():
        values = getattr(data, group).model_dump()
        for field, (key, value_type) in fields.items():
            await set_setting(
                db, key, _encode(values[field], value_type),
                value_type=value_type, category=group,
            )
    after = (await get_app_settings(db)).model_dump()
    await write_audit(
        db, entity="sys_settings", entity_id=0, action=AuditAction.UPDATE,
        actor=user, before=before, after=after, summary="System settings updated",
    )
    await db.commit()
    await load_unit_limits(db)
    return await get_app_settings(db)


async def load_unit_limits(db: AsyncSession) -> None:
    """Push the warehouse unit caps into shared.limits for this process."""
    from app.shared.limits import set_runtime_limits
    wh = (await get_app_settings(db)).warehouse
    set_runtime_limits(
        max_serials_per_line=wh.max_serials_per_line,
        max_serials_per_request=wh.max_serials_per_request,
        max_units_per_code_mint=wh.max_units_per_code_mint,
    )


async def get_hcm_schedule(db: AsyncSession) -> tuple[bool, int]:
    enabled = (await get_setting(db, HCM_ENABLED_KEY, "false")).lower() == "true"
    interval = int(await get_setting(db, HCM_INTERVAL_KEY, str(DEFAULT_INTERVAL)))
    return enabled, interval


async def set_hcm_schedule(db: AsyncSession, enabled: bool, interval_minutes: int) -> None:
    await set_setting(db, HCM_ENABLED_KEY, "true" if enabled else "false", "bool", "hcm")
    await set_setting(db, HCM_INTERVAL_KEY, int(interval_minutes), "int", "hcm")


# --------------------------------------------------------------------------- #
#  Audit log
# --------------------------------------------------------------------------- #
def audit_safe(value):
    """Coerce a value into something `json.dumps` can write.

    `sys_audit_log.changed_fields` is a JSON column, so anything a caller puts in a
    before/after dict is serialised by the driver — and a `date`, a `time` or a
    `Decimal` raises TypeError there, which fails the whole INSERT and therefore the
    caller's own write. A storekeeper saving a monthly-indent reminder got "something
    went wrong on our side" because the reminder's `trigger_time` is a `datetime.time`.

    Coercing HERE rather than in each caller is the point: every module hand-coercing
    its own snapshot is how the one that forgot went unnoticed until the save 500'd.
    Values that are already JSON-native pass through untouched, so no existing caller
    changes shape. Dates/times become ISO strings and Decimals become floats, matching
    what `indents` had already been doing by hand.
    """
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Enum):
        return audit_safe(value.value)
    if isinstance(value, Decimal):
        return float(value)
    # datetime is a subclass of date, so one branch covers date/datetime/time.
    if isinstance(value, (date, time)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): audit_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [audit_safe(v) for v in value]
    return str(value)


def diff_fields(before: dict | None, after: dict | None) -> dict | None:
    """{"field": {"from": old, "to": new}} for the fields that actually differ.

    A full row on both sides would make the log a second copy of every table and bury
    the one field that changed. Returns None when nothing changed.
    """
    if before and after:
        changed = {k: {"from": before.get(k), "to": after.get(k)}
                   for k in after if before.get(k) != after.get(k)}
        return changed or None
    if after:
        return {k: {"from": None, "to": v} for k, v in after.items()}
    if before:
        return {k: {"from": v, "to": None} for k, v in before.items()}
    return None


async def write_audit(db: AsyncSession, *, entity: str, action: AuditAction,
                      entity_id: int | None = None, actor=None,
                      before: dict | None = None, after: dict | None = None,
                      summary: str | None = None, entity_no: str | None = None,
                      ip_address: str | None = None) -> None:
    """Append one audit row. Never commits — it joins the caller's transaction, so an
    action that rolls back cannot leave a log entry claiming it happened."""
    changed = diff_fields(audit_safe(before), audit_safe(after))
    if action == AuditAction.UPDATE and changed is None:
        return   # a PUT that changed nothing is not an event worth recording
    client = get_client_info()

    db.add(AuditLog(
        entity_type=entity,
        # entity_id is NOT NULL in the live table; 0 stands for "not a row-level event".
        entity_id=entity_id if entity_id is not None else 0,
        entity_no=entity_no or summary,
        action=action.value if isinstance(action, AuditAction) else str(action),
        changed_fields=changed,
        actor_id=getattr(actor, "id", None),
        actor_name=getattr(actor, "full_name", None),
        # An explicit argument wins; otherwise the address the middleware captured for
        # this request. Almost every caller passes nothing, which is why the column was
        # NULL on every row ever written.
        # An explicit argument wins; otherwise what the middleware captured for this
        # request. Almost every caller passes nothing, which is why these columns were
        # empty on every row ever written.
        ip_address=ip_address or client.get("ip_address"),
        location=client.get("location"),
        device_type=client.get("device_type"),
        browser=client.get("browser"),
        os=client.get("os"),
        user_agent=client.get("user_agent"),
    ))
    await db.flush()


async def list_audit(db: AsyncSession, params: PageParams, entity: str | None = None,
                     entity_id: int | None = None, actor_id: int | None = None,
                     action: str | None = None, search: str | None = None) -> dict:
    stmt = select(AuditLog)
    if entity:
        stmt = stmt.where(AuditLog.entity_type == entity)
    if entity_id is not None:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    if actor_id is not None:
        stmt = stmt.where(AuditLog.actor_id == actor_id)
    if action:
        stmt = stmt.where(AuditLog.action == action)
    if search and search.strip():
        # The three things anyone types into an audit log: a person, a document
        # number, or the table they are chasing.
        like = f"%{search.strip()}%"
        stmt = stmt.where(or_(
            AuditLog.actor_name.ilike(like),
            AuditLog.entity_no.ilike(like),
            AuditLog.entity_type.ilike(like),
        ))

    page = await paginate(db, stmt.order_by(desc(AuditLog.created_at)), params)
    page["items"] = [{
        "id": r.id, "entity": r.entity_type, "entity_id": r.entity_id,
        "entity_no": r.entity_no, "action": r.action, "actor_id": r.actor_id,
        "actor_name": r.actor_name, "changed_fields": r.changed_fields,
        # Already on the row and never served. It is the only "where from" this log
        # actually holds — no geo lookup, no third-party call, just what the request
        # arrived with — so the screen shows it and says nothing it cannot prove.
        "ip_address": r.ip_address, "location": r.location,
        "device_type": r.device_type, "browser": r.browser, "os": r.os,
        "at": r.created_at.isoformat() if r.created_at else None,
    } for r in page["items"]]
    return page
