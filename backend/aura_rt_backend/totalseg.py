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
    task_name: str = "total",
) -> None:
    """Ejecuta TotalSegmentator para una tarea y subconjunto de ROIs dados.

    Args:
        input_nifti: Ruta al archivo NIfTI de entrada.
        output_dir: Directorio de salida para las máscaras generadas.
        roi_names: Lista de nombres de ROI a segmentar (``--roi_subset``).
            Ignorada si la tarea no soporta ``--roi_subset`` (ej. subtasks H&N).
        fast_mode: Activa ``--fast`` (modelo 3mm, menor VRAM y tiempo).
        force_split: Activa ``--force_split`` para estudios de campo largo.
        task_name: Nombre de la tarea de TotalSegmentator.
            ``'total'`` es el modelo principal (117 estructuras).
            Subtasks soportados para RT:
            - ``'head_glands_cavities'``: parótidas, glándulas submaxilares,
              ojos, nervios ópticos, faringe.
            - ``'head_muscles'``: maseteros, temporales, lengua.
            - ``'headneck_bones_vessels'``: laringe, cartílagos, carótidas,
              yugulares.
            - ``'headneck_muscles'``: esternocleidomastoideo, constrictores
              faríngeos, trapecios.
            - ``'brain_structures'``: tronco cerebral y subestructuras.
    """
    if not is_totalsegmentator_available():
        raise TotalSegmentatorError(
            "TotalSegmentator no esta disponible en el PATH del entorno actual."
        )

    # Subtasks de H&N no soportan --roi_subset: siempre generan todas sus clases.
    TASKS_WITHOUT_ROI_SUBSET = {
        "head_glands_cavities",
        "head_muscles",
        "headneck_bones_vessels",
        "headneck_muscles",
        "brain_structures",
        "lung_vessels",
        "body",
        "tissue_types",
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    command = [
        "TotalSegmentator",
        "-i", str(input_nifti),
        "-o", str(output_dir),
        "--task", task_name,
    ]
    if fast_mode:
        command.append("--fast")
    if force_split:
        command.append("--force_split")
    if roi_names and task_name not in TASKS_WITHOUT_ROI_SUBSET:
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
            f"TotalSegmentator fallo con codigo {completed.returncode} "
            f"(task={task_name}): {error_output}"
        )

