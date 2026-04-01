import dicomParser from "dicom-parser";

const LITTLE_ENDIAN_TRANSFER_SYNTAXES = new Set([
  "1.2.840.10008.1.2",
  "1.2.840.10008.1.2.1",
  "1.2.840.10008.1.2.1.99",
]);

const BIG_ENDIAN_TRANSFER_SYNTAX = "1.2.840.10008.1.2.2";

function readString(dataSet, tag) {
  try {
    const value = dataSet.string(tag);
    return value ? value.trim() : "";
  } catch {
    return "";
  }
}

function readNumber(dataSet, tag, fallback = 0) {
  const raw = readString(dataSet, tag);
  if (!raw) {
    return fallback;
  }
  const firstValue = raw.split("\\")[0];
  const numericValue = Number(firstValue);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function sortedFiles(files) {
  return [...files].sort((left, right) =>
    (left.webkitRelativePath || left.name).localeCompare(
      right.webkitRelativePath || right.name,
      undefined,
      { numeric: true, sensitivity: "base" },
    ),
  );
}

function selectPreviewFile(files) {
  const ordered = sortedFiles(files);
  if (!ordered.length) {
    return null;
  }
  return ordered[Math.floor(ordered.length / 2)];
}

function decodePixelArray(dataSet, rows, columns) {
  const pixelElement = dataSet.elements.x7fe00010;
  if (!pixelElement) {
    throw new Error("El archivo DICOM no contiene Pixel Data.");
  }

  const transferSyntax = readString(dataSet, "x00020010") || "1.2.840.10008.1.2.1";
  const isLittleEndian =
    LITTLE_ENDIAN_TRANSFER_SYNTAXES.has(transferSyntax) || transferSyntax === "";
  if (!isLittleEndian && transferSyntax !== BIG_ENDIAN_TRANSFER_SYNTAX) {
    throw new Error("Preview no disponible para DICOM comprimido en esta version.");
  }

  const bitsAllocated = readNumber(dataSet, "x00280100", 16);
  const pixelRepresentation = readNumber(dataSet, "x00280103", 0);
  const samplesPerPixel = readNumber(dataSet, "x00280002", 1);
  if (samplesPerPixel !== 1) {
    throw new Error("Preview solo soporta imagenes monocromas por ahora.");
  }

  const pixelCount = rows * columns;
  const bytesPerSample = bitsAllocated / 8;
  if (![1, 2].includes(bytesPerSample)) {
    throw new Error("BitsAllocated no soportado para preview.");
  }

  const byteArray = dataSet.byteArray;
  const pixelBytes = new Uint8Array(
    byteArray.buffer,
    byteArray.byteOffset + pixelElement.dataOffset,
    pixelElement.length,
  );
  const view = new DataView(pixelBytes.buffer, pixelBytes.byteOffset, pixelBytes.byteLength);
  const useLittleEndian = transferSyntax !== BIG_ENDIAN_TRANSFER_SYNTAX;
  const values = new Float32Array(pixelCount);
  const slope = readNumber(dataSet, "x00281053", 1);
  const intercept = readNumber(dataSet, "x00281052", 0);

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * bytesPerSample;
    let sample = 0;
    if (bytesPerSample === 1) {
      sample = pixelRepresentation === 0 ? view.getUint8(offset) : view.getInt8(offset);
    } else {
      sample =
        pixelRepresentation === 0
          ? view.getUint16(offset, useLittleEndian)
          : view.getInt16(offset, useLittleEndian);
    }
    values[index] = sample * slope + intercept;
  }

  return values;
}

function buildPreviewImage(dataSet) {
  const rows = readNumber(dataSet, "x00280010", 0);
  const columns = readNumber(dataSet, "x00280011", 0);
  if (!rows || !columns) {
    throw new Error("El archivo DICOM no contiene Rows/Columns validos.");
  }

  const huValues = decodePixelArray(dataSet, rows, columns);
  let minValue = Number.POSITIVE_INFINITY;
  let maxValue = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < huValues.length; index += 1) {
    const value = huValues[index];
    if (value < minValue) minValue = value;
    if (value > maxValue) maxValue = value;
  }

  const windowCenter = readNumber(dataSet, "x00281050", (minValue + maxValue) / 2);
  const windowWidth = Math.max(readNumber(dataSet, "x00281051", maxValue - minValue || 1), 1);
  const lowerBound = windowCenter - windowWidth / 2;
  const upperBound = windowCenter + windowWidth / 2;
  const canvas = document.createElement("canvas");
  canvas.width = columns;
  canvas.height = rows;
  const context = canvas.getContext("2d");
  const imageData = context.createImageData(columns, rows);

  for (let index = 0; index < huValues.length; index += 1) {
    const clamped = Math.max(lowerBound, Math.min(upperBound, huValues[index]));
    const normalized = Math.round(((clamped - lowerBound) / (upperBound - lowerBound)) * 255);
    const pixelOffset = index * 4;
    imageData.data[pixelOffset] = normalized;
    imageData.data[pixelOffset + 1] = normalized;
    imageData.data[pixelOffset + 2] = normalized;
    imageData.data[pixelOffset + 3] = 255;
  }

  context.putImageData(imageData, 0, 0);
  return {
    previewUrl: canvas.toDataURL("image/png"),
    rows,
    columns,
    windowCenter,
    windowWidth,
  };
}

export async function inspectDicomFiles(files) {
  const previewFile = selectPreviewFile(files);
  if (!previewFile) {
    return null;
  }

  try {
    const arrayBuffer = await previewFile.arrayBuffer();
    const byteArray = new Uint8Array(arrayBuffer);
    const dataSet = dicomParser.parseDicom(byteArray);

    let previewUrl = "";
    let previewError = "";
    let previewStats = null;

    try {
      previewStats = buildPreviewImage(dataSet);
      previewUrl = previewStats.previewUrl;
    } catch (error) {
      previewError = error instanceof Error ? error.message : "No se pudo generar el preview.";
    }

    return {
      modality: readString(dataSet, "x00080060") || "N/D",
      studyDate: readString(dataSet, "x00080020") || "N/D",
      patientName: readString(dataSet, "x00100010") || "N/D",
      patientId: readString(dataSet, "x00100020") || "N/D",
      seriesDescription: readString(dataSet, "x0008103e") || "N/D",
      instanceNumber: readString(dataSet, "x00200013") || "N/D",
      rows: previewStats?.rows || readNumber(dataSet, "x00280010", 0) || "N/D",
      columns: previewStats?.columns || readNumber(dataSet, "x00280011", 0) || "N/D",
      previewUrl,
      previewError,
      previewWindowCenter: previewStats?.windowCenter || null,
      previewWindowWidth: previewStats?.windowWidth || null,
      sourceFileName: previewFile.name,
      parseError: "",
    };
  } catch (error) {
    return {
      modality: "N/D",
      studyDate: "N/D",
      patientName: "N/D",
      patientId: "N/D",
      seriesDescription: "N/D",
      rows: "N/D",
      columns: "N/D",
      previewUrl: "",
      previewError: "",
      previewWindowCenter: null,
      previewWindowWidth: null,
      instanceNumber: "N/D",
      sourceFileName: previewFile.name,
      parseError: error instanceof Error ? error.message : "No se pudo leer el DICOM seleccionado.",
    };
  }
}
