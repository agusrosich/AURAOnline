from __future__ import annotations

import hashlib
import json
import os
import zipfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
import pydicom
import SimpleITK as sitk
from pydicom.dataset import Dataset


PHI_TAGS_TO_CLEAR = [
    (0x0008, 0x0050),
    (0x0008, 0x0080),
    (0x0008, 0x0081),
    (0x0008, 0x0090),
    (0x0008, 0x1010),
    (0x0008, 0x1070),
    (0x0008, 0x1030),
    (0x0008, 0x103E),
    (0x0010, 0x1000),
    (0x0010, 0x1001),
    (0x0010, 0x1040),
    (0x0010, 0x2154),
]


@dataclass(frozen=True)
class SeriesInfo:
    modality: str
    study_date: str
    slices: int
    voxel_spacing: tuple[float, float, float]
    preview_slice: np.ndarray


def _series_file_names(folder: Path) -> list[str]:
    file_names = list(sitk.ImageSeriesReader.GetGDCMSeriesFileNames(str(folder)))
    if not file_names:
        raise ValueError("No se encontraron archivos DICOM validos en la carpeta seleccionada.")
    return file_names


def _read_series_image(folder: Path) -> sitk.Image:
    reader = sitk.ImageSeriesReader()
    reader.SetFileNames(_series_file_names(folder))
    return reader.Execute()


def inspect_dicom_series(folder: Path) -> SeriesInfo:
    image = _read_series_image(folder)
    array = sitk.GetArrayFromImage(image)
    center_slice = array[array.shape[0] // 2]
    first_dataset = pydicom.dcmread(_series_file_names(folder)[0], stop_before_pixels=True)
    modality = str(getattr(first_dataset, "Modality", ""))
    if modality.upper() != "CT":
        raise ValueError(f"Solo se admiten estudios CT. Modalidad detectada: {modality or 'desconocida'}")

    spacing = image.GetSpacing()
    return SeriesInfo(
        modality=modality,
        study_date=str(getattr(first_dataset, "StudyDate", "")),
        slices=int(array.shape[0]),
        voxel_spacing=(round(spacing[0], 3), round(spacing[1], 3), round(spacing[2], 3)),
        preview_slice=center_slice,
    )


def generate_anonymized_id(seed: str) -> str:
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    digest = hashlib.sha1(f"{seed}:{timestamp}".encode("utf-8")).hexdigest()[:6].upper()
    return f"CASE_{timestamp}_{digest}"


def _clear_phi_tags(dataset: Dataset) -> None:
    dataset.remove_private_tags()
    dataset.PatientName = "ANON"
    dataset.PatientBirthDate = "19000101"
    if "PatientID" not in dataset:
        dataset.PatientID = "ANON"

    for tag in PHI_TAGS_TO_CLEAR:
        if tag in dataset:
            dataset[tag].value = ""


def anonymize_dicom_series(source_dir: Path, destination_dir: Path, anonymized_id: str) -> None:
    destination_dir.mkdir(parents=True, exist_ok=True)

    for source_path in sorted(source_dir.rglob("*")):
        if not source_path.is_file():
            continue

        dataset = pydicom.dcmread(str(source_path), force=True)
        _clear_phi_tags(dataset)
        dataset.PatientName = "ANON"
        dataset.PatientID = anonymized_id
        dataset.PatientBirthDate = "19000101"
        if "PatientSex" not in dataset:
            dataset.PatientSex = ""
        if "StudyDate" not in dataset:
            dataset.StudyDate = ""
        relative_path = source_path.relative_to(source_dir)
        target_path = destination_dir / relative_path
        target_path.parent.mkdir(parents=True, exist_ok=True)
        dataset.save_as(str(target_path))


def convert_series_to_nifti(dicom_dir: Path, output_path: Path) -> Path:
    image = _read_series_image(dicom_dir)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sitk.WriteImage(image, str(output_path))
    return output_path


def create_request_archive(
    dicom_dir: Path,
    input_nifti_path: Path,
    config: dict[str, object],
    archive_path: Path,
) -> Path:
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    config_bytes = json.dumps(config, indent=2).encode("utf-8")

    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("config.json", config_bytes)
        archive.write(input_nifti_path, "input.nii.gz")
        for file_path in dicom_dir.rglob("*"):
            if file_path.is_file():
                archive.write(file_path, Path("dicom") / file_path.relative_to(dicom_dir))
    return archive_path


def extract_response_archive(archive_path: Path, destination_dir: Path) -> Path:
    destination_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive_path, "r") as archive:
        archive.extractall(destination_dir)
    return destination_dir


def load_report(output_dir: Path) -> dict[str, object]:
    report_path = output_dir / "report.json"
    if not report_path.exists():
        raise FileNotFoundError("La respuesta del backend no contiene report.json")
    return json.loads(report_path.read_text(encoding="utf-8"))


def open_in_file_manager(path: Path) -> None:
    if os.name == "nt":
        os.startfile(path)  # type: ignore[attr-defined]
        return
    raise RuntimeError("Abrir carpeta automaticamente solo esta implementado para Windows en este MVP.")
