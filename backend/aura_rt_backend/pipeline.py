from __future__ import annotations

import json
import logging
import shutil
import time
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import pydicom
import SimpleITK as sitk
from pydicom.uid import ExplicitVRBigEndian, ExplicitVRLittleEndian, ImplicitVRLittleEndian

from .constants import MODEL_LABELS, MODEL_MONAI_UNEST, MODEL_NNUNET_PELVIS, MODEL_TOTALSEGMENTATOR, STRUCTURES, StructureDefinition
from .rtstruct_builder import build_rtstruct
from .schemas import SegmentConfig, SegmentReport
from .status import StatusTracker
from .totalseg import TotalSegmentatorError, run_totalsegmentator


logger = logging.getLogger("aura_rt.backend.pipeline")


@dataclass(frozen=True)
class DicomSliceCandidate:
    file_path: Path
    series_instance_uid: str
    sop_instance_uid: str
    instance_number: int | None
    image_position: tuple[float, float, float] | None
    image_orientation: tuple[float, float, float, float, float, float] | None


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


def _safe_int(value: object) -> int | None:
    if value is None:
        return None
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return None


def _safe_float(value: object, *, default: float) -> float:
    if value is None:
        return default
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return default


def _safe_float_tuple(value: object, *, expected_length: int) -> tuple[float, ...] | None:
    if value is None:
        return None

    if isinstance(value, str):
        parts = [item.strip() for item in value.split("\\") if item.strip()]
    else:
        try:
            parts = [str(item).strip() for item in value]
        except TypeError:
            parts = [str(value).strip()]

    if len(parts) < expected_length:
        return None

    try:
        return tuple(float(parts[index]) for index in range(expected_length))
    except (TypeError, ValueError):
        return None


def _ensure_transfer_syntax(dataset: object) -> None:
    file_meta = getattr(dataset, "file_meta", None)
    if file_meta is None:
        file_meta = pydicom.dataset.FileMetaDataset()
        dataset.file_meta = file_meta

    if getattr(file_meta, "TransferSyntaxUID", None):
        return

    is_little_endian = getattr(dataset, "is_little_endian", True)
    is_implicit_vr = getattr(dataset, "is_implicit_VR", False)

    if is_little_endian and is_implicit_vr:
        file_meta.TransferSyntaxUID = ImplicitVRLittleEndian
    elif is_little_endian:
        file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    else:
        file_meta.TransferSyntaxUID = ExplicitVRBigEndian


def _compute_slice_normal(
    slices: list[DicomSliceCandidate],
) -> tuple[float, float, float] | None:
    orientation = next(
        (candidate.image_orientation for candidate in slices if candidate.image_orientation is not None),
        None,
    )
    if orientation is None:
        return None

    row = orientation[:3]
    column = orientation[3:]
    normal = (
        row[1] * column[2] - row[2] * column[1],
        row[2] * column[0] - row[0] * column[2],
        row[0] * column[1] - row[1] * column[0],
    )
    if max(abs(component) for component in normal) <= 1e-6:
        return None
    return normal


def _sort_slice_candidates(candidates: list[DicomSliceCandidate]) -> list[DicomSliceCandidate]:
    slice_normal = _compute_slice_normal(candidates)

    def sort_key(candidate: DicomSliceCandidate) -> tuple[object, ...]:
        if candidate.image_position is not None:
            if slice_normal is not None:
                position_value = sum(
                    coordinate * axis
                    for coordinate, axis in zip(candidate.image_position, slice_normal)
                )
            else:
                position_value = candidate.image_position[2]
            return (
                0,
                round(position_value, 6),
                candidate.instance_number if candidate.instance_number is not None else 0,
                candidate.file_path.name.lower(),
            )
        if candidate.instance_number is not None:
            return (1, candidate.instance_number, candidate.file_path.name.lower())
        return (2, candidate.file_path.name.lower())

    return sorted(candidates, key=sort_key)


def _build_direction_from_orientation(
    orientation: tuple[float, ...] | None,
) -> tuple[float, ...]:
    if orientation is None or len(orientation) < 6:
        return (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)

    row = orientation[:3]
    column = orientation[3:6]
    normal = (
        row[1] * column[2] - row[2] * column[1],
        row[2] * column[0] - row[0] * column[2],
        row[0] * column[1] - row[1] * column[0],
    )
    if max(abs(component) for component in normal) <= 1e-6:
        return (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)

    return (
        row[0],
        column[0],
        normal[0],
        row[1],
        column[1],
        normal[1],
        row[2],
        column[2],
        normal[2],
    )


def _estimate_slice_spacing(datasets: list[object]) -> float:
    if not datasets:
        return 1.0

    first_dataset = datasets[0]
    orientation = _safe_float_tuple(
        getattr(first_dataset, "ImageOrientationPatient", None),
        expected_length=6,
    )
    normal = _compute_slice_normal(
        [
            DicomSliceCandidate(
                file_path=Path("slice.dcm"),
                series_instance_uid="",
                sop_instance_uid="",
                instance_number=None,
                image_position=_safe_float_tuple(
                    getattr(dataset, "ImagePositionPatient", None),
                    expected_length=3,
                ),
                image_orientation=orientation,
            )
            for dataset in datasets
        ]
    )

    projected_positions: list[float] = []
    if normal is not None:
        for dataset in datasets:
            position = _safe_float_tuple(
                getattr(dataset, "ImagePositionPatient", None),
                expected_length=3,
            )
            if position is None:
                continue
            projected_positions.append(
                sum(coordinate * axis for coordinate, axis in zip(position, normal))
            )

    if len(projected_positions) >= 2:
        diffs = sorted(
            abs(projected_positions[index + 1] - projected_positions[index])
            for index in range(len(projected_positions) - 1)
            if abs(projected_positions[index + 1] - projected_positions[index]) > 1e-6
        )
        if diffs:
            return diffs[len(diffs) // 2]

    return _safe_float(
        getattr(first_dataset, "SpacingBetweenSlices", None),
        default=_safe_float(getattr(first_dataset, "SliceThickness", None), default=1.0),
    )


def _scan_dicom_slices_with_pydicom(dicom_root: Path) -> list[DicomSliceCandidate]:
    candidates: list[DicomSliceCandidate] = []

    for file_path in sorted(path for path in dicom_root.rglob("*") if path.is_file()):
        try:
            dataset = pydicom.dcmread(str(file_path), stop_before_pixels=True, force=True)
        except Exception:
            continue

        modality = str(getattr(dataset, "Modality", "")).strip().upper()
        if modality and modality != "CT":
            continue
        if not hasattr(dataset, "Rows") or not hasattr(dataset, "Columns"):
            continue

        candidates.append(
            DicomSliceCandidate(
                file_path=file_path,
                series_instance_uid=str(getattr(dataset, "SeriesInstanceUID", "")).strip(),
                sop_instance_uid=str(getattr(dataset, "SOPInstanceUID", "")).strip(),
                instance_number=_safe_int(getattr(dataset, "InstanceNumber", None)),
                image_position=_safe_float_tuple(
                    getattr(dataset, "ImagePositionPatient", None),
                    expected_length=3,
                ),
                image_orientation=_safe_float_tuple(
                    getattr(dataset, "ImageOrientationPatient", None),
                    expected_length=6,
                ),
            )
        )

    return candidates


def _convert_dicom_to_nifti_with_pydicom(series_file_names: list[str], output_path: Path) -> Path:
    datasets = [pydicom.dcmread(file_name, force=True) for file_name in series_file_names]
    if not datasets:
        raise ValueError("No hay datasets DICOM para convertir.")

    pixel_arrays: list[np.ndarray] = []
    expected_shape: tuple[int, int] | None = None

    for dataset in datasets:
        _ensure_transfer_syntax(dataset)
        pixel_array = np.asarray(dataset.pixel_array)
        if pixel_array.ndim != 2:
            raise ValueError("Solo se admite una serie CT 2D por slice.")
        if expected_shape is None:
            expected_shape = (int(pixel_array.shape[0]), int(pixel_array.shape[1]))
        elif pixel_array.shape != expected_shape:
            raise ValueError("La serie DICOM no tiene una grilla consistente entre slices.")

        slope = _safe_float(getattr(dataset, "RescaleSlope", 1), default=1.0)
        intercept = _safe_float(getattr(dataset, "RescaleIntercept", 0), default=0.0)
        pixel_arrays.append(pixel_array.astype(np.float32) * slope + intercept)

    volume = np.stack(pixel_arrays, axis=0)
    int16_info = np.iinfo(np.int16)
    if (
        np.allclose(volume, np.rint(volume))
        and float(volume.min()) >= int16_info.min
        and float(volume.max()) <= int16_info.max
    ):
        volume = np.rint(volume).astype(np.int16)
    else:
        volume = volume.astype(np.float32)

    first_dataset = datasets[0]
    orientation = _safe_float_tuple(
        getattr(first_dataset, "ImageOrientationPatient", None),
        expected_length=6,
    )
    direction = _build_direction_from_orientation(orientation)
    origin = _safe_float_tuple(
        getattr(first_dataset, "ImagePositionPatient", None),
        expected_length=3,
    ) or (0.0, 0.0, 0.0)
    pixel_spacing = _safe_float_tuple(
        getattr(first_dataset, "PixelSpacing", None),
        expected_length=2,
    ) or (1.0, 1.0)
    spacing = (
        float(pixel_spacing[1]),
        float(pixel_spacing[0]),
        float(_estimate_slice_spacing(datasets)),
    )

    image = sitk.GetImageFromArray(volume)
    image.SetDirection(direction)
    image.SetOrigin(origin)
    image.SetSpacing(spacing)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sitk.WriteImage(image, str(output_path))
    logger.warning(
        "Fallback pydicom usado para convertir serie DICOM a NIfTI output=%s slices=%s",
        output_path,
        len(series_file_names),
    )
    return output_path


def _discover_dicom_series_with_pydicom(
    dicom_root: Path,
    staging_dir: Path,
) -> tuple[Path, list[str]]:
    grouped_candidates: dict[str, list[DicomSliceCandidate]] = defaultdict(list)
    seen_ids_by_group: dict[str, set[str]] = defaultdict(set)

    for candidate in _scan_dicom_slices_with_pydicom(dicom_root):
        group_key = candidate.series_instance_uid or f"dir::{candidate.file_path.parent.as_posix()}"
        dedupe_key = candidate.sop_instance_uid or candidate.file_path.as_posix()
        if dedupe_key in seen_ids_by_group[group_key]:
            continue
        seen_ids_by_group[group_key].add(dedupe_key)
        grouped_candidates[group_key].append(candidate)

    if not grouped_candidates:
        raise PipelineError(
            "No se detecto una serie DICOM valida dentro de la carpeta dicom/.",
            code="invalid_dicom_series",
            hint="Verifica que el ZIP incluya una serie CT legible por GDCM dentro de dicom/ o sus subcarpetas.",
        )

    selected_group_key, selected_candidates = max(
        grouped_candidates.items(),
        key=lambda item: len(item[1]),
    )
    ordered_candidates = _sort_slice_candidates(selected_candidates)

    if staging_dir.exists():
        shutil.rmtree(staging_dir, ignore_errors=True)
    staging_dir.mkdir(parents=True, exist_ok=True)

    staged_file_names: list[str] = []
    for index, candidate in enumerate(ordered_candidates, start=1):
        suffix = candidate.file_path.suffix or ".dcm"
        target_path = staging_dir / f"{index:04d}{suffix.lower()}"
        shutil.copy2(candidate.file_path, target_path)
        staged_file_names.append(str(target_path))

    logger.warning(
        "Fallback pydicom usado para detectar serie DICOM dicom_root=%s staging_dir=%s slices=%s group=%s groups=%s",
        dicom_root,
        staging_dir,
        len(staged_file_names),
        selected_group_key,
        len(grouped_candidates),
    )
    return staging_dir, staged_file_names


def _discover_dicom_series(dicom_root: Path, staging_dir: Path) -> tuple[Path, list[str]]:
    candidate_dirs = [dicom_root, *sorted(path for path in dicom_root.rglob("*") if path.is_dir())]
    discovered_series: list[tuple[Path, list[str]]] = []

    for candidate_dir in candidate_dirs:
        try:
            series_ids = sitk.ImageSeriesReader.GetGDCMSeriesIDs(str(candidate_dir)) or []
        except RuntimeError:
            continue

        for series_id in series_ids:
            series_file_names = list(
                sitk.ImageSeriesReader.GetGDCMSeriesFileNames(str(candidate_dir), series_id)
            )
            if series_file_names:
                discovered_series.append((candidate_dir, series_file_names))

        if series_ids:
            continue

        series_file_names = list(sitk.ImageSeriesReader.GetGDCMSeriesFileNames(str(candidate_dir)))
        if series_file_names:
            discovered_series.append((candidate_dir, series_file_names))

    if not discovered_series:
        return _discover_dicom_series_with_pydicom(dicom_root, staging_dir)

    selected_dir, series_file_names = max(discovered_series, key=lambda item: len(item[1]))
    logger.info(
        "Serie DICOM detectada dicom_root=%s series_dir=%s slices=%s candidates=%s",
        dicom_root,
        selected_dir,
        len(series_file_names),
        len(discovered_series),
    )
    return selected_dir, series_file_names


def _convert_dicom_to_nifti(series_file_names: list[str], output_path: Path) -> Path:
    if not series_file_names:
        raise PipelineError(
            "No se detecto una serie DICOM valida dentro de la carpeta dicom/.",
            code="invalid_dicom_series",
            hint="Verifica que el ZIP incluya una serie CT legible por GDCM dentro de dicom/ o sus subcarpetas.",
        )

    reader = sitk.ImageSeriesReader()
    reader.SetFileNames(series_file_names)
    try:
        image = reader.Execute()
    except RuntimeError:
        logger.warning("GDCM no pudo convertir la serie DICOM. Se intenta fallback con pydicom.")
        try:
            return _convert_dicom_to_nifti_with_pydicom(series_file_names, output_path)
        except Exception as fallback_exc:
            raise PipelineError(
                "Se detectaron archivos DICOM, pero no se pudo reconstruir el volumen CT.",
                code="dicom_read_error",
                hint="Verifica que la serie use una transfer syntax soportada y que todas las slices pertenezcan al mismo volumen CT.",
            ) from fallback_exc
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sitk.WriteImage(image, str(output_path))
    logger.info("Serie DICOM convertida a NIfTI output=%s slices=%s", output_path, len(series_file_names))
    return output_path


def _resolve_inputs(work_dir: Path, status_tracker: StatusTracker) -> tuple[Path, Path, Path]:
    input_nifti = work_dir / "input.nii.gz"
    dicom_root = work_dir / "dicom"
    if not dicom_root.exists():
        raise PipelineError(
            "El ZIP recibido no contiene la carpeta dicom/.",
            code="missing_dicom_folder",
            hint="Incluye la serie DICOM dentro de la carpeta dicom/ del ZIP.",
        )

    dicom_series_dir, series_file_names = _discover_dicom_series(
        dicom_root,
        work_dir / "__resolved_dicom_series__",
    )

    if input_nifti.exists():
        logger.info("Input NIfTI encontrado en payload path=%s", input_nifti)
        return input_nifti, dicom_root, dicom_series_dir

    status_tracker.update(
        message="Convirtiendo serie DICOM a NIfTI en backend",
        phase="preprocessing",
        progress_percent=18,
    )
    return _convert_dicom_to_nifti(series_file_names, input_nifti), dicom_root, dicom_series_dir


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
        input_nifti, dicom_dir, dicom_series_dir = _resolve_inputs(request_root, status_tracker)

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
            dicom_series_dir=dicom_series_dir,
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
