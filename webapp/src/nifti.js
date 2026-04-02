import { gunzipSync } from "fflate";

const NATIVE_LITTLE_ENDIAN = (() => {
  const buffer = new ArrayBuffer(2);
  new DataView(buffer).setUint16(0, 0x00ff, true);
  return new Uint8Array(buffer)[0] === 0xff;
})();

const NIFTI_TYPED_ARRAYS = {
  2: { label: "UInt8", bytesPerVoxel: 1, ArrayType: Uint8Array },
  4: { label: "Int16", bytesPerVoxel: 2, ArrayType: Int16Array },
  8: { label: "Int32", bytesPerVoxel: 4, ArrayType: Int32Array },
  16: { label: "Float32", bytesPerVoxel: 4, ArrayType: Float32Array },
  64: { label: "Float64", bytesPerVoxel: 8, ArrayType: Float64Array },
  256: { label: "Int8", bytesPerVoxel: 1, ArrayType: Int8Array },
  512: { label: "UInt16", bytesPerVoxel: 2, ArrayType: Uint16Array },
  768: { label: "UInt32", bytesPerVoxel: 4, ArrayType: Uint32Array },
};

function isGzip(bytes) {
  return bytes?.[0] === 0x1f && bytes?.[1] === 0x8b;
}

function normalizeNiftiBytes(sourceBytes) {
  return isGzip(sourceBytes) ? gunzipSync(sourceBytes) : sourceBytes;
}

function detectLittleEndian(headerView) {
  if (headerView.getInt32(0, true) === 348) {
    return true;
  }
  if (headerView.getInt32(0, false) === 348) {
    return false;
  }
  throw new Error("Header NIfTI invalido o no soportado.");
}

function readSpacing(view, littleEndian) {
  const values = [];
  for (let index = 1; index <= 3; index += 1) {
    const spacing = view.getFloat32(76 + index * 4, littleEndian);
    values.push(Number.isFinite(spacing) && spacing > 0 ? spacing : 1);
  }
  return values;
}

function parseNiftiHeader(sourceBytes) {
  const bytes = normalizeNiftiBytes(sourceBytes);
  if (bytes.byteLength < 352) {
    throw new Error("Archivo NIfTI incompleto.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = detectLittleEndian(view);
  const width = Math.max(1, view.getInt16(42, littleEndian));
  const height = Math.max(1, view.getInt16(44, littleEndian));
  const depth = Math.max(1, view.getInt16(46, littleEndian));
  const volumes = Math.max(1, view.getInt16(48, littleEndian) || 1);
  const datatypeCode = view.getInt16(70, littleEndian);
  const bitpix = view.getInt16(72, littleEndian);
  const datatype = NIFTI_TYPED_ARRAYS[datatypeCode];

  if (!datatype) {
    throw new Error(`Datatype NIfTI no soportado: ${datatypeCode}.`);
  }

  const dataOffset = Math.max(0, Math.floor(view.getFloat32(108, littleEndian) || 352));
  const bytesPerVoxel = datatype.bytesPerVoxel || Math.max(1, bitpix / 8);
  const voxelCount = width * height * depth;
  const availableVoxelCount = Math.floor((bytes.byteLength - dataOffset) / bytesPerVoxel);
  if (availableVoxelCount < voxelCount) {
    throw new Error("El volumen NIfTI no contiene suficientes voxeles.");
  }

  return {
    bytes,
    littleEndian,
    width,
    height,
    depth,
    volumes,
    datatype,
    datatypeCode,
    bytesPerVoxel,
    dataOffset,
    voxelCount,
    spacing: readSpacing(view, littleEndian),
  };
}

function createVoxelReader(header) {
  const { bytes, littleEndian, datatypeCode, datatype, dataOffset, voxelCount } = header;
  const typedOffset = bytes.byteOffset + dataOffset;
  const useTypedArray =
    littleEndian === NATIVE_LITTLE_ENDIAN &&
    typedOffset % datatype.bytesPerVoxel === 0;

  if (useTypedArray) {
    const typed = new datatype.ArrayType(bytes.buffer, typedOffset, voxelCount);
    return {
      isActive(index) {
        return Math.abs(typed[index]) > 1e-6;
      },
    };
  }

  const view = new DataView(bytes.buffer, typedOffset, voxelCount * datatype.bytesPerVoxel);
  const readAt = {
    2: (offset) => view.getUint8(offset),
    4: (offset) => view.getInt16(offset, littleEndian),
    8: (offset) => view.getInt32(offset, littleEndian),
    16: (offset) => view.getFloat32(offset, littleEndian),
    64: (offset) => view.getFloat64(offset, littleEndian),
    256: (offset) => view.getInt8(offset),
    512: (offset) => view.getUint16(offset, littleEndian),
    768: (offset) => view.getUint32(offset, littleEndian),
  }[datatypeCode];

  return {
    isActive(index) {
      return Math.abs(readAt(index * datatype.bytesPerVoxel)) > 1e-6;
    },
  };
}

function buildPreviewCanvas(width, height, sliceOffset, sliceVoxelCount, reader) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const imageData = context.createImageData(width, height);

  for (let index = 0; index < sliceVoxelCount; index += 1) {
    const active = reader.isActive(sliceOffset + index);
    const pixelOffset = index * 4;

    if (active) {
      imageData.data[pixelOffset] = 64;
      imageData.data[pixelOffset + 1] = 197;
      imageData.data[pixelOffset + 2] = 255;
      imageData.data[pixelOffset + 3] = 255;
      continue;
    }

    imageData.data[pixelOffset] = 9;
    imageData.data[pixelOffset + 1] = 16;
    imageData.data[pixelOffset + 2] = 24;
    imageData.data[pixelOffset + 3] = 255;
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

export function parseNiftiMaskVolume(sourceBytes) {
  const header = parseNiftiHeader(sourceBytes);
  const reader = createVoxelReader(header);
  const sliceVoxelCount = header.width * header.height;
  const slices = [];

  for (let z = 0; z < header.depth; z++) {
    const mask = new Uint8Array(sliceVoxelCount);
    const sliceOffset = z * sliceVoxelCount;
    for (let i = 0; i < sliceVoxelCount; i++) {
      mask[i] = reader.isActive(sliceOffset + i) ? 1 : 0;
    }
    slices.push(mask);
  }

  return { slices, width: header.width, height: header.height, depth: header.depth, spacing: header.spacing };
}

export function buildNiftiMaskPreview(sourceBytes) {
  const header = parseNiftiHeader(sourceBytes);
  const reader = createVoxelReader(header);
  const sliceVoxelCount = header.width * header.height;

  let bestSliceIndex = Math.floor(header.depth / 2);
  let bestSliceVoxels = -1;
  let nonZeroVoxelCount = 0;

  for (let sliceIndex = 0; sliceIndex < header.depth; sliceIndex += 1) {
    const sliceOffset = sliceIndex * sliceVoxelCount;
    let sliceActiveVoxels = 0;

    for (let voxelIndex = 0; voxelIndex < sliceVoxelCount; voxelIndex += 1) {
      if (reader.isActive(sliceOffset + voxelIndex)) {
        sliceActiveVoxels += 1;
      }
    }

    nonZeroVoxelCount += sliceActiveVoxels;

    if (sliceActiveVoxels > bestSliceVoxels) {
      bestSliceVoxels = sliceActiveVoxels;
      bestSliceIndex = sliceIndex;
    }
  }

  const previewCanvas = buildPreviewCanvas(
    header.width,
    header.height,
    bestSliceIndex * sliceVoxelCount,
    sliceVoxelCount,
    reader,
  );

  return {
    previewUrl: previewCanvas.toDataURL("image/png"),
    dimensions: [header.width, header.height, header.depth],
    sliceIndex: bestSliceIndex,
    sliceCount: header.depth,
    spacing: header.spacing,
    datatypeLabel: header.datatype.label,
    nonZeroVoxelCount,
    nonZeroPercent: header.voxelCount
      ? (nonZeroVoxelCount / header.voxelCount) * 100
      : 0,
    highlightedSlicePercent: sliceVoxelCount
      ? (Math.max(bestSliceVoxels, 0) / sliceVoxelCount) * 100
      : 0,
  };
}
