import { startTransition, useEffect, useRef, useState } from "react";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { inspectDicomFiles } from "./dicom";
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

function parseZipReport(blob) {
  return blob.arrayBuffer().then((buffer) => {
    const archive = unzipSync(new Uint8Array(buffer));
    const reportBytes = archive["report.json"];
    if (!reportBytes) {
      return null;
    }
    return JSON.parse(strFromU8(reportBytes));
  });
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
  const [backendStatus, setBackendStatus] = useState(null);
  const [studyFiles, setStudyFiles] = useState([]);
  const [studyMeta, setStudyMeta] = useState(null);
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
    if (!isSubmitting) {
      return undefined;
    }

    const intervalId = window.setInterval(async () => {
      try {
        const response = await fetch(`${serverUrl.replace(/\/$/, "")}/status`);
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
    appendLog(`Resumen historico cargado para ${snapshot.case_id}.`);
  }

  function clearHistory() {
    setCaseHistory([]);
    appendLog("Historial local limpiado.");
  }

  async function verifyConnection() {
    setConnectionState({ label: "Verificando...", tone: "neutral" });
    try {
      const response = await fetch(`${serverUrl.replace(/\/$/, "")}/health`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      setConnectionState({ label: "Conectado", tone: "success" });
      appendLog("Conexion con backend validada por /health.");
    } catch (error) {
      setConnectionState({ label: "Sin conexion", tone: "danger" });
      appendLog(`Error de conexion: ${error.message}`);
    }
  }

  async function handleStudySelection(event) {
    const files = Array.from(event.target.files || []);
    setResult(null);
    setDownloadUrl("");
    setDownloadName("");

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
    appendLog(`Construyendo request ZIP para ${caseId}.`);

    for (const file of studyFiles) {
      const relativePath = file.webkitRelativePath || file.name;
      const archivePath = relativePath.startsWith("dicom/")
        ? relativePath
        : `dicom/${relativePath}`;
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
      const response = await fetch(`${serverUrl.replace(/\/$/, "")}/segment`, {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new Error(detail || `HTTP ${response.status}`);
      }

      setPhase("Downloading");
      appendLog("Respuesta recibida. Extrayendo reporte.");
      const responseBlob = await response.blob();
      const report =
        (await parseZipReport(responseBlob)) || {
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
      setResult(snapshot);
      recordCaseHistory(snapshot);
      setPhase("Completed");
      appendLog("Caso completado. ZIP listo para descargar.");
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

      setResult(snapshot);
      recordCaseHistory(snapshot);
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
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="https://xxxxx.ngrok-free.app"
                />
                <button className="primary-button full-width" onClick={verifyConnection}>
                  Verificar conexion
                </button>
                <p className="field-help">
                  La URL queda guardada en este navegador. Tambien podes abrir la app con
                  <code>?backend=https://...</code>.
                </p>
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

                    {downloadUrl && (
                      <a className="primary-button anchor-button" href={downloadUrl} download={downloadName}>
                        Descargar ZIP
                      </a>
                    )}
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
          {studyMeta?.previewUrl ? (
            <figure className="preview-figure">
              <img
                className="preview-image"
                src={studyMeta.previewUrl}
                alt="Preview del slice DICOM"
              />
              <figcaption className="preview-caption">
                <span>Slice {studyMeta.instanceNumber || "N/D"} · {studyMeta.rows} × {studyMeta.columns}</span>
                <span>WC {studyMeta.previewWindowCenter ?? "N/D"} / WW {studyMeta.previewWindowWidth ?? "N/D"}</span>
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

        <section className="safety-banner">
          <strong>Aviso clinico</strong>
          <p>RT-STRUCT borrador tecnico — requiere revision medica antes de uso clinico.</p>
        </section>
      </main>
    </div>
  );
}
