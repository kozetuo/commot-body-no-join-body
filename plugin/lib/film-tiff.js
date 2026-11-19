/* Baseline little-endian TIFF, one uncompressed 1-bit BlackIsZero strip.
 * The raster can be appended in row chunks, so even large films need little RAM.
 * No resampling, JPEG, alpha or printer halftoning is involved in film output.
 */
"use strict";

function createHeader(width, height, dpi) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("Film dimensions must be positive whole pixels.");
  }
  if (!Number.isFinite(dpi) || dpi <= 0 || dpi > 100000) {
    throw new Error("Film resolution must be a valid pixels-per-inch value.");
  }
  const rowBytes = Math.ceil(width / 8);
  const byteCount = rowBytes * height;
  const tagCount = 13;
  const rationalStart = 8 + 2 + tagCount * 12 + 4;
  const pixelOffset = rationalStart + 16;
  if (!Number.isSafeInteger(byteCount) || byteCount + pixelOffset > 0xffffffff) {
    throw new Error("A film exceeds the 4 GB baseline TIFF limit. Reduce the canvas dimensions.");
  }
  const data = new Uint8Array(pixelOffset);
  const view = new DataView(data.buffer);
  data[0] = 0x49; data[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, tagCount, true);
  const tags = [
    [256, 4, 1, width], [257, 4, 1, height], [258, 3, 1, 1],
    [259, 3, 1, 1], [262, 3, 1, 1], [273, 4, 1, pixelOffset],
    [277, 3, 1, 1], [278, 4, 1, height], [279, 4, 1, byteCount],
    [282, 5, 1, rationalStart], [283, 5, 1, rationalStart + 8],
    [284, 3, 1, 1], [296, 3, 1, 2]
  ];
  tags.forEach((tag, i) => {
    const at = 10 + i * 12;
    view.setUint16(at, tag[0], true);
    view.setUint16(at + 2, tag[1], true);
    view.setUint32(at + 4, tag[2], true);
    if (tag[1] === 3) view.setUint16(at + 8, tag[3], true);
    else view.setUint32(at + 8, tag[3], true);
  });
  const numerator = Math.round(dpi * 1000);
  view.setUint32(rationalStart, numerator, true);
  view.setUint32(rationalStart + 4, 1000, true);
  view.setUint32(rationalStart + 8, numerator, true);
  view.setUint32(rationalStart + 12, 1000, true);
  return { data, rowBytes, byteCount, pixelOffset };
}

function packRows(indices, width, height, inkIndex) {
  if (indices.length !== width * height) throw new Error("Film index buffer has the wrong size.");
  const rowBytes = Math.ceil(width / 8);
  const data = new Uint8Array(rowBytes * height);
  data.fill(255);
  for (let y = 0; y < height; y++) {
    const src = y * width;
    const dst = y * rowBytes;
    for (let x = 0; x < width; x++) {
      if (indices[src + x] === inkIndex) data[dst + (x >> 3)] &= ~(128 >> (x & 7));
    }
  }
  return data;
}

module.exports = { createHeader, packRows };
