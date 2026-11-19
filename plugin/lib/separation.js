/*
 * COMMOT BODY NO JOIN BODY — perceptual spot-color separation.
 * Dependency-free CommonJS / browser module. Colors are working-space sRGB.
 * A separation has exactly one ink index per pixel, or 255 for no ink.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CommotSeparation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const NONE = 255;
  const LINEAR = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    LINEAR[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function finite(v, fallback) { return Number.isFinite(Number(v)) ? Number(v) : fallback; }
  function srgb(v) {
    v = clamp(v, 0, 1);
    return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
  }
  function labLinear(r, g, b) {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }
  function rgbLab(rgb) { return labLinear(LINEAR[rgb[0]], LINEAR[rgb[1]], LINEAR[rgb[2]]); }
  function labRGB(v) {
    const l = Math.pow(v[0] + 0.3963377774 * v[1] + 0.2158037573 * v[2], 3);
    const m = Math.pow(v[0] - 0.1055613458 * v[1] - 0.0638541728 * v[2], 3);
    const s = Math.pow(v[0] - 0.0894841775 * v[1] - 1.2914855480 * v[2], 3);
    return [srgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      srgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      srgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)];
  }
  function distance(a, b) {
    const l = a[0] - b[0], c = a[1] - b[1], h = a[2] - b[2];
    return l * l + c * c + h * h;
  }
  function color(value) {
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      if (value.length < 3 || !Number.isFinite(Number(value[0])) || !Number.isFinite(Number(value[1])) || !Number.isFinite(Number(value[2]))) {
        throw new Error("An ink color must contain three RGB values.");
      }
      return [0, 1, 2].map(function (i) { return Math.round(clamp(Number(value[i]), 0, 255)); });
    }
    if (typeof value === "string" && /^#?[\da-f]{6}$/i.test(value)) {
      const n = parseInt(value.replace("#", ""), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    throw new Error("Use an RGB color or a six-digit hexadecimal color.");
  }
  function substrateColor(value) {
    if (value === undefined || value === null || value === false || value === "none") return null;
    if (value === "white") return [255, 255, 255];
    if (value === "black") return [0, 0, 0];
    return color(value);
  }
  function settings(options) {
    options = options || {};
    const k = finite(options.inkCount, 6);
    if (!Number.isInteger(k) || k < 3 || k > 8) throw new Error("Choose between 3 and 8 ink colors.");
    const dpi = finite(options.dpi, 300), lpi = finite(options.lpi, 35);
    if (dpi <= 0 || lpi <= 0) throw new Error("Resolution and screen frequency must be greater than zero.");
    const substrate = substrateColor(options.substrate);
    const mode = options.mode || "solid";
    if (mode !== "solid" && mode !== "halftone") throw new Error("Choose solid or halftone separation.");
    return {
      inkCount: k, mode: mode, dpi: dpi, lpi: lpi,
      angle: finite(options.angle, 22.5),
      sourceScale: Math.max(0.00001, finite(options.sourceScale, 1)),
      originX: finite(options.originX, 0), originY: finite(options.originY, 0),
      alphaThreshold: clamp(finite(options.alphaThreshold, 1), 0, 255),
      substrate: substrate, substrateLab: substrate ? rgbLab(substrate) : null,
      tolerance: clamp(finite(options.tolerance, 4), 0, 100),
      onProgress: typeof options.onProgress === "function" ? options.onProgress : null
    };
  }
  function imageSize(image) {
    if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0) {
      throw new Error("The image must have a positive pixel width and height.");
    }
    const size = image.width * image.height;
    if (!image.data || image.data.length < size * 4) throw new Error("The image must contain interleaved 8-bit RGBA pixels.");
    return size;
  }
  function keyOf(r, g, b) { return (r << 16) | (g << 8) | b; }
  function binOf(r, g, b) { return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3); }

  // Background tests are cached by exact RGB value while the cache remains small.
  // This preserves a literal tolerance of zero, even for values in the same bin.
  function backgroundTest(config) {
    if (!config.substrate) return function () { return false; };
    const cache = new Map(), tolerance2 = Math.pow(config.tolerance / 100, 2);
    return function (r, g, b) {
      const key = keyOf(r, g, b);
      if (cache.has(key)) return cache.get(key);
      const yes = distance(labLinear(LINEAR[r], LINEAR[g], LINEAR[b]), config.substrateLab) <= tolerance2 + 1e-14;
      if (cache.size < 65536) cache.set(key, yes);
      return yes;
    };
  }

  function sortedPalette(palette) {
    return palette.sort(function (a, b) {
      const al = rgbLab(a), bl = rgbLab(b);
      return al[0] - bl[0] || al[1] - bl[1] || al[2] - bl[2];
    });
  }

  /**
   * Incremental full-resolution palette analysis. Feed full-width RGBA strips
   * from top to bottom. Only the fixed histogram and one preceding row are
   * retained. A width change starts a new edge boundary rather than relating
   * unrelated rows. finish() is idempotent; adding after finish is an error.
   */
  function createAnalyzer(options) {
    const config = settings(options);
    const histogram = {
      weights: new Float64Array(32768), sumsR: new Float64Array(32768),
      sumsG: new Float64Array(32768), sumsB: new Float64Array(32768),
      exact: new Map(), sourceTransparentPixels: 0, substratePixels: 0,
      sourcePixels: 0, sampledPixels: 0
    };
    const isBackground = backgroundTest(config);
    let previousRow = null, previousWidth = 0, finished = false, result = null;
    const analyzer = {
      add: function (image) {
        if (finished) throw new Error("This palette analysis is already finished.");
        const size = imageSize(image), pixels = image.data, width = image.width;
        const above = previousWidth === width ? previousRow : null;
        const weights = histogram.weights, sumsR = histogram.sumsR, sumsG = histogram.sumsG, sumsB = histogram.sumsB;
        histogram.sampledPixels += size;
        for (let i = 0; i < size; i++) {
          const p = i * 4, a = pixels[p + 3];
          if (a < config.alphaThreshold || a === 0) { histogram.sourceTransparentPixels++; continue; }
          const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
          if (isBackground(r, g, b)) { histogram.substratePixels++; continue; }
          histogram.sourcePixels++;
          if (histogram.exact) {
            histogram.exact.set(keyOf(r, g, b), [r, g, b]);
            if (histogram.exact.size > config.inkCount) histogram.exact = null;
          }
          let edge = 0;
          if (i % width) {
            edge = Math.abs(r - pixels[p - 4]) + Math.abs(g - pixels[p - 3]) + Math.abs(b - pixels[p - 2]);
          }
          if (i >= width) {
            const q = p - width * 4;
            edge = Math.max(edge, Math.abs(r - pixels[q]) + Math.abs(g - pixels[q + 1]) + Math.abs(b - pixels[q + 2]));
          } else if (above) {
            edge = Math.max(edge, Math.abs(r - above[p]) + Math.abs(g - above[p + 1]) + Math.abs(b - above[p + 2]));
          }
          const w = (a / 255) * (1 + Math.min(2, edge / 90));
          const bin = binOf(r, g, b);
          weights[bin] += w; sumsR[bin] += r * w; sumsG[bin] += g * w; sumsB[bin] += b * w;
        }
        // Copy rather than retain a view into the complete strip's buffer.
        previousRow = new Uint8Array(width * 4);
        const rowStart = (image.height - 1) * width * 4;
        for (let p = 0; p < previousRow.length; p++) previousRow[p] = pixels[rowStart + p];
        previousWidth = width;
        return analyzer;
      },
      finish: function () {
        if (!finished) {
          result = quantizeHistogram(histogram, config);
          finished = true;
          histogram.weights = histogram.sumsR = histogram.sumsG = histogram.sumsB = histogram.exact = null;
          previousRow = null;
        }
        return result;
      }
    };
    return analyzer;
  }

  /**
   * Derive up to inkCount source-adaptive colors. The 5-bit histogram scans all
   * pixels, so a small accent is not missed by a regular sampling grid. Boundary
   * pixels receive extra weight; population weights are tempered to retain
   * small high-contrast details. K-means operates in perceptual OKLab space.
   */
  function analyze(image, options) {
    return createAnalyzer(options).add(image).finish();
  }

  function quantizeHistogram(histogram, config) {
    const weights = histogram.weights, sumsR = histogram.sumsR, sumsG = histogram.sumsG, sumsB = histogram.sumsB;
    const exact = histogram.exact;
    const stats = { sourcePixels: histogram.sourcePixels, sourceTransparentPixels: histogram.sourceTransparentPixels,
      substratePixels: histogram.substratePixels, sampledPixels: histogram.sampledPixels, requestedInks: config.inkCount };
    if (!histogram.sourcePixels) return { palette: [], coverage: [], stats: stats };
    if (exact) {
      const palette = sortedPalette(Array.from(exact.values()));
      stats.inkCount = palette.length;
      return { palette: palette, coverage: [], stats: stats };
    }
    const points = [];
    for (let i = 0; i < weights.length; i++) {
      if (!weights[i]) continue;
      const rgb = [Math.round(sumsR[i] / weights[i]), Math.round(sumsG[i] / weights[i]), Math.round(sumsB[i] / weights[i])];
      points.push({ rgb: rgb, lab: rgbLab(rgb), weight: Math.pow(weights[i], 0.78) });
    }
    const k = Math.min(config.inkCount, points.length), centers = [];
    let biggest = 0;
    for (let i = 1; i < points.length; i++) if (points[i].weight > points[biggest].weight) biggest = i;
    centers.push(points[biggest].lab.slice());
    const nearest = new Float64Array(points.length); nearest.fill(Infinity);
    for (let c = 1; c < k; c++) {
      let best = -1, bestScore = -1;
      const last = centers[c - 1];
      for (let i = 0; i < points.length; i++) {
        nearest[i] = Math.min(nearest[i], distance(points[i].lab, last));
        const score = nearest[i] * (0.15 + Math.sqrt(points[i].weight / points[biggest].weight));
        if (score > bestScore) { bestScore = score; best = i; }
      }
      centers.push(points[best].lab.slice());
    }
    const assignment = new Uint8Array(points.length);
    for (let iteration = 0; iteration < 28; iteration++) {
      const sums = Array.from({ length: k }, function () { return [0, 0, 0, 0]; });
      let changed = false;
      for (let i = 0; i < points.length; i++) {
        const point = points[i]; let best = 0, bestDistance = Infinity;
        for (let c = 0; c < k; c++) {
          const d = distance(point.lab, centers[c]);
          if (d < bestDistance) { bestDistance = d; best = c; }
        }
        if (assignment[i] !== best) changed = true;
        assignment[i] = best;
        const sum = sums[best], w = point.weight;
        sum[0] += point.lab[0] * w; sum[1] += point.lab[1] * w; sum[2] += point.lab[2] * w; sum[3] += w;
      }
      let movement = 0;
      for (let c = 0; c < k; c++) {
        if (!sums[c][3]) continue;
        const next = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
        movement += distance(centers[c], next); centers[c] = next;
      }
      if (config.onProgress) config.onProgress((iteration + 1) / 28);
      if (iteration > 0 && (!changed || movement < 1e-10)) break;
    }
    // Keep the perceptual centroids; collapse duplicates introduced by 8-bit
    // conversion. Empty/duplicate screens never consume the requested budget.
    const seen = new Set(), palette = [];
    for (let c = 0; c < centers.length; c++) {
      const rgb = labRGB(centers[c]), key = keyOf(rgb[0], rgb[1], rgb[2]);
      if (!seen.has(key)) { palette.push(rgb); seen.add(key); }
    }
    sortedPalette(palette); stats.inkCount = palette.length;
    return { palette: palette, coverage: [], stats: stats };
  }

  // Area-correct circular clustered-dot threshold. The CDF of radius in a unit
  // square makes a 25% tint cover approximately 25%, rather than an arbitrary
  // amount dictated by the spot-function shape.
  const DOT_CDF = new Float64Array(2049);
  for (let i = 0; i < DOT_CDF.length; i++) {
    const r2 = i / 2048 * 0.5, radius = Math.sqrt(r2);
    DOT_CDF[i] = r2 <= 0.25 ? Math.PI * r2 : Math.PI * r2 -
      4 * (r2 * Math.acos(0.5 / radius) - 0.5 * Math.sqrt(r2 - 0.25));
  }
  function threshold(x, y, period, cosine, sine) {
    let u = (x * cosine + y * sine) / period;
    let v = (-x * sine + y * cosine) / period;
    u = u - Math.floor(u) - 0.5; v = v - Math.floor(v) - 0.5;
    const f = Math.min(2048, (u * u + v * v) * 4096), i = Math.floor(f);
    return i === 2048 ? 1 : DOT_CDF[i] + (DOT_CDF[i + 1] - DOT_CDF[i]) * (f - i);
  }

  // Small lazy color lookup shared across document tiles. Each bin stores the
  // best single ink and the best two-color linear-light area mixture.
  let cachedLookup = null;
  function lookupFor(palette, config) {
    const signature = JSON.stringify([palette, config.mode, config.substrate]);
    if (cachedLookup && cachedLookup.signature === signature) return cachedLookup;
    const candidates = palette.map(function (rgb, index) {
      return { rgb: rgb, linear: rgb.map(function (v) { return LINEAR[v]; }), lab: rgbLab(rgb), index: index };
    });
    if (config.mode === "halftone" && config.substrate) {
      candidates.push({ rgb: config.substrate, linear: config.substrate.map(function (v) { return LINEAR[v]; }), lab: config.substrateLab, index: NONE });
    }
    const exact = new Map();
    palette.forEach(function (rgb, index) { const key = keyOf(rgb[0], rgb[1], rgb[2]); if (!exact.has(key)) exact.set(key, index); });
    const pairs = [];
    for (let a = 0; a < candidates.length; a++) for (let b = a + 1; b < candidates.length; b++) {
      const ca = candidates[a], cb = candidates[b];
      const delta = [cb.linear[0] - ca.linear[0], cb.linear[1] - ca.linear[1], cb.linear[2] - ca.linear[2]];
      const length2 = delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2];
      if (length2 > 1e-12) pairs.push({ a: a, b: b, delta: delta, length2: length2 });
    }
    cachedLookup = { signature: signature, candidates: candidates, exact: exact, pairs: pairs,
      entries: new Array(32768) };
    return cachedLookup;
  }
  function lookupBin(lookup, bin, halftone) {
    if (lookup.entries[bin]) return lookup.entries[bin];
    const r = ((bin >> 10) & 31) * 8 + 3, g = ((bin >> 5) & 31) * 8 + 3, b = (bin & 31) * 8 + 3;
    const linear = [LINEAR[r], LINEAR[g], LINEAR[b]], lab = labLinear(linear[0], linear[1], linear[2]);
    let single = 0, error = Infinity;
    for (let c = 0; c < lookup.candidates.length; c++) {
      const d = distance(lab, lookup.candidates[c].lab);
      if (d < error) { single = c; error = d; }
    }
    const result = { single: single, a: single, b: single, pair: null };
    if (halftone && error > 0.0000001) {
      let bestError = error;
      for (let p = 0; p < lookup.pairs.length; p++) {
        const pair = lookup.pairs[p], ca = lookup.candidates[pair.a], delta = pair.delta;
        const t = clamp(((linear[0] - ca.linear[0]) * delta[0] + (linear[1] - ca.linear[1]) * delta[1] +
          (linear[2] - ca.linear[2]) * delta[2]) / pair.length2, 0, 1);
        if (t <= 0.0001 || t >= 0.9999) continue;
        const mix = labLinear(ca.linear[0] + delta[0] * t, ca.linear[1] + delta[1] * t, ca.linear[2] + delta[2] * t);
        const e = distance(lab, mix);
        // A small improvement is not worth introducing dots into a flat area.
        if (e < bestError * 0.96) { bestError = e; result.a = pair.a; result.b = pair.b; result.pair = pair; }
      }
    }
    lookup.entries[bin] = result;
    return result;
  }

  /**
   * Apply an edited or analyzed palette at original resolution. Halftone
   * coordinates are expressed in source pixels, including when working on
   * preview pixels (sourceScale) or on tiles (originX/originY).
   */
  function separate(image, inputPalette, options) {
    const size = imageSize(image), config = settings(options);
    if (!Array.isArray(inputPalette) || inputPalette.length > 8) throw new Error("A palette must contain up to 8 RGB ink colors.");
    const palette = inputPalette.map(color), indices = new Uint8Array(size); indices.fill(NONE);
    const counts = new Array(palette.length).fill(0), pixels = image.data;
    const isBackground = backgroundTest(config), halftone = config.mode === "halftone";
    const lookup = palette.length ? lookupFor(palette, config) : null;
    const angle = config.angle * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
    const period = Math.max(2, config.dpi / config.lpi);
    const errorStride = Math.max(1, Math.floor(size / 4096));
    let sourceTransparentPixels = 0, substratePixels = 0, noInkPixels = 0;
    let errorSum = 0, errorWeight = 0, maxError = 0, errorSamples = 0;
    for (let i = 0; i < size; i++) {
      const p = i * 4, alpha = pixels[p + 3];
      if (alpha < config.alphaThreshold || alpha === 0 || (!halftone && alpha < 128)) {
        sourceTransparentPixels++; noInkPixels++; continue;
      }
      const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
      if (isBackground(r, g, b)) { substratePixels++; noInkPixels++; continue; }
      if (!lookup) { noInkPixels++; continue; }
      let chosen, mixLinear = null;
      const exactIndex = lookup.exact.get(keyOf(r, g, b));
      const x = config.originX + (i % image.width + 0.5) * config.sourceScale;
      const y = config.originY + (Math.floor(i / image.width) + 0.5) * config.sourceScale;
      let spot = 0;
      if (halftone) {
        spot = threshold(x, y, period, cosine, sine);
        if (alpha !== 255) {
          const opacity = alpha / 255;
          if (spot >= opacity) { noInkPixels++; continue; }
          spot /= opacity;
        }
      }
      if (exactIndex !== undefined) {
        chosen = exactIndex;
      } else {
        const entry = lookupBin(lookup, binOf(r, g, b), halftone);
        if (entry.pair) {
          const pair = entry.pair, ca = lookup.candidates[pair.a], cb = lookup.candidates[pair.b], d = pair.delta;
          const t = clamp(((LINEAR[r] - ca.linear[0]) * d[0] + (LINEAR[g] - ca.linear[1]) * d[1] +
            (LINEAR[b] - ca.linear[2]) * d[2]) / pair.length2, 0, 1);
          chosen = spot < t ? cb.index : ca.index;
          if (i % errorStride === 0) mixLinear = [ca.linear[0] + d[0] * t, ca.linear[1] + d[1] * t, ca.linear[2] + d[2] * t];
        } else chosen = lookup.candidates[entry.single].index;
      }
      indices[i] = chosen;
      if (chosen === NONE) noInkPixels++; else counts[chosen]++;
      if (i % errorStride === 0) {
        const sourceLab = labLinear(LINEAR[r], LINEAR[g], LINEAR[b]);
        const targetLab = mixLinear ? labLinear(mixLinear[0], mixLinear[1], mixLinear[2]) :
          (chosen === NONE ? config.substrateLab : lookup.candidates[chosen].lab);
        if (targetLab) {
          const e = Math.sqrt(distance(sourceLab, targetLab)) * 100, w = alpha / 255;
          errorSum += e * w; errorWeight += w; maxError = Math.max(maxError, e); errorSamples++;
        }
      }
    }
    return {
      indices: indices,
      coverage: counts.map(function (n) { return n / size; }),
      stats: { printablePixels: size - noInkPixels, transparentPixels: noInkPixels,
        sourceTransparentPixels: sourceTransparentPixels, substratePixels: substratePixels,
        meanDeltaE: errorWeight ? errorSum / errorWeight : 0, maxDeltaE: maxError,
        errorSamples: errorSamples, inkCount: palette.length, pixels: size,
        effectiveLpi: config.dpi / period }
    };
  }

  function validateIndices(indices, width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || !indices || indices.length < width * height) {
      throw new Error("The separation mask does not match the image dimensions.");
    }
  }
  function renderComposite(image, result, inputPalette, options) {
    const size = imageSize(image), indices = result && result.indices;
    validateIndices(indices, image.width, image.height);
    const palette = inputPalette.map(color), substrate = substrateColor(options && options.substrate);
    const data = new Uint8Array(size * 4);
    for (let i = 0; i < size; i++) {
      const rgb = indices[i] === NONE ? substrate : palette[indices[i]];
      if (!rgb) continue;
      const p = i * 4; data[p] = rgb[0]; data[p + 1] = rgb[1]; data[p + 2] = rgb[2]; data[p + 3] = 255;
    }
    return data;
  }
  function makePlate(indices, width, height, inkIndex) {
    validateIndices(indices, width, height);
    if (!Number.isInteger(inkIndex) || inkIndex < 0 || inkIndex > 7) throw new Error("Choose a valid ink index.");
    const data = new Uint8Array(width * height);
    for (let i = 0; i < data.length; i++) data[i] = indices[i] === inkIndex ? 0 : 255;
    return data;
  }
  function makeColorLayer(indices, width, height, inkIndex, inputPalette) {
    validateIndices(indices, width, height);
    const rgb = color(inputPalette[inkIndex]), data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) if (indices[i] === inkIndex) {
      const p = i * 4; data[p] = rgb[0]; data[p + 1] = rgb[1]; data[p + 2] = rgb[2]; data[p + 3] = 255;
    }
    return data;
  }

  return { analyze: analyze, createAnalyzer: createAnalyzer, separate: separate, renderComposite: renderComposite,
    makePlate: makePlate, makeColorLayer: makeColorLayer, NONE: NONE };
});
