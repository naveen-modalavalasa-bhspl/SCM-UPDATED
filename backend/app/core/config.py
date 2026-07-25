"""Reads .env only. No business rules, no hardcoded secrets/URLs.

Required values (DATABASE_URL, SECRET_KEY, HCM_*) have NO defaults — they must come
from backend/.env (see .env.example). Missing them fails fast at startup rather than
silently running on a baked-in value.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # --- Database (MySQL only) — required ---
    DATABASE_URL: str

    # --- Auth — required ---
    SECRET_KEY: str
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480

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

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

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
