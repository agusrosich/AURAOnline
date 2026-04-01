export const structureGroups = [
  {
    id: "abdomen",
    label: "Abdomen",
    items: [
      { key: "liver", label: "Higado", status: "ready" },
      { key: "spleen", label: "Bazo", status: "ready" },
      { key: "kidney_right", label: "Rinon D", status: "ready" },
      { key: "kidney_left", label: "Rinon I", status: "ready" },
      { key: "pancreas", label: "Pancreas", status: "ready" },
      { key: "gallbladder", label: "Vesicula", status: "ready" },
      { key: "aorta_abdominal", label: "Aorta abdominal", status: "ready" },
      { key: "stomach", label: "Estomago", status: "ready" },
      { key: "intestine", label: "Intestino", status: "ready" },
    ],
  },
  {
    id: "thorax",
    label: "Torax",
    items: [
      { key: "lung_right", label: "Pulmon D", status: "planned" },
      { key: "lung_left", label: "Pulmon I", status: "planned" },
      { key: "heart", label: "Corazon", status: "planned" },
      { key: "trachea", label: "Traquea", status: "planned" },
      { key: "esophagus", label: "Esofago", status: "planned" },
    ],
  },
  {
    id: "skeleton",
    label: "Esqueleto",
    items: [
      { key: "vertebrae", label: "Vertebras", status: "planned" },
      { key: "pelvis_bone", label: "Pelvis osea", status: "planned" },
      { key: "femurs", label: "Femures", status: "planned" },
      { key: "ribs", label: "Costillas", status: "planned" },
    ],
  },
  {
    id: "pelvis",
    label: "Pelvis masculina",
    items: [
      { key: "prostate", label: "Prostata", status: "planned" },
      { key: "seminal_vesicles", label: "Vesiculas seminales", status: "planned" },
      { key: "penile_bulb", label: "Bulbo peneano", status: "planned" },
      { key: "lymph_nodes_pelvis", label: "Ganglios pelvicos", status: "planned" },
      { key: "rectum", label: "Recto", status: "planned" },
      { key: "bladder", label: "Vejiga", status: "planned" },
    ],
  },
  {
    id: "neuro",
    label: "Neurologico",
    items: [
      { key: "brain", label: "Cerebro completo", status: "planned" },
      { key: "brainstem", label: "Tronco encefalico", status: "planned" },
      { key: "cerebellum", label: "Cerebelo", status: "planned" },
    ],
  },
];

export const presets = [
  { id: "abdomen-complete", label: "Abdomen completo", keys: ["liver", "spleen", "kidney_right", "kidney_left", "pancreas", "gallbladder", "aorta_abdominal", "stomach", "intestine"] },
  { id: "abdomen-core", label: "Abdomen MVP", keys: ["liver", "spleen", "kidney_right", "kidney_left", "pancreas"] },
  { id: "prostate-standard", label: "Prostata estandar", keys: ["prostate", "penile_bulb", "lymph_nodes_pelvis"] },
  { id: "lung-standard", label: "Pulmon estandar", keys: ["lung_right", "lung_left", "heart", "esophagus", "trachea"] },
  { id: "craneo", label: "Craneo", keys: ["brain", "brainstem", "cerebellum"] },
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
  { label: "Dicom folder upload en navegador", status: "done" },
  { label: "Segmentacion abdominal MVP", status: "in-progress" },
  { label: "Integracion MONAI UNesT", status: "planned" },
  { label: "Integracion nnU-Net pelvis", status: "planned" },
];

