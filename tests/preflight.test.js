const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { preflightPage } = require("../lib/preflight");

async function sheet(rects, width = 600, height = 800) {
  const body = rects.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#111"/>`).join("");
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#fff"/>${body}</svg>`)).png().toBuffer();
}

const template = {
  frame: { left: 0.1, top: 0.1, boxWidth: 0.8, boxHeight: 0.8 },
  regions: [{
    questionId: "q1", questionNo: "1", bbox: [0.15, 0.2, 0.7, 0.2],
    subs: [{ subId: "s1", label: "(1)", bbox: [0.15, 0.2, 0.7, 0.1] }, { subId: "s2", label: "(2)", bbox: [0.15, 0.3, 0.7, 0.1] }],
  }],
};

// A page whose ink bounding box matches the template frame maps 1:1.
const aligned = () => sheet([
  [60, 80, 480, 640],
  [100, 180, 380, 40],
  [100, 260, 380, 40],
]);

test("aligned page maps template boxes and passes preflight", async () => {
  const result = await preflightPage({ image: await aligned(), template });
  assert.equal(result.status, "ok");
  assert.equal(result.confidence, 1);
  assert.equal(result.issue, "");
  const [question] = result.regions;
  assert.deepEqual(question.bbox, [0.15, 0.2, 0.7, 0.2]);
  assert.deepEqual(question.subs.map((sub) => sub.label), ["(1)", "(2)"]);
  assert.ok(question.ink > 0.05);
});

test("blank page is invalid because no ink is detected", async () => {
  const result = await preflightPage({ image: await sheet([]), template });
  assert.equal(result.status, "invalid");
  assert.equal(result.confidence, 0);
  assert.match(result.issue, /未检测到作答墨迹/);
  assert.deepEqual(result.regions, []);
});

test("ink concentrated in a small area fails scale validation and asks for a check", async () => {
  const result = await preflightPage({ image: await sheet([[240, 320, 80, 80]]), template });
  assert.equal(result.status, "check");
  assert.equal(result.confidence, 0.5);
  assert.match(result.issue, /页面比例差异过大/);
});

test("missing template regions only requests a visual check", async () => {
  const result = await preflightPage({ image: await aligned(), template: { frame: template.frame, regions: [] } });
  assert.equal(result.status, "check");
  assert.match(result.issue, /尚无页模板/);
});

test("box without any ink marks the page invalid", async () => {
  const blankInk = { data: Buffer.alloc(600 * 800, 255), width: 600, height: 800, cutoff: 128 };
  const result = await preflightPage({ image: await aligned(), template, ink: blankInk });
  assert.equal(result.status, "invalid");
  assert.equal(result.confidence, 0);
  assert.match(result.issue, /缺少墨迹/);
});
