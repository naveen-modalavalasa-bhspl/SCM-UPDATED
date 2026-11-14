"""Password hashing + JWT encode/decode. No user-table logic here.

**bcrypt does not belong on the event loop** (2026-09-03). It is CPU-bound by design
— roughly 200–300 ms at the default cost — and a `verify` called straight from an
`async def` stops the ENTIRE application for that long, not just the caller's
request. Ten call sites did it: login, password change, the vendor and carrier
portals, HCM joiner provisioning. Measured ceiling was about four sign-ins per
second, application-wide, which a shift change of 800 people cannot get through.

So there are two of each function. The sync pair is unchanged and is what the seed
scripts and the tests call — they own their process and have nothing to block. Every
caller inside a request handler awaits the `_async` pair instead, which moves the
work to the thread pool exactly as `platform/mail/client.py` does for smtplib. The
names are deliberately different rather than the sync ones being made async: a script
calling an awaitable and never awaiting it writes a coroutine object into
`password_hash` and locks the account out silently.
"""
import asyncio
from datetime import datetime, timedelta, timezone

import bcrypt

# Compatibility patch for passlib with bcrypt >= 4.0.0.
# passlib 1.7.4 reads `bcrypt.__about__.__version__`, which bcrypt 4.0.0 removed.
if not hasattr(bcrypt, "__about__"):
    class _About:
        __version__ = getattr(bcrypt, "__version__", "4.0.0")
    bcrypt.__about__ = _About()

from jose import jwt, JWTError
from passlib.context import CryptContext

from app.core.config import settings
from app.core.exceptions import AuthenticationError

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


async def hash_password_async(password: str) -> str:
    """`hash_password`, off the event loop. Use this in any request path."""
    return await asyncio.to_thread(pwd_context.hash, password)


async def verify_password_async(plain: str, hashed: str) -> bool:
    """`verify_password`, off the event loop. Use this in any request path."""
    return await asyncio.to_thread(pwd_context.verify, plain, hashed)


def create_access_token(subject: str | int, extra: dict | None = None) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(subject),
        "iat": now,
        "exp": now + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        raise AuthenticationError("Invalid or expired token")
