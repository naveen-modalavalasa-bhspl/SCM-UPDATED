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

    # --- HCM integration — required (base URL + key from env) ---
    HCM_BASE_URL: str
    HCM_API_KEY: str
    HCM_TIMEOUT_SECONDS: float = 5.0
    HCM_RETRIES: int = 3

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


settings = Settings()
