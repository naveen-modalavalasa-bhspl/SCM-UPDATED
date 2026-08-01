"""DB engine + session + Base. No table definitions here."""
from sqlalchemy import event
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings

_is_sqlite = settings.DATABASE_URL.startswith("sqlite")

# The one collation the whole schema uses. Migration f9b0c1d2e3f4 converged
# every table on it; keep the two in step.
DB_COLLATION = "utf8mb4_unicode_ci"


class Base(DeclarativeBase):
    pass


# MySQL (prod) gets a real pool; SQLite (local/test) does not accept pool sizing.
if _is_sqlite:
    engine = create_async_engine(settings.DATABASE_URL, echo=False)
else:
    engine = create_async_engine(
        settings.DATABASE_URL,
        # The shared MySQL caps out at max_connections=151 and every developer
        # points their own uvicorn at it. At 20+10 a handful of running servers
        # exhausts the server and every query dies with "Too many connections"
        # (error 1040) — which surfaces as blank screens, not as an error.
        # 5+5 keeps one server well inside its share; raise it only on a box
        # that owns its database.
        pool_size=5,
        max_overflow=5,
        pool_pre_ping=True,
        pool_recycle=1800,   # drop connections before the server's wait_timeout does
        pool_timeout=30,
        echo=False,
    )

    # Every table is utf8mb4_unicode_ci (migration f9b0c1d2e3f4) but the server
    # default is utf8mb4_0900_ai_ci, so a fresh connection talks 0900_ai_ci.
    # CAST(:param AS CHAR) then lands at the same coercibility as a real column
    # with a different collation and MySQL refuses the query with 1271 "Illegal
    # mix of collations" — which is what broke the indent activity ledger's
    # UNION. aiomysql's own handshake overrides connect_args=init_command, so
    # set it here, after the connection is fully established.
    @event.listens_for(engine.sync_engine, "connect")
    def _pin_connection_collation(dbapi_connection, _record):
        cursor = dbapi_connection.cursor()
        cursor.execute(f"SET NAMES utf8mb4 COLLATE {DB_COLLATION}")
        cursor.close()

SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db():
    async with SessionLocal() as session:
        yield session
