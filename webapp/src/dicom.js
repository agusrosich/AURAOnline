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

function readNumberList(dataSet, tag) {
  const raw = readString(dataSet, tag);
  if (!raw) {
    return [];
  }
  return raw
    .split("\\")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
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

function getTransferSyntax(dataSet) {
  return readString(dataSet, "x00020010") || "1.2.840.10008.1.2.1";
}

function isSupportedTransferSyntax(transferSyntax) {
  return (
    LITTLE_ENDIAN_TRANSFER_SYNTAXES.has(transferSyntax) ||
    transferSyntax === "" ||
    transferSyntax === BIG_ENDIAN_TRANSFER_SYNTAX
  );
}

function readPositionVector(dataSet, tag, expectedLength) {
  const values = readNumberList(dataSet, tag);
  return values.length >= expectedLength ? values.slice(0, expectedLength) : null;
}

function computeSliceNormal(imageOrientation) {
  if (!imageOrientation || imageOrientation.length < 6) {
    return null;
  }
  const [rowX, rowY, rowZ, colX, colY, colZ] = imageOrientation;
  const normal = [
    rowY * colZ - rowZ * colY,
    rowZ * colX - rowX * colZ,
    rowX * colY - rowY * colX,
  ];
  const magnitude = Math.max(...normal.map((value) => Math.abs(value)));
  return magnitude > 1e-6 ? normal : null;
}

function projectPosition(imagePosition, sliceNormal) {
  if (!imagePosition || !sliceNormal) {
    return null;
  }
  return imagePosition.reduce(
    (sum, coordinate, index) => sum + coordinate * sliceNormal[index],
    0,
  );
}

function scorePreviewWindow(values, lowerBound, upperBound, invert) {
  const range = Math.max(upperBound - lowerBound, 1);
  let sum = 0;
  let sumSquares = 0;

  for (let index = 0; index < values.length; index += 1) {
    const clamped = Math.max(lowerBound, Math.min(upperBound, values[index]));
    let normalized = ((clamped - lowerBound) / range) * 255;
    if (invert) {
      normalized = 255 - normalized;
    }
    sum += normalized;
    sumSquares += normalized * normalized;
  }

  const mean = sum / values.length;
  const variance = Math.max(sumSquares / values.length - mean * mean, 0);
  const standardDeviation = Math.sqrt(variance);
  return standardDeviation - Math.abs(mean - 128) * 0.15;
}

function computePercentileWindow(values) {
  if (!values.length) {
    return { lowerBound: 0, upperBound: 1 };
  }

  const sampleStride = Math.max(1, Math.floor(values.length / 4096));
  const sample = [];
  for (let index = 0; index < values.length; index += sampleStride) {
    sample.push(values[index]);
  }
  sample.sort((left, right) => left - right);

  const pick = (ratio) => {
    const clampedRatio = Math.min(Math.max(ratio, 0), 1);
    const sampleIndex = Math.min(
      sample.length - 1,
      Math.max(0, Math.round(clampedRatio * (sample.length - 1))),
    );
    return sample[sampleIndex];
  };

  const lowerBound = pick(0.01);
  const upperBound = pick(0.99);
  if (upperBound > lowerBound) {
    return { lowerBound, upperBound };
  }

  const fallbackLower = sample[0];
  const fallbackUpper = sample[sample.length - 1];
  return {
    lowerBound: fallbackLower,
    upperBound: fallbackUpper > fallbackLower ? fallbackUpper : fallbackLower + 1,
  };
}

function choosePreviewWindow(dataSet, values) {
  let minValue = Number.POSITIVE_INFINITY;
  let maxValue = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value < minValue) minValue = value;
    if (value > maxValue) maxValue = value;
  }

  const percentileWindow = computePercentileWindow(values);
  const dicomWindowCenter = readNumber(dataSet, "x00281050", Number.NaN);
  const dicomWindowWidth = readNumber(dataSet, "x00281051", Number.NaN);
  const dicomWindowIsUsable =
    Number.isFinite(dicomWindowCenter) &&
    Number.isFinite(dicomWindowWidth) &&
    dicomWindowWidth > 1;

  const percentileScore = scorePreviewWindow(
    values,
    percentileWindow.lowerBound,
    percentileWindow.upperBound,
    readString(dataSet, "x00280004").toUpperCase() === "MONOCHROME1",
  );

  if (!dicomWindowIsUsable) {
    return {
      lowerBound: percentileWindow.lowerBound,
      upperBound: percentileWindow.upperBound,
      minValue,
      maxValue,
    };
  }

  const dicomLowerBound = dicomWindowCenter - dicomWindowWidth / 2;
  const dicomUpperBound = dicomWindowCenter + dicomWindowWidth / 2;
  const dicomScore = scorePreviewWindow(
    values,
    dicomLowerBound,
    dicomUpperBound,
    readString(dataSet, "x00280004").toUpperCase() === "MONOCHROME1",
  );

  if (dicomScore >= percentileScore - 6) {
    return {
      lowerBound: dicomLowerBound,
      upperBound: dicomUpperBound,
      minValue,
      maxValue,
    };
  }

  return {
    lowerBound: percentileWindow.lowerBound,
    upperBound: percentileWindow.upperBound,
    minValue,
    maxValue,
  };
}

function decodePixelArray(dataSet, rows, columns) {
  const pixelElement = dataSet.elements.x7fe00010;
  if (!pixelElement) {
    throw new Error("El archivo DICOM no contiene Pixel Data.");
  }

  const transferSyntax = getTransferSyntax(dataSet);
  const isLittleEndian =
    LITTLE_ENDIAN_TRANSFER_SYNTAXES.has(transferSyntax) || transferSyntax === "";
  if (!isSupportedTransferSyntax(transferSyntax)) {
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
  const invert = readString(dataSet, "x00280004").toUpperCase() === "MONOCHROME1";
  const { lowerBound, upperBound } = choosePreviewWindow(dataSet, huValues);
  const windowCenter = (lowerBound + upperBound) / 2;
  const windowWidth = Math.max(upperBound - lowerBound, 1);
  const canvas = document.createElement("canvas");
  canvas.width = columns;
  canvas.height = rows;
  const context = canvas.getContext("2d");
  const imageData = context.createImageData(columns, rows);
  const range = Math.max(upperBound - lowerBound, 1);

  for (let index = 0; index < huValues.length; index += 1) {
    const clamped = Math.max(lowerBound, Math.min(upperBound, huValues[index]));
    let normalized = Math.round(((clamped - lowerBound) / range) * 255);
    if (invert) {
      normalized = 255 - normalized;
    }
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

async function loadDicomCandidate(file) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const byteArray = new Uint8Array(arrayBuffer);
    const dataSet = dicomParser.parseDicom(byteArray);
    const transferSyntax = getTransferSyntax(dataSet);
    const rows = readNumber(dataSet, "x00280010", 0);
    const columns = readNumber(dataSet, "x00280011", 0);
    const samplesPerPixel = readNumber(dataSet, "x00280002", 1);
    const bitsAllocated = readNumber(dataSet, "x00280100", 16);
    const hasPixelData = Boolean(dataSet.elements.x7fe00010);
    const previewSupported =
      hasPixelData &&
      rows > 0 &&
      columns > 0 &&
      samplesPerPixel === 1 &&
      [8, 16].includes(bitsAllocated) &&
      isSupportedTransferSyntax(transferSyntax);

    return {
      file,
      dataSet,
      hasPixelData,
      previewSupported,
      instanceNumber: readNumber(dataSet, "x00200013", Number.NaN),
      imagePosition: readPositionVector(dataSet, "x00200032", 3),
      imageOrientation: readPositionVector(dataSet, "x00200037", 6),
      parseError: "",
    };
  } catch (error) {
    return {
      file,
      dataSet: null,
      hasPixelData: false,
      previewSupported: false,
      instanceNumber: Number.NaN,
      imagePosition: null,
      imageOrientation: null,
      parseError: error instanceof Error ? error.message : "No se pudo leer el DICOM seleccionado.",
    };
  }
}

function sortPreviewCandidates(candidates) {
  const sliceNormal = computeSliceNormal(
    candidates.find((candidate) => candidate.imageOrientation)?.imageOrientation || null,
  );

  return [...candidates].sort((left, right) => {
    const leftProjection = projectPosition(left.imagePosition, sliceNormal);
    const rightProjection = projectPosition(right.imagePosition, sliceNormal);
    if (leftProjection !== null && rightProjection !== null && leftProjection !== rightProjection) {
      return leftProjection - rightProjection;
    }

    const leftInstance = Number.isFinite(left.instanceNumber) ? left.instanceNumber : null;
    const rightInstance = Number.isFinite(right.instanceNumber) ? right.instanceNumber : null;
    if (leftInstance !== null && rightInstance !== null && leftInstance !== rightInstance) {
      return leftInstance - rightInstance;
    }

    return (left.file.webkitRelativePath || left.file.name).localeCompare(
      right.file.webkitRelativePath || right.file.name,
      undefined,
      { numeric: true, sensitivity: "base" },
    );
  });
}

async function selectPreviewCandidate(files) {
  const orderedFiles = sortedFiles(files);
  const parsedCandidates = [];

  for (const file of orderedFiles) {
    const candidate = await loadDicomCandidate(file);
    if (candidate.dataSet) {
      parsedCandidates.push(candidate);
    }
  }

  if (!parsedCandidates.length) {
    return {
      candidate: null,
      parseError:
        "No se pudo leer ningun archivo DICOM de la carpeta seleccionada.",
    };
  }

  const previewableCandidates = parsedCandidates.filter((candidate) => candidate.previewSupported);
  const metadataCandidate =
    previewableCandidates[0] || parsedCandidates.find((candidate) => candidate.dataSet) || null;

  if (!previewableCandidates.length) {
    return {
      candidate: metadataCandidate,
      parseError: parsedCandidates.find((candidate) => candidate.parseError)?.parseError || "",
    };
  }

  const orderedCandidates = sortPreviewCandidates(previewableCandidates);
  return {
    candidate: orderedCandidates[Math.floor(orderedCandidates.length / 2)] || metadataCandidate,
    parseError: "",
  };
}

export async function inspectDicomFiles(files) {
  const selection = await selectPreviewCandidate(files);
  const previewCandidate = selection.candidate;
  if (!previewCandidate?.dataSet) {
    return null;
  }

  try {
    const { file: previewFile, dataSet } = previewCandidate;

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
      parseError: selection.parseError || "",
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
      sourceFileName: previewCandidate.file.name,
      parseError:
        error instanceof Error ? error.message : "No se pudo leer el DICOM seleccionado.",
    };
  }
}
