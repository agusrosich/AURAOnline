from __future__ import annotations

from dataclasses import dataclass


MODEL_TOTALSEGMENTATOR = "totalsegmentator"
MODEL_TOTALSEG_HEAD_GLANDS = "totalseg_head_glands_cavities"
MODEL_TOTALSEG_HEAD_MUSCLES = "totalseg_head_muscles"
MODEL_TOTALSEG_HEADNECK_BONES = "totalseg_headneck_bones_vessels"
MODEL_TOTALSEG_HEADNECK_MUSCLES = "totalseg_headneck_muscles"
MODEL_TOTALSEG_BRAIN = "totalseg_brain_structures"
MODEL_MONAI_UNEST = "monai_unest"
MODEL_NNUNET_PELVIS = "nnunet_pelvis"

# Mapeo de constante de modelo -> task_name de TotalSegmentator
TOTALSEG_TASK_MAP: dict[str, str] = {
    MODEL_TOTALSEGMENTATOR:        "total",
    MODEL_TOTALSEG_HEAD_GLANDS:    "head_glands_cavities",
    MODEL_TOTALSEG_HEAD_MUSCLES:   "head_muscles",
    MODEL_TOTALSEG_HEADNECK_BONES: "headneck_bones_vessels",
    MODEL_TOTALSEG_HEADNECK_MUSCLES: "headneck_muscles",
    MODEL_TOTALSEG_BRAIN:          "brain_structures",
}


@dataclass(frozen=True)
class StructureDefinition:
    request_key: str
    display_name: str
    clinical_name: str
    model: str
    roi_names: tuple[str, ...]
    color: tuple[int, int, int]


RIGHT_LUNG_ROIS = (
    "lung_upper_lobe_right",
    "lung_middle_lobe_right",
    "lung_lower_lobe_right",
)

LEFT_LUNG_ROIS = (
    "lung_upper_lobe_left",
    "lung_lower_lobe_left",
)

VERTEBRAE_ROIS = (
    "vertebrae_C1",
    "vertebrae_C2",
    "vertebrae_C3",
    "vertebrae_C4",
    "vertebrae_C5",
    "vertebrae_C6",
    "vertebrae_C7",
    "vertebrae_T1",
    "vertebrae_T2",
    "vertebrae_T3",
    "vertebrae_T4",
    "vertebrae_T5",
    "vertebrae_T6",
    "vertebrae_T7",
    "vertebrae_T8",
    "vertebrae_T9",
    "vertebrae_T10",
    "vertebrae_T11",
    "vertebrae_T12",
    "vertebrae_L1",
    "vertebrae_L2",
    "vertebrae_L3",
    "vertebrae_L4",
    "vertebrae_L5",
)

PELVIS_BONE_ROIS = (
    "hip_left",
    "hip_right",
    "sacrum",
)

FEMUR_ROIS = (
    "femur_left",
    "femur_right",
)

RIB_ROIS = tuple(
    [f"rib_left_{index}" for index in range(1, 13)]
    + [f"rib_right_{index}" for index in range(1, 13)]
)


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
    "lung_right": StructureDefinition(
        request_key="lung_right",
        display_name="Pulmon derecho",
        clinical_name="Lung_R",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=RIGHT_LUNG_ROIS,
        color=(102, 204, 255),
    ),
    "lung_left": StructureDefinition(
        request_key="lung_left",
        display_name="Pulmon izquierdo",
        clinical_name="Lung_L",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=LEFT_LUNG_ROIS,
        color=(51, 153, 204),
    ),
    "heart": StructureDefinition(
        request_key="heart",
        display_name="Corazon",
        clinical_name="Heart",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=("heart",),
        color=(255, 80, 80),
    ),
    "trachea": StructureDefinition(
        request_key="trachea",
        display_name="Traquea",
        clinical_name="Trachea",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=("trachea",),
        color=(102, 255, 204),
    ),
    "esophagus": StructureDefinition(
        request_key="esophagus",
        display_name="Esofago",
        clinical_name="Esophagus",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=("esophagus",),
        color=(255, 170, 102),
    ),
    "vertebrae": StructureDefinition(
        request_key="vertebrae",
        display_name="Vertebras",
        clinical_name="Vertebrae",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=VERTEBRAE_ROIS,
        color=(210, 180, 140),
    ),
    "pelvis_bone": StructureDefinition(
        request_key="pelvis_bone",
        display_name="Pelvis osea",
        clinical_name="Pelvis_Bone",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=PELVIS_BONE_ROIS,
        color=(196, 164, 132),
    ),
    "femurs": StructureDefinition(
        request_key="femurs",
        display_name="Femures",
        clinical_name="Femurs",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=FEMUR_ROIS,
        color=(184, 134, 11),
    ),
    "ribs": StructureDefinition(
        request_key="ribs",
        display_name="Costillas",
        clinical_name="Ribs",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=RIB_ROIS,
        color=(222, 184, 135),
    ),
    "brain": StructureDefinition(
        request_key="brain",
        display_name="Cerebro completo",
        clinical_name="Brain",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=("brain",),
        color=(204, 102, 255),
    ),
    "prostate": StructureDefinition(
        request_key="prostate",
        display_name="Prostata",
        clinical_name="Prostate",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=("prostate",),
        color=(255, 153, 153),
    ),
    "bladder": StructureDefinition(
        request_key="bladder",
        display_name="Vejiga",
        clinical_name="Bladder",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=("urinary_bladder",),
        color=(255, 230, 128),
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
    # ── Médula espinal (total task) ──────────────────────────────────────
    "spinal_cord": StructureDefinition(
        request_key="spinal_cord",
        display_name="Medula espinal",
        clinical_name="SpinalCord",
        model=MODEL_TOTALSEGMENTATOR,
        roi_names=("spinal_cord",),
        color=(255, 255, 153),
    ),
    # ── H&N: glándulas y cavidades (subtask head_glands_cavities) ────────
    "parotid_right": StructureDefinition(
        request_key="parotid_right",
        display_name="Parotida derecha",
        clinical_name="Parotid_R",
        model=MODEL_TOTALSEG_HEAD_GLANDS,
        roi_names=("parotid_gland_right",),
        color=(255, 178, 102),
    ),
    "parotid_left": StructureDefinition(
        request_key="parotid_left",
        display_name="Parotida izquierda",
        clinical_name="Parotid_L",
        model=MODEL_TOTALSEG_HEAD_GLANDS,
        roi_names=("parotid_gland_left",),
        color=(255, 204, 128),
    ),
    "submandibular_right": StructureDefinition(
        request_key="submandibular_right",
        display_name="Submaxilar derecha",
        clinical_name="Submandibular_R",
        model=MODEL_TOTALSEG_HEAD_GLANDS,
        roi_names=("submandibular_gland_right",),
        color=(255, 153, 51),
    ),
    "submandibular_left": StructureDefinition(
        request_key="submandibular_left",
        display_name="Submaxilar izquierda",
        clinical_name="Submandibular_L",
        model=MODEL_TOTALSEG_HEAD_GLANDS,
        roi_names=("submandibular_gland_left",),
        color=(255, 178, 77),
    ),
    "eye_right": StructureDefinition(
        request_key="eye_right",
        display_name="Ojo derecho",
        clinical_name="Eye_R",
        model=MODEL_TOTALSEG_HEAD_GLANDS,
        roi_names=("eye_right",),
        color=(153, 255, 153),
    ),
    "eye_left": StructureDefinition(
        request_key="eye_left",
        display_name="Ojo izquierdo",
        clinical_name="Eye_L",
        model=MODEL_TOTALSEG_HEAD_GLANDS,
        roi_names=("eye_left",),
        color=(102, 255, 102),
    ),
    "lens_right": StructureDefinition(
        request_key="lens_right",
        display_name="Cristalino derecho",
        clinical_name="Lens_R",
        model=MODEL_TOTALSEG_HEAD_GLANDS,
        roi_names=("eye_lens_right",),
        color=(204, 255, 204),
    ),
    "lens_left": StructureDefinition(
        request_key="lens_left",
        display_name="Cristalino izquierdo",
        clinical_name="Lens_L",
        model=MODEL_TOTALSEG_HEAD_GLANDS,
        roi_names=("eye_lens_left",),
        color=(178, 255, 178),
    ),
    "optic_nerve_right": StructureDefinition(
        request_key="optic_nerve_right",
        display_name="Nervio optico derecho",
        clinical_name="OpticNerve_R",
        model=MODEL_TOTALSEG_HEAD_GLANDS,
        roi_names=("optic_nerve_right",),
        color=(255, 255, 102),
    ),
    "optic_nerve_left": StructureDefinition(
        request_key="optic_nerve_left",
        display_name="Nervio optico izquierdo",
        clinical_name="OpticNerve_L",
        model=MODEL_TOTALSEG_HEAD_GLANDS,
        roi_names=("optic_nerve_left",),
        color=(255, 255, 51),
    ),
    "nasopharynx": StructureDefinition(
        request_key="nasopharynx",
        display_name="Nasofaringe",
        clinical_name="Nasopharynx",
        model=MODEL_TOTALSEG_HEAD_GLANDS,
        roi_names=("nasopharynx",),
        color=(204, 153, 255),
    ),
    "oropharynx": StructureDefinition(
        request_key="oropharynx",
        display_name="Orofaringe",
        clinical_name="Oropharynx",
        model=MODEL_TOTALSEG_HEAD_GLANDS,
        roi_names=("oropharynx",),
        color=(178, 102, 255),
    ),
    "hypopharynx": StructureDefinition(
        request_key="hypopharynx",
        display_name="Hipofaringe",
        clinical_name="Hypopharynx",
        model=MODEL_TOTALSEG_HEAD_GLANDS,
        roi_names=("hypopharynx",),
        color=(153, 51, 255),
    ),
    # ── H&N: músculos de cabeza (subtask head_muscles) ───────────────────
    "masseter_right": StructureDefinition(
        request_key="masseter_right",
        display_name="Massetero derecho",
        clinical_name="Masseter_R",
        model=MODEL_TOTALSEG_HEAD_MUSCLES,
        roi_names=("masseter_right",),
        color=(255, 102, 178),
    ),
    "masseter_left": StructureDefinition(
        request_key="masseter_left",
        display_name="Massetero izquierdo",
        clinical_name="Masseter_L",
        model=MODEL_TOTALSEG_HEAD_MUSCLES,
        roi_names=("masseter_left",),
        color=(255, 51, 153),
    ),
    "tongue": StructureDefinition(
        request_key="tongue",
        display_name="Lengua",
        clinical_name="Tongue",
        model=MODEL_TOTALSEG_HEAD_MUSCLES,
        roi_names=("tongue",),
        color=(255, 102, 102),
    ),
    # ── H&N: huesos y vasos (subtask headneck_bones_vessels) ─────────────
    "larynx": StructureDefinition(
        request_key="larynx",
        display_name="Laringe",
        clinical_name="Larynx",
        model=MODEL_TOTALSEG_HEADNECK_BONES,
        roi_names=("larynx_air",),
        color=(153, 204, 255),
    ),
    "thyroid_cartilage": StructureDefinition(
        request_key="thyroid_cartilage",
        display_name="Cartilago tiroides",
        clinical_name="ThyroidCartilage",
        model=MODEL_TOTALSEG_HEADNECK_BONES,
        roi_names=("thyroid_cartilage",),
        color=(178, 216, 255),
    ),
    # ── H&N: músculos de cuello (subtask headneck_muscles) ───────────────
    "sternocleidomastoid_right": StructureDefinition(
        request_key="sternocleidomastoid_right",
        display_name="Esternocleidomastoideo D",
        clinical_name="SCM_R",
        model=MODEL_TOTALSEG_HEADNECK_MUSCLES,
        roi_names=("sternocleidomastoid_right",),
        color=(204, 255, 229),
    ),
    "sternocleidomastoid_left": StructureDefinition(
        request_key="sternocleidomastoid_left",
        display_name="Esternocleidomastoideo I",
        clinical_name="SCM_L",
        model=MODEL_TOTALSEG_HEADNECK_MUSCLES,
        roi_names=("sternocleidomastoid_left",),
        color=(153, 255, 204),
    ),
    "pharyngeal_constrictor": StructureDefinition(
        request_key="pharyngeal_constrictor",
        display_name="Constrictores faringeos",
        clinical_name="PharyngealConstrictor",
        model=MODEL_TOTALSEG_HEADNECK_MUSCLES,
        roi_names=(
            "superior_pharyngeal_constrictor",
            "middle_pharyngeal_constrictor",
            "inferior_pharyngeal_constrictor",
        ),
        color=(102, 255, 178),
    ),
    # ── Tronco cerebral (subtask brain_structures) ───────────────────────
    "brainstem": StructureDefinition(
        request_key="brainstem",
        display_name="Tronco cerebral",
        clinical_name="Brainstem",
        model=MODEL_TOTALSEG_BRAIN,
        roi_names=("brainstem",),
        color=(178, 102, 204),
    ),
}


MODEL_LABELS = {
    MODEL_TOTALSEGMENTATOR:          "TotalSegmentator V2",
    MODEL_TOTALSEG_HEAD_GLANDS:      "TotalSegmentator V2 (Head Glands)",
    MODEL_TOTALSEG_HEAD_MUSCLES:     "TotalSegmentator V2 (Head Muscles)",
    MODEL_TOTALSEG_HEADNECK_BONES:   "TotalSegmentator V2 (HeadNeck Bones)",
    MODEL_TOTALSEG_HEADNECK_MUSCLES: "TotalSegmentator V2 (HeadNeck Muscles)",
    MODEL_TOTALSEG_BRAIN:            "TotalSegmentator V2 (Brain)",
    MODEL_MONAI_UNEST:               "MONAI UNesT",
    MODEL_NNUNET_PELVIS:             "nnU-Net Pelvis",
}


MVP_STRUCTURE_KEYS = (
    "liver",
    "spleen",
    "kidney_right",
    "kidney_left",
    "pancreas",
)
