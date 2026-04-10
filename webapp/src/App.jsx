import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { inspectDicomFiles, loadAllDicomSlices } from "./dicom";
import { buildNiftiMaskPreview, parseNiftiMaskVolume } from "./nifti";
import { presets, referenceDsc, structureGroups } from "./catalog";

const STORAGE_KEYS = {
  serverUrl: "aura_rt_server_url",
  selectedStructures: "aura_rt_selected_structures",
  customPresets: "aura_rt_custom_presets",
  caseHistory: "aura_rt_case_history",
  dicomDestination: "aura_rt_dicom_destination",
};

const SERVER_URL_QUERY_KEYS = ["backend", "server", "serverUrl"];
const DEFAULT_SERVER_URL =
  import.meta.env.VITE_AURA_RT_DEFAULT_SERVER_URL || "http://127.0.0.1:8000";
const POLL_INTERVAL_MS = Number(import.meta.env.VITE_AURA_RT_POLL_INTERVAL_MS || 800);
const PREVIEW_DRAW_INTERVAL_MS = Number(import.meta.env.VITE_AURA_RT_PREVIEW_DRAW_INTERVAL_MS || 140);
const CASE_HISTORY_LIMIT = 8;
const CUSTOM_PRESET_LIMIT = 8;

const STRUCTURE_COLORS = {
  Liver:            [0,   102, 204],
  Spleen:           [0,   153, 255],
  Kidney_R:         [51,  153, 255],
  Kidney_L:         [102, 178, 255],
  Pancreas:         [0,   128, 255],
  Gallbladder:      [0,   204, 204],
  Aorta:            [255, 64,  64],
  Stomach:          [255, 153, 51],
  Bowel:            [255, 204, 0],
  Lung_R:           [102, 204, 255],
  Lung_L:           [51,  153, 204],
  Heart:            [255, 80,  80],
  Trachea:          [102, 255, 204],
  Esophagus:        [255, 170, 102],
  Vertebrae:        [210, 180, 140],
  Pelvis_Bone:      [196, 164, 132],
  Femurs:           [184, 134, 11],
  Ribs:             [222, 184, 135],
  Brain:            [204, 102, 255],
  Prostate:         [255, 153, 153],
  Bladder:          [255, 230, 128],
  PenileBulb:       [255, 102, 102],
  PelvicLymphNodes: [255, 204, 153],
};
function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}
function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

const NGROK_SKIP_WARNING_HEADERS = {
  "ngrok-skip-browser-warning": "1",
};

const structureLabelMap = structureGroups
  .flatMap((group) => group.items)
  .reduce((labels, item) => {
    labels[item.key] = item.label;
    if (item.clinicalName) {
      labels[item.clinicalName] = item.label;
    }
    return labels;
  }, {});

const readyStructureKeys = new Set(
  structureGroups
    .flatMap((group) => group.items)
    .filter((item) => item.status === "ready")
    .map((item) => item.key),
);

function loadStoredJson(key, fallback) {
  try {
    const rawValue = window.localStorage.getItem(key);
    if (!rawValue) {
      return fallback;
    }
    const parsedValue = JSON.parse(rawValue);
    return parsedValue ?? fallback;
  } catch {
    return fallback;
  }
}

function normalizeServerUrl(value) {
  return (value || "").trim().replace(/\/+$/, "");
}

function parseServerUrl(value) {
  const normalizedValue = normalizeServerUrl(value);
  if (!normalizedValue) {
    throw new Error("Ingresa la URL del backend.");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(normalizedValue);
  } catch {
    throw new Error("La URL del backend no es valida. Usa http:// o https://.");
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("La URL del backend debe usar http:// o https://.");
  }

  return parsedUrl;
}

function loadQueryServerUrl() {
  const params = new URLSearchParams(window.location.search);
  for (const key of SERVER_URL_QUERY_KEYS) {
    const value = normalizeServerUrl(params.get(key));
    if (value) {
      return value;
    }
  }
  return "";
}

function clearServerUrlQueryParams() {
  const url = new URL(window.location.href);
  let changed = false;

  for (const key of SERVER_URL_QUERY_KEYS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  if (changed) {
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, "", nextUrl || "/");
  }
}

function buildBackendUrl(serverUrl, path) {
  const parsedUrl = parseServerUrl(serverUrl);
  const baseUrl = parsedUrl.toString().endsWith("/") ? parsedUrl.toString() : `${parsedUrl}/`;
  return new URL(path.replace(/^\/+/, ""), baseUrl).toString();
}

function buildBackendFetchOptions(serverUrl, options = {}) {
  const headers = {
    ...(options.headers || {}),
  };
  if (parseServerUrl(serverUrl).hostname.includes("ngrok")) {
    Object.assign(headers, NGROK_SKIP_WARNING_HEADERS);
  }
  return {
    ...options,
    headers,
  };
}

function explainConnectionError(error) {
  if (error instanceof TypeError) {
    return "El navegador no pudo completar la solicitud. Revisa la URL, que el backend siga activo y que CORS este habilitado.";
  }
  if (error instanceof Error) {
    if (error.message.startsWith("HTTP ")) {
      return `El backend respondio ${error.message}.`;
    }
    return error.message;
  }
  return "No se pudo validar la conexion con el backend.";
}

function buildDicomArchivePath(file) {
  const rawRelativePath = (file.webkitRelativePath || file.name).replace(/\\/g, "/");
  const pathSegments = rawRelativePath.split("/").filter(Boolean);
  const relativePath =
    file.webkitRelativePath && pathSegments.length > 1
      ? pathSegments.slice(1).join("/")
      : pathSegments.join("/");
  const normalizedPath = relativePath || file.name;
  return normalizedPath.startsWith("dicom/") ? normalizedPath : `dicom/${normalizedPath}`;
}

function nowStamp() {
  return new Date().toLocaleTimeString("es-UY", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatTimestamp(timestamp) {
  if (!timestamp) {
    return "N/D";
  }
  return new Date(timestamp).toLocaleString("es-UY");
}

function formatDuration(seconds) {
  if (!seconds) {
    return "N/D";
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }
  return `${(seconds / 60).toFixed(1)} min`;
}

function generateCaseId() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `CASE_${stamp}_${suffix}`;
}

function bytesToReadable(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function archiveBaseName(path) {
  return path.split("/").filter(Boolean).pop() || path;
}

function archiveVolumeLabel(path) {
  return archiveBaseName(path).replace(/\.nii(\.gz)?$/i, "");
}

function inferArchiveAssetType(path) {
  const normalizedPath = path.toLowerCase();
  if (normalizedPath.endsWith(".dcm")) {
    return "application/dicom";
  }
  if (normalizedPath.endsWith(".nii.gz")) {
    return "application/gzip";
  }
  if (normalizedPath.endsWith(".json")) {
    return "application/json";
  }
  return "application/octet-stream";
}

function createArchiveAsset(path, bytes) {
  return {
    path,
    name: archiveBaseName(path),
    label: archiveVolumeLabel(path),
    size: bytes.byteLength,
    url: URL.createObjectURL(
      new Blob([bytes], { type: inferArchiveAssetType(path) }),
    ),
  };
}

function createMaskOverlay(label, bytes) {
  const volume = parseNiftiMaskVolume(bytes);
  const color = STRUCTURE_COLORS[label] ?? [255, 255, 0];
  let nonZeroCount = 0;
  for (const slice of volume.slices) {
    for (let index = 0; index < slice.length; index += 1) {
      if (slice[index]) {
        nonZeroCount += 1;
      }
    }
  }
  const [sx, sy, sz] = volume.spacing ?? [1, 1, 1];
  const volumeMl = (nonZeroCount * sx * sy * sz) / 1000;
  return { label, color, nonZeroCount, volumeMl, ...volume };
}

function sliceHasActiveVoxel(slice) {
  if (!slice) {
    return false;
  }
  for (let index = 0; index < slice.length; index += 1) {
    if (slice[index]) {
      return true;
    }
  }
  return false;
}

function buildPreviewSteps(overlays, structureOrder) {
  const overlayByLabel = new Map(overlays.map((overlay) => [overlay.label, overlay]));
  const orderedLabels = structureOrder.filter((label) => overlayByLabel.has(label));
  const steps = [];

  orderedLabels.forEach((label, structureIndex) => {
    const overlay = overlayByLabel.get(label);
    overlay.slices.forEach((slice, sliceIndex) => {
      if (!sliceHasActiveVoxel(slice)) {
        return;
      }
      steps.push({
        label,
        structureIndex,
        structureTotal: orderedLabels.length,
        sliceIndex,
        sliceTotal: overlay.slices.length,
      });
    });
  });

  return steps;
}

async function extractResultAssets(blob) {
  const buffer = await blob.arrayBuffer();
  const archive = unzipSync(new Uint8Array(buffer));
  const entries = Object.entries(archive);
  const reportBytes = archive["report.json"];

  return {
    report: reportBytes ? JSON.parse(strFromU8(reportBytes)) : null,
    rtstruct: entries
      .filter(([path]) => path.toLowerCase().endsWith(".dcm"))
      .sort(([left], [right]) =>
        left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }),
      )
      .map(([path, bytes]) => createArchiveAsset(path, bytes))[0] || null,
    masks: entries
      .filter(([path]) => path.startsWith("masks/") && path.toLowerCase().endsWith(".nii.gz"))
      .sort(([left], [right]) =>
        left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }),
      )
      .map(([path, bytes]) => createArchiveAsset(path, bytes)),
    ctFileCount: entries.filter(([path]) => path.startsWith("CT/")).length,
    zipSize: blob.size,
  };
}

function formatSpacing(spacing) {
  if (!Array.isArray(spacing) || spacing.length < 3) {
    return "N/D";
  }
  return spacing.map((value) => Number(value).toFixed(2)).join(" x ");
}

async function readErrorDetail(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const payload = await response.json();
    const detail = payload.detail ?? payload;
    if (typeof detail === "string") {
      return detail;
    }
    if (detail && typeof detail === "object") {
      return [
        detail.message || "Error del backend",
        detail.hint ? `Hint: ${detail.hint}` : "",
        detail.request_id ? `Request ID: ${detail.request_id}` : "",
      ]
        .filter(Boolean)
        .join(" | ");
    }
    return JSON.stringify(payload);
  }
  return response.text();
}

function normalizeSupportedStructures(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.supported_structures)) {
    return null;
  }
  return [...new Set(
    payload.supported_structures
      .filter((key) => typeof key === "string")
      .map((key) => key.trim())
      .filter(Boolean),
  )].sort();
}

function phaseLabel(phase) {
  const labels = {
    idle: "Idle",
    packaging: "Empaquetando",
    Packaging: "Empaquetando",
    received: "Recibido",
    routing: "Routing",
    preprocessing: "Preprocesando",
    segmenting: "Segmentando",
    postprocessing: "Post-procesando",
    rtstruct: "Construyendo RT-STRUCT",
    Uploading: "Subiendo",
    Downloading: "Descargando",
    Completed: "Completado",
    completed: "Completado",
    Cancelled: "Cancelado",
    cancelled: "Cancelado",
    Failed: "Fallido",
    failed: "Fallido",
  };
  return labels[phase] || phase || "Idle";
}

function buildPreviewMaskUrl(serverUrl, caseId, structureName) {
  return buildBackendUrl(
    serverUrl,
    `/preview/${encodeURIComponent(caseId)}/mask/${encodeURIComponent(structureName)}`,
  );
}

function structureLabel(key) {
  return structureLabelMap[key] || key;
}

function structureAvailabilityText(item, backendSupportedStructureSet) {
  if (item.status !== "ready") {
    return "Planned";
  }
  if (backendSupportedStructureSet && !backendSupportedStructureSet.has(item.key)) {
    return "No en backend";
  }
  return "Disponible";
}

function statusTone(status) {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "cancelled") return "warning";
  return "neutral";
}

function compactStudySummary(studyMeta) {
  if (!studyMeta) {
    return null;
  }

  return {
    modality: studyMeta.modality || "N/D",
    studyDate: studyMeta.studyDate || "N/D",
    seriesDescription: studyMeta.seriesDescription || "N/D",
    instanceNumber: studyMeta.instanceNumber || "N/D",
    rows: studyMeta.rows || "N/D",
    columns: studyMeta.columns || "N/D",
    fileCount: studyMeta.fileCount || 0,
    totalBytes: studyMeta.totalBytes || 0,
    sourceFileName: studyMeta.sourceFileName || "N/D",
  };
}

function buildCaseSnapshot({
  caseId,
  status,
  requestedStructures,
  report,
  studySummary,
  serverUrl,
  errorMessage = "",
}) {
  return {
    case_id: report?.case_id || caseId,
    status,
    requested_structures: requestedStructures,
    generated_structures: report?.generated_structures || [],
    models_used: report?.models_used || [],
    processing_seconds: report?.processing_seconds || 0,
    warnings: report?.warnings || [],
    dicom_send_summary: report?.dicom_send_summary || null,
    completed_at: new Date().toISOString(),
    server_url: serverUrl,
    study: studySummary,
    error_message: errorMessage,
  };
}

function DicomCanvas({
  slices,
  initialSliceIndex,
  windowCenter: initWC,
  windowWidth: initWW,
  onWindowChange,
  onSliceChange,
  overlays,
  forcedSliceIndex = null,
  overlayProgress = null,
}) {
  const canvasRef = useRef(null);
  const offscreenRef = useRef(null);
  const overlayOffscreenRef = useRef(null);
  const slicesRef = useRef(slices);
  const overlaysRef = useRef(overlays);
  overlaysRef.current = overlays;
  const overlayProgressRef = useRef(overlayProgress);
  overlayProgressRef.current = overlayProgress;
  const onSliceChangeRef = useRef(onSliceChange);
  const onWindowChangeRef = useRef(onWindowChange);
  onSliceChangeRef.current = onSliceChange;
  onWindowChangeRef.current = onWindowChange;
  const viewRef = useRef({
    zoom: 1, panX: 0, panY: 0, wc: initWC, ww: initWW,
    sliceIndex: initialSliceIndex, dragging: false, button: -1, lastX: 0, lastY: 0,
  });

  // renderPixels y draw usan solo refs → son estables (sin deps)
  const renderPixels = useCallback(() => {
    const offscreen = offscreenRef.current;
    const slice = slicesRef.current[viewRef.current.sliceIndex] || slicesRef.current[0];
    if (!offscreen || !slice?.pixelData) return;
    const { pixelData, rows, columns, invert } = slice;
    const ctx = offscreen.getContext("2d");
    const imageData = ctx.createImageData(columns, rows);
    const { wc, ww } = viewRef.current;
    const lower = wc - ww / 2;
    const upper = wc + ww / 2;
    const range = Math.max(ww, 1);
    for (let i = 0; i < pixelData.length; i++) {
      const clamped = Math.max(lower, Math.min(upper, pixelData[i]));
      let v = Math.round(((clamped - lower) / range) * 255);
      if (invert) v = 255 - v;
      const o = i * 4;
      imageData.data[o] = v;
      imageData.data[o + 1] = v;
      imageData.data[o + 2] = v;
      imageData.data[o + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
  }, []);

  const buildOverlay = useCallback(() => {
    const slice = slicesRef.current[viewRef.current.sliceIndex] || slicesRef.current[0];
    const ovList = overlaysRef.current;
    if (!slice || !ovList?.length) {
      overlayOffscreenRef.current = null;
      return;
    }
    const progress = overlayProgressRef.current;
    const completedLabels = progress?.completedLabels?.length
      ? new Set(progress.completedLabels)
      : null;
    const { columns, rows } = slice;
    const oc = document.createElement("canvas");
    oc.width = columns;
    oc.height = rows;
    const ctx = oc.getContext("2d");
    const imageData = ctx.createImageData(columns, rows);
    for (const ov of ovList) {
      if (!ov.slices) continue;
      if (progress) {
        const isCompleted = completedLabels?.has(ov.label);
        const isActive = ov.label === progress.activeLabel;
        const isVisible =
          isCompleted || (isActive && viewRef.current.sliceIndex <= progress.activeSliceIndex);
        if (!isVisible) {
          continue;
        }
      }
      const maskSlice = ov.slices[viewRef.current.sliceIndex];
      if (!maskSlice) continue;
      const [r, g, b] = ov.color;
      for (let i = 0; i < maskSlice.length; i++) {
        if (maskSlice[i]) {
          const o = i * 4;
          imageData.data[o]     = r;
          imageData.data[o + 1] = g;
          imageData.data[o + 2] = b;
          imageData.data[o + 3] = 140;
        }
      }
    }
    ctx.putImageData(imageData, 0, 0);
    overlayOffscreenRef.current = oc;
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const offscreen = offscreenRef.current;
    if (!canvas || !offscreen) return;
    const ctx = canvas.getContext("2d");
    const { zoom, panX, panY } = viewRef.current;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);
    ctx.imageSmoothingEnabled = zoom < 1;
    ctx.drawImage(offscreen, -offscreen.width / 2, -offscreen.height / 2);
    const overlayOffscreen = overlayOffscreenRef.current;
    if (overlayOffscreen) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(overlayOffscreen, -overlayOffscreen.width / 2, -overlayOffscreen.height / 2);
    }
    ctx.restore();
  }, []);

  // Inicializar o actualizar cuando cambia el array de slices
  useEffect(() => {
    const slice = slices[0];
    if (!slice) return;

    const needsReinit = !offscreenRef.current
      || offscreenRef.current.width !== slice.columns
      || offscreenRef.current.height !== slice.rows;

    slicesRef.current = slices;

    if (needsReinit) {
      const offscreen = document.createElement("canvas");
      offscreen.width = slice.columns;
      offscreen.height = slice.rows;
      offscreenRef.current = offscreen;

      const canvas = canvasRef.current;
      if (canvas?.offsetWidth && canvas?.offsetHeight) {
        canvas.width = canvas.offsetWidth;
        canvas.height = canvas.offsetHeight;
      }
      const w = canvasRef.current?.width || slice.columns;
      const h = canvasRef.current?.height || slice.rows;
      const fitZoom = Math.min(w / slice.columns, h / slice.rows) * 0.95;
      viewRef.current = {
        zoom: fitZoom, panX: 0, panY: 0, wc: initWC, ww: initWW,
        sliceIndex: Math.min(initialSliceIndex, slices.length - 1),
        dragging: false, button: -1, lastX: 0, lastY: 0,
      };
    } else {
      // Slices extra cargados: ir al slice central sin resetear zoom/pan/window
      viewRef.current.sliceIndex = Math.min(initialSliceIndex, slices.length - 1);
    }

    renderPixels();
    buildOverlay();
    draw();
    onSliceChangeRef.current?.(viewRef.current.sliceIndex, slices.length);
  }, [slices, initialSliceIndex, initWC, initWW, renderPixels, buildOverlay, draw]);

  // Overlays cambian → rebuild
  useEffect(() => {
    buildOverlay();
    draw();
  }, [overlays, overlayProgress, buildOverlay, draw]);

  useEffect(() => {
    if (!Number.isInteger(forcedSliceIndex) || !slicesRef.current.length) {
      return;
    }
    const nextIndex = Math.max(0, Math.min(slicesRef.current.length - 1, forcedSliceIndex));
    if (nextIndex === viewRef.current.sliceIndex) {
      return;
    }
    viewRef.current.sliceIndex = nextIndex;
    renderPixels();
    buildOverlay();
    draw();
    onSliceChangeRef.current?.(nextIndex, slicesRef.current.length);
  }, [forcedSliceIndex, renderPixels, buildOverlay, draw]);

  // Rueda → navegar slices
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const allSlices = slicesRef.current;
    if (allSlices.length <= 1) return;
    const view = viewRef.current;
    const delta = e.deltaY > 0 ? 1 : -1;
    const newIndex = Math.max(0, Math.min(allSlices.length - 1, view.sliceIndex + delta));
    if (newIndex === view.sliceIndex) return;
    view.sliceIndex = newIndex;
    renderPixels();
    buildOverlay();
    draw();
    onSliceChangeRef.current?.(newIndex, allSlices.length);
  }, [renderPixels, buildOverlay, draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      if (!canvas.offsetWidth || !canvas.offsetHeight) return;
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      draw();
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw]);

  function handleMouseDown(e) {
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    const view = viewRef.current;
    view.dragging = true;
    view.button = e.button;
    view.lastX = e.clientX;
    view.lastY = e.clientY;
  }

  function handleMouseMove(e) {
    const view = viewRef.current;
    if (!view.dragging) return;
    const dx = e.clientX - view.lastX;
    const dy = e.clientY - view.lastY;
    view.lastX = e.clientX;
    view.lastY = e.clientY;
    if (view.button === 0) {
      // Zoom: arrastre vertical (arriba = acercar, abajo = alejar)
      const factor = Math.exp(-dy * 0.01);
      const canvas = canvasRef.current;
      if (canvas) {
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const newZoom = Math.max(0.05, Math.min(40, view.zoom * factor));
        const ratio = newZoom / view.zoom;
        view.panX = cx - (cx - view.panX) * ratio;
        view.panY = cy - (cy - view.panY) * ratio;
        view.zoom = newZoom;
      }
      draw();
    } else if (view.button === 2) {
      // Windowing: horizontal = WW, vertical = WC
      view.ww = Math.max(1, view.ww + dx * 4);
      view.wc += dy * 2;
      renderPixels();
      draw();
    }
  }

  function handleMouseUp() {
    const view = viewRef.current;
    if (view.dragging && view.button === 2) {
      onWindowChangeRef.current?.(Math.round(view.wc), Math.round(view.ww));
    }
    view.dragging = false;
    view.button = -1;
  }

  function handleDoubleClick() {
    const canvas = canvasRef.current;
    const slice = slicesRef.current[0];
    if (!canvas || !slice) return;
    const fitZoom = Math.min(canvas.width / slice.columns, canvas.height / slice.rows) * 0.95;
    const view = viewRef.current;
    view.zoom = fitZoom;
    view.panX = 0;
    view.panY = 0;
    view.wc = initWC;
    view.ww = initWW;
    renderPixels();
    draw();
    onWindowChangeRef.current?.(Math.round(initWC), Math.round(initWW));
  }

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: "100%", display: "block", cursor: "crosshair" }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}

export default function App() {
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);
  const initialQueryServerUrlRef = useRef(loadQueryServerUrl());
  const previewLoadKeyRef = useRef("");

  const [serverUrl, setServerUrl] = useState(
    () =>
      initialQueryServerUrlRef.current ||
      window.localStorage.getItem(STORAGE_KEYS.serverUrl) ||
      DEFAULT_SERVER_URL,
  );
  const [connectionState, setConnectionState] = useState({
    label: "Sin verificar",
    tone: "neutral",
  });
  const [connectionDetail, setConnectionDetail] = useState("");
  const [backendInfo, setBackendInfo] = useState(null);
  const [backendStatus, setBackendStatus] = useState(null);

  // ── DICOM destination state ─────────────────────────────────────────
  const [dicomEnabled, setDicomEnabled] = useState(() => {
    const stored = loadStoredJson(STORAGE_KEYS.dicomDestination, null);
    return stored?.enabled ?? false;
  });
  const [dicomAeTitle, setDicomAeTitle] = useState(() => {
    const stored = loadStoredJson(STORAGE_KEYS.dicomDestination, null);
    return stored?.ae_title ?? "";
  });
  const [dicomHost, setDicomHost] = useState(() => {
    const stored = loadStoredJson(STORAGE_KEYS.dicomDestination, null);
    return stored?.host ?? "";
  });
  const [dicomPort, setDicomPort] = useState(() => {
    const stored = loadStoredJson(STORAGE_KEYS.dicomDestination, null);
    return stored?.port ?? 104;
  });
  const [dicomSourceAe, setDicomSourceAe] = useState(() => {
    const stored = loadStoredJson(STORAGE_KEYS.dicomDestination, null);
    return stored?.source_ae_title ?? "AURA_RT";
  });
  const [dicomVerifyState, setDicomVerifyState] = useState({ label: "", tone: "neutral" });
  const [studyFiles, setStudyFiles] = useState([]);
  const [studyMeta, setStudyMeta] = useState(null);
  const [viewWindow, setViewWindow] = useState(null);
  const [slices, setSlices] = useState([]);
  const [sliceInfo, setSliceInfo] = useState({ index: 0, total: 0 });
  const [selectedStructures, setSelectedStructures] = useState(() => {
    const storedValue = loadStoredJson(STORAGE_KEYS.selectedStructures, []);
    return Array.isArray(storedValue) ? storedValue : [];
  });
  const [customPresets, setCustomPresets] = useState(() => {
    const storedValue = loadStoredJson(STORAGE_KEYS.customPresets, []);
    return Array.isArray(storedValue) ? storedValue : [];
  });
  const [customPresetName, setCustomPresetName] = useState("");
  const [phase, setPhase] = useState("Idle");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [logs, setLogs] = useState([`[${nowStamp()}] Interfaz web inicializada.`]);
  const [result, setResult] = useState(null);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadName, setDownloadName] = useState("");
  const [resultAssets, setResultAssets] = useState(null);
  const [selectedVolumePath, setSelectedVolumePath] = useState("");
  const [volumePreview, setVolumePreview] = useState(null);
  const [livePreviewCaseId, setLivePreviewCaseId] = useState("");
  const [livePreviewOverlays, setLivePreviewOverlays] = useState([]);
  const [livePreviewCursor, setLivePreviewCursor] = useState(0);
  const [maskOverlays, setMaskOverlays] = useState([]);
  const [hiddenStructures, setHiddenStructures] = useState([]);
  const [structureColorOverrides, setStructureColorOverrides] = useState({});
  const [lastStatusMessage, setLastStatusMessage] = useState("");
  const [caseHistory, setCaseHistory] = useState(() => {
    const storedValue = loadStoredJson(STORAGE_KEYS.caseHistory, []);
    return Array.isArray(storedValue) ? storedValue : [];
  });
  const backendSupportedStructures = useMemo(
    () => normalizeSupportedStructures(backendInfo),
    [backendInfo],
  );
  const backendSupportedStructureSet = useMemo(
    () => (backendSupportedStructures ? new Set(backendSupportedStructures) : null),
    [backendSupportedStructures],
  );
  const backendSupportedStructureCount = backendSupportedStructures?.length ?? null;
  const livePreviewActive = Boolean(
    isSubmitting &&
    livePreviewOverlays.length > 0 &&
    livePreviewCaseId &&
    livePreviewCaseId === backendStatus?.current_case_id,
  );
  const livePreviewStructureOrder = useMemo(() => {
    const overlayLabels = new Set(livePreviewOverlays.map((overlay) => overlay.label));
    const preferredOrder = Array.isArray(backendStatus?.preview_structures)
      ? backendStatus.preview_structures.filter((label) => overlayLabels.has(label))
      : [];
    const remaining = livePreviewOverlays
      .map((overlay) => overlay.label)
      .filter((label) => !preferredOrder.includes(label));
    return [...preferredOrder, ...remaining];
  }, [backendStatus?.preview_structures, livePreviewOverlays]);
  const livePreviewSteps = useMemo(
    () => buildPreviewSteps(livePreviewOverlays, livePreviewStructureOrder),
    [livePreviewOverlays, livePreviewStructureOrder],
  );
  const livePreviewAnimating =
    livePreviewActive && backendStatus?.phase === "rtstruct" && livePreviewSteps.length > 0;
  const activePreviewStep = livePreviewAnimating
    ? livePreviewSteps[Math.min(livePreviewCursor, livePreviewSteps.length - 1)]
    : null;
  const previewCompletedLabels = useMemo(
    () => (activePreviewStep ? livePreviewStructureOrder.slice(0, activePreviewStep.structureIndex) : []),
    [activePreviewStep, livePreviewStructureOrder],
  );
  const viewerOverlaySource = livePreviewActive ? livePreviewOverlays : maskOverlays;
  const viewerForcedSliceIndex = activePreviewStep?.sliceIndex ?? null;
  const overlayProgress = activePreviewStep
    ? {
        activeLabel: activePreviewStep.label,
        activeSliceIndex: activePreviewStep.sliceIndex,
        completedLabels: previewCompletedLabels,
      }
    : null;

  const isStructureSelectable = useCallback((key) => {
    if (!readyStructureKeys.has(key)) {
      return false;
    }
    if (!backendSupportedStructureSet) {
      return true;
    }
    return backendSupportedStructureSet.has(key);
  }, [backendSupportedStructureSet]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.serverUrl, serverUrl);
  }, [serverUrl]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.selectedStructures, JSON.stringify(selectedStructures));
  }, [selectedStructures]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.customPresets, JSON.stringify(customPresets));
  }, [customPresets]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.caseHistory, JSON.stringify(caseHistory));
  }, [caseHistory]);

  useEffect(() => {
    window.localStorage.setItem(
      STORAGE_KEYS.dicomDestination,
      JSON.stringify({
        enabled: dicomEnabled,
        ae_title: dicomAeTitle,
        host: dicomHost,
        port: dicomPort,
        source_ae_title: dicomSourceAe,
      }),
    );
  }, [dicomEnabled, dicomAeTitle, dicomHost, dicomPort, dicomSourceAe]);

  useEffect(() => {
    if (!backendSupportedStructureSet) {
      return;
    }
    setSelectedStructures((current) => {
      const filtered = current.filter((key) => backendSupportedStructureSet.has(key));
      if (filtered.length === current.length) {
        return current;
      }
      const removed = current.filter((key) => !backendSupportedStructureSet.has(key));
      appendLog(
        `La instancia activa no soporta: ${removed.map((key) => structureLabel(key)).join(", ")}.`,
      );
      return filtered;
    });
  }, [backendSupportedStructureSet]);

  useEffect(() => {
    const input = fileInputRef.current;
    if (!input) {
      return;
    }
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    if (!downloadUrl) {
      return undefined;
    }
    return () => {
      URL.revokeObjectURL(downloadUrl);
    };
  }, [downloadUrl]);

  useEffect(() => {
    if (!resultAssets) {
      return undefined;
    }

    return () => {
      if (resultAssets.rtstruct?.url) {
        URL.revokeObjectURL(resultAssets.rtstruct.url);
      }
      for (const asset of resultAssets.masks || []) {
        URL.revokeObjectURL(asset.url);
      }
    };
  }, [resultAssets]);

  useEffect(() => {
    if (!isSubmitting || !backendStatus?.preview_ready || !backendStatus?.current_case_id) {
      if (!isSubmitting) {
        previewLoadKeyRef.current = "";
        setLivePreviewCaseId("");
        setLivePreviewOverlays([]);
        setLivePreviewCursor(0);
      }
      return undefined;
    }

    const structureOrder = Array.isArray(backendStatus.preview_structures)
      ? backendStatus.preview_structures.filter(Boolean)
      : [];
    if (!structureOrder.length) {
      return undefined;
    }

    const caseId = backendStatus.current_case_id;
    const previewKey = `${serverUrl}|${caseId}|${structureOrder.join("|")}`;
    if (previewLoadKeyRef.current === previewKey) {
      return undefined;
    }

    previewLoadKeyRef.current = previewKey;
    let cancelled = false;

    const loadPreviewMasks = async () => {
      try {
        const overlays = await Promise.all(
          structureOrder.map(async (label) => {
            const response = await fetch(
              buildPreviewMaskUrl(serverUrl, caseId, label),
              buildBackendFetchOptions(serverUrl),
            );
            if (!response.ok) {
              throw new Error(`Preview no disponible para ${label}.`);
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            return createMaskOverlay(label, bytes);
          }),
        );

        if (!cancelled) {
          setLivePreviewCaseId(caseId);
          setLivePreviewOverlays(overlays);
          setLivePreviewCursor(0);
          appendLog(`Preview progresivo listo con ${overlays.length} estructura(s).`);
        }
      } catch {
        if (!cancelled) {
          previewLoadKeyRef.current = "";
          setLivePreviewCaseId("");
          setLivePreviewOverlays([]);
        }
      }
    };

    void loadPreviewMasks();

    return () => {
      cancelled = true;
    };
  }, [
    isSubmitting,
    backendStatus?.preview_ready,
    backendStatus?.current_case_id,
    serverUrl,
    backendStatus?.preview_structures,
  ]);

  useEffect(() => {
    if (!livePreviewAnimating) {
      return undefined;
    }

    setLivePreviewCursor((current) => Math.min(current, livePreviewSteps.length - 1));
    const intervalId = window.setInterval(() => {
      setLivePreviewCursor((current) =>
        current >= livePreviewSteps.length - 1 ? current : current + 1,
      );
    }, PREVIEW_DRAW_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [livePreviewAnimating, livePreviewSteps.length]);

  useEffect(() => {
    if (!resultAssets?.masks?.length) {
      setMaskOverlays([]);
      return undefined;
    }
    let cancelled = false;
    Promise.all(
      resultAssets.masks.map(async (asset) => {
        const response = await fetch(asset.url);
        const bytes = new Uint8Array(await response.arrayBuffer());
        return createMaskOverlay(asset.label, bytes);
      }),
    ).then((overlays) => {
      if (!cancelled) setMaskOverlays(overlays);
    }).catch(() => {
      if (!cancelled) setMaskOverlays([]);
    });
    return () => { cancelled = true; };
  }, [resultAssets]);

  useEffect(() => {
    if (!resultAssets?.masks?.length) {
      if (selectedVolumePath) {
        setSelectedVolumePath("");
      }
      return;
    }

    const isSelectedPresent = resultAssets.masks.some((asset) => asset.path === selectedVolumePath);
    if (!selectedVolumePath || !isSelectedPresent) {
      setSelectedVolumePath(resultAssets.masks[0].path);
    }
  }, [resultAssets, selectedVolumePath]);

  useEffect(() => {
    if (!resultAssets?.masks?.length || !selectedVolumePath) {
      setVolumePreview(null);
      return undefined;
    }

    const selectedAsset =
      resultAssets.masks.find((asset) => asset.path === selectedVolumePath) || resultAssets.masks[0];
    let cancelled = false;

    setVolumePreview({
      status: "loading",
      label: selectedAsset.label,
      name: selectedAsset.name,
    });

    const loadPreview = async () => {
      try {
        const response = await fetch(selectedAsset.url);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const preview = buildNiftiMaskPreview(bytes);
        if (!cancelled) {
          setVolumePreview({
            status: "ready",
            label: selectedAsset.label,
            name: selectedAsset.name,
            size: selectedAsset.size,
            ...preview,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setVolumePreview({
            status: "error",
            label: selectedAsset.label,
            message: error instanceof Error ? error.message : "No se pudo leer el volumen NIfTI.",
          });
        }
      }
    };

    void loadPreview();

    return () => {
      cancelled = true;
    };
  }, [resultAssets, selectedVolumePath]);

  useEffect(() => {
    if (!isSubmitting) {
      return undefined;
    }

    const intervalId = window.setInterval(async () => {
      try {
        const response = await fetch(
          buildBackendUrl(serverUrl, "/status"),
          buildBackendFetchOptions(serverUrl),
        );
        if (!response.ok) {
          return;
        }
        const payload = await response.json();
        setBackendStatus(payload);
      } catch {
        // Sin ruido si el polling falla temporalmente.
      }
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isSubmitting, serverUrl]);

  useEffect(() => {
    if (!backendStatus?.message || backendStatus.message === lastStatusMessage) {
      return;
    }
    appendLog(`Backend: ${backendStatus.message}`);
    setLastStatusMessage(backendStatus.message);
  }, [backendStatus, lastStatusMessage]);

  function appendLog(message) {
    startTransition(() => {
      setLogs((current) => [...current, `[${nowStamp()}] ${message}`]);
    });
  }

  async function verifyDicom() {
    if (!dicomAeTitle.trim() || !dicomHost.trim()) {
      setDicomVerifyState({ label: "AE Title y host son requeridos", tone: "danger" });
      return;
    }
    setDicomVerifyState({ label: "Verificando...", tone: "neutral" });
    try {
      const response = await fetch(
        buildBackendUrl(serverUrl, "/dicom/verify"),
        buildBackendFetchOptions(serverUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ae_title: dicomAeTitle.trim(),
            host: dicomHost.trim(),
            port: Number(dicomPort),
            source_ae_title: dicomSourceAe.trim() || "AURA_RT",
          }),
        }),
      );
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        setDicomVerifyState({ label: err?.detail?.message || `Error ${response.status}`, tone: "danger" });
        return;
      }
      const data = await response.json();
      if (data.reachable) {
        setDicomVerifyState({ label: `✓ Alcanzable — ${data.ae_title}@${data.host}:${data.port}`, tone: "success" });
      } else {
        setDicomVerifyState({ label: `✗ Sin respuesta C-ECHO — ${data.ae_title}@${data.host}:${data.port}`, tone: "danger" });
      }
    } catch (err) {
      setDicomVerifyState({ label: `Error de conexión: ${err.message}`, tone: "danger" });
    }
  }

  async function fetchBackendHealth() {
    const response = await fetch(
      buildBackendUrl(serverUrl, "/health"),
      buildBackendFetchOptions(serverUrl),
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    return payload && typeof payload === "object" ? payload : { status: "ok" };
  }

  useEffect(() => {
    if (!initialQueryServerUrlRef.current) {
      return;
    }

    clearServerUrlQueryParams();
    appendLog(`Backend cargado desde el enlace: ${initialQueryServerUrlRef.current}.`);
    void verifyConnection();
  }, []);

  function recordCaseHistory(snapshot) {
    setCaseHistory((current) => [snapshot, ...current].slice(0, CASE_HISTORY_LIMIT));
  }

  function restoreHistoryCase(snapshot) {
    setResult(snapshot);
    setDownloadUrl("");
    setDownloadName("");
    setResultAssets(null);
    setSelectedVolumePath("");
    setVolumePreview(null);
    setOpenSections((current) => ({ ...current, resultados: true }));
    appendLog(`Resumen historico cargado para ${snapshot.case_id}.`);
  }

  function clearHistory() {
    setCaseHistory([]);
    appendLog("Historial local limpiado.");
  }

  async function verifyConnection() {
    setConnectionState({ label: "Verificando...", tone: "neutral" });
    setConnectionDetail("");
    try {
      const payload = await fetchBackendHealth();
      const supportedStructures = normalizeSupportedStructures(payload);
      setBackendInfo(payload);
      setConnectionState({ label: "Conectado", tone: "success" });
      setConnectionDetail("");
      appendLog("Conexion con backend validada por /health.");
      if (supportedStructures) {
        const versionLabel = payload.app_version ? ` v${payload.app_version}` : "";
        appendLog(
          `Backend${versionLabel} anuncia ${supportedStructures.length} estructuras activas.`,
        );
      } else {
        appendLog(
          "El backend conectado no publica catalogo de estructuras. Puede estar desactualizado.",
        );
      }
    } catch (error) {
      const detail = explainConnectionError(error);
      setBackendInfo(null);
      setConnectionState({ label: "Sin conexion", tone: "danger" });
      setConnectionDetail(detail);
      appendLog(`Error de conexion: ${detail}`);
    }
  }

  async function handleStudySelection(event) {
    const files = Array.from(event.target.files || []);
    setResult(null);
    setDownloadUrl("");
    setDownloadName("");
    setResultAssets(null);
    setSelectedVolumePath("");
    setVolumePreview(null);
    setViewWindow(null);
    setSlices([]);
    setSliceInfo({ index: 0, total: 0 });

    if (!files.length) {
      return;
    }

    appendLog(`Carpeta seleccionada con ${files.length} archivos.`);
    try {
      const meta = await inspectDicomFiles(files);
      if (meta?.parseError) {
        appendLog(
          `No se pudo parsear ${meta.sourceFileName}. Se cargara la carpeta igualmente con metadata parcial.`,
        );
      }

      setStudyFiles(files);
      setStudyMeta({
        ...meta,
        fileCount: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      });

      // Cargar todos los slices en segundo plano
      loadAllDicomSlices(files).then((allSlices) => {
        if (allSlices.length > 0) {
          setSlices(allSlices);
          setSliceInfo({ index: Math.floor(allSlices.length / 2), total: allSlices.length });
          appendLog(`${allSlices.length} slices cargados.`);
        }
      });
    } catch (error) {
      appendLog(`Fallo al inspeccionar archivos DICOM: ${error.message}`);
      setStudyFiles(files);
      setStudyMeta({
        modality: "N/D",
        studyDate: "N/D",
        patientName: "N/D",
        patientId: "N/D",
        seriesDescription: "N/D",
        instanceNumber: "N/D",
        rows: "N/D",
        columns: "N/D",
        sourceFileName: "N/D",
        fileCount: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      });
    }
  }

  function toggleStructure(key) {
    if (!isStructureSelectable(key)) {
      appendLog(`La estructura ${structureLabel(key)} no esta disponible en el backend activo.`);
      return;
    }
    setSelectedStructures((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );
  }

  function applyStructureSelection(keys, label) {
    const readyKeys = [...new Set(keys)].filter((key) => isStructureSelectable(key));
    const excludedKeys = [...new Set(keys)].filter(
      (key) => readyStructureKeys.has(key) && !readyKeys.includes(key),
    );
    setSelectedStructures(readyKeys);
    appendLog(`${label} aplicado con ${readyKeys.length} estructuras disponibles.`);
    if (excludedKeys.length) {
      appendLog(
        `Omitidas por backend activo: ${excludedKeys.map((key) => structureLabel(key)).join(", ")}.`,
      );
    }
  }

  function saveCustomPreset() {
    const label = customPresetName.trim();
    if (!label) {
      appendLog("Asigne un nombre antes de guardar el preset local.");
      return;
    }
    if (!selectedStructures.length) {
      appendLog("Seleccione al menos una estructura antes de guardar un preset local.");
      return;
    }

    const keys = [...new Set(selectedStructures)].sort();
    setCustomPresets((current) => {
      const withoutSameName = current.filter(
        (preset) => preset.label.toLowerCase() !== label.toLowerCase(),
      );
      return [
        {
          id: `local-${Date.now()}`,
          label,
          keys,
          created_at: new Date().toISOString(),
        },
        ...withoutSameName,
      ].slice(0, CUSTOM_PRESET_LIMIT);
    });
    setCustomPresetName("");
    appendLog(`Preset local "${label}" guardado.`);
  }

  function deleteCustomPreset(presetId, label) {
    setCustomPresets((current) => current.filter((preset) => preset.id !== presetId));
    appendLog(`Preset local "${label}" eliminado.`);
  }

  async function submitCase() {
    if (!studyFiles.length) {
      appendLog("No hay estudio cargado.");
      return;
    }
    if (!selectedStructures.length) {
      appendLog("Seleccione al menos una estructura disponible.");
      return;
    }

    const caseId = generateCaseId();
    const requestedStructures = [...selectedStructures];
    const studySummary = compactStudySummary(studyMeta);

    try {
      const currentBackendInfo = backendInfo || await fetchBackendHealth();
      const supportedStructures = normalizeSupportedStructures(currentBackendInfo);
      setBackendInfo(currentBackendInfo);
      setConnectionState({ label: "Conectado", tone: "success" });
      setConnectionDetail("");

      if (supportedStructures) {
        const supportedStructureSet = new Set(supportedStructures);
        const unsupportedKeys = requestedStructures.filter((key) => !supportedStructureSet.has(key));
        if (unsupportedKeys.length) {
          appendLog(
            `El backend activo no soporta: ${unsupportedKeys.map((key) => structureLabel(key)).join(", ")}.`,
          );
          appendLog("Reinicia la instancia del backend con la version actual antes de reenviar.");
          return;
        }
      } else {
        appendLog(
          "Backend sin catalogo publicado. Si rechaza ROI nuevas, reinicia la instancia con la version actual.",
        );
      }
    } catch (error) {
      const detail = explainConnectionError(error);
      setBackendInfo(null);
      setConnectionState({ label: "Sin conexion", tone: "danger" });
      setConnectionDetail(detail);
      appendLog(`Error de conexion: ${detail}`);
      return;
    }

    const dicomDestination = dicomEnabled && dicomAeTitle.trim() && dicomHost.trim()
      ? {
          ae_title: dicomAeTitle.trim(),
          host: dicomHost.trim(),
          port: Number(dicomPort),
          source_ae_title: dicomSourceAe.trim() || "AURA_RT",
        }
      : null;

    const payloadMap = {
      "config.json": new TextEncoder().encode(
        JSON.stringify(
          {
            structures: requestedStructures,
            modality: "CT",
            fast_mode: true,
            anonymized_id: caseId,
            ...(dicomDestination ? { dicom_destination: dicomDestination } : {}),
          },
          null,
          2,
        ),
      ),
    };

    setIsSubmitting(true);
    setPhase("Packaging");
    setBackendStatus(null);
    setLastStatusMessage("");
    setResult(null);
    setDownloadUrl("");
    setDownloadName("");
    setResultAssets(null);
    setSelectedVolumePath("");
    setVolumePreview(null);
    previewLoadKeyRef.current = "";
    setLivePreviewCaseId("");
    setLivePreviewOverlays([]);
    setLivePreviewCursor(0);
    appendLog(`Construyendo request ZIP para ${caseId}.`);

    for (const file of studyFiles) {
      const archivePath = buildDicomArchivePath(file);
      payloadMap[archivePath] = new Uint8Array(await file.arrayBuffer());
    }

    const zipBytes = zipSync(payloadMap, { level: 6 });
    const requestBlob = new Blob([zipBytes], { type: "application/zip" });
    const formData = new FormData();
    formData.append("file", requestBlob, `${caseId}.zip`);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      setPhase("Uploading");
      appendLog("Enviando estudio al backend.");
      const response = await fetch(
        buildBackendUrl(serverUrl, "/segment"),
        buildBackendFetchOptions(serverUrl, {
          method: "POST",
          body: formData,
          signal: controller.signal,
        }),
      );

      if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new Error(detail || `HTTP ${response.status}`);
      }

      setPhase("Downloading");
      appendLog("Respuesta recibida. Extrayendo resultado.");
      const responseBlob = await response.blob();
      const extractedAssets = await extractResultAssets(responseBlob);
      const report =
        extractedAssets.report || {
          case_id: caseId,
          generated_structures: backendStatus?.generated_structures || [],
          models_used: [],
          processing_seconds: 0,
          warnings: ["No se encontro report.json dentro del ZIP de salida."],
        };
      const objectUrl = URL.createObjectURL(responseBlob);
      const snapshot = buildCaseSnapshot({
        caseId,
        status: "completed",
        requestedStructures,
        report,
        studySummary,
        serverUrl,
      });

      setDownloadUrl(objectUrl);
      setDownloadName(`${caseId}_output.zip`);
      setResultAssets(extractedAssets);
      setResult(snapshot);
      recordCaseHistory(snapshot);
      setOpenSections((current) => ({ ...current, resultados: true }));
      setPhase("Completed");
      appendLog(
        `Caso completado. Salida lista: ${extractedAssets.masks.length} volumen(es) y ${extractedAssets.rtstruct ? "1 RT-STRUCT" : "sin RT-STRUCT"}.`,
      );
    } catch (error) {
      const cancelled = error?.name === "AbortError";
      const errorMessage = cancelled
        ? "Solicitud cancelada por el usuario."
        : error.message || "Error no controlado.";
      const snapshot = buildCaseSnapshot({
        caseId,
        status: cancelled ? "cancelled" : "failed",
        requestedStructures,
        report: null,
        studySummary,
        serverUrl,
        errorMessage,
      });

      setResultAssets(null);
      setSelectedVolumePath("");
      setVolumePreview(null);
      setResult(snapshot);
      recordCaseHistory(snapshot);
      setOpenSections((current) => ({ ...current, resultados: true }));
      setPhase(cancelled ? "Cancelled" : "Failed");
      if (!cancelled) {
        appendLog(`Fallo en procesamiento: ${errorMessage}`);
        if (errorMessage.includes("Estructura no soportada:")) {
          appendLog(
            "La instancia activa del backend no coincide con el catalogo del frontend. Reiniciala con el codigo actual.",
          );
        }
      }
    } finally {
      abortRef.current = null;
      setIsSubmitting(false);
    }
  }

  function cancelSubmission() {
    if (abortRef.current) {
      abortRef.current.abort();
      previewLoadKeyRef.current = "";
      setLivePreviewCaseId("");
      setLivePreviewOverlays([]);
      setLivePreviewCursor(0);
      appendLog("Solicitud cancelada por el usuario.");
      setIsSubmitting(false);
      setPhase("Cancelled");
    }
  }

  const selectedCount = selectedStructures.length;
  const estimateMinutes = selectedCount ? Math.max(2, Math.ceil(selectedCount * 1.6)) : 0;
  const progressPercent = isSubmitting
    ? backendStatus?.progress_percent ?? (phase === "Uploading" ? 20 : 8)
    : result?.status === "completed"
      ? 100
      : 0;
  const progressPhase = isSubmitting
    ? backendStatus?.phase
      ? phaseLabel(backendStatus.phase)
      : phase
    : phase;
  const allPresets = [...presets, ...customPresets];
  const selectedResultVolume =
    resultAssets?.masks?.find((asset) => asset.path === selectedVolumePath) ||
    resultAssets?.masks?.[0] ||
    null;

  const visibleOverlays = useMemo(
    () =>
      viewerOverlaySource
        .filter((ov) => !hiddenStructures.includes(ov.label))
        .map((ov) => ({
          ...ov,
          color: structureColorOverrides[ov.label] ?? ov.color,
        })),
    [viewerOverlaySource, hiddenStructures, structureColorOverrides],
  );

  const allHidden =
    viewerOverlaySource.length > 0 && hiddenStructures.length === viewerOverlaySource.length;
  const livePreviewHeadline = activePreviewStep
    ? `Dibujando ${structureLabel(activePreviewStep.label)} · slice ${activePreviewStep.sliceIndex + 1}/${activePreviewStep.sliceTotal}`
    : livePreviewActive
      ? "Preview progresivo disponible"
      : "";

  const [openSections, setOpenSections] = useState({
    servidor: false,
    dicom: false,
    estudio: true,
    estructuras: true,
    procesamiento: true,
    resultados: false,
  });

  function toggleSection(key) {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <p className="eyebrow">AURA-RT</p>
          <h1>Segmentation<br />Platform</h1>
        </div>

        <div className="accordion">

          {/* Servidor */}
          <div className="accordion-item">
            <button className="accordion-trigger" onClick={() => toggleSection("servidor")}>
              <span className="accordion-arrow">{openSections.servidor ? "▾" : "▸"}</span>
              Servidor
              <span className={`status-dot ${connectionState.tone}`} />
            </button>
            {openSections.servidor && (
              <div className="accordion-body">
                <input
                  className="text-input"
                  value={serverUrl}
                  onChange={(e) => {
                    setServerUrl(e.target.value);
                    setBackendInfo(null);
                    setConnectionState({ label: "Sin verificar", tone: "neutral" });
                    setConnectionDetail("");
                  }}
                  placeholder="https://xxxxx.ngrok-free.app"
                />
                <button className="primary-button full-width" onClick={verifyConnection}>
                  Verificar conexion
                </button>
                <p className="field-help">
                  La URL queda guardada en este navegador. Tambien podes abrir la app con
                  <code>?backend=https://...</code>.
                </p>
                {backendInfo?.app_version && (
                  <p className="field-help">
                    Backend v{backendInfo.app_version}
                    {backendSupportedStructureCount !== null
                      ? ` · ${backendSupportedStructureCount} estructuras activas`
                      : ""}
                  </p>
                )}
                {connectionDetail && <div className="error-banner">{connectionDetail}</div>}
              </div>
            )}
          </div>

          {/* Destino DICOM (C-STORE) */}
          <div className="accordion-item">
            <button className="accordion-trigger" onClick={() => toggleSection("dicom")}>
              <span className="accordion-arrow">{openSections.dicom ? "▾" : "▸"}</span>
              Destino DICOM
              {dicomEnabled && dicomAeTitle && dicomHost && (
                <span className="accordion-badge" style={{ backgroundColor: "#22c55e" }}>
                  {dicomAeTitle}@{dicomHost}:{dicomPort}
                </span>
              )}
            </button>
            {openSections.dicom && (
              <div className="accordion-body" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <p style={{ fontSize: "13px", color: "var(--text-secondary)", margin: 0 }}>
                  Configura un nodo DICOM SCP (Eclipse/ARIA, Monaco) para recibir
                  automáticamente la TC y el RT-STRUCT al finalizar la segmentación.
                  El backend enviará los archivos via C-STORE sin intervención manual.
                </p>

                {/* Toggle habilitar */}
                <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer", fontSize: "14px" }}>
                  <input
                    type="checkbox"
                    checked={dicomEnabled}
                    onChange={(e) => setDicomEnabled(e.target.checked)}
                    style={{ width: "18px", height: "18px" }}
                  />
                  <span>Enviar automáticamente al TPS al finalizar</span>
                </label>

                {/* Campos de configuración */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "var(--text-secondary)", fontWeight: 600 }}>
                      AE Title destino *
                    </label>
                    <input
                      type="text"
                      value={dicomAeTitle}
                      onChange={(e) => { setDicomAeTitle(e.target.value.toUpperCase()); setDicomVerifyState({ label: "", tone: "neutral" }); }}
                      placeholder="ARIA_SCP"
                      maxLength={16}
                      style={{ padding: "8px 10px", borderRadius: "6px", border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text-primary)", fontSize: "13px", fontFamily: "monospace" }}
                    />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "var(--text-secondary)", fontWeight: 600 }}>
                      Host / IP *
                    </label>
                    <input
                      type="text"
                      value={dicomHost}
                      onChange={(e) => { setDicomHost(e.target.value); setDicomVerifyState({ label: "", tone: "neutral" }); }}
                      placeholder="192.168.1.100"
                      style={{ padding: "8px 10px", borderRadius: "6px", border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text-primary)", fontSize: "13px", fontFamily: "monospace" }}
                    />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "var(--text-secondary)", fontWeight: 600 }}>
                      Puerto
                    </label>
                    <input
                      type="number"
                      value={dicomPort}
                      onChange={(e) => { setDicomPort(Number(e.target.value)); setDicomVerifyState({ label: "", tone: "neutral" }); }}
                      min={1}
                      max={65535}
                      style={{ padding: "8px 10px", borderRadius: "6px", border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text-primary)", fontSize: "13px", fontFamily: "monospace" }}
                    />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "var(--text-secondary)", fontWeight: 600 }}>
                      AE Title origen (AURA)
                    </label>
                    <input
                      type="text"
                      value={dicomSourceAe}
                      onChange={(e) => setDicomSourceAe(e.target.value.toUpperCase())}
                      placeholder="AURA_RT"
                      maxLength={16}
                      style={{ padding: "8px 10px", borderRadius: "6px", border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text-primary)", fontSize: "13px", fontFamily: "monospace" }}
                    />
                  </div>
                </div>

                {/* Botón verificar + estado */}
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <button
                    onClick={verifyDicom}
                    style={{
                      padding: "8px 18px", borderRadius: "6px",
                      background: "var(--accent)", color: "#fff",
                      border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 600,
                    }}
                  >
                    Verificar C-ECHO
                  </button>
                  {dicomVerifyState.label && (
                    <span style={{
                      fontSize: "13px",
                      color: dicomVerifyState.tone === "success" ? "#22c55e"
                           : dicomVerifyState.tone === "danger"  ? "#ef4444"
                           : "var(--text-secondary)",
                    }}>
                      {dicomVerifyState.label}
                    </span>
                  )}
                </div>

                {/* Info de configuración en ARIA/Monaco */}
                <details style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                  <summary style={{ cursor: "pointer", fontWeight: 600, marginBottom: "6px" }}>
                    ¿Cómo configurar el SCP en Eclipse/ARIA o Monaco?
                  </summary>
                  <div style={{ paddingLeft: "12px", lineHeight: "1.7" }}>
                    <strong>Eclipse/ARIA (Varian):</strong><br/>
                    ARIA → Administration → DICOM SCP → agregar AE Source con AE Title <code>AURA_RT</code>
                    y la IP del servidor Colab/ngrok. Puerto destino: el que usa ARIA Storage SCP (default 104).<br/><br/>
                    <strong>Monaco (Elekta):</strong><br/>
                    Monaco → System → DICOM → Storage SCP → agregar como nodo permitido el AE Title <code>AURA_RT</code>.<br/><br/>
                    <strong>Nota ngrok:</strong> Si el backend corre en Colab con ngrok, el C-STORE no puede
                    usar la URL ngrok (es HTTPS, no DICOM). El backend debe tener acceso de red directo al SCP.
                    En producción, ARIA y el servidor Colab deben estar en la misma red o VPN.
                  </div>
                </details>
              </div>
            )}
          </div>

          {/* Estudio DICOM */}
          <div className="accordion-item">
            <button className="accordion-trigger" onClick={() => toggleSection("estudio")}>
              <span className="accordion-arrow">{openSections.estudio ? "▾" : "▸"}</span>
              Estudio DICOM
              {studyFiles.length > 0 && (
                <span className="accordion-badge">{studyFiles.length} archivos</span>
              )}
            </button>
            {openSections.estudio && (
              <div className="accordion-body">
                <label className="upload-dropzone">
                  <input ref={fileInputRef} type="file" multiple onChange={handleStudySelection} />
                  <span>Seleccionar carpeta DICOM</span>
                  <small>Idealmente estudios ya anonimizados.</small>
                </label>
                {studyMeta && (
                  <div className="meta-compact">
                    <div className="meta-row">
                      <span>Modalidad</span>
                      <strong>{studyMeta.modality || "N/D"}</strong>
                    </div>
                    <div className="meta-row">
                      <span>Fecha</span>
                      <strong>{studyMeta.studyDate || "N/D"}</strong>
                    </div>
                    <div className="meta-row">
                      <span>Paciente</span>
                      <strong>{studyMeta.patientName || "N/D"}</strong>
                    </div>
                    <div className="meta-row">
                      <span>PatientID</span>
                      <strong>{studyMeta.patientId || "N/D"}</strong>
                    </div>
                    <div className="meta-row">
                      <span>Serie</span>
                      <strong>{studyMeta.seriesDescription || "N/D"}</strong>
                    </div>
                    <div className="meta-row">
                      <span>Archivos</span>
                      <strong>{studyMeta.fileCount || 0} · {bytesToReadable(studyMeta.totalBytes || 0)}</strong>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Estructuras */}
          <div className="accordion-item">
            <button className="accordion-trigger" onClick={() => toggleSection("estructuras")}>
              <span className="accordion-arrow">{openSections.estructuras ? "▾" : "▸"}</span>
              Estructuras
              {selectedCount > 0 && (
                <span className="accordion-badge">{selectedCount} sel.</span>
              )}
            </button>
            {openSections.estructuras && (
              <div className="accordion-body">
                <div className="pill-row">
                  {allPresets.map((preset) => (
                    <button
                      key={preset.id}
                      className="pill-button"
                      onClick={() => applyStructureSelection(preset.keys, `Preset ${preset.label}`)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>

                <div className="custom-preset-bar">
                  <input
                    className="text-input"
                    value={customPresetName}
                    onChange={(e) => setCustomPresetName(e.target.value)}
                    placeholder="Nombre del preset..."
                  />
                  <button className="secondary-button" onClick={saveCustomPreset}>
                    Guardar
                  </button>
                </div>

                {customPresets.length > 0 && (
                  <div className="saved-presets">
                    {customPresets.map((preset) => (
                      <div className="saved-preset" key={preset.id}>
                        <div>
                          <strong>{preset.label}</strong>
                          <small>{preset.keys.map((k) => structureLabel(k)).join(", ")}</small>
                        </div>
                        <div className="pill-row">
                          <button
                            className="pill-button"
                            onClick={() => applyStructureSelection(preset.keys, `Preset ${preset.label}`)}
                          >
                            Aplicar
                          </button>
                          <button
                            className="secondary-button danger"
                            onClick={() => deleteCustomPreset(preset.id, preset.label)}
                          >
                            Eliminar
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="structure-compact">
                  {structureGroups.map((group) => (
                    <div key={group.id}>
                      <p className="structure-group-label">{group.label}</p>
                      <div className="structure-list">
                        {group.items.map((item) => {
                          const checked = selectedStructures.includes(item.key);
                          const isReady = item.status === "ready";
                          const isSelectable = isStructureSelectable(item.key);
                          return (
                            <label
                              className={`structure-item ${checked ? "checked" : ""} ${!isSelectable ? "disabled" : ""}`}
                              key={item.key}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={!isSelectable}
                                onChange={() => toggleStructure(item.key)}
                              />
                              <span>{item.label}</span>
                              <small>{structureAvailabilityText(item, backendSupportedStructureSet)}</small>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Procesamiento */}
          <div className="accordion-item">
            <button className="accordion-trigger" onClick={() => toggleSection("procesamiento")}>
              <span className="accordion-arrow">{openSections.procesamiento ? "▾" : "▸"}</span>
              Procesamiento
              {isSubmitting && <span className="accordion-badge running">En curso</span>}
            </button>
            {openSections.procesamiento && (
              <div className="accordion-body">
                <div className="phase-chip">
                  {progressPhase} · {progressPercent}%
                </div>
                <div className="progress-rail">
                  <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
                </div>
                <div className="button-row">
                  <button className="primary-button" disabled={isSubmitting} onClick={submitCase}>
                    Iniciar
                  </button>
                  <button
                    className="secondary-button danger"
                    disabled={!isSubmitting}
                    onClick={cancelSubmission}
                  >
                    Cancelar
                  </button>
                </div>
                <div className="status-box">
                  <strong>Estado backend</strong>
                  <p>{backendStatus?.message || "Sin polling activo"}</p>
                  <div className="status-meta">
                    <span>Fase: {phaseLabel(backendStatus?.phase)}</span>
                    <span>Modelo: {backendStatus?.active_model || "N/D"}</span>
                  </div>
                  {backendStatus?.last_error && (
                    <div className="error-banner">{backendStatus.last_error}</div>
                  )}
                </div>
                <div className="log-box">
                  {logs.map((entry, index) => (
                    <div key={`${entry}-${index}`}>{entry}</div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Resultados */}
          <div className="accordion-item">
            <button className="accordion-trigger" onClick={() => toggleSection("resultados")}>
              <span className="accordion-arrow">{openSections.resultados ? "▾" : "▸"}</span>
              Resultados
              {result?.status === "completed" && (
                <span className="accordion-badge success">Listo</span>
              )}
            </button>
            {openSections.resultados && (
              <div className="accordion-body">
                {result ? (
                  <div className="result-stack">
                    <div className="result-grid">
                      <div className="result-summary">
                        <span>Case ID</span>
                        <strong>{result.case_id}</strong>
                      </div>
                      <div className="result-summary">
                        <span>Estado</span>
                        <strong>{phaseLabel(result.status)}</strong>
                      </div>
                      <div className="result-summary">
                        <span>Modelos</span>
                        <strong>{result.models_used.length ? result.models_used.join(", ") : "N/D"}</strong>
                      </div>
                      <div className="result-summary">
                        <span>Tiempo</span>
                        <strong>{formatDuration(result.processing_seconds)}</strong>
                      </div>
                      {result.dicom_send_summary && (
                        <div className="result-summary" style={{ gridColumn: "1 / -1" }}>
                          <span>C-STORE</span>
                          <strong style={{
                            color: result.dicom_send_summary.startsWith("C-STORE completado")
                              ? "#22c55e" : "#ef4444",
                            fontSize: "12px",
                            fontFamily: "monospace",
                          }}>
                            {result.dicom_send_summary}
                          </strong>
                        </div>
                      )}
                    </div>

                    <div className="result-section">
                      <div className="section-head">
                        <h4>Solicitud</h4>
                        <span className={`status-badge ${statusTone(result.status)}`}>
                          {phaseLabel(result.status)}
                        </span>
                      </div>
                      <div className="chip-list">
                        {result.requested_structures?.length ? (
                          result.requested_structures.map((item) => (
                            <span className="chip" key={item}>{structureLabel(item)}</span>
                          ))
                        ) : (
                          <span className="chip muted">Sin estructuras registradas</span>
                        )}
                      </div>
                    </div>

                    <div className="result-section">
                      <div className="section-head">
                        <h4>Estructuras generadas</h4>
                        <span>{result.generated_structures.length}</span>
                      </div>
                      <div className="result-list">
                        {result.generated_structures.length ? (
                          result.generated_structures.map((item) => (
                            <div className="result-item" key={item}>
                              <span>{item}</span>
                              <small>{referenceDsc[item] || "N/D"}</small>
                            </div>
                          ))
                        ) : (
                          <div className="empty-result compact">
                            <p>No hubo estructuras generadas.</p>
                          </div>
                        )}
                      </div>
                    </div>

                    {result.status === "completed" && (
                      <div className="result-section">
                        <div className="section-head">
                          <h4>Archivos de salida</h4>
                          <span>{resultAssets ? "Disponibles" : "Resumen"}</span>
                        </div>

                        {resultAssets ? (
                          <div className="download-list">
                            {downloadUrl && (
                              <div className="download-item">
                                <div>
                                  <strong>ZIP completo</strong>
                                  <small>{downloadName} · {bytesToReadable(resultAssets.zipSize)}</small>
                                </div>
                                <a
                                  className="anchor-button"
                                  href={downloadUrl}
                                  download={downloadName}
                                >
                                  Descargar
                                </a>
                              </div>
                            )}

                            <div className="download-item">
                              <div>
                                <strong>Serie CT original</strong>
                                <small>{resultAssets.ctFileCount} archivo(s) DICOM dentro del ZIP</small>
                              </div>
                              <span className="download-meta">Incluida</span>
                            </div>

                            <div className="download-item">
                              <div>
                                <strong>RT-STRUCT DICOM</strong>
                                <small>
                                  {resultAssets.rtstruct
                                    ? `${resultAssets.rtstruct.name} · ${bytesToReadable(resultAssets.rtstruct.size)}`
                                    : "No encontrado en la respuesta"}
                                </small>
                              </div>
                              {resultAssets.rtstruct ? (
                                <a
                                  className="anchor-button"
                                  href={resultAssets.rtstruct.url}
                                  download={resultAssets.rtstruct.name}
                                >
                                  Descargar
                                </a>
                              ) : (
                                <span className="download-meta warning">Falta</span>
                              )}
                            </div>
                          </div>
                        ) : (
                          <div className="empty-result compact">
                            <p>Este historial solo conserva el resumen local del caso.</p>
                            <small>Los archivos del resultado se pueden bajar al terminar el proceso actual.</small>
                          </div>
                        )}
                      </div>
                    )}

                    {result.status === "completed" && (
                      <div className="result-section">
                        <div className="section-head">
                          <h4>Volumenes generados</h4>
                          <span>{resultAssets?.masks?.length || 0}</span>
                        </div>

                        {resultAssets?.masks?.length ? (
                          <div className="volume-browser">
                            <div className="volume-list">
                              {resultAssets.masks.map((asset) => (
                                <div
                                  className={`volume-item ${selectedResultVolume?.path === asset.path ? "active" : ""}`}
                                  key={asset.path}
                                >
                                  <button
                                    className="volume-select"
                                    onClick={() => setSelectedVolumePath(asset.path)}
                                  >
                                    <strong>{asset.label}</strong>
                                    <small>
                                      {asset.name} · {bytesToReadable(asset.size)}
                                    </small>
                                  </button>
                                  <a
                                    className="pill-button"
                                    href={asset.url}
                                    download={asset.name}
                                  >
                                    NIfTI
                                  </a>
                                </div>
                              ))}
                            </div>

                            <div className="volume-preview-card">
                              {volumePreview?.status === "loading" && (
                                <div className="empty-result compact">
                                  <p>Cargando vista previa del volumen...</p>
                                </div>
                              )}

                              {volumePreview?.status === "error" && (
                                <div className="empty-result compact">
                                  <p>No se pudo abrir {volumePreview.label}.</p>
                                  <small>{volumePreview.message}</small>
                                </div>
                              )}

                              {volumePreview?.status === "ready" && (
                                <>
                                  <div className="volume-preview-head">
                                    <div>
                                      <strong>{volumePreview.label}</strong>
                                      <small>{volumePreview.name}</small>
                                    </div>
                                    <span className="status-badge neutral">
                                      Slice {volumePreview.sliceIndex + 1}/{volumePreview.sliceCount}
                                    </span>
                                  </div>

                                  <div className="volume-preview-meta">
                                    <span>Dims: {volumePreview.dimensions.join(" x ")}</span>
                                    <span>Spacing: {formatSpacing(volumePreview.spacing)} mm</span>
                                    <span>Tipo: {volumePreview.datatypeLabel}</span>
                                    <span>Activos: {volumePreview.nonZeroPercent.toFixed(2)}%</span>
                                  </div>

                                  <div className="volume-preview-frame">
                                    <img
                                      src={volumePreview.previewUrl}
                                      alt={`Vista previa axial de ${volumePreview.label}`}
                                    />
                                  </div>

                                  <small className="volume-preview-note">
                                    Se muestra el slice axial con mayor cantidad de voxeles activos.
                                  </small>
                                </>
                              )}
                            </div>
                          </div>
                        ) : (
                          <div className="empty-result compact">
                            <p>No hay mascaras NIfTI expuestas en el ZIP de salida.</p>
                          </div>
                        )}
                      </div>
                    )}

                    {result.error_message && (
                      <div className="error-banner">{result.error_message}</div>
                    )}
                    {result.warnings?.length > 0 && (
                      <div className="warning-banner">
                        {result.warnings.map((w) => <div key={w}>{w}</div>)}
                      </div>
                    )}

                    <div className="status-meta">
                      <span>Servidor: {result.server_url || "N/D"}</span>
                      <span>Registrado: {formatTimestamp(result.completed_at)}</span>
                    </div>
                  </div>
                ) : (
                  <div className="empty-result">
                    <p>Sin resultado todavia.</p>
                    <small>Procesá un caso para ver el resultado aqui.</small>
                  </div>
                )}

                <div className="history-panel">
                  <div className="section-head">
                    <h4>Ultimos casos</h4>
                    <button className="pill-button" onClick={clearHistory} disabled={!caseHistory.length}>
                      Limpiar
                    </button>
                  </div>
                  {caseHistory.length ? (
                    <div className="history-list">
                      {caseHistory.map((item) => (
                        <div className="history-item" key={`${item.case_id}-${item.completed_at}`}>
                          <div className="history-item-head">
                            <strong>{item.case_id}</strong>
                            <span className={`status-badge ${statusTone(item.status)}`}>
                              {phaseLabel(item.status)}
                            </span>
                          </div>
                          <div className="history-item-meta">
                            <span>{formatTimestamp(item.completed_at)}</span>
                            <span>{item.generated_structures.length} ROI</span>
                            <span>{formatDuration(item.processing_seconds)}</span>
                          </div>
                          <small>
                            {item.requested_structures?.map((k) => structureLabel(k)).join(", ") ||
                              "Sin estructuras"}
                          </small>
                          <button className="pill-button" onClick={() => restoreHistoryCase(item)}>
                            Ver resumen
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-result compact">
                      <p>Sin historial local.</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

        </div>
      </aside>

      <main className="main-stage">
        <header className="topbar">
          <h2>AURA-RT &nbsp;/&nbsp; Segmentacion CT</h2>
          <div className="status-cluster">
            <span className={`status-badge ${connectionState.tone}`}>{connectionState.label}</span>
            <span className="status-badge neutral">{progressPhase}</span>
          </div>
        </header>

        <div className="stage-metrics">
          <div className="metric-card">
            <span className="metric-label">Archivos</span>
            <strong>{studyFiles.length || "—"}</strong>
          </div>
          <div className="metric-card">
            <span className="metric-label">Estructuras sel.</span>
            <strong>{selectedCount || "—"}</strong>
          </div>
          <div className="metric-card">
            <span className="metric-label">Est. proceso</span>
            <strong>{estimateMinutes ? `~${estimateMinutes} min` : "—"}</strong>
          </div>
          <div className="metric-card">
            <span className="metric-label">Progreso</span>
            <strong>{progressPercent}%</strong>
          </div>
        </div>

        <div className="stage-preview">
          <div className="dicom-viewer-area">
            {studyMeta?.previewUrl ? (
              <figure className="preview-figure">
                {slices.length > 0 ? (
                  <DicomCanvas
                    slices={slices}
                    initialSliceIndex={Math.floor(slices.length / 2)}
                    windowCenter={studyMeta.previewWindowCenter}
                    windowWidth={studyMeta.previewWindowWidth}
                    onWindowChange={(wc, ww) => setViewWindow({ wc, ww })}
                    onSliceChange={(index, total) => setSliceInfo({ index, total })}
                    overlays={visibleOverlays}
                    forcedSliceIndex={viewerForcedSliceIndex}
                    overlayProgress={overlayProgress}
                  />
                ) : (
                  <img
                    className="preview-image"
                    src={studyMeta.previewUrl}
                    alt="Preview del slice DICOM"
                  />
                )}
                <figcaption className="preview-caption">
                  <span>
                    {slices.length > 0
                      ? `Slice ${sliceInfo.index + 1}/${sliceInfo.total}`
                      : `Slice ${studyMeta.instanceNumber || "N/D"}`}
                    {" · "}{studyMeta.rows} × {studyMeta.columns}
                  </span>
                  <span>WC {viewWindow?.wc ?? studyMeta.previewWindowCenter ?? "N/D"} / WW {viewWindow?.ww ?? studyMeta.previewWindowWidth ?? "N/D"}</span>
                  {livePreviewHeadline && <span>{livePreviewHeadline}</span>}
                </figcaption>
              </figure>
            ) : (
              <div className="preview-placeholder">
                <span>Preview DICOM</span>
                <p>
                  {studyMeta?.previewError ||
                    "Seleccioná una carpeta DICOM con pixel data no comprimido."}
                </p>
              </div>
            )}
          </div>

          {viewerOverlaySource.length > 0 && (
            <div className="structures-side-panel">
              <div className="struct-panel-header">
                <div className="struct-panel-heading">
                  <span className="struct-panel-title">Estructuras</span>
                  {livePreviewActive && <small className="struct-panel-subtitle">Preview en vivo</small>}
                </div>
                <button
                  className="pill-button"
                  onClick={() =>
                    setHiddenStructures(
                      allHidden ? [] : viewerOverlaySource.map((ov) => ov.label),
                    )
                  }
                >
                  {allHidden ? "Mostrar todas" : "Ocultar todas"}
                </button>
              </div>

              <div className="struct-list">
                {viewerOverlaySource.map((ov) => {
                  const isHidden = hiddenStructures.includes(ov.label);
                  const effectiveColor = structureColorOverrides[ov.label] ?? ov.color;
                  const hexColor = rgbToHex(effectiveColor);
                  const displayName = structureLabelMap[ov.label] || ov.label;
                  const volText = ov.volumeMl != null ? `${ov.volumeMl.toFixed(1)} ml` : null;
                  const structureIndex = livePreviewStructureOrder.indexOf(ov.label);
                  const isCurrent =
                    !!activePreviewStep && activePreviewStep.label === ov.label;
                  const isCompleted =
                    !!activePreviewStep &&
                    structureIndex >= 0 &&
                    structureIndex < activePreviewStep.structureIndex;
                  const previewStateLabel = livePreviewActive
                    ? isCurrent
                      ? `Slice ${activePreviewStep.sliceIndex + 1}`
                      : isCompleted
                        ? "Lista"
                        : "En cola"
                    : null;
                  return (
                    <div
                      key={ov.label}
                      className={`struct-row${isHidden ? " struct-hidden" : ""}${isCurrent ? " struct-drawing" : ""}${isCompleted ? " struct-drawn" : ""}`}
                    >
                      <label className="struct-color-wrap" title="Cambiar color">
                        <input
                          type="color"
                          value={hexColor}
                          onChange={(e) =>
                            setStructureColorOverrides((prev) => ({
                              ...prev,
                              [ov.label]: hexToRgb(e.target.value),
                            }))
                          }
                        />
                        <span
                          className="struct-color-swatch"
                          style={{ background: hexColor }}
                        />
                      </label>
                      <div className="struct-info">
                        <span className="struct-name">{displayName}</span>
                        <div className="struct-meta-line">
                          {volText && <span className="struct-vol">{volText}</span>}
                          {previewStateLabel && <span className="struct-state">{previewStateLabel}</span>}
                        </div>
                      </div>
                      <button
                        className={`struct-toggle${isHidden ? " off" : ""}`}
                        title={isHidden ? "Mostrar" : "Ocultar"}
                        onClick={() =>
                          setHiddenStructures((prev) =>
                            isHidden
                              ? prev.filter((l) => l !== ov.label)
                              : [...prev, ov.label],
                          )
                        }
                      >
                        {isHidden ? "○" : "●"}
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="struct-panel-footer">
                {resultAssets?.rtstruct && (
                  <a
                    className="anchor-button full-width"
                    style={{ textAlign: "center" }}
                    href={resultAssets.rtstruct.url}
                    download={resultAssets.rtstruct.name}
                  >
                    Descargar RT-STRUCT
                  </a>
                )}
                {downloadUrl && (
                  <a
                    className="anchor-button full-width"
                    style={{ textAlign: "center" }}
                    href={downloadUrl}
                    download={downloadName}
                  >
                    Descargar ZIP completo
                  </a>
                )}
              </div>
            </div>
          )}
        </div>

        <section className="safety-banner">
          <strong>Aviso clinico</strong>
          <p>RT-STRUCT borrador tecnico — requiere revision medica antes de uso clinico.</p>
        </section>
      </main>
    </div>
  );
}
