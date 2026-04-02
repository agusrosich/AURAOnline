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
};

const SERVER_URL_QUERY_KEYS = ["backend", "server", "serverUrl"];
const DEFAULT_SERVER_URL =
  import.meta.env.VITE_AURA_RT_DEFAULT_SERVER_URL || "http://127.0.0.1:8000";
const POLL_INTERVAL_MS = Number(import.meta.env.VITE_AURA_RT_POLL_INTERVAL_MS || 5000);
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
  Brain:            [204, 102, 255],
  Prostate:         [255, 153, 153],
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
    return labels;
  }, {});

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

function structureLabel(key) {
  return structureLabelMap[key] || key;
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
    completed_at: new Date().toISOString(),
    server_url: serverUrl,
    study: studySummary,
    error_message: errorMessage,
  };
}

function DicomCanvas({ slices, initialSliceIndex, windowCenter: initWC, windowWidth: initWW, onWindowChange, onSliceChange, overlays }) {
  const canvasRef = useRef(null);
  const offscreenRef = useRef(null);
  const overlayOffscreenRef = useRef(null);
  const slicesRef = useRef(slices);
  const overlaysRef = useRef(overlays);
  overlaysRef.current = overlays;
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
    const { columns, rows } = slice;
    const oc = document.createElement("canvas");
    oc.width = columns;
    oc.height = rows;
    const ctx = oc.getContext("2d");
    const imageData = ctx.createImageData(columns, rows);
    for (const ov of ovList) {
      if (!ov.slices) continue;
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
  }, [overlays, buildOverlay, draw]);

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
  const [backendStatus, setBackendStatus] = useState(null);
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
  const [maskOverlays, setMaskOverlays] = useState([]);
  const [hiddenStructures, setHiddenStructures] = useState([]);
  const [structureColorOverrides, setStructureColorOverrides] = useState({});
  const [lastStatusMessage, setLastStatusMessage] = useState("");
  const [caseHistory, setCaseHistory] = useState(() => {
    const storedValue = loadStoredJson(STORAGE_KEYS.caseHistory, []);
    return Array.isArray(storedValue) ? storedValue : [];
  });

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
    if (!resultAssets?.masks?.length) {
      setMaskOverlays([]);
      return undefined;
    }
    let cancelled = false;
    Promise.all(
      resultAssets.masks.map(async (asset) => {
        const response = await fetch(asset.url);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const volume = parseNiftiMaskVolume(bytes);
        const color = STRUCTURE_COLORS[asset.label] ?? [255, 255, 0];
        let nonZeroCount = 0;
        for (const s of volume.slices) {
          for (let i = 0; i < s.length; i++) { if (s[i]) nonZeroCount++; }
        }
        const [sx, sy, sz] = volume.spacing ?? [1, 1, 1];
        const volumeMl = (nonZeroCount * sx * sy * sz) / 1000;
        return { label: asset.label, color, nonZeroCount, volumeMl, ...volume };
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
      const response = await fetch(
        buildBackendUrl(serverUrl, "/health"),
        buildBackendFetchOptions(serverUrl),
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      setConnectionState({ label: "Conectado", tone: "success" });
      setConnectionDetail("");
      appendLog("Conexion con backend validada por /health.");
    } catch (error) {
      const detail = explainConnectionError(error);
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
    setSelectedStructures((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );
  }

  function applyStructureSelection(keys, label) {
    const readyKeys = keys.filter((key) =>
      structureGroups.some((group) =>
        group.items.some((item) => item.key === key && item.status === "ready"),
      ),
    );
    setSelectedStructures(readyKeys);
    appendLog(`${label} aplicado con ${readyKeys.length} estructuras disponibles.`);
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
    const payloadMap = {
      "config.json": new TextEncoder().encode(
        JSON.stringify(
          {
            structures: requestedStructures,
            modality: "CT",
            fast_mode: true,
            anonymized_id: caseId,
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
      }
    } finally {
      abortRef.current = null;
      setIsSubmitting(false);
    }
  }

  function cancelSubmission() {
    if (abortRef.current) {
      abortRef.current.abort();
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
      maskOverlays
        .filter((ov) => !hiddenStructures.includes(ov.label))
        .map((ov) => ({
          ...ov,
          color: structureColorOverrides[ov.label] ?? ov.color,
        })),
    [maskOverlays, hiddenStructures, structureColorOverrides],
  );

  const allHidden = maskOverlays.length > 0 && hiddenStructures.length === maskOverlays.length;

  const [openSections, setOpenSections] = useState({
    servidor: false,
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
                {connectionDetail && <div className="error-banner">{connectionDetail}</div>}
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
                          return (
                            <label
                              className={`structure-item ${checked ? "checked" : ""} ${!isReady ? "disabled" : ""}`}
                              key={item.key}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={!isReady}
                                onChange={() => toggleStructure(item.key)}
                              />
                              <span>{item.label}</span>
                              <small>{isReady ? "MVP" : "Planned"}</small>
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

          {maskOverlays.length > 0 && (
            <div className="structures-side-panel">
              <div className="struct-panel-header">
                <span className="struct-panel-title">Estructuras</span>
                <button
                  className="pill-button"
                  onClick={() =>
                    setHiddenStructures(
                      allHidden ? [] : maskOverlays.map((ov) => ov.label),
                    )
                  }
                >
                  {allHidden ? "Mostrar todas" : "Ocultar todas"}
                </button>
              </div>

              <div className="struct-list">
                {maskOverlays.map((ov) => {
                  const isHidden = hiddenStructures.includes(ov.label);
                  const effectiveColor = structureColorOverrides[ov.label] ?? ov.color;
                  const hexColor = rgbToHex(effectiveColor);
                  const displayName = structureLabelMap[ov.label] || ov.label;
                  const volText = ov.volumeMl != null ? `${ov.volumeMl.toFixed(1)} ml` : null;
                  return (
                    <div key={ov.label} className={`struct-row${isHidden ? " struct-hidden" : ""}`}>
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
                        {volText && <span className="struct-vol">{volText}</span>}
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
