from __future__ import annotations

import json
import logging
import shutil
import time
import zipfile
from collections import defaultdict
from pathlib import Path
from tempfile import TemporaryDirectory

import SimpleITK as sitk

from .constants import MODEL_LABELS, MODEL_MONAI_UNEST, MODEL_NNUNET_PELVIS, MODEL_TOTALSEGMENTATOR, STRUCTURES, StructureDefinition
from .rtstruct_builder import build_rtstruct
from .schemas import SegmentConfig, SegmentReport
from .status import StatusTracker
from .totalseg import TotalSegmentatorError, run_totalsegmentator


logger = logging.getLogger("aura_rt.backend.pipeline")


class PipelineError(RuntimeError):
    def __init__(
        self,
        message: str,
        status_code: int = 400,
        *,
        code: str = "pipeline_error",
        hint: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.hint = hint

    def to_detail(self, *, request_id: str | None = None) -> dict[str, object]:
        detail: dict[str, object] = {
            "code": self.code,
            "message": str(self),
        }
        if self.hint:
            detail["hint"] = self.hint
        if request_id:
            detail["request_id"] = request_id
        return detail


def _unpack_request(archive_path: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive_path, "r") as archive:
        archive.extractall(destination)


def _load_config(config_path: Path) -> SegmentConfig:
    if not config_path.exists():
        raise PipelineError(
            "El ZIP recibido no contiene config.json.",
            code="missing_config",
            hint="Incluye un config.json con structures, modality, fast_mode y anonymized_id.",
        )
    return SegmentConfig.model_validate_json(config_path.read_text(encoding="utf-8"))


def _convert_dicom_to_nifti(dicom_dir: Path, output_path: Path) -> Path:
    series_file_names = list(sitk.ImageSeriesReader.GetGDCMSeriesFileNames(str(dicom_dir)))
    if not series_file_names:
        raise PipelineError(
            "No se detecto una serie DICOM valida dentro de la carpeta dicom/.",
            code="invalid_dicom_series",
            hint="Verifica que el ZIP incluya una sola serie CT en formato DICOM legible por GDCM.",
        )

    reader = sitk.ImageSeriesReader()
    reader.SetFileNames(series_file_names)
    image = reader.Execute()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sitk.WriteImage(image, str(output_path))
    logger.info("Serie DICOM convertida a NIfTI output=%s slices=%s", output_path, len(series_file_names))
    return output_path


def _resolve_inputs(work_dir: Path, status_tracker: StatusTracker) -> tuple[Path, Path]:
    input_nifti = work_dir / "input.nii.gz"
    dicom_dir = work_dir / "dicom"
    if not dicom_dir.exists():
        raise PipelineError(
            "El ZIP recibido no contiene la carpeta dicom/.",
            code="missing_dicom_folder",
            hint="Incluye la serie DICOM dentro de la carpeta dicom/ del ZIP.",
        )

    if input_nifti.exists():
        logger.info("Input NIfTI encontrado en payload path=%s", input_nifti)
        return input_nifti, dicom_dir

    status_tracker.update(
        message="Convirtiendo serie DICOM a NIfTI en backend",
        phase="preprocessing",
        progress_percent=18,
    )
    return _convert_dicom_to_nifti(dicom_dir, input_nifti), dicom_dir


def _require_inputs(work_dir: Path) -> tuple[Path, Path]:
    # Compatibilidad para cualquier llamada futura que aun espere esta funcion.
    raise NotImplementedError("_require_inputs fue reemplazada por _resolve_inputs")


def _resolve_structure_groups(structure_keys: list[str]) -> dict[str, list[StructureDefinition]]:
    grouped: dict[str, list[StructureDefinition]] = defaultdict(list)
    for key in structure_keys:
        definition = STRUCTURES.get(key)
        if definition is None:
            raise PipelineError(
                f"Estructura no soportada: {key}",
                code="unsupported_structure",
                hint="Consulta el catalogo de estructuras soportadas por el backend actual.",
            )
        grouped[definition.model].append(definition)
    return dict(grouped)


def _build_union_mask(source_masks: list[Path], destination: Path) -> None:
    combined_image = None
    for mask_path in source_masks:
        if not mask_path.exists():
            raise PipelineError(
                f"No se encontro la mascara esperada: {mask_path.name}",
                code="missing_mask",
                hint="Revisar logs de inferencia y nombres reales de ROI devueltos por TotalSegmentator.",
            )
        image = sitk.Cast(sitk.ReadImage(str(mask_path)) > 0, sitk.sitkUInt8)
        combined_image = image if combined_image is None else sitk.Or(combined_image, image)

    if combined_image is None:
        raise PipelineError("No hubo mascaras para combinar.")

    sitk.WriteImage(combined_image, str(destination))


def _materialize_masks(
    definitions: list[StructureDefinition],
    generated_mask_dir: Path,
    destination_dir: Path,
) -> dict[str, tuple[Path, tuple[int, int, int]]]:
    destination_dir.mkdir(parents=True, exist_ok=True)
    results: dict[str, tuple[Path, tuple[int, int, int]]] = {}

    for definition in definitions:
        target_path = destination_dir / f"{definition.clinical_name}.nii.gz"
        if len(definition.roi_names) == 1:
            source_path = generated_mask_dir / f"{definition.roi_names[0]}.nii.gz"
            if not source_path.exists():
                raise PipelineError(
                    f"TotalSegmentator no genero la mascara requerida para {definition.request_key}.",
                    code="missing_mask",
                    hint="Revisar compatibilidad entre los nombres internos y las ROI generadas por TotalSegmentator.",
                )
            shutil.copy2(source_path, target_path)
        else:
            source_paths = [generated_mask_dir / f"{roi_name}.nii.gz" for roi_name in definition.roi_names]
            _build_union_mask(source_paths, target_path)
        results[definition.clinical_name] = (target_path, definition.color)

    return results


def _package_output(
    dicom_dir: Path,
    generated_masks: dict[str, tuple[Path, tuple[int, int, int]]],
    rtstruct_path: Path,
    report: SegmentReport,
    output_zip_path: Path,
) -> None:
    with TemporaryDirectory(prefix="aura_rt_output_") as temp_dir_name:
        output_root = Path(temp_dir_name) / "output"
        ct_output_dir = output_root / "CT"
        masks_output_dir = output_root / "masks"
        ct_output_dir.mkdir(parents=True, exist_ok=True)
        masks_output_dir.mkdir(parents=True, exist_ok=True)

        for path in dicom_dir.rglob("*"):
            if not path.is_file():
                continue
            relative_path = path.relative_to(dicom_dir)
            target_path = ct_output_dir / relative_path
            target_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target_path)

        for clinical_name, (mask_path, _) in generated_masks.items():
            shutil.copy2(mask_path, masks_output_dir / f"{clinical_name}.nii.gz")

        shutil.copy2(rtstruct_path, output_root / rtstruct_path.name)
        (output_root / "report.json").write_text(
            json.dumps(report.model_dump(), indent=2),
            encoding="utf-8",
        )

        with zipfile.ZipFile(output_zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in output_root.rglob("*"):
                if path.is_file():
                    archive.write(path, path.relative_to(output_root))


def process_archive(
    archive_path: Path,
    output_zip_path: Path,
    status_tracker: StatusTracker,
) -> SegmentReport:
    started_at = time.perf_counter()

    with TemporaryDirectory(prefix="aura_rt_case_") as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        request_root = temp_dir / "request"
        request_root.mkdir(parents=True, exist_ok=True)
        _unpack_request(archive_path, request_root)

        config = _load_config(request_root / "config.json")
        if config.modality.upper() != "CT":
            raise PipelineError(
                "Solo se admite modalidad CT en este MVP.",
                code="unsupported_modality",
                hint="Convierte o selecciona un estudio CT antes de enviarlo a /segment.",
            )

        grouped_structures = _resolve_structure_groups(config.structures)
        status_tracker.begin_case(config.anonymized_id, config.structures)
        logger.info(
            "Caso recibido case_id=%s structures=%s",
            config.anonymized_id,
            ",".join(config.structures),
        )
        status_tracker.update(
            message="Routing de modelos resuelto",
            phase="routing",
            progress_percent=10,
        )
        input_nifti, dicom_dir = _resolve_inputs(request_root, status_tracker)

        warnings: list[str] = []
        generated_masks: dict[str, tuple[Path, tuple[int, int, int]]] = {}
        models_used: list[str] = []

        if grouped_structures.get(MODEL_MONAI_UNEST):
            raise PipelineError(
                "MONAI UNesT esta contemplado en la arquitectura pero no esta implementado en este MVP.",
                status_code=501,
                code="model_not_implemented",
                hint="Limita el pedido a estructuras soportadas por TotalSegmentator en esta version.",
            )

        if grouped_structures.get(MODEL_NNUNET_PELVIS):
            raise PipelineError(
                "nnU-Net pelvico esta contemplado en la arquitectura pero no esta implementado en este MVP.",
                status_code=501,
                code="model_not_implemented",
                hint="Limita el pedido a estructuras soportadas por TotalSegmentator en esta version.",
            )

        totalseg_definitions = grouped_structures.get(MODEL_TOTALSEGMENTATOR, [])
        if totalseg_definitions:
            logger.info(
                "Ejecutando TotalSegmentator case_id=%s roi_subset=%s",
                config.anonymized_id,
                [roi_name for definition in totalseg_definitions for roi_name in definition.roi_names],
            )
            status_tracker.update(
                message="Ejecutando TotalSegmentator",
                active_model=MODEL_LABELS[MODEL_TOTALSEGMENTATOR],
                phase="segmenting",
                progress_percent=45,
            )
            totalseg_output_dir = temp_dir / "totalseg_output"
            roi_subset = [roi_name for definition in totalseg_definitions for roi_name in definition.roi_names]
            try:
                run_totalsegmentator(
                    input_nifti=input_nifti,
                    output_dir=totalseg_output_dir,
                    roi_names=roi_subset,
                    fast_mode=config.fast_mode,
                )
            except TotalSegmentatorError as exc:
                raise PipelineError(
                    str(exc),
                    status_code=500,
                    code="segmentation_engine_error",
                    hint="Revisa disponibilidad de TotalSegmentator, memoria GPU y logs del backend.",
                ) from exc

            generated_masks.update(
                _materialize_masks(
                    definitions=totalseg_definitions,
                    generated_mask_dir=totalseg_output_dir,
                    destination_dir=temp_dir / "prepared_masks",
                )
            )
            models_used.append(MODEL_LABELS[MODEL_TOTALSEGMENTATOR])
            status_tracker.update(
                message="Mascaras generadas por TotalSegmentator",
                generated_structures=list(generated_masks.keys()),
                phase="postprocessing",
                progress_percent=75,
            )
            logger.info(
                "Mascaras generadas case_id=%s structures=%s",
                config.anonymized_id,
                list(generated_masks.keys()),
            )

        if not generated_masks:
            raise PipelineError(
                "No se genero ninguna mascara de salida.",
                code="no_output_masks",
                hint="Revisa si las ROI solicitadas estan disponibles para la anatomia del estudio enviado.",
            )

        status_tracker.update(
            message="Construyendo DICOM RT-STRUCT",
            active_model="rt-utils",
            phase="rtstruct",
            progress_percent=86,
        )
        rtstruct_path = temp_dir / f"RS.{config.anonymized_id}.dcm"
        build_rtstruct(
            dicom_series_dir=dicom_dir,
            structures=generated_masks,
            output_path=rtstruct_path,
        )

        elapsed = round(time.perf_counter() - started_at, 2)
        report = SegmentReport(
            case_id=config.anonymized_id,
            generated_structures=list(generated_masks.keys()),
            models_used=models_used,
            processing_seconds=elapsed,
            warnings=warnings,
        )
        status_tracker.update(
            message="Empaquetando resultados",
            active_model=None,
            phase="packaging",
            progress_percent=94,
        )
        _package_output(
            dicom_dir=dicom_dir,
            generated_masks=generated_masks,
            rtstruct_path=rtstruct_path,
            report=report,
            output_zip_path=output_zip_path,
        )
        logger.info(
            "Caso completado case_id=%s generated_structures=%s processing_seconds=%s",
            config.anonymized_id,
            report.generated_structures,
            report.processing_seconds,
        )
        status_tracker.complete(report.generated_structures)
        return report
