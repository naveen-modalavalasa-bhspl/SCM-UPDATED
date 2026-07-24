"""Shared pytest fixtures. Tests run on a dedicated MySQL database (scm_erp_test),
created from the same credentials as the app (.env). Each test gets a freshly
created schema (drop_all + create_all) for isolation. No SQLite anywhere.
"""
import re

import pymysql
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

import app.all_models  # noqa: F401  (registers every table on Base.metadata)
from app.core.config import settings
from app.core.database import Base, get_db
from app.core.security import hash_password
from app.platform.hcm.models import HcmEmployee
from app.platform.rbac.models import Permission, Role, RolePermission, UserRole
from app.platform.settings.models import UserCredential
from app.shared.models.base import utcnow

_DSN_RE = re.compile(r"mysql\+aiomysql://([^:]+):([^@]*)@([^:/]+):(\d+)/(.+)")


def _parts():
    m = _DSN_RE.match(settings.DATABASE_URL)
    if not m:
        raise RuntimeError("DATABASE_URL must be mysql+aiomysql://... to run tests")
    user, pw, host, port, db = m.groups()
    return user, pw, host, int(port), db


def _test_dsn() -> str:
    user, pw, host, port, db = _parts()
    return f"mysql+aiomysql://{user}:{pw}@{host}:{port}/{db}_test"


def _ensure_test_db() -> None:
    user, pw, host, port, db = _parts()
    conn = pymysql.connect(host=host, port=port, user=user, password=pw)
    try:
        conn.cursor().execute(f"CREATE DATABASE IF NOT EXISTS {db}_test CHARACTER SET utf8mb4")
        conn.commit()
    finally:
        conn.close()


_ensure_test_db()


@pytest_asyncio.fixture
async def engine():
    eng = create_async_engine(_test_dsn(), poolclass=NullPool)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await eng.dispose()


@pytest_asyncio.fixture
async def session_factory(engine):
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


@pytest_asyncio.fixture
async def db(session_factory) -> AsyncSession:
    async with session_factory() as s:
        yield s


@pytest_asyncio.fixture
async def client(session_factory):
    from app.main import app

    async def _override_get_db():
        async with session_factory() as s:
            yield s

    app.dependency_overrides[get_db] = _override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
def make_user(db):
    """Factory: create an HCM employee + local credential + a role holding the given
    permission codes. Returns the HcmEmployee."""
    async def _make(employee_id=1, username="user", password="pw",
                    full_name="Test User", permissions=()):
        db.add(HcmEmployee(id=employee_id, full_name=full_name,
                           emp_code=f"E{employee_id}", is_active=True, synced_at=utcnow()))
        db.add(UserCredential(employee_id=employee_id, username=username,
                              password_hash=hash_password(password)))
        role = Role(code=f"R_{username}", name=username, is_active=True)
        db.add(role)
        await db.flush()
        db.add(UserRole(employee_id=employee_id, role_id=role.id))
        for code in permissions:
            perm = (await db.execute(
                select(Permission).where(Permission.code == code)
            )).scalar_one_or_none()
            if perm is None:
                perm = Permission(code=code)
                db.add(perm)
                await db.flush()
            db.add(RolePermission(role_id=role.id, permission_id=perm.id))
        await db.commit()
        return await db.get(HcmEmployee, employee_id)
    return _make


@pytest_asyncio.fixture
def login(client):
    """Log in and return an Authorization header dict."""
    async def _login(username="user", password="pw"):
        r = await client.post("/api/auth/login",
                              data={"username": username, "password": password})
        assert r.status_code == 200, r.text
        return {"Authorization": f"Bearer {r.json()['access_token']}"}
    return _login
