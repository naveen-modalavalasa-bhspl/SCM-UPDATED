"""sys_settings key-value helpers, the HCM sync schedule, and the audit log."""
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.pagination import PageParams, paginate
from app.platform.settings.models import AuditLog, Setting
from app.shared.enums import AuditAction

HCM_ENABLED_KEY = "hcm_sync_enabled"
HCM_INTERVAL_KEY = "hcm_sync_interval_minutes"
DEFAULT_INTERVAL = 1440  # daily


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
    changed = diff_fields(before, after)
    if action == AuditAction.UPDATE and changed is None:
        return   # a PUT that changed nothing is not an event worth recording

    db.add(AuditLog(
        entity_type=entity,
        # entity_id is NOT NULL in the live table; 0 stands for "not a row-level event".
        entity_id=entity_id if entity_id is not None else 0,
        entity_no=entity_no or summary,
        action=action.value if isinstance(action, AuditAction) else str(action),
        changed_fields=changed,
        actor_id=getattr(actor, "id", None),
        actor_name=getattr(actor, "full_name", None),
        ip_address=ip_address,
    ))
    await db.flush()


async def list_audit(db: AsyncSession, params: PageParams, entity: str | None = None,
                     entity_id: int | None = None, actor_id: int | None = None,
                     action: str | None = None) -> dict:
    stmt = select(AuditLog)
    if entity:
        stmt = stmt.where(AuditLog.entity_type == entity)
    if entity_id is not None:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    if actor_id is not None:
        stmt = stmt.where(AuditLog.actor_id == actor_id)
    if action:
        stmt = stmt.where(AuditLog.action == action)

    page = await paginate(db, stmt.order_by(desc(AuditLog.created_at)), params)
    page["items"] = [{
        "id": r.id, "entity": r.entity_type, "entity_id": r.entity_id,
        "entity_no": r.entity_no, "action": r.action, "actor_id": r.actor_id,
        "actor_name": r.actor_name, "changed_fields": r.changed_fields,
        "at": r.created_at.isoformat() if r.created_at else None,
    } for r in page["items"]]
    return page
