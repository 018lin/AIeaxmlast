const sharp = require("sharp");
const { analyzeContentBounds, otsuCutoff, splitRegionRows } = require("./answer-layout");

const SAMPLE_WIDTH = 900;
const MIN_INK_RATIO = 0.002;

const round4 = (value) => Math.round(value * 10000) / 10000;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function validBox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [x, y, width, height] = value.map(Number);
  if (![x, y, width, height].every(Number.isFinite) ||
      x < 0 || y < 0 || width <= 0.005 || height <= 0.005 || x >= 1 || y >= 1) {
    return null;
  }
  return [round4(x), round4(y), round4(Math.min(width, 1 - x)), round4(Math.min(height, 1 - y))];
}

async function analyzeInk(image) {
  const { data, info } = await sharp(image).rotate().grayscale()
    .resize({ width: SAMPLE_WIDTH, withoutEnlargement: true })
    .raw().toBuffer({ resolveWithObject: true });
  if (info.width < 50 || info.height < 50) return null;
  return { data, width: info.width, height: info.height, cutoff: otsuCutoff(data) };
}

function inkRatio(ink, box) {
  if (!ink || !box) return 0;
  const x0 = clamp(Math.floor(box[0] * ink.width), 0, ink.width - 1);
  const x1 = clamp(Math.ceil((box[0] + box[2]) * ink.width), x0 + 1, ink.width);
  const y0 = clamp(Math.floor(box[1] * ink.height), 0, ink.height - 1);
  const y1 = clamp(Math.ceil((box[1] + box[3]) * ink.height), y0 + 1, ink.height);
  let dark = 0, total = 0;
  for (let y = y0; y < y1; y++) {
    const offset = y * ink.width;
    for (let x = x0; x < x1; x++) {
      total++;
      if (ink.data[offset + x] <= ink.cutoff) dark++;
    }
  }
  return total ? dark / total : 0;
}

// Builds question + sub-question boxes from a locate result. The same routine
// is used for the answer key cache, page templates and AI fallback relocations.
async function buildRegionsFromBoxes({ image, questions, boxes }) {
  const regions = [];
  for (const question of questions) {
    const source = boxes instanceof Map ? boxes.get(question.questionNo) : boxes?.[question.questionNo];
    const bbox = validBox(source);
    const subBoxes = bbox ? await splitRegionRows(image, bbox, Math.max(1, question.subs?.length || 1)) : [];
    regions.push({
      questionId: question.id || null,
      questionNo: question.questionNo,
      bbox,
      subs: (question.subs || []).map((sub, index) => ({
        subId: sub.id || null,
        label: sub.label || "",
        bbox: subBoxes[index] || null,
      })),
    });
  }
  return regions;
}

function frameFromBounds(bounds) {
  return bounds ? {
    left: bounds.left, top: bounds.top,
    boxWidth: bounds.boxWidth, boxHeight: bounds.boxHeight,
  } : null;
}

function mapBox(box, frame, bounds, scaleX, scaleY) {
  if (!validBox(box) || !frame || !bounds) return { box: null, inside: false };
  const x = bounds.left + (box[0] - frame.left) * scaleX;
  const y = bounds.top + (box[1] - frame.top) * scaleY;
  const width = box[2] * scaleX;
  const height = box[3] * scaleY;
  const inside = x >= -0.02 && y >= -0.02 && x + width <= 1.02 && y + height <= 1.02;
  return {
    inside,
    box: [
      round4(clamp(x, 0, 1)), round4(clamp(y, 0, 1)),
      round4(Math.min(width, 1 - clamp(x, 0, 1))), round4(Math.min(height, 1 - clamp(y, 0, 1))),
    ],
  };
}

// Pure local preflight: align a page template to the student's photo using the
// ink bounding box, then score ink coverage and bounds. No model call.
async function preflightPage({ image, template, ink }) {
  const regions = Array.isArray(template?.regions) ? template.regions : [];
  if (!regions.length) return { status: "check", confidence: 0, regions: [], issue: "尚无页模板" };
  const frame = template.frame;
  if (!frame?.boxWidth || !frame?.boxHeight) {
    return { status: "check", confidence: 0, regions: [], issue: "模板缺少页面范围" };
  }
  const bounds = await analyzeContentBounds(image);
  if (!bounds) return { status: "invalid", confidence: 0, regions: [], issue: "未检测到作答墨迹" };

  const scaleX = bounds.boxWidth / frame.boxWidth;
  const scaleY = bounds.boxHeight / frame.boxHeight;
  const scale = (scaleX + scaleY) / 2;
  const scaleOk = scale >= 0.55 && scale <= 1.8 && Math.abs(scaleX - scaleY) <= 0.35;
  const inkMap = ink || await analyzeInk(image);

  let valid = 0, outside = 0, blank = 0;
  const positioned = regions.map((region) => {
    const mapped = mapBox(region.bbox, frame, bounds, scaleX, scaleY);
    const subs = (region.subs || []).map((sub) => ({
      ...sub,
      bbox: mapBox(sub.bbox, frame, bounds, scaleX, scaleY).box,
    }));
    const ratio = mapped.inside ? inkRatio(inkMap, mapped.box) : 0;
    const ok = mapped.inside && mapped.box && ratio >= MIN_INK_RATIO &&
      mapped.box[2] >= 0.03 && mapped.box[3] >= 0.015;
    if (ok) valid++;
    else if (!mapped.inside) outside++;
    else blank++;
    return { ...region, bbox: mapped.box, subs, ink: round4(ratio) };
  });

  const total = regions.length || 1;
  let confidence = valid / total;
  if (!scaleOk) confidence *= 0.5;
  const status = confidence >= 0.85 && outside === 0 ? "ok" : confidence >= 0.5 ? "check" : "invalid";
  const issues = [];
  if (!scaleOk) issues.push("页面比例差异过大");
  if (outside) issues.push(`${outside} 个框超出照片`);
  if (blank) issues.push(`${blank} 个框缺少墨迹`);
  if (status !== "ok" && !issues.length) issues.push("对齐置信度偏低");
  return { status, confidence: round4(confidence), regions: positioned, issue: issues.join("，") };
}

module.exports = { buildRegionsFromBoxes, frameFromBounds, preflightPage };
