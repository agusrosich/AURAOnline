from __future__ import annotations

from dataclasses import dataclass


MODEL_TOTALSEGMENTATOR = "totalsegmentator"
MODEL_MONAI_UNEST = "monai_unest"
MODEL_NNUNET_PELVIS = "nnunet_pelvis"


@dataclass(frozen=True)
class StructureDefinition:
    request_key: str
    display_name: str
    clinical_name: str
    model: str
    roi_names: tuple[str, ...]
    color: tuple[int, int, int]


STRUCTURES: dict[str, StructureDefinition] = {
    "liver": StructureDefinition(
        request_key="liver",
        display_name="Higado",
        clinical_name="Liver",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=("liver",),
        color=(0, 102, 204),
    ),
    "spleen": StructureDefinition(
        request_key="spleen",
        display_name="Bazo",
        clinical_name="Spleen",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=("spleen",),
        color=(0, 153, 255),
    ),
    "kidney_right": StructureDefinition(
        request_key="kidney_right",
        display_name="Rinon derecho",
        clinical_name="Kidney_R",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=("kidney_right",),
        color=(51, 153, 255),
    ),
    "kidney_left": StructureDefinition(
        request_key="kidney_left",
        display_name="Rinon izquierdo",
        clinical_name="Kidney_L",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=("kidney_left",),
        color=(102, 178, 255),
    ),
    "pancreas": StructureDefinition(
        request_key="pancreas",
        display_name="Pancreas",
        clinical_name="Pancreas",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=("pancreas",),
        color=(0, 128, 255),
    ),
    "gallbladder": StructureDefinition(
        request_key="gallbladder",
        display_name="Vesicula biliar",
        clinical_name="Gallbladder",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=("gallbladder",),
        color=(0, 204, 204),
    ),
    "aorta_abdominal": StructureDefinition(
        request_key="aorta_abdominal",
        display_name="Aorta abdominal",
        clinical_name="Aorta",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=("aorta",),
        color=(255, 64, 64),
    ),
    "stomach": StructureDefinition(
        request_key="stomach",
        display_name="Estomago",
        clinical_name="Stomach",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=("stomach",),
        color=(255, 153, 51),
    ),
    "intestine": StructureDefinition(
        request_key="intestine",
        display_name="Intestino",
        clinical_name="Bowel",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=("small_bowel", "colon"),
        color=(255, 204, 0),
    ),
    "brain": StructureDefinition(
        request_key="brain",
        display_name="Cerebro completo",
        clinical_name="Brain",
        model=MODEL_MONAI_UNEST,
        roi_names=(),
        color=(204, 102, 255),
    ),
    "prostate": StructureDefinition(
        request_key="prostate",
        display_name="Prostata",
        clinical_name="Prostate",
        model=MODEL_NNUNET_PELVIS,
        roi_names=(),
        color=(255, 153, 153),
    ),
    "penile_bulb": StructureDefinition(
        request_key="penile_bulb",
        display_name="Bulbo peneano",
        clinical_name="PenileBulb",
        model=MODEL_NNUNET_PELVIS,
        roi_names=(),
        color=(255, 102, 102),
    ),
    "lymph_nodes_pelvis": StructureDefinition(
        request_key="lymph_nodes_pelvis",
        display_name="Ganglios pelvicos",
        clinical_name="PelvicLymphNodes",
        model=MODEL_NNUNET_PELVIS,
        roi_names=(),
        color=(255, 204, 153),
    ),
}


MODEL_LABELS = {
    MODEL_TOTALSEGMENTATOR: "TotalSegmentator V2",
    MODEL_MONAI_UNEST: "MONAI UNesT",
    MODEL_NNUNET_PELVIS: "nnU-Net Pelvis",
}


MVP_STRUCTURE_KEYS = (
    "liver",
    "spleen",
    "kidney_right",
    "kidney_left",
    "pancreas",
)

