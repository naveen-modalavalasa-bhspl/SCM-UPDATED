"""Shared pytest fixtures. Tests run on a dedicated MySQL database (scm_erp_test),
created from the same credentials as the app (.env). Each test gets a freshly
created schema (drop_all + create_all) for isolation. No SQLite anywhere.
"""
import os
import re
from urllib.parse import quote, unquote

import pymysql
import pytest
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


def _source_url() -> str:
    """TEST_DATABASE_URL wins so the suite can point at a local MySQL. The app's
    DATABASE_URL may name a shared server whose account cannot CREATE DATABASE, or
    which only accepts connections from whitelisted hosts.

    Checked in os.environ first (a one-off override on the command line), then in
    settings, which is what actually reads .env — putting it only in .env and reading
    only os.getenv silently did nothing, and every DB test kept skipping.
    """
    return (os.getenv("TEST_DATABASE_URL")
            or settings.TEST_DATABASE_URL
            or settings.DATABASE_URL)


def _parts():
    m = _DSN_RE.match(_source_url())
    if not m:
        raise RuntimeError(
            "DATABASE_URL (or TEST_DATABASE_URL) must be mysql+aiomysql://... to run tests")
    user, pw, host, port, db = m.groups()
    # pw arrives percent-encoded from the URL (# -> %23). SQLAlchemy decodes it when it
    # parses the DSN, but pymysql is handed the value directly and needs it raw.
    return unquote(user), unquote(pw), host, int(port), db


def _test_dsn() -> str:
    """_parts() hands back a decoded password for pymysql; SQLAlchemy parses a URL,
    so it has to go back in percent-encoded or a '#' truncates the DSN."""
    user, pw, host, port, db = _parts()
    suffix = "" if db.endswith("_test") else "_test"
    return (f"mysql+aiomysql://{quote(user, safe='')}:{quote(pw, safe='')}"
            f"@{host}:{port}/{db}{suffix}")


def _ensure_test_db() -> str | None:
    """Returns None on success, or a human-readable reason the suite cannot run.

    Raising here would surface as a bare ImportError on conftest, which hides the
    actual cause (no MySQL, wrong credentials, host not whitelisted).
    """
    try:
        user, pw, host, port, db = _parts()
    except RuntimeError as exc:
        return str(exc)
    if db.endswith("_test"):
        return None    # caller pointed us straight at a database they already made
    try:
        conn = pymysql.connect(host=host, port=port, user=user, password=pw,
                               connect_timeout=10)
    except Exception as exc:
        return (f"cannot reach MySQL at {host}:{port} as {user!r} ({exc}). "
                f"Set TEST_DATABASE_URL to a MySQL you can create databases on.")
    try:
        conn.cursor().execute(
            f"CREATE DATABASE IF NOT EXISTS {db}_test CHARACTER SET utf8mb4")
        conn.commit()
    except Exception as exc:
        return (f"{user!r} cannot CREATE DATABASE {db}_test ({exc}). "
                f"Set TEST_DATABASE_URL, or have the DBA create it and grant access.")
    finally:
        conn.close()
    return None


_SKIP_REASON = _ensure_test_db()


DB_FIXTURES = {"engine", "session_factory", "db", "client", "make_user", "login"}


def pytest_collection_modifyitems(config, items):
    """Skip loudly rather than erroring out of conftest, so `pytest -q` still reports
    which tests exist and exactly why they did not run.

    Only tests that actually ask for a database fixture are skipped; pure-logic tests
    (operators, conflict overlap, numbering periods) still run and still catch
    regressions on a machine with no MySQL.
    """
    if not _SKIP_REASON:
        return
    marker = pytest.mark.skip(reason=f"No test database: {_SKIP_REASON}")
    for item in items:
        if DB_FIXTURES & set(getattr(item, "fixturenames", ())):
            item.add_marker(marker)


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
        # sys_local_credentials has no username column: login matches emp_code or
        # email (see auth/service.authenticate), so the login name IS the emp_code.
        db.add(HcmEmployee(id=employee_id, full_name=full_name,
                           emp_code=username, is_active=True, synced_at=utcnow()))
        db.add(UserCredential(employee_id=employee_id,
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
                # module/resource/action are NOT NULL. Derive them from the code
                # ("indent.view" -> indents/indent/view) rather than passing None,
                # which sends an explicit NULL and raises 1048.
                head, _, tail = code.partition(".")
                perm = Permission(code=code, module=head, resource=head,
                                  action=tail or "view", description=code)
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
