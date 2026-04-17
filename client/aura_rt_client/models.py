from __future__ import annotations

from dataclasses import dataclass


DISCLAIMER_TEXT = (
    "Los contornos generados son un punto de partida y deben ser revisados "
    "por el medico tratante antes de cualquier uso clinico."
)


IMPORT_INSTRUCTIONS = (
    "En Eclipse/ARIA: File > Import > DICOM > seleccionar la carpeta CT y luego "
    "el archivo RT-STRUCT devuelto por la plataforma."
)


REFERENCE_DSC = {
    "Liver": "0.95 esperado",
    "Spleen": "0.94 esperado",
    "Kidney_R": "0.93 esperado",
    "Kidney_L": "0.93 esperado",
    "Pancreas": "0.83 esperado",
}


STRUCTURE_DISPLAY_NAMES = {
    "Liver": "Higado",
    "Spleen": "Bazo",
    "Kidney_R": "Rinon derecho",
    "Kidney_L": "Rinon izquierdo",
    "Pancreas": "Pancreas",
}


STRUCTURE_DEFAULT_COLORS = {
    "Liver": (0, 102, 204),
    "Spleen": (0, 153, 255),
    "Kidney_R": (51, 153, 255),
    "Kidney_L": (102, 178, 255),
    "Pancreas": (0, 128, 255),
}


@dataclass(frozen=True)
class StructureOption:
    key: str
    label: str


MVP_STRUCTURE_OPTIONS = (
    StructureOption("liver", "Higado"),
    StructureOption("spleen", "Bazo"),
    StructureOption("kidney_right", "Rinon D"),
    StructureOption("kidney_left", "Rinon I"),
    StructureOption("pancreas", "Pancreas"),
)


PRESETS = {
    "Abdomen MVP": [option.key for option in MVP_STRUCTURE_OPTIONS],
}


ESTIMATED_MINUTES = {
    "liver": 2,
    "spleen": 2,
    "kidney_right": 2,
    "kidney_left": 2,
    "pancreas": 3,
}


def structure_display_name(structure_name: str) -> str:
    return STRUCTURE_DISPLAY_NAMES.get(structure_name, structure_name)


def structure_default_color(structure_name: str) -> tuple[int, int, int]:
    return STRUCTURE_DEFAULT_COLORS.get(structure_name, (255, 255, 0))

