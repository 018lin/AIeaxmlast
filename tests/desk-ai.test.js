const test = require("node:test");
const assert = require("node:assert/strict");
const { gradeWholePaper, recognizeAnswerQuestions, sanitizePaperBoxes, validateWholePaperResult, validateDeskQuestions, diffPasses } = require("../lib/ai-grader");

const expected = (count) => Array.from({ length: count }, (_, i) => ({ questionNo: String(i + 1), title: "Test", maxScore: 5 }));
const resultFor = (questions) => ({ questions: questions.map((q) => ({ question_no: q.questionNo, max_score: q.maxScore, score: 3, confidence: 0.9, analysis: "Feedback" })) });

function mockProvider(t, respond) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const reply = respond(body, calls.length);
    if (reply && reply.reasoningOnly) {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "", reasoning_content: "thinking only" } }] }) };
    }
    if (reply && reply.fail) {
      return { ok: false, status: reply.fail.status || 500, json: async () => ({ error: { message: reply.fail.message || "provider error" } }) };
    }
    const content = reply && Object.prototype.hasOwnProperty.call(reply, "raw") ? reply.raw : JSON.stringify(reply);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  });
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "mock-only-not-a-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  });
  return calls;
}

function withoutApiKey(t) {
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  t.after(() => {
    if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous;
  });
}

test("answer recognition uses one teacher-only request and validates explicit scores", async (t) => {
  const calls = mockProvider(t, () => ({ questions: [{ question_no: "1", title: "Addition", max_score: 5 }] }));
  assert.deepEqual(await recognizeAnswerQuestions("teacher-test-image"), {
    questions: [{ questionNo: "1", title: "Addition", maxScore: 5 }], totalScore: 5,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].max_tokens, 16384);
  assert.deepEqual(calls[0].response_format, { type: "json_object" });
  assert.deepEqual(calls[0].messages[0].content.filter((c) => c.type === "image_url").map((c) => c.image_url.url), ["teacher-test-image"]);
});

test("answer recognition splits examples into sub-questions and drops duplicate parents", async (t) => {
  mockProvider(t, () => ({ questions: [
    { question_no: "1", title: "第1题答案", max_score: null },
    { question_no: "例1", title: "判断题", max_score: null },
    { question_no: "例1(1)", title: "同类项", max_score: null },
    { question_no: "例1（1）", title: "重复", max_score: 5 },
    { question_no: "2", title: "选择题", max_score: "5" },
    { question_no: "", title: "空题号", max_score: 5 },
  ] }));
  const recognized = await recognizeAnswerQuestions("answer");
  assert.deepEqual(recognized.questions.map((q) => q.questionNo), ["例1(1)", "2"]);
  assert.deepEqual(recognized.questions.map((q) => q.maxScore), [10, 5]);
  assert.equal(recognized.totalScore, 15);
});

test("unmarked teacher answers use an editable ten-point draft without requiring handwritten scores", async (t) => {
  mockProvider(t, () => ({ questions: [{ question_no: "1", title: "Addition", max_score: null }] }));
  const recognized = await recognizeAnswerQuestions("teacher-test-image");
  assert.equal(recognized.questions[0].maxScore, 10);
  assert.equal(recognized.totalScore, 10);
});

for (const count of [1, 15, 16, 20]) {
  test(`${count} questions use ${count <= 15 ? 1 : Math.ceil(count / 5)} exact-sized calls with both images`, async (t) => {
    const all = expected(count);
    const size = count <= 15 ? count : 5;
    const calls = mockProvider(t, (body, index) => {
      const text = body.messages[0].content[0].text;
      const group = JSON.parse(text.split("\n")[2]);
      assert.deepEqual(group, all.slice((index - 1) * size, index * size));
      assert.equal(body.max_tokens, 16384);
      assert.deepEqual(body.response_format, { type: "json_object" });
      assert.deepEqual(body.messages[0].content.slice(1).map((c) => c.image_url.url), ["teacher", "student"]);
      return resultFor(group);
    });
    const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: all });
    assert.equal(calls.length, Math.ceil(count / size));
    assert.deepEqual(graded.result.questions.map((q) => q.question_no), all.map((q) => q.questionNo));
  });
}

test("grading snaps AI boxes to the student's real ink rows", async (t) => {
  const sharp = require("sharp");
  const rows = [120, 260, 400].map((top) => `<rect x="30" y="${top}" width="420" height="30" fill="#111"/>`);
  const image = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
    <rect width="100%" height="100%" fill="#fff"/><rect x="30" y="40" width="200" height="30" fill="#111"/>
    ${rows.join("")}</svg>`)).png().toBuffer();
  mockProvider(t, () => {
    const raw = resultFor(expected(3));
    raw.questions.forEach((question, index) => { question.bbox = [0.05, 0.12 * (index + 1), 0.8, 0.08]; });
    return raw;
  });
  const graded = await gradeWholePaper({
    teacherAnswerImage: "teacher", studentImage: `data:image/png;base64,${image.toString("base64")}`,
    expectedQuestions: expected(3),
  });
  const tops = graded.result.questions.map((question) => question.bbox[1]);
  assert.ok(tops[0] > 0.18 && tops[0] < 0.22, `first box top ${tops[0]}`);
  assert.ok(tops[1] > 0.41 && tops[1] < 0.46, `second box top ${tops[1]}`);
  assert.ok(tops[2] > 0.64 && tops[2] < 0.7, `third box top ${tops[2]}`);
});

test("a chunk with no usable questions becomes review rows instead of failing the paper", async (t) => {
  const all = expected(16);
  const calls = mockProvider(t, (body, index) => {
    if (index === 2) return { questions: [] };
    return resultFor(JSON.parse(body.messages[0].content[0].text.split("\n")[2]));
  });
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: all });
  assert.equal(calls.length, 4);
  assert.equal(graded.result.questions.length, 16);
  const review = graded.result.questions.filter((q) => q.needs_review);
  assert.deepEqual(review.map((q) => q.question_no), ["6", "7", "8", "9", "10"]);
  for (const question of review) assert.equal(question.score, null);
  assert.match(graded.result.overall_analysis, /6、7、8、9、10/);
});

test("unknown and duplicate question numbers are dropped, never re-mapped by position", async (t) => {
  mockProvider(t, () => ({ questions: [
    { question_no: "999", score: 4, max_score: 5, confidence: 0.9 },
    { question_no: "1", score: 2, max_score: 5, confidence: 0.9 },
    { question_no: "1", score: 5, max_score: 5, confidence: 0.9 },
  ] }));
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: expected(3) });
  assert.deepEqual(graded.result.questions.map((q) => [q.question_no, q.score, q.needs_review]),
    [["1", 2, false], ["2", null, true], ["3", null, true]]);
  assert.match(graded.result.overall_analysis, /无法匹配的题号 999/);
  assert.match(graded.result.overall_analysis, /重复返回题号 1/);
});

test("scores are clamped to the configured maximum and flagged for review", async (t) => {
  mockProvider(t, () => ({ questions: [
    { question_no: "1", max_score: 100, score: "99", confidence: "0.9" },
    { question_no: "2", max_score: 5, score: -3, confidence: 0.9 },
  ] }));
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: expected(2) });
  assert.deepEqual(graded.result.questions.map((q) => [q.score, q.max_score, q.needs_review]),
    [[5, 5, true], [0, 5, true]]);
});

test("a null score stays ungraded instead of becoming zero", async (t) => {
  mockProvider(t, () => ({ questions: [{ question_no: "1", max_score: 5, score: null, confidence: 0.9, needs_review: false }] }));
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: expected(1) });
  assert.equal(graded.result.questions[0].score, null);
  assert.equal(graded.result.questions[0].needs_review, true);
});

test("a truncated reply keeps the questions that were already complete", async (t) => {
  mockProvider(t, () => ({ raw: '{"questions":[{"question_no":"1","max_score":5,"score":3,"confidence":0.9,"analysis":"ok"},{"question_no":"2","score":' }));
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: expected(2) });
  assert.equal(graded.result.questions[0].score, 3);
  assert.equal(graded.result.questions[1].score, null);
  assert.equal(graded.result.questions[1].needs_review, true);
});

test("one failed chunk keeps the other chunks and marks only its questions for review", async (t) => {
  const all = expected(16);
  const calls = mockProvider(t, (body, index) => {
    if (index === 2) throw new Error("network down");
    return resultFor(JSON.parse(body.messages[0].content[0].text.split("\n")[2]));
  });
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: all });
  assert.equal(calls.length, 4);
  assert.equal(graded.result.questions.length, 16);
  const review = graded.result.questions.filter((q) => q.needs_review);
  assert.deepEqual(review.map((q) => q.question_no), ["6", "7", "8", "9", "10"]);
  assert.match(graded.result.overall_analysis, /批改请求失败/);
});

test("a failed chunk with a 5xx status degrades instead of failing the whole page", async (t) => {
  const all = expected(16);
  mockProvider(t, (body, index) => index === 2
    ? { fail: { status: 500, message: "upstream overloaded" } }
    : resultFor(JSON.parse(body.messages[0].content[0].text.split("\n")[2])));
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: all });
  assert.equal(graded.result.questions.length, 16);
  assert.equal(graded.result.questions.filter((q) => q.needs_review).length, 5);
});

test("a reasoning-only chunk is reported clearly and does not sink the page", async (t) => {
  const all = expected(16);
  mockProvider(t, (body, index) => {
    if (index === 2) return { reasoningOnly: true };
    return resultFor(JSON.parse(body.messages[0].content[0].text.split("\n")[2]));
  });
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: all });
  assert.equal(graded.result.questions.length, 16);
  assert.deepEqual(graded.result.questions.filter((q) => q.needs_review).map((q) => q.question_no),
    ["6", "7", "8", "9", "10"]);
  assert.match(graded.result.overall_analysis, /推理可能占满输出预算/);
});

test("a total provider outage still fails the job so it can be retried", async (t) => {
  mockProvider(t, () => { throw new Error("offline"); });
  await assert.rejects(gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: expected(16) }), { statusCode: 502 });
});

test("an auth failure is fatal and does not fabricate review-only results", async (t) => {
  mockProvider(t, () => ({ fail: { status: 401, message: "invalid key" } }));
  await assert.rejects(gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: expected(2) }), { statusCode: 401 });
});

test("a missing API key aborts grading instead of writing review rows", async (t) => {
  withoutApiKey(t);
  await assert.rejects(gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: expected(2) }), { statusCode: 503 });
});

test("missing or null confidence always requires teacher review", () => {
  for (const confidence of [undefined, null, 0.2, 0.79]) {
    const raw = resultFor(expected(1));
    raw.questions[0].confidence = confidence;
    raw.questions[0].needs_review = false;
    assert.equal(validateWholePaperResult(raw, expected(1)).questions[0].needs_review, true);
  }
  const raw = resultFor(expected(1));
  raw.questions[0].needs_review = true;
  assert.equal(validateWholePaperResult(raw, expected(1)).questions[0].needs_review, true);
});

test("final validation still rejects missing, duplicate, unknown and non-numeric questions", () => {
  const badResults = {
    missing: (r) => r.questions.pop(),
    duplicate: (r) => { r.questions[1].question_no = "1"; },
    unknown: (r) => { r.questions[1].question_no = "999"; },
    extra: (r) => { r.questions.push({ ...r.questions[0] }); },
    nonNumericScore: (r) => { r.questions[0].score = "abc"; },
    infiniteScore: (r) => { r.questions[0].score = Infinity; },
  };
  for (const mutate of Object.values(badResults)) {
    const raw = resultFor(expected(2));
    mutate(raw);
    assert.throws(() => validateWholePaperResult(raw, expected(2)), { statusCode: 502 });
  }
});

test("final validation keeps ungraded scores null and flags them for review", () => {
  for (const score of [null, undefined]) {
    const raw = resultFor(expected(2));
    raw.questions[0].score = score;
    raw.questions[0].needs_review = false;
    const checked = validateWholePaperResult(raw, expected(2));
    assert.equal(checked.questions[0].score, null);
    assert.equal(checked.questions[0].needs_review, true);
  }
});

test("final validation clamps score quirks and ignores the model's max_score", () => {
  const raw = resultFor(expected(2));
  raw.questions[0].score = "3";
  raw.questions[0].max_score = 100;
  raw.questions[1].score = 9;
  const checked = validateWholePaperResult(raw, expected(2));
  assert.equal(checked.questions[0].score, 3);
  assert.equal(checked.questions[0].max_score, 5);
  assert.equal(checked.questions[0].needs_review, false);
  assert.equal(checked.questions[1].score, 5);
  assert.equal(checked.questions[1].needs_review, true);
});

test("valid zero score is preserved, feedback is shortened, order follows expected questions", () => {
  const raw = resultFor(expected(2));
  raw.questions[0].score = 0;
  raw.questions[0].analysis = "a".repeat(500);
  raw.questions[0].suggestions = Array(10).fill("b".repeat(100));
  raw.questions.reverse();
  const checked = validateWholePaperResult(raw, expected(2));
  assert.equal(checked.questions[0].score, 0);
  assert.equal(checked.questions[0].analysis.length, 240);
  assert.equal(checked.questions[0].suggestions.length, 3);
});

test("unreliable overlays are hidden entirely instead of drawn in the wrong place", () => {
  const base = () => {
    const raw = resultFor(expected(3));
    raw.questions.forEach((question, index) => { question.bbox = [0.05, 0.1 + index * 0.1, 0.4, 0.05]; });
    return raw;
  };
  const reliable = validateWholePaperResult(base(), expected(3));
  assert.deepEqual(sanitizePaperBoxes(reliable.questions).map((q) => q.bbox),
    [[0.05, 0.1, 0.4, 0.05], [0.05, 0.2, 0.4, 0.05], [0.05, 0.3, 0.4, 0.05]]);

  const overlap = base();
  overlap.questions[1].bbox = [0.05, 0.11, 0.4, 0.05];
  assert.deepEqual(sanitizePaperBoxes(validateWholePaperResult(overlap, expected(3)).questions).map((q) => q.bbox),
    [null, null, null]);

  const outOfOrder = base();
  outOfOrder.questions[2].bbox = [0.05, 0.15, 0.4, 0.05];
  assert.deepEqual(sanitizePaperBoxes(validateWholePaperResult(outOfOrder, expected(3)).questions).map((q) => q.bbox),
    [null, null, null]);

  const partial = base();
  partial.questions[0].bbox = null;
  assert.deepEqual(sanitizePaperBoxes(validateWholePaperResult(partial, expected(3)).questions).map((q) => q.bbox),
    [null, null, null]);
});

test("single-column pages use a dedicated student-only localization pass", async (t) => {
  const all = expected(2);
  const image = `data:image/png;base64,${Buffer.from("synthetic").toString("base64")}`;
  const calls = mockProvider(t, (body) => {
    const text = body.messages[0].content[0].text;
    if (text.includes("请定位下列题目的印刷题号")) {
      return { boxes: [
        { question_no: "1", bbox: [0.1, 0.6, 0.8, 0.1] },
        { question_no: "2", bbox: [0.1, 0.75, 0.8, 0.1] },
      ] };
    }
    const graded = resultFor(all);
    graded.questions.forEach((question, index) => { question.bbox = [0.1, 0.1 + index * 0.2, 0.8, 0.08]; });
    return graded;
  });
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: image, expectedQuestions: all });
  assert.equal(calls.length, 2);
  assert.deepEqual(graded.result.questions.map((q) => q.bbox), [
    [0.1, 0.6, 0.8, 0.1], [0.1, 0.75, 0.8, 0.1],
  ]);
});

test("uniformly shifted boxes are anchored to the last ink row", async (t) => {
  const sharp = require("sharp");
  const image = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
    <rect width="100%" height="100%" fill="#fff"/>
    <rect x="100" y="280" width="300" height="20" fill="#111"/>
  </svg>`)).png().toBuffer();
  const all = expected(2);
  mockProvider(t, (body) => {
    const text = body.messages[0].content[0].text;
    if (text.includes("请定位下列题目的印刷题号")) {
      return { boxes: [
        { question_no: "1", bbox: [0.1, 0.1, 0.8, 0.1] },
        { question_no: "2", bbox: [0.1, 0.25, 0.8, 0.1] },
      ] };
    }
    const graded = resultFor(all);
    graded.questions.forEach((question, index) => { question.bbox = [0.1, 0.1 + index * 0.15, 0.8, 0.1]; });
    return graded;
  });
  const graded = await gradeWholePaper({
    teacherAnswerImage: "teacher", studentImage: `data:image/png;base64,${image.toString("base64")}`,
    expectedQuestions: all,
  });
  const tops = graded.result.questions.map((q) => q.bbox[1]);
  assert.ok(Math.abs(tops[0] - 0.25) < 0.02, `first top ${tops[0]}`);
  assert.ok(Math.abs(tops[1] - 0.4) < 0.02, `second top ${tops[1]}`);
});

test("question positions are normalized, clamped and invalid values dropped", () => {
  const raw = resultFor(expected(3));
  raw.questions[0].bbox = [0.1, 0.2, 0.3, 0.4];
  raw.questions[1].bbox = { x: 0.8, y: 0.5, width: 0.5, height: 0.4 };
  raw.questions[2].bbox = [0.1, 0.1, 0, 0.2];
  const checked = validateWholePaperResult(raw, expected(3));
  assert.deepEqual(checked.questions[0].bbox, [0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual(checked.questions[1].bbox, [0.8, 0.5, 0.2, 0.4]);
  assert.equal(checked.questions[2].bbox, null);
});

test("question edits reject empty, duplicate and nonnumeric scores", () => {
  for (const value of [[], null, [{ questionNo: "", maxScore: 5 }], [expected(1)[0], expected(1)[0]],
    [{ questionNo: "1", maxScore: "5" }], [{ questionNo: "1", maxScore: NaN }], [{ questionNo: "1", maxScore: 0 }]]) {
    assert.throws(() => validateDeskQuestions(value), { statusCode: 400 });
  }
});

test("unreadable teacher answer aborts creation rather than inventing a rubric", async (t) => {
  mockProvider(t, () => ({ questions: [] }));
  await assert.rejects(recognizeAnswerQuestions("teacher"), { statusCode: 502 });
});

test("cancellation prevents subsequent provider requests", async (t) => {
  const calls = mockProvider(t, () => resultFor(expected(1)));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: expected(1), signal: controller.signal }), { statusCode: 504 });
  assert.equal(calls.length, 0);
});

// ---------- 精批模式：双评 + 争议仲裁 ----------

const entryMap = (entries) => new Map(entries.map(([no, score, extra]) => [no, {
  question_no: no, score, confidence: 0.9, needs_review: false, analysis: "", deductions: [], suggestions: [], knowledge_points: [], bbox: null, ...extra,
}]));
const passReply = (pairs, maxScore = 5) => ({ questions: pairs.map(([no, score]) => ({
  question_no: no, max_score: maxScore, score, confidence: 0.9, needs_review: false, analysis: "反馈",
})) });

test("diffPasses only escalates gaps that matter at the question's own weight", () => {
  const list = [{ questionNo: "1", maxScore: 5 }, { questionNo: "2", maxScore: 10 }, { questionNo: "3", maxScore: 5 }, { questionNo: "4", maxScore: 5 }];
  const passA = entryMap([["1", 4], ["2", 8], ["3", 5], ["4", 3]]);
  const passB = entryMap([["1", 3], ["2", 7], ["3", 5], ["4", 3]]);
  const { agree, disputes } = diffPasses(list, passA, passB);
  // 5 分题差 1 分是 20%；10 分题差 1 分只是 10%，不触发第三次介入。
  assert.deepEqual(disputes.map((item) => [item.questionNo, item.reason]), [["1", "score"]]);
  assert.deepEqual(agree.map((item) => item.questionNo), ["2", "3", "4"]);
  assert.equal(agree[0].weakConflict, true);
  assert.equal(agree[1].weakConflict, false);
});

test("diffPasses escalates unscored and missing passes but not low confidence", () => {
  const list = [{ questionNo: "1", maxScore: 5 }, { questionNo: "2", maxScore: 5 }, { questionNo: "3", maxScore: 5 },
    { questionNo: "4", maxScore: 5 }, { questionNo: "5", maxScore: 5 }];
  const passA = entryMap([["1", null], ["2", 4], ["3", 4], ["4", 4, { deductions: ["漏单位"] }], ["5", 3]]);
  const passB = new Map([
    ["1", { score: 4, confidence: 0.9, needs_review: false, deductions: [] }],
    ["2", { score: 4, confidence: 0.9, needs_review: false, deductions: [] }],
    ["3", { score: 4, confidence: 0.4, needs_review: false, deductions: [] }],
    ["4", { score: 4, confidence: 0.9, needs_review: false, deductions: ["计算错误"] }],
  ]);
  const { agree, disputes } = diffPasses(list, passA, passB);
  assert.deepEqual(disputes.map((item) => [item.questionNo, item.reason]),
    [["1", "unscored"], ["5", "missing"]]);
  // 两次同分即使置信度低也算一致：两票已成多数，第三次介入翻不了盘。
  assert.deepEqual(agree.map((item) => [item.questionNo, item.weakConflict]), [["2", false], ["3", false], ["4", true]]);
});

test("fine mode arbitrates only the questions the two passes disagree on", async (t) => {
  const calls = mockProvider(t, (body) => {
    const text = body.messages[0].content[0].text;
    if (text.includes("教研组长")) {
      return { reviews: [{ question_no: "2", student_answer: "12", key_points: ["列出步骤"], my_score: 4, chosen_score: 4, reason: "步骤完整", confidence: 0.9, needs_review: false }] };
    }
    const group = JSON.parse(text.split("\n")[2]);
    const scores = body.temperature === 0 ? [5, 4, 4] : [5, 3, 4];
    return passReply(group.map((q) => [q.questionNo, scores[Number(q.questionNo) - 1]]));
  });
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: expected(3), gradingMode: "fine" });
  assert.deepEqual(graded.result.questions.map((q) => [q.score, q.agreement, q.needs_review]),
    [[5, "agree", false], [4, "arbitrated", false], [4, "agree", false]]);
  assert.equal(graded.result.questions[0].passes.length, 2);
  assert.equal(graded.result.questions[1].passes.length, 3);
  assert.match(graded.result.overall_analysis, /1 题两次评判不一致/);
  assert.match(graded.result.overall_analysis, /1 题已复核确认/);
  assert.equal(calls.filter((body) => body.temperature === 0.5).length, 1);
  assert.equal(calls.filter((body) => /教研组长/.test(body.messages[0].content[0].text)).length, 1);
});

test("fine mode keeps agreeing questions when the second pass fails outright", async (t) => {
  mockProvider(t, (body) => (body.temperature === 0.5
    ? { fail: { status: 500, message: "provider down" } }
    : passReply([["1", 4], ["2", 5]])));
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: expected(2), gradingMode: "fine" });
  assert.deepEqual(graded.result.questions.map((q) => [q.score, q.agreement]), [[4, "single"], [5, "single"]]);
  assert.match(graded.result.overall_analysis, /第二次评判失败/);
});

test("a failed arbitration leaves disputes for the teacher instead of silently keeping one score", async (t) => {
  mockProvider(t, (body) => {
    if (/教研组长/.test(body.messages[0].content[0].text)) return { fail: { status: 500, message: "arbiter down" } };
    return body.temperature === 0 ? passReply([["1", 5], ["2", 3]]) : passReply([["1", 5], ["2", 5]]);
  });
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: expected(2), gradingMode: "fine" });
  const [first, second] = graded.result.questions;
  assert.equal(first.agreement, "agree");
  assert.equal(second.agreement, "disputed");
  assert.equal(second.needs_review, true);
  assert.equal(second.score, null);
  assert.match(second.analysis, /两次 AI 评判不一致/);
});

test("fast mode never issues a second pass or an arbitration", async (t) => {
  const calls = mockProvider(t, () => passReply([["1", 4], ["2", 5]]));
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: expected(2), gradingMode: "fast" });
  assert.equal(calls.length, 1);
  assert.deepEqual(graded.result.questions.map((q) => q.agreement), ["single", "single"]);
});

// ---------- 多数票：三次里有两票同分就不打扰教师 ----------

test("two agreeing passes settle a question even when both report low confidence", async (t) => {
  mockProvider(t, () => ({ questions: [{ question_no: "1", max_score: 10, score: 10, confidence: 0.4, needs_review: false, analysis: "答案正确" }] }));
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", gradingMode: "fine",
    expectedQuestions: [{ questionNo: "1", title: "Test", maxScore: 10 }] });
  const [question] = graded.result.questions;
  assert.equal(question.score, 10);
  assert.equal(question.agreement, "agree");
  assert.equal(question.needs_review, false);
});

test("arbiter agreeing with one pass settles the question on majority, not confidence", async (t) => {
  mockProvider(t, (body) => {
    if (/教研组长/.test(body.messages[0].content[0].text)) {
      return { reviews: [{ question_no: "1", my_score: 6, chosen_score: 6, confidence: 0.55, needs_review: false, reason: "一次项合并错误，给部分分" }] };
    }
    return body.temperature === 0
      ? passReply([["1", 6]], 10)
      : passReply([["1", null]], 10);
  });
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", gradingMode: "fine",
    expectedQuestions: [{ questionNo: "1", title: "Test", maxScore: 10 }] });
  const [question] = graded.result.questions;
  assert.equal(question.score, 6);
  assert.equal(question.agreement, "arbitrated");
  assert.equal(question.needs_review, false);
  assert.equal(question.passes.length, 3);
});

test("three conflicting opinions with no majority stay in the teacher queue", async (t) => {
  mockProvider(t, (body) => {
    if (/教研组长/.test(body.messages[0].content[0].text)) {
      return { reviews: [{ question_no: "1", my_score: 4, chosen_score: 4, confidence: 0.45, needs_review: false, reason: "拿不准" }] };
    }
    return body.temperature === 0 ? passReply([["1", 5]], 10) : passReply([["1", 2]], 10);
  });
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", gradingMode: "fine",
    expectedQuestions: [{ questionNo: "1", title: "Test", maxScore: 10 }] });
  const [question] = graded.result.questions;
  assert.equal(question.score, null);
  assert.equal(question.agreement, "disputed");
  assert.equal(question.needs_review, true);
});

test("a single confident arbiter can still break a genuine three-way tie", async (t) => {
  mockProvider(t, (body) => {
    if (/教研组长/.test(body.messages[0].content[0].text)) {
      return { reviews: [{ question_no: "1", my_score: 4, chosen_score: 4, confidence: 0.92, needs_review: false, reason: "前两次都漏了单位" }] };
    }
    return body.temperature === 0 ? passReply([["1", 5]], 10) : passReply([["1", 2]], 10);
  });
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", gradingMode: "fine",
    expectedQuestions: [{ questionNo: "1", title: "Test", maxScore: 10 }] });
  const [question] = graded.result.questions;
  assert.equal(question.score, 4);
  assert.equal(question.agreement, "arbitrated");
  assert.equal(question.needs_review, false);
});
