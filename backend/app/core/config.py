"""Reads .env only. No business rules, no hardcoded secrets/URLs.

Required values (DATABASE_URL, SECRET_KEY, HCM_*) have NO defaults — they must come
from backend/.env (see .env.example). Missing them fails fast at startup rather than
silently running on a baked-in value.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # --- Database (MySQL only) — required ---
    DATABASE_URL: str
    # Optional: point the test suite at a MySQL the developer can CREATE DATABASE on.
    # The shared server's SCM account cannot, so without this the 100+ DB-backed tests
    # skip and the reservation maths goes unverified. Read here rather than straight
    # from os.environ so it can live in .env like every other setting.
    TEST_DATABASE_URL: str | None = None

    # --- Auth — required ---
    SECRET_KEY: str
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480
    # Demo seeds create mock HCM identities and local credentials. Production must
    # opt in explicitly rather than accepting demo access by accident.
    ALLOW_DEMO_DATA: bool = False
    # The password an employee arriving from an HCM sync gets, so a new joiner can log
    # in without an admin issuing one by hand. Unset means no login is created — every
    # account it makes shares one password, which is fine for a test org and is not
    # something to fall back into silently anywhere else. Never a literal in code
    # (rule 13); it comes from .env or it does not happen.
    NEW_USER_DEFAULT_PASSWORD: str | None = None

    # --- CORS (comma-separated) ---
    CORS_ORIGINS: str = "http://localhost:5173"
    # Let any machine on the local network reach the API, for demos and phone testing.
    # A regex over the private ranges rather than "*": the API sends credentials, and
    # browsers reject a wildcard origin when they are present. Off unless set, so
    # nothing is exposed by accident.
    CORS_ALLOW_PRIVATE_NETWORK: bool = False

    # --- HCM integration — required (base URL + key from env) ---
    HCM_BASE_URL: str
    HCM_API_KEY: str
    HCM_TIMEOUT_SECONDS: float = 5.0
    HCM_RETRIES: int = 3

    # --- Mail (SMTP out, IMAP in) — all OPTIONAL, all from .env (rule 13) ---
    #
    # Optional on purpose: an unconfigured mailbox must leave the app exactly as it is
    # today. `mail_configured` below is the single switch every caller reads — with it
    # false, the Mail screen says so, "forgot password" still answers 204 (so it never
    # becomes an account-enumeration oracle), and nothing raises.
    MAIL_SMTP_HOST: str | None = None
    MAIL_SMTP_PORT: int = 587
    MAIL_USERNAME: str | None = None
    MAIL_PASSWORD: str | None = None
    #: What recipients see in From. Defaults to the login when unset.
    MAIL_FROM: str | None = None
    MAIL_FROM_NAME: str = "SCM ERP"
    #: STARTTLS on 587 (the default). Set false only for a host that wants implicit
    #: TLS on 465, which `MAIL_SMTP_SSL` covers instead.
    MAIL_STARTTLS: bool = True
    MAIL_SMTP_SSL: bool = False
    MAIL_TIMEOUT_SECONDS: float = 20.0

    #: Reading the mailbox is a SEPARATE capability from sending to it — a host may
    #: offer SMTP and no IMAP, and the Inbox tab degrades to a notice rather than an
    #: error when this is unset.
    MAIL_IMAP_HOST: str | None = None
    MAIL_IMAP_PORT: int = 993
    MAIL_IMAP_SSL: bool = True
    #: Falls back to the SMTP credentials, which is the usual case for one mailbox.
    MAIL_IMAP_USERNAME: str | None = None
    MAIL_IMAP_PASSWORD: str | None = None

    # --- Password reset ---
    #: Where the reset link points. The FRONTEND origin, not the API's — the link is
    #: opened by a person in a browser. Never a literal in code.
    APP_BASE_URL: str = "http://localhost:5173"
    #: How long a reset link lives. Short on purpose: it is a bearer secret in an
    #: inbox, and a long window is the whole risk of the feature.
    PASSWORD_RESET_MINUTES: int = 30

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def mail_configured(self) -> bool:
        """Can this deployment SEND mail? One switch, read everywhere.

        Every mail feature branches on this rather than on the individual keys, so
        "the mailbox is not set up" is one answer in one place instead of four
        different failures in four screens.
        """
        return bool(self.MAIL_SMTP_HOST and self.MAIL_USERNAME and self.MAIL_PASSWORD)

    @property
    def imap_configured(self) -> bool:
        """Can this deployment READ the mailbox? Separate from sending — a host may
        offer one and not the other, and the Inbox is the only thing that needs it."""
        return bool(
            self.MAIL_IMAP_HOST
            and (self.MAIL_IMAP_USERNAME or self.MAIL_USERNAME)
            and (self.MAIL_IMAP_PASSWORD or self.MAIL_PASSWORD)
        )

    @property
    def mail_from_address(self) -> str:
        return self.MAIL_FROM or self.MAIL_USERNAME or ""

    @property
    def imap_username(self) -> str:
        return self.MAIL_IMAP_USERNAME or self.MAIL_USERNAME or ""

    @property
    def imap_password(self) -> str:
        return self.MAIL_IMAP_PASSWORD or self.MAIL_PASSWORD or ""

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def cors_origin_regex(self) -> str | None:
        """Matches http(s)://<private-ip-or-hostname>[:port] on 10/x, 172.16-31/x,
        192.168/x and localhost. Returns None when the flag is off."""
        if not self.CORS_ALLOW_PRIVATE_NETWORK:
            return None
        host = (r"(localhost|127\.0\.0\.1|\[::1\]"
                r"|10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
                r"|192\.168\.\d{1,3}\.\d{1,3}"
                r"|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})")
        return rf"^https?://{host}(:\d+)?$"


settings = Settings()
