"""Wait for the configured database before running Alembic in a container."""
import asyncio
import logging
import os

from sqlalchemy import text

from app.core.database import engine

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("wait_for_db")


async def main() -> None:
    attempts = int(os.getenv("DB_STARTUP_ATTEMPTS", "30"))
    delay = float(os.getenv("DB_STARTUP_DELAY_SECONDS", "2"))
    last_error: Exception | None = None

    for attempt in range(1, attempts + 1):
        try:
            async with engine.connect() as connection:
                await connection.execute(text("SELECT 1"))
            await engine.dispose()
            log.info("Database is ready")
            return
        except Exception as exc:  # startup boundary: log and retry connectivity
            last_error = exc
            log.warning("Database not ready (%s/%s): %s", attempt, attempts, exc)
            await asyncio.sleep(delay)

    await engine.dispose()
    raise SystemExit(f"Database did not become ready: {last_error}")


if __name__ == "__main__":
    asyncio.run(main())
