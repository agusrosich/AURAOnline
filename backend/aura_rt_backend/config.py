from __future__ import annotations

import os


def _split_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


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
        self.cors_origins = _split_csv(
            os.environ.get(
                "AURA_RT_CORS_ORIGINS",
                "http://localhost:5173,http://127.0.0.1:5173",
            )
        )


settings = BackendSettings()
