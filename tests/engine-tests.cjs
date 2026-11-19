const assert = require('node:assert/strict');
const S = require('../plugin/lib/separation.js');
function image(width, height, pixel) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return { width, height, data };
}
function crop(img, x0, y0, width, height) {
  return image(width, height, (x, y) => Array.from(img.data.slice(((y + y0) * img.width + x + x0) * 4, ((y + y0) * img.width + x + x0) * 4 + 4)));
}
const colors = [[14, 30, 40], [245, 76, 52], [252, 209, 88], [20, 184, 176], [90, 52, 137], [255, 255, 255], [62, 84, 116], [198, 125, 108]];
let checks = 0;
function test(name, fn) { fn(); checks++; process.stdout.write('PASS ' + name + '\n'); }

test('preserves exact three-color artwork and deterministic palette', () => {
  const img = image(90, 70, (x, y) => [...colors[(x + y) % 3], 255]);
  const a = S.analyze(img, { inkCount: 3 });
  assert.deepEqual(a, S.analyze(img, { inkCount: 3 }));
  assert.deepEqual(new Set(a.palette.map(String)), new Set(colors.slice(0, 3).map(String)));
  const result = S.separate(img, a.palette, { inkCount: 3 });
  assert.deepEqual(S.renderComposite(img, result, a.palette), img.data);
  assert.equal(result.stats.meanDeltaE, 0);
  assert.equal(result.coverage.reduce((a, b) => a + b, 0), 1);
});
test('preserves all eight colors at an eight-ink budget', () => {
  const img = image(80, 60, (x, y) => [...colors[(x + y) % 8], 255]);
  const a = S.analyze(img, { inkCount: 8 });
  assert.equal(a.palette.length, 8);
  const result = S.separate(img, a.palette, { inkCount: 8, mode: 'halftone' });
  assert.deepEqual(S.renderComposite(img, result, a.palette), img.data);
});
test('returns fewer screens for fewer source colors', () => {
  const img = image(1, 1, () => [23, 45, 78, 255]);
  assert.deepEqual(S.analyze(img, { inkCount: 8 }).palette, [[23, 45, 78]]);
  assert.deepEqual(Array.from(S.separate(img, [[23, 45, 78]], {}).indices), [0]);
});
test('transparent artwork remains empty and does not create inks', () => {
  const img = image(10, 10, () => [120, 20, 220, 0]);
  const a = S.analyze(img, { inkCount: 4 });
  assert.equal(a.palette.length, 0);
  const result = S.separate(img, a.palette, {});
  assert.equal(result.stats.printablePixels, 0);
  assert.ok(result.indices.every(i => i === 255));
  assert.ok(S.renderComposite(img, result, a.palette).every(i => i === 0));
});
test('white background removal is explicit and respects a zero tolerance', () => {
  const img = image(3, 1, x => x === 0 ? [255, 255, 255, 255] : x === 1 ? [254, 254, 254, 255] : [...colors[0], 255]);
  assert.equal(S.analyze(img, { inkCount: 3, substrate: 'none' }).palette.length, 3);
  const options = { inkCount: 3, substrate: 'white', tolerance: 0 };
  const a = S.analyze(img, options);
  assert.equal(a.palette.length, 2);
  const result = S.separate(img, a.palette, options);
  assert.equal(result.indices[0], 255);
  assert.notEqual(result.indices[1], 255);
  assert.equal(result.stats.substratePixels, 1);
});
test('every pixel belongs to one plate, with no overlaps or missing solid art', () => {
  const img = image(128, 96, (x, y) => [x * 2, Math.min(255, y * 3), (x * 7 + y * 9) % 256, 255]);
  const a = S.analyze(img, { inkCount: 5 });
  assert.equal(a.palette.length, 5);
  const result = S.separate(img, a.palette, {});
  const plates = a.palette.map((_, i) => S.makePlate(result.indices, img.width, img.height, i));
  for (let p = 0; p < result.indices.length; p++) {
    assert.ok(result.indices[p] < a.palette.length);
    assert.equal(plates.reduce((sum, plate) => sum + (plate[p] === 0 ? 1 : 0), 0), 1);
  }
  for (let i = 0; i < a.palette.length; i++) {
    const layer = S.makeColorLayer(result.indices, img.width, img.height, i, a.palette);
    for (let p = 0; p < result.indices.length; p++) assert.equal(layer[p * 4 + 3], result.indices[p] === i ? 255 : 0);
  }
});
test('clustered halftones approximate intended linear-light area coverage', () => {
  const img = image(384, 384, () => [188, 188, 188, 255]);
  const palette = [[0, 0, 0], [255, 255, 255]];
  const result = S.separate(img, palette, { mode: 'halftone', dpi: 300, lpi: 25, angle: 22.5 });
  // sRGB 188 is approximately 50.3% linear white; the dot screen should agree.
  assert.ok(Math.abs(result.coverage[1] - 0.503) < 0.012, result.coverage.join(','));
  assert.ok(result.stats.meanDeltaE < 0.001, result.stats.meanDeltaE);
  assert.equal(result.stats.transparentPixels, 0);
});
test('substrate highlights create no-ink halftones without adding a screen', () => {
  const img = image(300, 300, () => [188, 188, 188, 255]);
  const result = S.separate(img, [[0, 0, 0]], { mode: 'halftone', substrate: 'white', tolerance: 0, dpi: 300, lpi: 25, angle: 22.5 });
  assert.ok(Math.abs(result.coverage[0] - 0.497) < 0.015);
  assert.ok(result.stats.transparentPixels > 40000);
  const composite = S.renderComposite(img, result, [[0, 0, 0]], { substrate: 'white' });
  for (let p = 0; p < result.indices.length; p++) assert.equal(composite[p * 4 + 3], 255);
});
test('partial alpha becomes tint area, not semi-transparent ink', () => {
  const img = image(300, 300, () => [...colors[1], 128]);
  const result = S.separate(img, [colors[1]], { mode: 'halftone', dpi: 300, lpi: 25, angle: 22.5 });
  assert.ok(Math.abs(result.coverage[0] - 128 / 255) < 0.015);
  const layer = S.makeColorLayer(result.indices, 300, 300, 0, [colors[1]]);
  for (let p = 3; p < layer.length; p += 4) assert.ok(layer[p] === 0 || layer[p] === 255);
});
test('halftone alignment is identical across tiles including X and Y origins', () => {
  const img = image(91, 77, (x, y) => [60 + (x * 2) % 170, 50 + (y * 2) % 170, 110, 255]);
  const palette = [colors[0], colors[1], colors[2], colors[3]];
  const options = { mode: 'halftone', dpi: 300, lpi: 37, angle: 22.5 };
  const full = S.separate(img, palette, options);
  const tiles = [[0, 0, 31, 29], [31, 0, 60, 29], [0, 29, 31, 48], [31, 29, 60, 48]];
  for (const [x0, y0, width, height] of tiles) {
    const tile = S.separate(crop(img, x0, y0, width, height), palette, { ...options, originX: x0, originY: y0 });
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) assert.equal(tile.indices[y * width + x], full.indices[(y0 + y) * img.width + x0 + x]);
  }
});
test('preview scale uses original document pixel coordinates', () => {
  const source = image(120, 80, () => [188, 188, 188, 255]);
  const preview = image(60, 40, () => [188, 188, 188, 255]);
  const palette = [[0, 0, 0], [255, 255, 255]], options = { mode: 'halftone', dpi: 300, lpi: 25, angle: 22.5 };
  // A sourceScale=2 pixel center is (1,1), matching an origin-shifted full-res pixel center.
  const full = S.separate(source, palette, { ...options, originX: 0.5, originY: 0.5 });
  const small = S.separate(preview, palette, { ...options, sourceScale: 2 });
  for (let y = 0; y < preview.height; y++) for (let x = 0; x < preview.width; x++) assert.equal(small.indices[y * preview.width + x], full.indices[(y * 2) * source.width + x * 2]);
});
test('streamed palette analysis exactly matches full-frame analysis across row boundaries', () => {
  const img = image(129, 93, (x, y) => {
    if ((x + y) % 23 === 0) return [255, 255, 255, 255];
    return [(x * 13 + y * 7) % 256, (x * 31 + y * 11) % 256, (x * 3 + y * 29) % 256, (x * 17 + y * 37) % 256];
  });
  const options = { inkCount: 6, substrate: 'white', tolerance: 2, alphaThreshold: 20 };
  const full = S.analyze(img, options);
  for (const rows of [1, 2, 7, 32, 93]) {
    const streamed = S.createAnalyzer(options);
    for (let y = 0; y < img.height; y += rows) streamed.add(crop(img, 0, y, img.width, Math.min(rows, img.height - y)));
    const actual = streamed.finish();
    assert.deepEqual(actual, full, `Mismatch with ${rows} rows per strip`);
    assert.strictEqual(streamed.finish(), actual);
    assert.throws(() => streamed.add(img), /already finished/);
  }
});
test('streamed exact-color analysis retains a one-pixel accent within the ink budget', () => {
  const img = image(127, 129, (x, y) => x === 63 && y === 64 ? [...colors[3], 255] : [...colors[(x + y) % 2], 255]);
  const streamed = S.createAnalyzer({ inkCount: 3 });
  for (let y = 0; y < img.height; y++) streamed.add(crop(img, 0, y, img.width, 1));
  const result = streamed.finish();
  assert.deepEqual(result, S.analyze(img, { inkCount: 3 }));
  assert.deepEqual(new Set(result.palette.map(String)), new Set([colors[0], colors[1], colors[3]].map(String)));
  assert.equal(result.stats.sampledPixels, img.width * img.height);
});
test('an analyzer with no strips returns an empty palette', () => {
  const result = S.createAnalyzer({ inkCount: 3 }).finish();
  assert.deepEqual(result.palette, []);
  assert.equal(result.stats.sampledPixels, 0);
});
test('invalid inputs fail with useful messages', () => {
  assert.throws(() => S.analyze(image(1, 1, () => [0, 0, 0, 255]), { inkCount: 2 }), /3 and 8/);
  assert.throws(() => S.analyze({ width: 2, height: 2, data: new Uint8Array(2) }, {}), /RGBA/);
  assert.throws(() => S.separate(image(1, 1, () => [0, 0, 0, 255]), [[0, 0, 0]], { lpi: 0 }), /greater than zero/);
  assert.throws(() => S.makePlate(new Uint8Array(2), 2, 2, 0), /dimensions/);
});
process.stdout.write(`${checks} engine tests passed.\n`);
