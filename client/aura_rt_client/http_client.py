from __future__ import annotations

from pathlib import Path
from typing import Callable, Optional

import requests


class HttpClientError(RuntimeError):
    pass


class SegmentationHttpClient:
    def __init__(self) -> None:
        self._session = requests.Session()

    def close(self) -> None:
        self._session.close()
        self._session = requests.Session()

    def _build_url(self, base_url: str, endpoint: str) -> str:
        return f"{base_url.rstrip('/')}/{endpoint.lstrip('/')}"

    def health_check(self, base_url: str) -> dict[str, object]:
        response = self._session.get(self._build_url(base_url, "/health"), timeout=10)
        response.raise_for_status()
        return response.json()

    def get_status(self, base_url: str) -> dict[str, object]:
        response = self._session.get(self._build_url(base_url, "/status"), timeout=10)
        response.raise_for_status()
        return response.json()

    def submit_segmentation(
        self,
        base_url: str,
        archive_path: Path,
        destination_path: Path,
        *,
        timeout_seconds: int = 600,
        cancel_check: Optional[Callable[[], bool]] = None,
    ) -> Path:
        destination_path.parent.mkdir(parents=True, exist_ok=True)
        with archive_path.open("rb") as input_file:
            files = {"file": (archive_path.name, input_file, "application/zip")}
            response = self._session.post(
                self._build_url(base_url, "/segment"),
                files=files,
                timeout=timeout_seconds,
                stream=True,
            )

            if not response.ok:
                detail = response.text.strip() or f"HTTP {response.status_code}"
                raise HttpClientError(detail)

            with destination_path.open("wb") as output_file:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if cancel_check and cancel_check():
                        self.close()
                        raise HttpClientError("Procesamiento cancelado por el usuario.")
                    if chunk:
                        output_file.write(chunk)
        return destination_path
