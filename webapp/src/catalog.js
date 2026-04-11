// Catálogo completo de estructuras AURA-RT
// Alineado con constants.py del backend
// Nomenclatura: TG-263 (AAPM 2018) / ICRU 83

export const structureGroups = [
  // ── ABDOMEN ─────────────────────────────────────────────────────────
  {
    id: "abdomen",
    label: "Abdomen",
    items: [
      { key: "liver",            label: "Hígado",              clinicalName: "Liver",       status: "ready" },
      { key: "spleen",           label: "Bazo",                clinicalName: "Spleen",      status: "ready" },
      { key: "kidney_right",     label: "Riñón D",             clinicalName: "Kidney_R",    status: "ready" },
      { key: "kidney_left",      label: "Riñón I",             clinicalName: "Kidney_L",    status: "ready" },
      { key: "pancreas",         label: "Páncreas",            clinicalName: "Pancreas",    status: "ready" },
      { key: "gallbladder",      label: "Vesícula biliar",     clinicalName: "Gallbladder", status: "ready" },
      { key: "stomach",          label: "Estómago",            clinicalName: "Stomach",     status: "ready" },
      { key: "intestine",        label: "Intestino (SB+Col)",  clinicalName: "Bowel",       status: "ready" },
      { key: "duodenum",         label: "Duodeno",             clinicalName: "Duodenum",    status: "ready" },
      { key: "adrenal_right",    label: "Suprarrenal D",       clinicalName: "Adrenal_R",   status: "ready" },
      { key: "adrenal_left",     label: "Suprarrenal I",       clinicalName: "Adrenal_L",   status: "ready" },
      { key: "abdominal_cavity", label: "Cavidad abdominal",   clinicalName: "CavityAbdom", status: "ready" },
    ],
  },
  // ── HÍGADO — SEGMENTOS COUINAUD ──────────────────────────────────────
  {
    id: "liver_segments",
    label: "Segmentos hepáticos (Couinaud)",
    items: [
      { key: "liver_seg_1", label: "Segmento I",    clinicalName: "Liver_Seg1", status: "ready" },
      { key: "liver_seg_2", label: "Segmento II",   clinicalName: "Liver_Seg2", status: "ready" },
      { key: "liver_seg_3", label: "Segmento III",  clinicalName: "Liver_Seg3", status: "ready" },
      { key: "liver_seg_4", label: "Segmento IV",   clinicalName: "Liver_Seg4", status: "ready" },
      { key: "liver_seg_5", label: "Segmento V",    clinicalName: "Liver_Seg5", status: "ready" },
      { key: "liver_seg_6", label: "Segmento VI",   clinicalName: "Liver_Seg6", status: "ready" },
      { key: "liver_seg_7", label: "Segmento VII",  clinicalName: "Liver_Seg7", status: "ready" },
      { key: "liver_seg_8", label: "Segmento VIII", clinicalName: "Liver_Seg8", status: "ready" },
    ],
  },
  // ── TÓRAX ────────────────────────────────────────────────────────────
  {
    id: "thorax",
    label: "Tórax",
    items: [
      { key: "lung_right",       label: "Pulmón D",             clinicalName: "Lung_R",          status: "ready" },
      { key: "lung_left",        label: "Pulmón I",             clinicalName: "Lung_L",          status: "ready" },
      { key: "heart",            label: "Corazón",              clinicalName: "Heart",           status: "ready" },
      { key: "trachea",          label: "Tráquea",              clinicalName: "Trachea",         status: "ready" },
      { key: "esophagus",        label: "Esófago",              clinicalName: "Esophagus",       status: "ready" },
      { key: "aorta_abdominal",  label: "Aorta",                clinicalName: "Aorta",           status: "ready" },
      { key: "vena_cava_sup",    label: "VCS",                  clinicalName: "V_Cava_Sup",      status: "ready" },
      { key: "vena_cava_inf",    label: "VCI",                  clinicalName: "V_Cava_Inf",      status: "ready" },
      { key: "pulmonary_vein",   label: "Venas pulmonares",     clinicalName: "V_Pulmonary",     status: "ready" },
      { key: "pericardium",      label: "Pericardio",           clinicalName: "Pericardium",     status: "ready" },
      { key: "thymus",           label: "Timo",                 clinicalName: "Thymus",          status: "ready" },
      { key: "mediastinum",      label: "Mediastino",           clinicalName: "Mediastinum",     status: "ready" },
      { key: "thoracic_cavity",  label: "Cavidad torácica",     clinicalName: "CavityThoracic",  status: "ready" },
      { key: "lung_vessels",     label: "Vasos pulmonares",     clinicalName: "LungVessels",     status: "ready" },
      { key: "lung_bronchia",    label: "Árbol bronquial",      clinicalName: "Bronchia",        status: "ready" },
    ],
  },
  // ── ESQUELETO ────────────────────────────────────────────────────────
  {
    id: "skeleton",
    label: "Esqueleto",
    items: [
      { key: "vertebrae",       label: "Vértebras",        clinicalName: "Vertebrae",    status: "ready" },
      { key: "pelvis_bone",     label: "Pelvis ósea",      clinicalName: "Pelvis_Bone",  status: "ready" },
      { key: "femurs",          label: "Fémures",          clinicalName: "Femurs",       status: "ready" },
      { key: "ribs",            label: "Costillas",        clinicalName: "Ribs",         status: "ready" },
      { key: "skull",           label: "Cráneo",           clinicalName: "Skull",        status: "ready" },
      { key: "clavicle_right",  label: "Clavícula D",      clinicalName: "Clavicle_R",   status: "ready" },
      { key: "clavicle_left",   label: "Clavícula I",      clinicalName: "Clavicle_L",   status: "ready" },
      { key: "humerus_right",   label: "Húmero D",         clinicalName: "HumeralHead_R",status: "ready" },
      { key: "humerus_left",    label: "Húmero I",         clinicalName: "HumeralHead_L",status: "ready" },
      { key: "mandible",        label: "Mandíbula",        clinicalName: "Mandible",     status: "ready" },
    ],
  },
  // ── VASOS ABDOMINOPÉLVICOS ───────────────────────────────────────────
  {
    id: "vessels",
    label: "Vasos abdominopélvicos",
    items: [
      { key: "portal_vein",       label: "V. porta/esplénica", clinicalName: "V_Portal",   status: "ready" },
      { key: "iliac_artery_right",label: "A. ilíaca D",        clinicalName: "A_Iliac_R",  status: "ready" },
      { key: "iliac_artery_left", label: "A. ilíaca I",        clinicalName: "A_Iliac_L",  status: "ready" },
      { key: "iliac_vein_right",  label: "V. ilíaca D",        clinicalName: "V_Iliac_R",  status: "ready" },
      { key: "iliac_vein_left",   label: "V. ilíaca I",        clinicalName: "V_Iliac_L",  status: "ready" },
    ],
  },
  // ── PELVIS MASCULINA ─────────────────────────────────────────────────
  {
    id: "pelvis_m",
    label: "Pelvis masculina",
    items: [
      { key: "prostate",          label: "Próstata",             clinicalName: "Prostate",        status: "ready" },
      { key: "bladder",           label: "Vejiga",               clinicalName: "Bladder",         status: "ready" },
      { key: "penile_bulb",       label: "Bulbo peneano",        clinicalName: "PenileBulb",      status: "planned" },
      { key: "lymph_nodes_pelvis",label: "Ganglios pélvicos",    clinicalName: "PelvicLymphNodes",status: "planned" },
    ],
  },
  // ── PELVIS FEMENINA ──────────────────────────────────────────────────
  {
    id: "pelvis_f",
    label: "Pelvis femenina",
    items: [
      { key: "uterus",   label: "Útero",   clinicalName: "Uterus",  status: "ready" },
    ],
  },
  // ── CABEZA Y CUELLO — GLÁNDULAS Y CAVIDADES ──────────────────────────
  {
    id: "hn_glands",
    label: "H&N — Glándulas y cavidades",
    items: [
      { key: "parotid_right",        label: "Parótida D",           clinicalName: "Parotid_R",     status: "ready" },
      { key: "parotid_left",         label: "Parótida I",           clinicalName: "Parotid_L",     status: "ready" },
      { key: "submandibular_right",  label: "Submaxilar D",         clinicalName: "Submand_R",     status: "ready" },
      { key: "submandibular_left",   label: "Submaxilar I",         clinicalName: "Submand_L",     status: "ready" },
      { key: "eye_right",            label: "Ojo D",                clinicalName: "Eye_R",         status: "ready" },
      { key: "eye_left",             label: "Ojo I",                clinicalName: "Eye_L",         status: "ready" },
      { key: "lens_right",           label: "Cristalino D",         clinicalName: "Lens_R",        status: "ready" },
      { key: "lens_left",            label: "Cristalino I",         clinicalName: "Lens_L",        status: "ready" },
      { key: "optic_nerve_right",    label: "N. óptico D",          clinicalName: "OpticNrv_R",    status: "ready" },
      { key: "optic_nerve_left",     label: "N. óptico I",          clinicalName: "OpticNrv_L",    status: "ready" },
      { key: "nasopharynx",          label: "Nasofaringe",          clinicalName: "Nasopharynx",   status: "ready" },
      { key: "oropharynx",           label: "Orofaringe",           clinicalName: "Oropharynx",    status: "ready" },
      { key: "hypopharynx",          label: "Hipofaringe",          clinicalName: "Hypopharynx",   status: "ready" },
      { key: "nasal_cavity_right",   label: "Fosa nasal D",         clinicalName: "NasalCavity_R", status: "ready" },
      { key: "nasal_cavity_left",    label: "Fosa nasal I",         clinicalName: "NasalCavity_L", status: "ready" },
      { key: "auditory_canal_right", label: "Cond. auditivo D",     clinicalName: "AudCanal_R",    status: "ready" },
      { key: "auditory_canal_left",  label: "Cond. auditivo I",     clinicalName: "AudCanal_L",    status: "ready" },
      { key: "soft_palate",          label: "Paladar blando",       clinicalName: "Palate_Soft",   status: "ready" },
      { key: "hard_palate",          label: "Paladar duro",         clinicalName: "Palate_Hard",   status: "ready" },
      { key: "thyroid_gland",        label: "Tiroides",             clinicalName: "Thyroid",       status: "ready" },
    ],
  },
  // ── CABEZA Y CUELLO — HUESOS Y VASOS ────────────────────────────────
  {
    id: "hn_bones",
    label: "H&N — Huesos y vasos",
    items: [
      { key: "larynx",               label: "Laringe",              clinicalName: "Larynx",        status: "ready" },
      { key: "thyroid_cartilage",    label: "Cartíl. tiroideo",     clinicalName: "Cricoid",       status: "ready" },
      { key: "hyoid",                label: "Hioides",              clinicalName: "Hyoid",         status: "ready" },
      { key: "cricoid_cartilage",    label: "Cricoides",            clinicalName: "Cricoid",       status: "ready" },
      { key: "zygomatic_arch_right", label: "Arco cigomático D",    clinicalName: "ZygArch_R",     status: "ready" },
      { key: "zygomatic_arch_left",  label: "Arco cigomático I",    clinicalName: "ZygArch_L",     status: "ready" },
      { key: "carotid_right",        label: "A. carótida int. D",   clinicalName: "A_Carotid_R",   status: "ready" },
      { key: "carotid_left",         label: "A. carótida int. I",   clinicalName: "A_Carotid_L",   status: "ready" },
      { key: "jugular_right",        label: "V. yugular int. D",    clinicalName: "V_Jugular_R",   status: "ready" },
      { key: "jugular_left",         label: "V. yugular int. I",    clinicalName: "V_Jugular_L",   status: "ready" },
    ],
  },
  // ── CABEZA Y CUELLO — MÚSCULOS ───────────────────────────────────────
  {
    id: "hn_muscles",
    label: "H&N — Músculos",
    items: [
      { key: "masseter_right",         label: "Masetero D",          clinicalName: "Musc_Masseter_R",      status: "ready" },
      { key: "masseter_left",          label: "Masetero I",          clinicalName: "Musc_Masseter_L",      status: "ready" },
      { key: "temporalis_right",       label: "Temporal D",          clinicalName: "Musc_Temporalis_R",    status: "ready" },
      { key: "temporalis_left",        label: "Temporal I",          clinicalName: "Musc_Temporalis_L",    status: "ready" },
      { key: "lat_pterygoid_right",    label: "Pterigoideo lat. D",  clinicalName: "Musc_LPterygoid_R",    status: "ready" },
      { key: "lat_pterygoid_left",     label: "Pterigoideo lat. I",  clinicalName: "Musc_LPterygoid_L",    status: "ready" },
      { key: "med_pterygoid_right",    label: "Pterigoideo med. D",  clinicalName: "Musc_MPterygoid_R",    status: "ready" },
      { key: "med_pterygoid_left",     label: "Pterigoideo med. I",  clinicalName: "Musc_MPterygoid_L",    status: "ready" },
      { key: "digastric_right",        label: "Digástrico D",        clinicalName: "Musc_Digastric_R",     status: "ready" },
      { key: "digastric_left",         label: "Digástrico I",        clinicalName: "Musc_Digastric_L",     status: "ready" },
      { key: "tongue",                 label: "Lengua",              clinicalName: "Tongue",               status: "ready" },
      { key: "sternocleidomastoid_right",label:"ECM D",              clinicalName: "Musc_Scleidomast_R",   status: "ready" },
      { key: "sternocleidomastoid_left", label:"ECM I",              clinicalName: "Musc_Scleidomast_L",   status: "ready" },
      { key: "pharyngeal_constrictor", label: "Const. faríngeos",    clinicalName: "Musc_Constrict",       status: "ready" },
      { key: "platysma_right",         label: "Platisma D",          clinicalName: "Musc_Platysma_R",      status: "ready" },
      { key: "platysma_left",          label: "Platisma I",          clinicalName: "Musc_Platysma_L",      status: "ready" },
      { key: "trapezius_hn_right",     label: "Trapecio D",          clinicalName: "Musc_Trapezius_R",     status: "ready" },
      { key: "trapezius_hn_left",      label: "Trapecio I",          clinicalName: "Musc_Trapezius_L",     status: "ready" },
    ],
  },
  // ── NEUROLÓGICO ──────────────────────────────────────────────────────
  {
    id: "neuro",
    label: "Neurológico",
    items: [
      { key: "brain",      label: "Cerebro",      clinicalName: "Brain",      status: "ready" },
      { key: "brainstem",  label: "Tronco cerebral",clinicalName: "Brainstem", status: "ready" },
      { key: "cerebellum", label: "Cerebelo",     clinicalName: "Cerebellum", status: "ready" },
      { key: "thalamus",   label: "Tálamo",       clinicalName: "Thalamus",   status: "ready" },
      { key: "hippocampus",label: "Hipocampo",    clinicalName: "Hippocampus",status: "ready" },
      { key: "ventricle",  label: "Ventrículos",  clinicalName: "Ventricle",  status: "ready" },
      { key: "spinal_cord",label: "Médula espinal",clinicalName: "SpinalCord",status: "ready" },
    ],
  },
];

export const presets = [
  {
    id: "abdomen-complete",
    label: "Abdomen completo",
    keys: ["liver","spleen","kidney_right","kidney_left","pancreas","gallbladder","aorta_abdominal","stomach","intestine","duodenum","adrenal_right","adrenal_left"],
  },
  {
    id: "abdomen-core",
    label: "Abdomen MVP",
    keys: ["liver","spleen","kidney_right","kidney_left","pancreas"],
  },
  {
    id: "prostate-standard",
    label: "Próstata estándar",
    keys: ["prostate","bladder","femurs","pelvis_bone","spinal_cord","vena_cava_inf","iliac_artery_right","iliac_artery_left"],
  },
  {
    id: "lung-standard",
    label: "Pulmón estándar",
    keys: ["lung_right","lung_left","heart","esophagus","spinal_cord","trachea","vena_cava_sup","aorta_abdominal"],
  },
  {
    id: "hn-oar",
    label: "H&N — OARs principales",
    keys: ["brainstem","spinal_cord","parotid_right","parotid_left","submandibular_right","submandibular_left","mandible","larynx","thyroid_gland","eye_right","eye_left","lens_right","lens_left","optic_nerve_right","optic_nerve_left"],
  },
  {
    id: "brain",
    label: "Cerebro",
    keys: ["brain","brainstem","cerebellum","thalamus","hippocampus","spinal_cord"],
  },
  {
    id: "liver-segments",
    label: "Segmentos hepáticos",
    keys: ["liver_seg_1","liver_seg_2","liver_seg_3","liver_seg_4","liver_seg_5","liver_seg_6","liver_seg_7","liver_seg_8"],
  },
];

export const referenceDsc = {
  Liver:      "DSC ~0.95",
  Spleen:     "DSC ~0.94",
  Kidney_R:   "DSC ~0.93",
  Kidney_L:   "DSC ~0.93",
  Pancreas:   "DSC ~0.83",
  Bladder:    "DSC ~0.92",
  Prostate:   "DSC ~0.87",
  Brainstem:  "DSC ~0.93",
  Parotid_R:  "DSC ~0.87",
  Parotid_L:  "DSC ~0.87",
  SpinalCord: "DSC ~0.92",
};
