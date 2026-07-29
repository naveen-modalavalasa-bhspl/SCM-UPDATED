"""DB engine + session + Base. No table definitions here."""
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings

_is_sqlite = settings.DATABASE_URL.startswith("sqlite")


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

SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db():
    async with SessionLocal() as session:
        yield session
