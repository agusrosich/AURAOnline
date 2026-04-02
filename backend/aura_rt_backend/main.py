from __future__ import annotations

import logging
import shutil
import tempfile
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool
from starlette.background import BackgroundTask

from .config import settings
from .constants import MODEL_LABELS, MODEL_MONAI_UNEST, MODEL_NNUNET_PELVIS, MODEL_TOTALSEGMENTATOR, STRUCTURES
from .pipeline import PipelineError, process_archive
from .status import StatusTracker
from .totalseg import is_totalsegmentator_available


app = FastAPI(
    title=settings.app_title,
    version=settings.app_version,
    summary="Backend MVP para segmentacion CT y generacion de RT-STRUCT",
)
status_tracker = StatusTracker()
logger = logging.getLogger("aura_rt.backend.http")

ACTIVE_STRUCTURE_KEYS = tuple(
    sorted(
        key
        for key, definition in STRUCTURES.items()
        if definition.model == MODEL_TOTALSEGMENTATOR and definition.roi_names
    )
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if settings.cors_allow_all else settings.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _cleanup_directory(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)


def _configure_logging() -> None:
    logging.basicConfig(
        level=getattr(logging, settings.log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    logger.setLevel(getattr(logging, settings.log_level, logging.INFO))


@app.on_event("startup")
def on_startup() -> None:
    _configure_logging()
    status_tracker.set_model_status(
        MODEL_LABELS[MODEL_TOTALSEGMENTATOR],
        "available" if is_totalsegmentator_available() else "missing",
    )
    status_tracker.set_model_status(MODEL_LABELS[MODEL_MONAI_UNEST], "planned")
    status_tracker.set_model_status(MODEL_LABELS[MODEL_NNUNET_PELVIS], "planned")
    logger.info(
        "Backend iniciado title=%s version=%s port=%s cors_origins=%s",
        settings.app_title,
        settings.app_version,
        settings.port,
        settings.cors_origins,
    )


@app.get("/health")
def healthcheck() -> dict[str, object]:
    return {
        "status": "ok",
        "app_version": settings.app_version,
        "supported_structures": list(ACTIVE_STRUCTURE_KEYS),
        "supported_structure_count": len(ACTIVE_STRUCTURE_KEYS),
    }


@app.get("/status")
def status() -> dict[str, object]:
    return status_tracker.snapshot().model_dump()


@app.get("/preview/{case_id}")
def preview_manifest(case_id: str) -> dict[str, object]:
    manifest = status_tracker.preview_manifest(case_id)
    if manifest is None:
        raise HTTPException(status_code=404, detail="Preview no disponible para este caso.")
    return manifest


@app.get("/preview/{case_id}/mask/{structure_name}")
def preview_mask(case_id: str, structure_name: str) -> FileResponse:
    mask_path = status_tracker.preview_mask_path(case_id, structure_name)
    if mask_path is None or not mask_path.exists():
        raise HTTPException(status_code=404, detail="Mascara preview no disponible.")
    return FileResponse(
        path=mask_path,
        media_type="application/gzip",
        filename=mask_path.name,
    )


@app.post("/segment")
async def segment(file: UploadFile = File(...)) -> FileResponse:
    if not file.filename or not file.filename.lower().endswith(".zip"):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "invalid_payload",
                "message": "El payload debe ser un archivo .zip",
                "hint": "Empaqueta config.json y dicom/ dentro del ZIP antes de llamar a /segment.",
            },
        )

    temp_dir = Path(tempfile.mkdtemp(prefix="aura_rt_http_"))
    request_zip_path = temp_dir / "request.zip"
    response_zip_path = temp_dir / "response.zip"
    request_id = uuid.uuid4().hex[:12]

    try:
        request_bytes = await file.read()
        request_zip_path.write_bytes(request_bytes)
        logger.info(
            "[request_id=%s] /segment recibido filename=%s size_bytes=%s",
            request_id,
            file.filename,
            len(request_bytes),
        )
        await run_in_threadpool(
            process_archive,
            archive_path=request_zip_path,
            output_zip_path=response_zip_path,
            status_tracker=status_tracker,
        )
        logger.info(
            "[request_id=%s] /segment completado response_zip=%s",
            request_id,
            response_zip_path,
        )
    except PipelineError as exc:
        status_tracker.fail(str(exc))
        logger.warning(
            "[request_id=%s] PipelineError code=%s status_code=%s message=%s",
            request_id,
            exc.code,
            exc.status_code,
            str(exc),
        )
        _cleanup_directory(temp_dir)
        raise HTTPException(
            status_code=exc.status_code,
            detail=exc.to_detail(request_id=request_id),
        ) from exc
    except Exception as exc:  # pragma: no cover
        status_tracker.fail(str(exc))
        logger.exception("[request_id=%s] Error interno no controlado", request_id)
        _cleanup_directory(temp_dir)
        raise HTTPException(
            status_code=500,
            detail={
                "code": "internal_server_error",
                "message": f"Error interno: {exc}",
                "hint": "Revisar logs del backend para diagnostico detallado.",
                "request_id": request_id,
            },
        ) from exc

    return FileResponse(
        path=response_zip_path,
        media_type="application/zip",
        filename=response_zip_path.name,
        background=BackgroundTask(_cleanup_directory, temp_dir),
    )
