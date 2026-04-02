from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class SegmentConfig(BaseModel):
    structures: list[str] = Field(min_length=1)
    modality: str = Field(default="CT")
    fast_mode: bool = True
    anonymized_id: str = Field(min_length=1)


class SegmentReport(BaseModel):
    case_id: str
    generated_structures: list[str]
    models_used: list[str]
    processing_seconds: float
    warnings: list[str] = Field(default_factory=list)


class StatusResponse(BaseModel):
    status: str
    message: str
    current_case_id: Optional[str] = None
    requested_structures: list[str] = Field(default_factory=list)
    generated_structures: list[str] = Field(default_factory=list)
    preview_ready: bool = False
    preview_structures: list[str] = Field(default_factory=list)
    active_model: Optional[str] = None
    phase: str = "idle"
    progress_percent: int = 0
    last_error: Optional[str] = None
    model_statuses: dict[str, str] = Field(default_factory=dict)
    updated_at: str
