/* Photoshop UXP adapter. Requires Photoshop 25+ and manifest apiVersion 2.
 * Reads a history-pinned composite and writes only new documents / new folders.
 * Adobe API references are recorded in the accompanying README.
 */
"use strict";

const ps = require("photoshop");
const uxp = require("uxp");
const engine = require("./separation");
const tiff = require("./film-tiff");
const SRGB = "sRGB IEC61966-2.1";
const MAX_STRIP_PIXELS = 262144;

function findDocument(id) {
  for (let i = 0; i < ps.app.documents.length; i++) {
    if (ps.app.documents[i].id === id) return ps.app.documents[i];
  }
  return null;
}

function describe(doc) {
  return {
    id: doc.id,
    name: doc.name,
    width: Math.round(doc.width),
    height: Math.round(doc.height),
    resolution: doc.resolution,
    historyStateID: doc.activeHistoryState.id,
    pixelAspectRatio: doc.pixelAspectRatio
  };
}

function validateSource(source) {
  const doc = findDocument(source && source.id);
  if (!doc) throw new Error("The source document was closed. Open it and capture the artwork again.");
  if (Math.round(doc.width) !== source.width || Math.round(doc.height) !== source.height ||
      doc.resolution !== source.resolution || doc.activeHistoryState.id !== source.historyStateID) {
    throw new Error("The source artwork changed. Capture it again before creating separations.");
  }
  return doc;
}

function assertNotCancelled(context, options) {
  if ((context && context.isCancelled) || (options && options.isCancelled && options.isCancelled())) {
    const err = new Error("Separation cancelled.");
    err.name = "AbortError";
    throw err;
  }
}

function progress(context, callback, value, message) {
  if (context) context.reportProgress({ value, commandName: message });
  if (callback) callback(value, message);
}

function validatePalette(palette) {
  if (!Array.isArray(palette) || palette.length < 1 || palette.length > 8 ||
      palette.some(c => !Array.isArray(c) || c.length !== 3 || c.some(v => !Number.isFinite(v) || v < 0 || v > 255))) {
    throw new Error("Analyze the artwork to choose up to eight ink colors first.");
  }
}

function cleanName(value) {
  return String(value).replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").slice(0, 65) || "Artwork";
}

function hex(rgb) { return rgb.map(v => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase(); }

function optionsForSource(source, options, y) {
  return Object.assign({}, options, {
    dpi: source.resolution,
    sourceScale: 1,
    originX: 0,
    originY: y
  });
}

async function rawPixels(source, bounds, targetSize) {
  const request = {
    documentID: source.id,
    historyStateID: source.historyStateID,
    sourceBounds: bounds,
    colorSpace: "RGB",
    colorProfile: SRGB,
    componentSize: 8,
    applyAlpha: false
  };
  if (targetSize) request.targetSize = targetSize;
  const result = await ps.imaging.getPixels(request);
  const imageData = result.imageData;
  try {
    if (!imageData || imageData.width < 1 || imageData.height < 1) return null;
    if (imageData.components !== 3 && imageData.components !== 4) {
      throw new Error("Photoshop did not return RGB pixels. Convert a copy of the artwork to RGB and capture it again.");
    }
    // Copy out before dispose: ownership of getData's backing store is host-specific.
    const data = new Uint8Array(await imageData.getData({ chunky: true }));
    return {
      data, width: imageData.width, height: imageData.height,
      components: imageData.components,
      bounds: result.sourceBounds || bounds,
      level: result.level || 0
    };
  } finally {
    if (imageData) imageData.dispose();
  }
}

// Imaging.getPixels can trim transparent margins and return pyramid-relative
// bounds. Reconstruct the requested canvas instead of silently moving the art.
function placePixels(raw, bounds, width, height) {
  const rgba = new Uint8Array(width * height * 4);
  if (!raw) return { data: rgba, width, height };
  const factor = Math.pow(2, raw.level);
  const b = raw.bounds;
  const left = b.left * factor;
  const top = b.top * factor;
  const regionW = ((b.right !== undefined ? b.right - b.left : b.width) || 0) * factor;
  const regionH = ((b.bottom !== undefined ? b.bottom - b.top : b.height) || 0) * factor;
  const scaleX = width / (bounds.right - bounds.left);
  const scaleY = height / (bounds.bottom - bounds.top);
  const x0 = Math.round((left - bounds.left) * scaleX);
  const y0 = Math.round((top - bounds.top) * scaleY);
  const outW = Math.max(1, Math.round(regionW * scaleX));
  const outH = Math.max(1, Math.round(regionH * scaleY));
  for (let y = Math.max(0, y0); y < Math.min(height, y0 + outH); y++) {
    const sy = Math.min(raw.height - 1, Math.floor((y - y0) * raw.height / outH));
    for (let x = Math.max(0, x0); x < Math.min(width, x0 + outW); x++) {
      const sx = Math.min(raw.width - 1, Math.floor((x - x0) * raw.width / outW));
      const src = (sy * raw.width + sx) * raw.components;
      const dst = (y * width + x) * 4;
      rgba[dst] = raw.data[src]; rgba[dst + 1] = raw.data[src + 1]; rgba[dst + 2] = raw.data[src + 2];
      rgba[dst + 3] = raw.components === 4 ? raw.data[src + 3] : 255;
    }
  }
  return { data: rgba, width, height };
}

async function encodePreview(rgba, width, height, background) {
  const bg = background || [245, 242, 232];
  const rgb = new Uint8Array(width * height * 3);
  for (let p = 0, q = 0; p < rgba.length; p += 4, q += 3) {
    const a = rgba[p + 3] / 255;
    for (let c = 0; c < 3; c++) rgb[q + c] = Math.round(rgba[p + c] * a + bg[c] * (1 - a));
  }
  const imageData = await ps.imaging.createImageDataFromBuffer(rgb, {
    width, height, components: 3, colorSpace: "RGB", colorProfile: SRGB
  });
  try {
    return "data:image/jpeg;base64," + await ps.imaging.encodeImageData({ imageData, base64: true });
  } finally { imageData.dispose(); }
}

async function readPreview(maxDimension) {
  if (!ps.app.documents.length) throw new Error("Open your flat artwork in Photoshop first.");
  const doc = ps.app.activeDocument;
  const source = describe(doc);
  const limit = Math.max(64, Math.min(1600, Number(maxDimension) || 1000));
  const scale = Math.min(1, limit / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const bounds = { left: 0, top: 0, right: source.width, bottom: source.height };
  const raw = await rawPixels(source, bounds, { width, height });
  const image = placePixels(raw, bounds, width, height);
  validateSource(source);
  return { image, source, dataUrl: await encodePreview(image.data, width, height, [232, 230, 218]) };
}

// Infer the palette from every original pixel. Preview downsampling can erase
// tiny accents; the streaming analyzer preserves them without retaining a full
// high-resolution image in the plugin's heap. Reads are pinned to the captured
// history state and rejected if the source changes while analysis is running.
async function analyzeSource(source, options, onProgress) {
  options = options || {};
  validateSource(source);
  assertNotCancelled(null, options);
  const analyzer = engine.createAnalyzer(optionsForSource(source, options, 0));
  const rows = Math.max(1, Math.min(256, Math.floor(MAX_STRIP_PIXELS / source.width)));
  for (let y = 0; y < source.height; y += rows) {
    assertNotCancelled(null, options);
    const height = Math.min(rows, source.height - y);
    const bounds = { left: 0, top: y, right: source.width, bottom: y + height };
    const image = placePixels(await rawPixels(source, bounds), bounds, source.width, height);
    assertNotCancelled(null, options);
    analyzer.add(image);
    progress(null, onProgress, (y + height) / source.height, "Finding ink colors in the full-resolution artwork");
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assertNotCancelled(null, options);
  validateSource(source);
  const result = analyzer.finish();
  assertNotCancelled(null, options);
  return result;
}

function colorLayer(indices, width, height, ink, color) {
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0, q = 0; p < indices.length; p++, q += 4) {
    if (indices[p] === ink) {
      rgba[q] = color[0]; rgba[q + 1] = color[1]; rgba[q + 2] = color[2]; rgba[q + 3] = 255;
    }
  }
  return rgba;
}

async function eachStrip(source, palette, options, context, onStrip) {
  const rows = Math.max(1, Math.min(256, Math.floor(MAX_STRIP_PIXELS / source.width)));
  const totals = new Array(palette.length).fill(0);
  for (let y = 0; y < source.height; y += rows) {
    assertNotCancelled(context, options);
    const height = Math.min(rows, source.height - y);
    const bounds = { left: 0, top: y, right: source.width, bottom: y + height };
    const image = placePixels(await rawPixels(source, bounds), bounds, source.width, height);
    assertNotCancelled(context, options);
    const result = engine.separate(image, palette, optionsForSource(source, options, y));
    for (let p = 0; p < result.indices.length; p++) {
      if (result.indices[p] < palette.length) totals[result.indices[p]]++;
    }
    await onStrip({ y, width: source.width, height, result });
    assertNotCancelled(context, options);
    // Await host I/O above and this event-loop break make Escape responsive.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assertNotCancelled(context, options);
  return totals.map(count => count / (source.width * source.height));
}

async function createSeparations(source, palette, options, onProgress) {
  validatePalette(palette);
  options = options || {};
  validateSource(source);
  return ps.core.executeAsModal(async context => {
    validateSource(source);
    assertNotCancelled(context, options);
    const name = cleanName(source.name) + " — COMMOT " + palette.length + " inks";
    const doc = await ps.app.documents.add({
      name, width: source.width, height: source.height, resolution: source.resolution,
      mode: ps.constants.NewDocumentMode.RGB, fill: ps.constants.DocumentFill.TRANSPARENT,
      depth: 8, profile: SRGB
    });
    await context.hostControl.registerAutoCloseDocument(doc.id);
    const suspension = await context.hostControl.suspendHistory({ documentID: doc.id, name: "COMMOT color separation" });
    if (source.pixelAspectRatio) doc.pixelAspectRatio = source.pixelAspectRatio;
    const layers = [];
    for (let ink = 0; ink < palette.length; ink++) {
      assertNotCancelled(context, options);
      const layerName = "INK " + String(ink + 1).padStart(2, "0") + " • #" + hex(palette[ink]);
      if (ink === 0 && doc.layers.length) {
        layers.push(doc.layers[0]); layers[0].name = layerName;
      } else {
        layers.push(await doc.createLayer(ps.constants.LayerKind.NORMAL, { name: layerName }));
      }
    }
    const coverage = await eachStrip(source, palette, options, context, async strip => {
      for (let ink = 0; ink < palette.length; ink++) {
        assertNotCancelled(context, options);
        const data = colorLayer(strip.result.indices, strip.width, strip.height, ink, palette[ink]);
        const imageData = await ps.imaging.createImageDataFromBuffer(data, {
          width: strip.width, height: strip.height, components: 4, colorSpace: "RGB", colorProfile: SRGB
        });
        try {
          await ps.imaging.putPixels({
            documentID: doc.id, layerID: layers[ink].id, imageData, replace: false,
            targetBounds: { left: 0, top: strip.y }
          });
        } finally { imageData.dispose(); }
      }
      progress(context, onProgress, (strip.y + strip.height) / source.height, "Separating artwork into " + palette.length + " inks");
    });
    assertNotCancelled(context, options);
    await context.hostControl.resumeHistory(suspension);
    await context.hostControl.unregisterAutoCloseDocument(doc.id);
    return { documentID: doc.id, name, palette, coverage };
  }, { commandName: "COMMOT BODY NO JOIN BODY" });
}

async function uniqueJobFolder(parent, name) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const base = cleanName(name) + "-COMMOT-" + stamp;
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = base + (attempt ? "-" + attempt : "");
    // createFolder may return an existing folder: inspect before creating.
    const entries = await parent.getEntries();
    if (entries.some(entry => entry.name === candidate)) continue;
    return parent.createFolder(candidate);
  }
  throw new Error("Could not choose a new export folder name.");
}

async function exportFilms(source, palette, options, onProgress) {
  validatePalette(palette);
  options = options || {};
  validateSource(source);
  const header = tiff.createHeader(source.width, source.height, source.resolution);
  const folder = await uxp.storage.localFileSystem.getFolder();
  if (!folder) return null;
  validateSource(source);
  const jobFolder = await uniqueJobFolder(folder, source.name);
  const files = [];
  const fileNames = [];
  const createdEntries = [];
  let complete = false;
  try {
    for (let ink = 0; ink < palette.length; ink++) {
      const fileName = "INK-" + String(ink + 1).padStart(2, "0") + "-" + hex(palette[ink]) + ".tif";
      const file = await jobFolder.createFile(fileName, { overwrite: false });
      createdEntries.push(file);
      await file.write(header.data.buffer, { format: uxp.storage.formats.binary });
      files.push(file); fileNames.push(fileName);
    }
    const coverage = await ps.core.executeAsModal(async context => {
      validateSource(source);
      return eachStrip(source, palette, options, context, async strip => {
        for (let ink = 0; ink < palette.length; ink++) {
          assertNotCancelled(context, options);
          const data = tiff.packRows(strip.result.indices, strip.width, strip.height, ink);
          await files[ink].write(data.buffer, { format: uxp.storage.formats.binary, append: true });
        }
        progress(context, onProgress, (strip.y + strip.height) / source.height, "Writing 1-bit film separations");
      });
    }, { commandName: "Export COMMOT film positives" });
    assertNotCancelled(null, options);
    const manifest = await jobFolder.createFile("INK-MAP.json", { overwrite: false });
    createdEntries.push(manifest);
    await manifest.write(JSON.stringify({
      plugin: "COMMOT BODY NO JOIN BODY", version: "1.0.0", source: source.name,
      created: new Date().toISOString(), width: source.width, height: source.height,
      dpi: source.resolution, physicalWidthInches: source.width / source.resolution,
      physicalHeightInches: source.height / source.resolution,
      format: "1-bit uncompressed TIFF; black = ink; white = no ink; no mirroring; no registration marks",
      mode: options.mode || "solid", lpi: options.mode === "halftone" ? options.lpi : null,
      angle: options.mode === "halftone" ? options.angle : null,
      substrate: options.substrate || "none", tolerance: options.tolerance,
      alphaThreshold: options.alphaThreshold,
      inks: palette.map((rgb, i) => ({ number: i + 1, rgb, hex: "#" + hex(rgb), coverage: coverage[i], file: fileNames[i] }))
    }, null, 2), { format: uxp.storage.formats.utf8 });
    assertNotCancelled(null, options);
    const notes = await jobFolder.createFile("PRINT-NOTES.txt", { overwrite: false });
    createdEntries.push(notes);
    await notes.write("COMMOT BODY NO JOIN BODY\n\n" +
      "Print TIFFs at 100% / actual size. Disable fit-to-page and printer resampling.\n" +
      "Each black pixel exposes ink on that screen; white stays unprinted.\n" +
      "All films have identical canvas dimensions and source DPI.\n" +
      "Films are not mirrored. Mirror at output only when your film/emulsion workflow requires it.\n" +
      "Add matching registration marks outside the artwork before imaging if needed.\n" +
      "These are non-overlapping spot-color plates. No white underbase, trapping, choke, or press ink formula is generated.\n" +
      "Test mesh, LPI, minimum dot, ink opacity and substrate on your press before production.\n" +
      "INK-MAP.json lists the sRGB color targets and coverage.\n");
    assertNotCancelled(null, options);
    complete = true;
    return { folderName: jobFolder.name, files: fileNames, palette, coverage };
  } finally {
    if (!complete) {
      // Only remove our newly created job. Never touch any pre-existing files.
      for (const entry of createdEntries) {
        try { await entry.delete(); } catch (_) { /* Preserve the original operation error. */ }
      }
      try { await jobFolder.delete(); } catch (_) { /* The UI reports failure; partial job may remain. */ }
    }
  }
}

module.exports = { readPreview, analyzeSource, encodePreview, createSeparations, exportFilms, validateSource,
  _testing: { placePixels, colorLayer, optionsForSource, cleanName, eachStrip } };
