"""sys_settings key-value helpers + the HCM sync schedule (canonical schema)."""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.settings.models import Setting

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
