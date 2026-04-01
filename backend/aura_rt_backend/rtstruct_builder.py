from __future__ import annotations

from pathlib import Path

import numpy as np
import SimpleITK as sitk
from rt_utils import RTStructBuilder


def _load_mask_for_rtstruct(mask_path: Path) -> np.ndarray:
    image = sitk.ReadImage(str(mask_path))
    mask = sitk.GetArrayFromImage(image) > 0
    return np.transpose(mask, (1, 2, 0))


def build_rtstruct(
    dicom_series_dir: Path,
    structures: dict[str, tuple[Path, tuple[int, int, int]]],
    output_path: Path,
) -> None:
    rtstruct = RTStructBuilder.create_new(dicom_series_path=str(dicom_series_dir))

    for clinical_name, (mask_path, color) in structures.items():
        mask = _load_mask_for_rtstruct(mask_path)
        if not mask.any():
            continue
        rtstruct.add_roi(
            mask=mask.astype(bool),
            color=list(color),
            name=clinical_name,
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    rtstruct.save(str(output_path))

