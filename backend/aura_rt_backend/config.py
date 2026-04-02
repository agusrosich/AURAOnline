from __future__ import annotations

import os


def _split_csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def _normalize_cors_origins(value: str | None) -> tuple[bool, list[str]]:
    origins = _split_csv(value)
    if not origins or "*" in origins:
        return True, ["*"]
    return False, origins


class BackendSettings:
    def __init__(self) -> None:
        self.app_title = os.environ.get(
            "AURA_RT_APP_TITLE",
            "AURA-RT Segmentation Backend",
        )
        self.app_version = os.environ.get("AURA_RT_APP_VERSION", "0.2.0")
        self.host = os.environ.get("AURA_RT_HOST", "0.0.0.0")
        self.port = int(os.environ.get("AURA_RT_PORT", "8000"))
        self.log_level = os.environ.get("AURA_RT_LOG_LEVEL", "INFO").upper()
        self.cors_allow_all, self.cors_origins = _normalize_cors_origins(
            os.environ.get("AURA_RT_CORS_ORIGINS", "*")
        )


settings = BackendSettings()
