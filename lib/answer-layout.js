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

const LINE_GAP = 8;
const SEPARATOR_MAX_HEIGHT = 0.008;
const SEPARATOR_MIN_SPAN = 0.5;
const SECTION_SPLIT_GAP = 0.045;
const BOX_VERTICAL_TOLERANCE = 0.04;

function lineExtent(data, width, top, bottom, left, right) {
  let first = -1, last = -1;
  const rows = [];
  for (let y = top; y <= bottom; y++) {
    const offset = y * width;
    let count = 0, minX = -1, maxX = -1;
    for (let x = left; x < right; x++) {
      if (data[offset + x] >= 128) continue;
      count++;
      if (minX < 0) minX = x;
      maxX = x;
    }
    rows.push({ y, count, minX, maxX, offset });
    if (count) {
      if (first < 0) first = y;
      last = y;
    }
  }
  if (first < 0) return null;
  let minX = width, maxX = 0;
  for (const row of rows) if (row.count) { minX = Math.min(minX, row.minX); maxX = Math.max(maxX, row.maxX); }
  return { top: first, bottom: last, left: minX, right: maxX };
}

// Detects the column split (two-column exercise books) and the text lines
// inside each column. Thin dashed rules separate question sections.
async function analyzePageLayout(image) {
  const { data, info } = await sharp(image).rotate().grayscale()
    .resize({ width: SAMPLE_WIDTH, withoutEnlargement: true })
    .raw().toBuffer({ resolveWithObject: true });
  const width = info.width, height = info.height;
  if (width < 200 || height < 200) return null;

  const colProfile = new Int32Array(width);
  for (let y = 0; y < height; y++) {
    const offset = y * width;
    for (let x = 0; x < width; x++) if (data[offset + x] < 128) colProfile[x]++;
  }
  const sorted = [...colProfile].sort((a, b) => a - b);
  const medianProfile = sorted[width >> 1] || 0;
  let split = Math.floor(width / 2), best = Infinity;
  const low = Math.floor(width * 0.35), high = Math.ceil(width * 0.65);
  for (let x = low; x < high; x++) {
    let sum = 0;
    for (let delta = -3; delta <= 3; delta++) sum += colProfile[Math.min(width - 1, Math.max(0, x + delta))];
    if (sum < best) { best = sum; split = x; }
  }
  const gutter = Math.round(width * 0.004);
  const ranges = medianProfile && best / 7 < medianProfile * 0.5
    ? [[0, split - gutter], [split + gutter, width]]
    : [[0, width]];

  const columns = [];
  for (const [left, right] of ranges) {
    if (right - left < width * 0.15) continue;
    const rowInk = new Float64Array(height);
    for (let y = 0; y < height; y++) {
      let count = 0;
      const offset = y * width;
      for (let x = left; x < right; x++) if (data[offset + x] < 128) count++;
      rowInk[y] = count >= (right - left) * 0.8 ? 0 : count;
    }

    const runs = [];
    let start = -1;
    for (let y = 0; y < height; y++) {
      if (rowInk[y] > 2) { if (start < 0) start = y; }
      else if (start >= 0) { runs.push([start, y - 1]); start = -1; }
    }
    if (start >= 0) runs.push([start, height - 1]);

    const merged = [];
    for (const run of runs) {
      const previous = merged[merged.length - 1];
      if (previous && run[0] - previous[1] <= LINE_GAP) previous[1] = run[1];
      else merged.push([...run]);
    }

    const lines = merged.map(([top, bottom]) => {
      const extent = lineExtent(data, width, top, bottom, left, right);
      return extent ? {
        top: round4(extent.top / height), bottom: round4((extent.bottom + 1) / height),
        left: round4(extent.left / width), right: round4((extent.right + 1) / width),
      } : null;
    }).filter(Boolean);

    const separators = [];
    const text = [];
    for (const line of lines) {
      const lineHeight = line.bottom - line.top;
      const span = line.right - line.left;
      if (lineHeight <= SEPARATOR_MAX_HEIGHT && span >= (right - left) / width * SEPARATOR_MIN_SPAN) {
        separators.push(line);
      } else {
        text.push(line);
      }
    }

    const separatorCenters = separators.map((line) => (line.top + line.bottom) / 2);
    const regionOf = (y) => separatorCenters.reduce((count, center) => count + (center < y ? 1 : 0), 0);

    const sections = [];
    let current = [];
    let previousBottom = null;
    let currentRegion = null;
    const flush = () => {
      if (!current.length) return;
      sections.push({
        top: Math.min(...current.map((line) => line.top)),
        bottom: Math.max(...current.map((line) => line.bottom)),
        left: Math.min(...current.map((line) => line.left)),
        right: Math.max(...current.map((line) => line.right)),
        lines: current,
      });
      current = [];
    };
    for (const line of text) {
      const region = regionOf(line.top);
      if (current.length && (region !== currentRegion || line.top - previousBottom > SECTION_SPLIT_GAP)) flush();
      current.push(line);
      currentRegion = region;
      previousBottom = line.bottom;
    }
    flush();

    const usable = sections.filter((section) => section.bottom - section.top >= MIN_BAND_HEIGHT && section.right - section.left >= 0.1);
    for (const section of usable) section.height = round4(section.bottom - section.top);

    if (usable.length) columns.push({ left: round4(left / width), right: round4(right / width), sections: usable, lines: text, separators });
  }

  return columns.length ? { width, height, columns } : null;
}

function boxOverlap(a, b) {
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  return Math.max(0, bottom - top);
}

function sectionScore(bbox, section) {
  const top = bbox[1], bottom = bbox[1] + bbox[3];
  const overlap = boxOverlap({ top, bottom }, section);
  const distance = Math.abs((top + bottom) / 2 - (section.top + section.bottom) / 2);
  return overlap * 10 - distance;
}

// Order-preserving assignment of questions to sections: questions keep the
// answer-key order and sections keep page order, so a rough model box cannot
// jump across a separator onto a neighbour's block.
function assignSections(items, sections) {
  const n = items.length, m = sections.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(-Infinity));
  const take = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(false));
  for (let j = 0; j <= m; j++) dp[0][j] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = dp[i][j - 1];
      const score = dp[i - 1][j - 1] + sectionScore(items[i - 1].bbox, sections[j - 1]);
      if (score > dp[i][j]) { dp[i][j] = score; take[i][j] = true; }
    }
  }
  const picked = new Array(n).fill(null);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (take[i][j]) { picked[i - 1] = sections[j - 1]; i--; j--; }
    else j--;
  }
  return picked;
}

// Drops a one-off narrow band (page title or footer) when it would otherwise
// shift every question onto its neighbour's block.
function questionSections(column, count) {
  const sections = column.sections;
  if (sections.length !== count + 1) return sections;
  const widths = sections.map((section) => section.right - section.left);
  const first = widths[0];
  const last = widths[widths.length - 1];
  if (first <= median(widths.slice(1)) * 0.75) return sections.slice(1);
  if (last <= median(widths.slice(0, -1)) * 0.75) return sections.slice(0, -1);
  return sections;
}

// Places AI-located boxes onto real text sections: a box is snapped to the
// section it mostly covers, then split from sibling questions by the model's
// own vertical guesses. This fixes two-column pages where reading-order grids
// (alignBoxes) cannot work.
function placeBoxes(entries, layout) {
  if (!layout?.columns?.length || !Array.isArray(entries) || !entries.length) return null;
  const result = entries.map((entry) => ({ ...entry }));
  const boxes = result.map((entry, index) => ({ index, bbox: entry.bbox })).filter((item) => Array.isArray(item.bbox));

  for (const column of layout.columns) {
    const inside = boxes.filter((item) => {
      const center = item.bbox[0] + item.bbox[2] / 2;
      return center >= column.left && center <= column.right;
    });
    if (!inside.length) continue;

    const sections = questionSections(column, inside.length);
    const picked = assignSections(inside, sections);
    const grouped = new Map();
    inside.forEach((item, position) => {
      let bestSection = picked[position];
      if (!bestSection) {
        let bestScore = -Infinity;
        for (const section of sections) {
          const score = sectionScore(item.bbox, section);
          if (score > bestScore) { bestScore = score; bestSection = section; }
        }
      }
      if (!bestSection) return;
      if (!grouped.has(bestSection)) grouped.set(bestSection, []);
      grouped.get(bestSection).push(item);
    });

    for (const [section, items] of grouped) {
      items.sort((a, b) => (a.bbox[1] + a.bbox[3] / 2) - (b.bbox[1] + b.bbox[3] / 2));
      const centers = items.map((item) => item.bbox[1] + item.bbox[3] / 2);
      items.forEach((item, position) => {
        const low = position === 0 ? -Infinity : (centers[position - 1] + centers[position]) / 2;
        const high = position === items.length - 1 ? Infinity : (centers[position] + centers[position + 1]) / 2;
        let lines = section.lines.filter((line) => {
          const center = (line.top + line.bottom) / 2;
          return center >= low && center < high;
        });
        if (!lines.length) {
          lines = section.lines.filter((line) => {
            const center = (line.top + line.bottom) / 2;
            return center >= item.bbox[1] - BOX_VERTICAL_TOLERANCE && center <= item.bbox[1] + item.bbox[3] + BOX_VERTICAL_TOLERANCE;
          });
        }
        if (!lines.length) lines = section.lines;
        const top = Math.max(0, Math.min(...lines.map((line) => line.top)) - BOX_PADDING);
        const bottom = Math.min(1, Math.max(...lines.map((line) => line.bottom)) + BOX_PADDING);
        const left = Math.max(0, Math.min(...lines.map((line) => line.left)) - BOX_PADDING);
        const right = Math.min(1, Math.max(...lines.map((line) => line.right)) + BOX_PADDING);
        if (bottom - top < 0.005 || right - left < 0.02) return;
        result[item.index].bbox = [round4(left), round4(top), round4(right - left), round4(bottom - top)];
      });
    }
  }

  return result;
}

module.exports = { analyzeAnswerLayout, analyzePageLayout, alignBoxes, bandBBox, placeBoxes };
