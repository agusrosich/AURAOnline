from __future__ import annotations

from datetime import datetime, timezone
from threading import Lock
from typing import Optional

from .schemas import StatusResponse


class StatusTracker:
    def __init__(self) -> None:
        self._lock = Lock()
        self._state: dict[str, object] = {
            "status": "idle",
            "message": "Servicio listo",
            "current_case_id": None,
            "requested_structures": [],
            "generated_structures": [],
            "active_model": None,
            "phase": "idle",
            "progress_percent": 0,
            "last_error": None,
            "model_statuses": {},
            "updated_at": self._timestamp(),
        }

    def _timestamp(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def set_model_status(self, model_key: str, status: str) -> None:
        with self._lock:
            model_statuses = dict(self._state.get("model_statuses", {}))
            model_statuses[model_key] = status
            self._state["model_statuses"] = model_statuses
            self._state["updated_at"] = self._timestamp()

    def begin_case(self, case_id: str, structures: list[str]) -> None:
        with self._lock:
            self._state.update(
                {
                    "status": "processing",
                    "message": "Caso recibido",
                    "current_case_id": case_id,
                    "requested_structures": structures,
                    "generated_structures": [],
                    "active_model": None,
                    "phase": "received",
                    "progress_percent": 5,
                    "last_error": None,
                    "updated_at": self._timestamp(),
                }
            )

    def update(
        self,
        *,
        status: Optional[str] = None,
        message: Optional[str] = None,
        generated_structures: Optional[list[str]] = None,
        active_model: Optional[str] = None,
        phase: Optional[str] = None,
        progress_percent: Optional[int] = None,
        last_error: Optional[str] = None,
    ) -> None:
        with self._lock:
            if status is not None:
                self._state["status"] = status
            if message is not None:
                self._state["message"] = message
            if generated_structures is not None:
                self._state["generated_structures"] = generated_structures
            if active_model is not None:
                self._state["active_model"] = active_model
            if phase is not None:
                self._state["phase"] = phase
            if progress_percent is not None:
                bounded = max(0, min(100, progress_percent))
                self._state["progress_percent"] = bounded
            if last_error is not None:
                self._state["last_error"] = last_error
            self._state["updated_at"] = self._timestamp()

    def complete(self, generated_structures: list[str]) -> None:
        self.update(
            status="completed",
            message="Procesamiento completado",
            generated_structures=generated_structures,
            active_model=None,
            phase="completed",
            progress_percent=100,
            last_error=None,
        )

    def fail(self, message: str) -> None:
        self.update(
            status="failed",
            message=message,
            active_model=None,
            phase="failed",
            last_error=message,
        )

    def snapshot(self) -> StatusResponse:
        with self._lock:
            return StatusResponse.model_validate(self._state)
