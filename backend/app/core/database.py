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
        pool_size=20,        # for 1k+ concurrent users
        max_overflow=10,
        pool_pre_ping=True,
        echo=False,
    )

SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db():
    async with SessionLocal() as session:
        yield session
