export const structureGroups = [
  {
    id: "abdomen",
    label: "Abdomen",
    items: [
      { key: "liver", label: "Higado", clinicalName: "Liver", status: "ready" },
      { key: "spleen", label: "Bazo", clinicalName: "Spleen", status: "ready" },
      { key: "kidney_right", label: "Rinon D", clinicalName: "Kidney_R", status: "ready" },
      { key: "kidney_left", label: "Rinon I", clinicalName: "Kidney_L", status: "ready" },
      { key: "pancreas", label: "Pancreas", clinicalName: "Pancreas", status: "ready" },
      { key: "gallbladder", label: "Vesicula", clinicalName: "Gallbladder", status: "ready" },
      { key: "aorta_abdominal", label: "Aorta abdominal", clinicalName: "Aorta", status: "ready" },
      { key: "stomach", label: "Estomago", clinicalName: "Stomach", status: "ready" },
      { key: "intestine", label: "Intestino", clinicalName: "Bowel", status: "ready" },
    ],
  },
  {
    id: "thorax",
    label: "Torax",
    items: [
      { key: "lung_right", label: "Pulmon D", clinicalName: "Lung_R", status: "ready" },
      { key: "lung_left", label: "Pulmon I", clinicalName: "Lung_L", status: "ready" },
      { key: "heart", label: "Corazon", clinicalName: "Heart", status: "ready" },
      { key: "trachea", label: "Traquea", clinicalName: "Trachea", status: "ready" },
      { key: "esophagus", label: "Esofago", clinicalName: "Esophagus", status: "ready" },
    ],
  },
  {
    id: "skeleton",
    label: "Esqueleto",
    items: [
      { key: "vertebrae", label: "Vertebras", clinicalName: "Vertebrae", status: "ready" },
      { key: "pelvis_bone", label: "Pelvis osea", clinicalName: "Pelvis_Bone", status: "ready" },
      { key: "femurs", label: "Femures", clinicalName: "Femurs", status: "ready" },
      { key: "ribs", label: "Costillas", clinicalName: "Ribs", status: "ready" },
    ],
  },
  {
    id: "pelvis",
    label: "Pelvis masculina",
    items: [
      { key: "prostate", label: "Prostata", clinicalName: "Prostate", status: "ready" },
      { key: "seminal_vesicles", label: "Vesiculas seminales", status: "planned" },
      { key: "penile_bulb", label: "Bulbo peneano", status: "planned" },
      { key: "lymph_nodes_pelvis", label: "Ganglios pelvicos", status: "planned" },
      { key: "rectum", label: "Recto", status: "planned" },
      { key: "bladder", label: "Vejiga", clinicalName: "Bladder", status: "ready" },
    ],
  },
  {
    id: "neuro",
    label: "Neurologico",
    items: [
      { key: "brain", label: "Cerebro completo", clinicalName: "Brain", status: "ready" },
      { key: "brainstem", label: "Tronco encefalico", status: "planned" },
      { key: "cerebellum", label: "Cerebelo", status: "planned" },
    ],
  },
];

export const presets = [
  { id: "abdomen-complete", label: "Abdomen completo", keys: ["liver", "spleen", "kidney_right", "kidney_left", "pancreas", "gallbladder", "aorta_abdominal", "stomach", "intestine"] },
  { id: "abdomen-core", label: "Abdomen MVP", keys: ["liver", "spleen", "kidney_right", "kidney_left", "pancreas"] },
  { id: "prostate-standard", label: "Pelvis basica", keys: ["prostate", "bladder"] },
  { id: "lung-standard", label: "Pulmon estandar", keys: ["lung_right", "lung_left", "heart", "esophagus", "trachea"] },
  { id: "craneo", label: "Cerebro", keys: ["brain"] },
];

export const referenceDsc = {
  Liver: "0.95 esperado",
  Spleen: "0.94 esperado",
  Kidney_R: "0.93 esperado",
  Kidney_L: "0.93 esperado",
  Pancreas: "0.83 esperado",
  Gallbladder: "0.82 esperado",
  Aorta: "0.92 esperado",
  Stomach: "0.86 esperado",
  Bowel: "0.78 esperado",
};

export const roadmapProgress = [
  { label: "Backend MVP FastAPI", status: "done" },
  { label: "Cliente web WhiteSur", status: "done" },
  { label: "Metadata y preview DICOM", status: "done" },
  { label: "Presets locales", status: "done" },
  { label: "Resultados e historial local", status: "done" },
  { label: "Segmentacion abdominal MVP", status: "in-progress" },
  { label: "Integracion nnU-Net pelvis", status: "planned" },
];
