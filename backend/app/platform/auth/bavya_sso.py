"""Bavya SSO: the Director signs in from a one-time pass that bhsdb.in signs.

Spec: director/docs/superpowers/specs/2026-10-15-director-sso-design.md, sections 4, 6
(fragment delivery), 9 and 10.

bhsdb.in opens https://scm.bhspl.in/#bavya_ticket=<pass>. The browser takes the pass
out of the address before the router mounts (`frontend/src/shared/auth/bavyaSso.ts`)
and posts it to POST /api/auth/bavya-sso as {"ticket": "..."}. The answer is exactly
what POST /api/auth/login answers: the same access token, minted by the same
`service.issue_token`, after the same account rules (`find_login_employee`,
`is_locked`) and the same side effects (`record_sign_in`). Everything after it is the
ordinary signed-in path.

The pass is a compact JWT signed with Ed25519: `alg` exactly EdDSA, `kid` the first
16 hex characters of SHA-256 of the raw public key. Claims: `iss` https://bhsdb.in,
`aud` "scm", `sub` the account's sign-in name (employee code, id or email — whatever
the login form takes), `iat`, `exp` = iat + 60 and `jti`. 30 seconds of clock skew are
allowed either way. The `jti` goes into `bavya_sso_used`, in this app's own database,
whose primary key makes a second use fail atomically across every worker and replica.

Off until BAVYA_SSO_PUBLIC_KEY is set: the route answers 404, so deploying the code
before the config changes nothing. The pass itself is never logged or echoed.
"""
import hashlib
import logging
import re
import textwrap
import time

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.config import settings
from app.core.exceptions import AppException, AuthenticationError
from app.platform.auth import service as auth_service
from app.platform.settings import service as settings_service
from app.platform.settings.models import UserCredential
from app.shared.enums import AuditAction

log = logging.getLogger("app.bavya_sso")

#: What every refused pass says: bad, expired, already used, or for another app.
EXPIRED = "This sign-in link has expired. Open the app again from bhsdb.in."
#: What a good pass says when this app has no active, unlocked account by its name.
NO_ACCOUNT = "No active account for you in this app. Ask the admin."

SKEW_SECONDS = 30
#: bhsdb.in signs passes for 60 s; 90 leaves room for its own rounding and no more.
MAX_PASS_SECONDS = 90
TABLE = "bavya_sso_used"
#: Longer than any real pass (about 300 characters); anything bigger is not one.
MAX_TICKET = 4096

# ascii_bin, not the schema's utf8mb4_unicode_ci: a pass id is base64url, where "Ab"
# and "aB" are different passes, and a case-insensitive key would call one a reuse of
# the other. NOT in the ORM metadata on purpose, so no Alembic migration runs for it;
# it is created here, at start-up and again on first use if it ever goes missing.
_DDL = (
    f"CREATE TABLE IF NOT EXISTS {TABLE} ("
    "jti VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY, "
    "exp BIGINT NOT NULL"
    ") ENGINE=InnoDB"
)
_JTI = re.compile(r"[\x21-\x7e]{1,64}")
_PEM_BLOCK = re.compile(r"-----BEGIN PUBLIC KEY-----(.*?)-----END PUBLIC KEY-----", re.S)


class ExpiredPassError(AuthenticationError):
    """401. One sentence for every refused pass; the reason goes to the log only."""
    error_code = "SSO_PASS_REFUSED"
    title = "Sign-in link expired"


class NoAccountError(AppException):
    """403. A good pass for somebody with no active, unlocked account here."""
    status_code = 403
    error_code = "SSO_NO_ACCOUNT"
    title = "No account"


class PassRefused(Exception):
    """Why a pass was refused. A short fixed reason for the log, never shown."""


# --------------------------------------------------------------------------- #
# Keys                                                                         #
# --------------------------------------------------------------------------- #

def kid_for(key: Ed25519PublicKey) -> str:
    raw = key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return hashlib.sha256(raw).hexdigest()[:16]


def load_keys(value: str) -> dict[str, Ed25519PublicKey]:
    """Every Ed25519 public key in BAVYA_SSO_PUBLIC_KEY, by kid.

    The setting is the PEM text or the path of a PEM file. Text may come with real
    newlines, with the two characters \\n (a one-line .env value) or with spaces, so
    each block is rebuilt from its base64 before it is loaded. A block that will not
    load is skipped, so one bad key in a rotation file cannot switch the others off.
    """
    value = (value or "").strip()
    if not value:
        return {}
    if "-----BEGIN" in value:
        pem = value
    else:
        try:
            with open(value, encoding="utf-8") as fh:
                pem = fh.read()
        except OSError as exc:
            log.warning("[bavya-sso] off: cannot read the key file (%s)", type(exc).__name__)
            return {}
    keys: dict[str, Ed25519PublicKey] = {}
    for body in _PEM_BLOCK.findall(pem.replace("\\n", "\n")):
        b64 = re.sub(r"\s+", "", body)
        block = ("-----BEGIN PUBLIC KEY-----\n" + "\n".join(textwrap.wrap(b64, 64))
                 + "\n-----END PUBLIC KEY-----\n")
        try:
            key = serialization.load_pem_public_key(block.encode("ascii"))
        except Exception as exc:
            log.warning("[bavya-sso] skipped a public key that will not load (%s)",
                        type(exc).__name__)
            continue
        if isinstance(key, Ed25519PublicKey):
            keys[kid_for(key)] = key
    if not keys:
        log.warning("[bavya-sso] off: BAVYA_SSO_PUBLIC_KEY holds no Ed25519 public key")
    return keys


_key_cache: tuple[str, dict[str, Ed25519PublicKey]] | None = None


def current_keys() -> dict[str, Ed25519PublicKey]:
    """The configured keys, loaded once per process (and again if the setting changes)."""
    global _key_cache
    value = settings.BAVYA_SSO_PUBLIC_KEY or ""
    if _key_cache is None or _key_cache[0] != value:
        _key_cache = (value, load_keys(value))
    return _key_cache[1]


# --------------------------------------------------------------------------- #
# The pass                                                                     #
# --------------------------------------------------------------------------- #

def verify_pass(token, keys: dict[str, Ed25519PublicKey], *, audience: str,
                issuer: str) -> dict:
    """The pass's claims, or PassRefused. Signature first, then iss/aud/exp/iat."""
    if not isinstance(token, str) or not token or len(token) > MAX_TICKET:
        raise PassRefused("no pass")
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError:
        raise PassRefused("malformed") from None
    # Exactly EdDSA. `none` and the HMAC family are refused here, before any key is
    # chosen, so a pass "signed" with the public key as an HMAC secret goes nowhere.
    if header.get("alg") != "EdDSA":
        raise PassRefused("not EdDSA")
    kid = header.get("kid")
    if not isinstance(kid, str) or kid not in keys:
        raise PassRefused("unknown key id")
    try:
        claims = jwt.decode(
            token, keys[kid], algorithms=["EdDSA"], audience=audience, issuer=issuer,
            leeway=SKEW_SECONDS,
            options={"require": ["iss", "aud", "sub", "iat", "exp", "jti"]},
        )
    except jwt.PyJWTError as exc:
        raise PassRefused(type(exc).__name__) from None
    iat, exp = claims["iat"], claims["exp"]
    # PyJWT accepts "1760000000" or 1.5e9 for these; bhsdb.in issues whole seconds.
    # Checked here, before any arithmetic, so a string can only ever be a refusal.
    # (`type(...) is int` also rules out True/False.)
    if type(iat) is not int or type(exp) is not int:
        raise PassRefused("iat or exp not a whole number")
    # A pass lives 60 s. Anything signed to live longer (or not at all) is refused,
    # whatever its own exp says.
    if not 0 < exp - iat <= MAX_PASS_SECONDS:
        raise PassRefused("lifetime out of range")
    # PyJWT also accepts a list that CONTAINS "scm"; a pass names exactly one app.
    if not isinstance(claims["aud"], str):
        raise PassRefused("aud not a single app")
    if iat - SKEW_SECONDS > time.time():
        raise PassRefused("issued in the future")
    if not isinstance(claims["sub"], str) or not claims["sub"].strip():
        raise PassRefused("no subject")
    if not isinstance(claims["jti"], str) or not _JTI.fullmatch(claims["jti"]):
        raise PassRefused("bad pass id")
    return claims


# --------------------------------------------------------------------------- #
# Single use                                                                   #
# --------------------------------------------------------------------------- #

_table_ready = False


async def _rollback(db: AsyncSession) -> None:
    try:
        await db.rollback()
    except Exception:
        pass


async def ensure_table(db: AsyncSession) -> bool:
    """Create the used-pass table if it is missing. Never raises: while the table
    cannot be created every pass is refused, and the rest of the app is untouched."""
    global _table_ready
    if _table_ready:
        return True
    try:
        await db.execute(text(_DDL))
        await db.commit()
        _table_ready = True
    except Exception as exc:
        await _rollback(db)
        log.warning("[bavya-sso] cannot create %s, every pass is refused until it "
                    "exists: %s", TABLE, type(exc).__name__)
    return _table_ready


async def claim(db: AsyncSession, jti: str, exp: int, *, now: int | None = None) -> bool:
    """True the first time a pass id is seen; False on reuse or on any failure."""
    global _table_ready
    if not await ensure_table(db):
        return False
    now = int(time.time()) if now is None else int(now)
    try:
        # The purge commits on its own. Holding its locks into the INSERT would let two
        # sign-ins at the same instant deadlock each other on a near-empty table.
        await db.execute(text(f"DELETE FROM {TABLE} WHERE exp < :cutoff"),
                         {"cutoff": now - SKEW_SECONDS})
        await db.commit()
        await db.execute(text(f"INSERT INTO {TABLE} (jti, exp) VALUES (:jti, :exp)"),
                         {"jti": jti, "exp": int(exp)})
        await db.commit()
        return True
    except IntegrityError:
        await _rollback(db)
        return False
    except Exception as exc:
        await _rollback(db)
        _table_ready = False  # run the CREATE again next time, in case it was dropped
        log.warning("[bavya-sso] cannot record a pass, so it is refused: %s",
                    type(exc).__name__)
        return False


async def prepare(session_factory) -> bool:
    """Start-up: create the table when SSO is switched on. Never raises."""
    if not current_keys():
        return False
    try:
        async with session_factory() as db:
            return await ensure_table(db)
    except Exception as exc:
        log.warning("[bavya-sso] not prepared at start-up: %s", type(exc).__name__)
        return False


# --------------------------------------------------------------------------- #
# Sign-in                                                                      #
# --------------------------------------------------------------------------- #

async def read_ticket(request) -> str:
    """The `ticket` of a JSON body, or "" for anything else. Read by hand rather than
    through a pydantic model, so a malformed body is a refused pass and never a 422
    that echoes what was sent."""
    try:
        body = await request.json()
    except Exception:
        return ""
    ticket = body.get("ticket") if isinstance(body, dict) else None
    return ticket if isinstance(ticket, str) else ""


async def sign_in(db: AsyncSession, ticket: str) -> str:
    """The access token for the pass's account, exactly as password login mints it."""
    keys = current_keys()
    if not keys:
        raise StarletteHTTPException(status_code=404)
    try:
        claims = verify_pass(ticket, keys, audience=settings.BAVYA_SSO_APP_ID,
                             issuer=settings.BAVYA_SSO_ISSUER)
    except PassRefused as why:
        log.warning("[bavya-sso] refused a pass: %s", why)
        raise ExpiredPassError(EXPIRED) from None
    # Recorded BEFORE the account is looked up: a pass is spent the moment it is
    # presented, whatever the answer.
    if not await claim(db, claims["jti"], claims["exp"]):
        log.warning("[bavya-sso] refused a pass: already used")
        raise ExpiredPassError(EXPIRED)

    name = claims["sub"].strip()
    # Password login's own rules: the same lookup, active, a login row, not locked.
    employee = await auth_service.find_login_employee(db, name)
    cred = (await db.get(UserCredential, employee.id)
            if employee is not None and employee.is_active else None)
    if cred is None or auth_service.is_locked(cred):
        log.warning("[bavya-sso] refused %r: no active account", name[:100])
        raise NoAccountError(NO_ACCOUNT)

    # Password login writes no audit row; a pass does, so the Audit screen shows how
    # the Director came in. It joins the commit inside record_sign_in.
    await settings_service.write_audit(
        db, entity="sys_local_credentials", action=AuditAction.LOGIN,
        entity_id=employee.id, actor=employee,
        entity_no=employee.emp_code or str(employee.id),
        after={"method": "bavya-sso"},
    )
    await auth_service.record_sign_in(db, cred)
    token = await auth_service.issue_token(db, employee)
    log.info("[bavya-sso] sign-in: employee %s (%s)", employee.id, employee.emp_code)
    return token
