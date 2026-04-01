from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


class TotalSegmentatorError(RuntimeError):
    pass


def is_totalsegmentator_available() -> bool:
    return shutil.which("TotalSegmentator") is not None


def run_totalsegmentator(
    input_nifti: Path,
    output_dir: Path,
    roi_names: list[str],
    *,
    fast_mode: bool = True,
    force_split: bool = False,
) -> None:
    if not is_totalsegmentator_available():
        raise TotalSegmentatorError(
            "TotalSegmentator no esta disponible en el PATH del entorno actual."
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    command = [
        "TotalSegmentator",
        "-i",
        str(input_nifti),
        "-o",
        str(output_dir),
    ]
    if fast_mode:
        command.append("--fast")
    if force_split:
        command.append("--force_split")
    if roi_names:
        command.extend(["--roi_subset", *sorted(set(roi_names))])

    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        error_output = completed.stderr.strip() or completed.stdout.strip()
        raise TotalSegmentatorError(
            f"TotalSegmentator fallo con codigo {completed.returncode}: {error_output}"
        )

