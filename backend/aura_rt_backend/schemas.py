from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class DicomDestinationConfig(BaseModel):
    """Configuración del nodo DICOM destino para C-STORE.

    Se incluye opcionalmente en el config.json del payload.
    Si está presente, el backend envía CT + RT-STRUCT al SCP
    al finalizar la segmentación.
    """

    ae_title: str = Field(min_length=1, max_length=16)
    """AE Title del SCP destino (ej. 'ARIA_SCP', 'MONACO_STORE')."""

    host: str = Field(min_length=1)
    """Hostname o IP del SCP destino."""

    port: int = Field(default=104, ge=1, le=65535)
    """Puerto DICOM. Default 104."""

    source_ae_title: str = Field(default="AURA_RT", max_length=16)
    """AE Title que usará AURA como SCU."""

    tls: bool = False

    timeout_seconds: int = Field(default=120, ge=10, le=600)


class SegmentConfig(BaseModel):
    structures: list[str] = Field(min_length=1)
    modality: str = Field(default="CT")
    fast_mode: bool = True
    anonymized_id: str = Field(min_length=1)
    dicom_destination: Optional[DicomDestinationConfig] = None
    """Si se especifica, el backend hará C-STORE al finalizar."""


class SegmentReport(BaseModel):
    case_id: str
    generated_structures: list[str]
    models_used: list[str]
    processing_seconds: float
    warnings: list[str] = Field(default_factory=list)
    dicom_send_summary: Optional[str] = None
    """Resumen del envío C-STORE, si se realizó."""


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
