const sharp = require("sharp");

const SAMPLE_WIDTH = 900;
const EDGE_MARGIN = 0.012;
const BRIDGE_GAP = 0.022;
const MIN_BAND_HEIGHT = 0.022;
const MAX_BAND_HEIGHT = 0.3;
const MIN_BAND_WIDTH = 0.08;
const BOX_PADDING = 0.008;

function otsuCutoff(gray) {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) histogram[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let sumDark = 0, darkCount = 0, best = -1, cutoff = 128;
  for (let i = 0; i < 256; i++) {
    darkCount += histogram[i];
    if (!darkCount) continue;
    const lightCount = total - darkCount;
    if (!lightCount) break;
    sumDark += i * histogram[i];
    const meanDark = sumDark / darkCount;
    const meanLight = (sum - sumDark) / lightCount;
    const variance = darkCount * lightCount * (meanDark - meanLight) ** 2;
    if (variance > best) { best = variance; cutoff = i; }
  }
  return cutoff;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

// Detect horizontal bands of page content (title, question rows, decoration) so
// AI-provided boxes can be aligned to real ink rows instead of a guessed grid.
async function analyzeAnswerLayout(image) {
  const { data, info } = await sharp(image).rotate().grayscale()
    .resize({ width: SAMPLE_WIDTH, withoutEnlargement: true })
    .raw().toBuffer({ resolveWithObject: true });
  const width = info.width, height = info.height;
  if (width < 200 || height < 200) return null;

  const cutoff = otsuCutoff(data);
  const rowInk = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0, offset = y * width; x < width; x++) if (data[offset + x] <= cutoff) count++;
    // Full-width rules (borders, table lines) are decoration, and would otherwise
    // glue the title band to the first question row.
    rowInk[y] = count >= width * 0.75 ? 0 : count;
  }
  const smooth = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    let sum = 0, samples = 0;
    for (let delta = -2; delta <= 2; delta++) {
      const row = y + delta;
      if (row < 0 || row >= height) continue;
      sum += rowInk[row];
      samples++;
    }
    smooth[y] = sum / samples;
  }

  const sortedInk = [...smooth].sort((a, b) => a - b);
  const base = sortedInk[height >> 1];
  const peak = sortedInk[Math.floor(height * 0.95)];
  if (peak - base < width * 0.01) return null;
  const rowLimit = base + (peak - base) * 0.3;

  const runs = [];
  let start = -1;
  for (let y = 0; y < height; y++) {
    if (smooth[y] >= rowLimit) {
      if (start < 0) start = y;
    } else if (start >= 0) {
      runs.push([start, y - 1]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, height - 1]);

  const bridge = Math.round(height * BRIDGE_GAP);
  const merged = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (previous && run[0] - previous[1] <= bridge) previous[1] = run[1];
    else merged.push([...run]);
  }

  const bands = [];
  const leftBound = Math.floor(width * EDGE_MARGIN);
  const rightBound = Math.ceil(width * (1 - EDGE_MARGIN));
  for (const [top, bottom] of merged) {
    if (bottom - top + 1 < height * MIN_BAND_HEIGHT) continue;
    const columns = new Uint32Array(width);
    for (let y = top; y <= bottom; y++) {
      const offset = y * width;
      for (let x = leftBound; x < rightBound; x++) if (data[offset + x] <= cutoff) columns[x]++;
    }
    const columnLimit = Math.max(1, Math.round((bottom - top + 1) * 0.02));
    let left = -1, right = -1;
    for (let x = leftBound; x < rightBound; x++) {
      if (columns[x] < columnLimit) continue;
      if (left < 0) left = x;
      right = x;
    }
    if (left < 0) continue;
    bands.push({
      top: round4(top / height),
      bottom: round4((bottom + 1) / height),
      left: round4(left / width),
      right: round4((right + 1) / width),
    });
  }

  const coverage = bands.reduce((sum, band) => sum + band.bottom - band.top, 0);
  if (!bands.length || coverage > 0.85) return null;
  return { width, height, bands };
}

// Bottom of the last handwritten/printed content row. Used to correct a whole
// set of AI boxes that is uniformly shifted up (a common failure when the
// teacher answer photo has a different crop from the student page).
async function lastInkRow(image) {
  const { data, info } = await sharp(image).rotate().grayscale()
    .resize({ width: SAMPLE_WIDTH, withoutEnlargement: true })
    .raw().toBuffer({ resolveWithObject: true });
  const width = info.width, height = info.height;
  if (width < 200 || height < 200) return null;
  const cutoff = otsuCutoff(data);
  const threshold = width * 0.01;
  const rowLimit = Math.floor(height * 0.95); // ignore page edge/footer
  for (let y = rowLimit; y >= 0; y--) {
    let count = 0;
    for (let x = 0, offset = y * width; x < width; x++) if (data[offset + x] <= cutoff) count++;
    if (count >= threshold && count <= width * 0.9) return y / height;
  }
  return null;
}

function bandBBox(band) {
  const left = Math.max(0, band.left - BOX_PADDING);
  const top = Math.max(0, band.top - BOX_PADDING);
  return [
    round4(left),
    round4(top),
    round4(Math.min(1 - left, band.right + BOX_PADDING - left)),
    round4(Math.min(1 - top, band.bottom + BOX_PADDING - top)),
  ];
}

function bandLooksValid(band) {
  const height = band.bottom - band.top;
  return height >= MIN_BAND_HEIGHT && height <= MAX_BAND_HEIGHT && band.right - band.left >= MIN_BAND_WIDTH;
}

// Assigns questions to detected bands in reading order. The sheet usually has one
// extra narrow band at the top (title/name line); it is dropped only when its width
// clearly differs from question rows, otherwise the AI boxes are left untouched.
function alignBoxes(entries, layout) {
  const bands = layout?.bands;
  const count = Array.isArray(entries) ? entries.length : 0;
  if (!count || !Array.isArray(bands) || !bands.length) return null;

  let selected;
  if (bands.length === count) {
    selected = bands;
  } else if (bands.length === count + 1) {
    const widths = bands.map((band) => band.right - band.left);
    const header = widths[0];
    const footer = widths[widths.length - 1];
    if (header <= median(widths.slice(1)) * 0.75) selected = bands.slice(1);
    else if (footer <= median(widths.slice(0, -1)) * 0.75) selected = bands.slice(0, -1);
    else return null;
  } else {
    return null;
  }

  if (!selected.every(bandLooksValid)) return null;
  const heights = selected.map((band) => band.bottom - band.top);
  if (Math.max(...heights) > Math.min(...heights) * 3) return null;

  return entries.map((entry, index) => ({ ...entry, bbox: bandBBox(selected[index]) }));
}

module.exports = { analyzeAnswerLayout, alignBoxes, bandBBox, lastInkRow };
