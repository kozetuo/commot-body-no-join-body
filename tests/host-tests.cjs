"use strict";
const fs = require("fs");
const vm = require("vm");
const assert = require("assert/strict");
const path = require("path");
const base = path.resolve(__dirname, "../plugin/lib");
const tiff = require(path.join(base, "film-tiff"));

class FakeEntry {
  constructor(name, parent, directory) { this.name = name; this.parent = parent; this.directory = directory; this.entries = []; this.bytes = Buffer.alloc(0); }
  async getEntries() { return this.entries.slice(); }
  async createFolder(name) { let entry = this.entries.find(e => e.name === name); if (!entry) { entry = new FakeEntry(name, this, true); this.entries.push(entry); } return entry; }
  async createFile(name, options) { if (this.entries.some(e => e.name === name) && !options.overwrite) throw Error("exists"); const entry = new FakeEntry(name, this, false); this.entries.push(entry); return entry; }
  async write(data, options = {}) { const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data); this.bytes = options.append ? Buffer.concat([this.bytes, bytes]) : Buffer.from(bytes); }
  async delete() { if (this.directory && this.entries.length) throw Error("FolderIsNotEmpty"); this.parent.entries.splice(this.parent.entries.indexOf(this), 1); }
}

function setup({ width = 13, height = 530, failPut = false, rareAccent = false, realEngine = false } = {}) {
  let id = 1, layerId = 10;
  const source = { id, name: "Original.psd", width, height, resolution: 300, pixelAspectRatio: 1, activeHistoryState: { id: 7 } };
  const original = JSON.stringify(source);
  const documents = [source];
  const calls = { gets: [], puts: [], disposed: 0, registers: [], unregisters: [], closed: [], encodes: [], analysis: [] };
  const root = new FakeEntry("chosen", null, true);
  const rasters = new Map();
  const ps = {
    app: { documents, activeDocument: source },
    constants: { NewDocumentMode: { RGB: "RGB" }, DocumentFill: { TRANSPARENT: "transparent" }, LayerKind: { NORMAL: "normal" } },
    core: {}, imaging: {}
  };
  documents.add = async options => {
    const doc = { id: ++id, ...options, layers: [{ id: ++layerId }], async createLayer(kind, options) { const layer = { id: ++layerId, ...options }; doc.layers.push(layer); return layer; } };
    documents.push(doc); ps.app.activeDocument = doc;
    return doc;
  };
  ps.core.executeAsModal = async fn => {
    const registered = new Set();
    const context = { isCancelled: false, reportProgress() {}, hostControl: {
      async registerAutoCloseDocument(id) { registered.add(id); calls.registers.push(id); },
      async unregisterAutoCloseDocument(id) { registered.delete(id); calls.unregisters.push(id); },
      async suspendHistory({ documentID }) { return documentID; }, async resumeHistory() {}
    } };
    try { return await fn(context); }
    finally { for (const id of registered) { calls.closed.push(id); documents.splice(documents.findIndex(d => d.id === id), 1); } }
  };
  ps.imaging.getPixels = async options => {
    calls.gets.push(options);
    const b = options.sourceBounds;
    const w = b.right - b.left, h = b.bottom - b.top;
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const kind = ((y + b.top) * width + x) % 3;
      if (kind === 0) { data[p] = 255; data[p + 3] = 255; }
      if (kind === 1) { data[p + 2] = 255; data[p + 3] = 255; }
      if (rareAccent && y + b.top === height - 1 && x === width - 1) {
        data[p] = 0; data[p + 1] = 255; data[p + 2] = 0; data[p + 3] = 255;
      }
    }
    return { imageData: { width: w, height: h, components: 4, async getData() { return data; }, dispose() { calls.disposed++; } }, sourceBounds: b, level: 0 };
  };
  ps.imaging.createImageDataFromBuffer = async (data, options) => ({ ...options, data, dispose() { calls.disposed++; } });
  ps.imaging.encodeImageData = async options => { calls.encodes.push(options.imageData); return "mock"; };
  ps.imaging.putPixels = async options => {
    calls.puts.push(options);
    if (failPut) throw Error("host write failed");
    const key = options.documentID + ":" + options.layerID;
    const raster = rasters.get(key) || new Uint8Array(width * height * 4);
    if (options.replace) raster.fill(0);
    raster.set(options.imageData.data, options.targetBounds.top * width * 4);
    rasters.set(key, raster);
  };
  const engine = { createAnalyzer(options) {
    let pixelCount = 0, greenPixels = 0;
    return {
      add(image) {
        calls.analysis.push({ width: image.width, height: image.height });
        pixelCount += image.width * image.height;
        for (let p = 0; p < image.data.length; p += 4) if (image.data[p + 1] === 255) greenPixels++;
      },
      finish() { return { palette: [[255, 0, 0], [0, 0, 255], [0, 255, 0]], stats: { pixelCount, greenPixels } }; }
    };
  }, separate(image, palette, options) {
    assert.equal(options.sourceScale, 1);
    assert.equal(options.dpi, 300);
    const indices = new Uint8Array(image.width * image.height); indices.fill(255);
    for (let p = 0; p < indices.length; p++) if (image.data[p * 4 + 3]) indices[p] = image.data[p * 4] ? 0 : 1;
    return { indices };
  } };
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, Uint8Array, ArrayBuffer, DataView, setTimeout, require(name) {
    if (name === "photoshop") return ps;
    if (name === "uxp") return { storage: { formats: { binary: "binary", utf8: "utf8" }, localFileSystem: { async getFolder() { return root; } } } };
    if (name === "./separation") return realEngine ? require(path.join(base, "separation")) : engine;
    if (name === "./film-tiff") return tiff;
    throw Error(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(base, "photoshop-host.js"), "utf8"), sandbox, { filename: "photoshop-host.js" });
  return { host: module.exports, source, original, calls, root, documents, rasters };
}

function parseTIFF(buffer) {
  assert.equal(buffer.toString("ascii", 0, 2), "II");
  assert.equal(buffer.readUInt16LE(2), 42);
  const ifd = buffer.readUInt32LE(4), count = buffer.readUInt16LE(ifd);
  const tags = {};
  for (let i = 0; i < count; i++) {
    const p = ifd + 2 + i * 12, type = buffer.readUInt16LE(p + 2), n = buffer.readUInt32LE(p + 4), v = buffer.readUInt32LE(p + 8);
    tags[buffer.readUInt16LE(p)] = type === 5 ? buffer.readUInt32LE(v) / buffer.readUInt32LE(v + 4) : type === 3 && n === 1 ? buffer.readUInt16LE(p + 8) : v;
  }
  return tags;
}

async function run() {
  const palette = [[255, 0, 0], [0, 0, 255]];
  {
    const header = tiff.createHeader(13, 3, 299.7);
    const indices = new Uint8Array(39); indices.fill(255); indices[0] = 0; indices[12] = 0; indices[13] = 1; indices[38] = 0;
    const raster = tiff.packRows(indices, 13, 3, 0);
    assert.deepEqual(Array.from(raster), [127, 247, 255, 255, 255, 247]);
    const bytes = Buffer.concat([Buffer.from(header.data), Buffer.from(raster)]);
    const tags = parseTIFF(bytes);
    assert.equal(tags[256], 13); assert.equal(tags[257], 3); assert.equal(tags[258], 1); assert.equal(tags[262], 1);
    assert.equal(tags[282], 299.7); assert.equal(tags[283], 299.7); assert.equal(tags[296], 2);
    assert.equal(tags[273] + tags[279], bytes.length);
    fs.writeFileSync(path.join(require("os").tmpdir(), "commot-test-odd-width.tif"), bytes);
    assert.throws(() => tiff.createHeader(300000, 300000, 300), /4 GB/);
  }
  {
    const { host } = setup();
    const raw = { data: new Uint8Array([255,0,0,255, 0,0,255,255]), width: 2, height: 1, components: 4, bounds: { left: 2, top: 3, right: 4, bottom: 4 }, level: 0 };
    const image = host._testing.placePixels(raw, { left: 0, top: 0, right: 6, bottom: 5 }, 6, 5);
    assert.equal(image.data[(3 * 6 + 2) * 4], 255); assert.equal(image.data[(3 * 6 + 3) * 4 + 2], 255);
    assert.equal(image.data.filter((v, i) => i % 4 === 3 && v).length, 2);
    raw.level = 1;
    const small = host._testing.placePixels(raw, { left: 0, top: 0, right: 12, bottom: 10 }, 6, 5);
    assert.deepEqual(Array.from(small.data), Array.from(image.data));
  }
  {
    const { host, source, original, calls, rasters } = setup();
    const result = await host.createSeparations({ ...source, historyStateID: 7 }, palette, {});
    assert.equal(JSON.stringify(source), original);
    assert.equal(result.documentID, 2);
    assert.equal(calls.gets.length, 3);
    assert.equal(calls.puts.length, 6);
    assert(calls.gets.every(c => c.documentID === 1 && c.historyStateID === 7 && !c.applyAlpha));
    assert(calls.puts.every(c => c.documentID === 2 && c.replace === false));
    assert.deepEqual(calls.closed, []);
    assert.deepEqual(calls.unregisters, [2]);
    const layers = Array.from(rasters.values());
    for (let p = 0; p < source.width * source.height; p++) {
      assert.equal(layers[0][p * 4 + 3], p % 3 === 0 ? 255 : 0);
      assert.equal(layers[1][p * 4 + 3], p % 3 === 1 ? 255 : 0);
    }
  }
  {
    const { host, source, documents, calls } = setup({ failPut: true });
    await assert.rejects(host.createSeparations({ ...source, historyStateID: 7 }, palette, {}), /host write failed/);
    assert.equal(documents.length, 1); assert.deepEqual(calls.closed, [2]);
  }
  {
    const { host, source, root } = setup();
    const result = await host.exportFilms({ ...source, historyStateID: 7 }, palette, { mode: "solid" });
    assert.equal(result.files.length, 2);
    const job = root.entries[0];
    const manifest = JSON.parse(job.entries.find(e => e.name === "INK-MAP.json").bytes.toString());
    assert.equal(manifest.width, 13); assert.equal(manifest.height, 530); assert.equal(manifest.dpi, 300);
    for (let ink = 0; ink < 2; ink++) {
      const bytes = job.entries.find(e => e.name === result.files[ink]).bytes;
      const tags = parseTIFF(bytes);
      assert.equal(tags[273] + tags[279], bytes.length);
      for (let y = 0; y < 530; y++) for (let x = 0; x < 13; x++) {
        const bit = (bytes[tags[273] + y * 2 + (x >> 3)] >> (7 - (x & 7))) & 1;
        assert.equal(bit, (y * 13 + x) % 3 === ink ? 0 : 1);
      }
    }
  }
  {
    const { host, source } = setup(); source.activeHistoryState.id = 8;
    await assert.rejects(host.createSeparations({ ...source, historyStateID: 7 }, palette, {}), /changed/);
  }
  {
    const { host, source } = setup();
    let cancelled = false;
    await assert.rejects(host.createSeparations({ ...source, historyStateID: 7 }, palette, { isCancelled: () => cancelled }, () => { cancelled = true; }), /cancelled/);
  }
  {
    const { host, source, root } = setup({ height: 2 });
    const untouched = await root.createFile("prior-existing.tif", { overwrite: false });
    await untouched.write("prior data");
    let cancelled = false;
    await assert.rejects(host.exportFilms({ ...source, historyStateID: 7 }, palette,
      { isCancelled: () => cancelled }, fraction => { if (fraction === 1) cancelled = true; }), /cancelled/);
    assert.equal(root.entries.length, 1, "cancelled export removes all partial job files and folder");
    assert.equal(root.entries[0], untouched);
    assert.equal(untouched.bytes.toString(), "prior data");
  }
  {
    const { host, source, original, calls, documents } = setup({ rareAccent: true });
    assert.equal(typeof host.analyzeSource, "function");
    const result = await host.analyzeSource({ ...source, historyStateID: 7 }, { inkCount: 3 });
    assert.equal(result.stats.pixelCount, 13 * 530, "analysis sees every full-resolution pixel exactly once");
    assert.equal(result.stats.greenPixels, 1, "single-pixel accent survives source read");
    assert.equal(calls.gets.length, 3); assert.equal(calls.analysis.length, 3);
    assert(calls.gets.every(c => c.documentID === 1 && c.historyStateID === 7 && !c.targetSize));
    assert.equal(calls.disposed, 3);
    assert.equal(calls.puts.length, 0); assert.equal(documents.length, 1);
    assert.equal(JSON.stringify(source), original);
  }
  {
    const { host, source, calls } = setup({ height: 2 });
    let cancelled = false;
    await assert.rejects(host.analyzeSource({ ...source, historyStateID: 7 },
      { isCancelled: () => cancelled }, fraction => { if (fraction === 1) cancelled = true; }), /cancelled/);
    assert.equal(calls.disposed, 1);
  }
  {
    const { host, source, calls } = setup({ height: 2 });
    await assert.rejects(host.analyzeSource({ ...source, historyStateID: 7 }, {}, fraction => {
      if (fraction === 1) source.activeHistoryState.id = 8;
    }), /changed/);
    assert.equal(calls.disposed, 1);
  }
  {
    const { host, calls } = setup({ height: 2 });
    const result = await host.readPreview();
    assert.equal(result.image.data[11], 0, "third source pixel is transparent");
    assert.deepEqual(Array.from(calls.encodes[0].data.slice(6, 9)), [232, 230, 218], "original preview matches separation matte");
  }
  {
    const { host, source } = setup({ rareAccent: true, realEngine: true });
    const result = await host.analyzeSource({ ...source, historyStateID: 7 }, { inkCount: 3, substrate: "none", mode: "solid" });
    assert.equal(result.palette.length, 3);
    assert.equal(result.stats.sampledPixels, 13 * 530);
    assert.equal(result.stats.sourcePixels + result.stats.sourceTransparentPixels, 13 * 530);
    assert(result.palette.some(rgb => rgb[0] === 0 && rgb[1] === 255 && rgb[2] === 0), "real engine keeps a full-resolution single-pixel accent");
  }
  console.log("PASS: TIFF metadata/packing, trimmed/pyramid geometry, tiled layers, history pinning, source preservation, failure cleanup, streamed films, stale preview, cancellation.");
}
run().catch(e => { console.error(e); process.exitCode = 1; });
