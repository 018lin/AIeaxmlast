const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { analyzeAnswerLayout, alignBoxes, bandBBox } = require("../lib/answer-layout");

function svgPage(width, height, shapes) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#ffffff"/>${shapes.join("")}</svg>`);
}

async function page(shapes, width = 600, height = 800) {
  return sharp(svgPage(width, height, shapes)).png().toBuffer();
}

const bar = (x, y, width, height = 26) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#111"/>`;

async function singleColumnPage() {
  const shapes = [bar(30, 20, 560, 5), bar(30, 40, 210, 30)];
  for (let index = 0; index < 6; index++) shapes.push(bar(30, 120 + index * 105, 300 + index * 20));
  shapes.push(bar(30, 775, 560, 5));
  return page(shapes);
}

test("single-column sheet aligns questions to its ink rows and skips the title", async () => {
  const layout = await analyzeAnswerLayout(await singleColumnPage());
  const entries = Array.from({ length: 6 }, (_, index) => ({ questionNo: String(index + 1), bbox: [0.05, 0.1 * (index + 1), 0.9, 0.09] }));
  const aligned = alignBoxes(entries, layout);
  assert.ok(aligned);
  assert.deepEqual(aligned.map((item) => item.questionNo), ["1", "2", "3", "4", "5", "6"]);
  for (let index = 0; index < 6; index++) {
    assert.ok(aligned[index].bbox[1] > 0.12 + index * 0.11, `box ${index + 1} should sit on row ${index + 1}`);
    assert.ok(aligned[index].bbox[1] < 0.17 + index * 0.13, `box ${index + 1} should not drift down`);
  }
});

test("a split row is merged before questions are assigned", async () => {
  const shapes = [bar(30, 40, 210, 30)];
  for (let index = 0; index < 6; index++) {
    const top = 120 + index * 105;
    shapes.push(bar(30, top, 260, 14));
    shapes.push(bar(30, top + 20, 320, 14));
  }
  const layout = await analyzeAnswerLayout(await page(shapes));
  assert.equal(layout.bands.length, 7);
  assert.ok(alignBoxes(Array.from({ length: 6 }, () => ({})), layout));
});

test("a narrow footer line is dropped instead of the first question", async () => {
  const shapes = [];
  for (let index = 0; index < 6; index++) shapes.push(bar(30, 120 + index * 105, 420));
  shapes.push(bar(30, 760, 150, 24));
  const layout = await analyzeAnswerLayout(await page(shapes));
  const aligned = alignBoxes(Array.from({ length: 6 }, (_, index) => ({ questionNo: String(index + 1) })), layout);
  assert.ok(aligned);
  assert.ok(aligned[5].bbox[1] > 0.78 && aligned[5].bbox[1] < 0.83, "last box stays on the last question row, not the footer");
});

test("two-column sheets are left to the AI boxes", async () => {
  const shapes = [bar(30, 40, 210, 30)];
  for (let row = 0; row < 3; row++) {
    shapes.push(bar(30, 120 + row * 105, 240));
    shapes.push(bar(330, 120 + row * 105, 240));
  }
  const layout = await analyzeAnswerLayout(await page(shapes));
  assert.equal(alignBoxes(Array.from({ length: 6 }, () => ({})), layout), null);
});

test("ambiguous extra bands leave existing boxes untouched", async () => {
  const layout = { bands: [
    { top: 0.05, bottom: 0.1, left: 0.05, right: 0.95 },
    { top: 0.2, bottom: 0.26, left: 0.05, right: 0.95 },
    { top: 0.4, bottom: 0.46, left: 0.05, right: 0.95 },
  ] };
  assert.equal(alignBoxes([{}, {}], layout), null);
});

test("band boxes stay inside the page and keep the band inside the padding", () => {
  const bbox = bandBBox({ top: 0.001, bottom: 0.05, left: 0.001, right: 0.999 });
  assert.equal(bbox[0], 0);
  assert.equal(bbox[1], 0);
  assert.ok(bbox[0] + bbox[2] <= 1);
  assert.ok(bbox[1] + bbox[3] <= 1);
  assert.ok(bbox[2] > 0.99 && bbox[3] > 0.05);
});

test("blank images produce no layout instead of inventing rows", async () => {
  assert.equal(await analyzeAnswerLayout(await page([])), null);
});
