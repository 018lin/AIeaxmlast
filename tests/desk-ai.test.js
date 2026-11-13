const test = require("node:test");
const assert = require("node:assert/strict");
const { gradeWholePaper, parseAiResult, recognizeAnswerQuestions, validateWholePaperResult, validateDeskQuestions } = require("../lib/ai-grader");

const expected = (count) => Array.from({ length: count }, (_, i) => ({ questionNo: String(i + 1), title: "Test", maxScore: 5 }));
const resultFor = (questions) => ({ questions: questions.map((q) => ({ question_no: q.questionNo, max_score: q.maxScore, score: 3, confidence: 0.9, analysis: "Feedback" })) });

// Locate requests and grading requests share the same provider; only grading
// prompts embed the question list, so this separates the two.
function gradeGroup(body) {
  const line = body.messages[0].content[0].text.split("\n").find((text) => text.startsWith('[{"questionNo"'));
  return line ? JSON.parse(line) : null;
}

function mockProvider(t, respond) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const value = respond(body, calls.length);
    return { ok: true, json: async () => ({ choices: [{ message: { content: typeof value === "string" ? value : JSON.stringify(value) } }] }) };
  });
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "mock-only-not-a-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  });
  return calls;
}

test("answer recognition uses one teacher-only request and validates explicit scores", async (t) => {
  const calls = mockProvider(t, () => ({ questions: [{ question_no: "1", title: "Addition", max_score: 5 }] }));
  assert.deepEqual(await recognizeAnswerQuestions("teacher-test-image"), {
    questions: [{ questionNo: "1", title: "Addition", maxScore: 5 }], totalScore: 5,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].messages[0].content.filter((c) => c.type === "image_url").map((c) => c.image_url.url), ["teacher-test-image"]);
});

test("unmarked teacher answers use an editable ten-point draft without requiring handwritten scores", async (t) => {
  mockProvider(t, () => ({ questions: [{ question_no: "1", title: "Addition", max_score: null }] }));
  const recognized = await recognizeAnswerQuestions("teacher-test-image");
  assert.equal(recognized.questions[0].maxScore, 10);
  assert.equal(recognized.totalScore, 10);
});

for (const count of [1, 5, 15, 16, 20]) {
  test(`${count} questions use ${Math.ceil(count / Math.min(count, 5))} exact-sized calls with both images`, async (t) => {
    const all = expected(count);
    const size = Math.min(count, 5);
    const calls = mockProvider(t, (body) => {
      const group = gradeGroup(body);
      if (!group) return { boxes: [] };
      const index = calls.length;
      assert.deepEqual(group, all.slice((index - 1) * size, index * size));
      assert.deepEqual(body.messages[0].content.slice(1).map((c) => c.image_url.url), ["teacher", "student"]);
      return resultFor(group);
    });
    const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: all });
    assert.equal(calls.filter((body) => gradeGroup(body)).length, Math.ceil(count / size));
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

test("a malformed batch is retried question by question instead of failing the paper", async (t) => {
  const all = expected(16);
  const calls = mockProvider(t, (body) => {
    const group = gradeGroup(body);
    if (!group) return { boxes: [] };
    if (group.length > 1 && group[0].questionNo === "6") return "抱歉，输出被截断，无法返回完整 JSON。";
    return resultFor(group);
  });
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: all });
  assert.equal(calls.filter((body) => gradeGroup(body)).length, 9); // four batches, the failed one replaced by five single calls
  assert.deepEqual(graded.result.questions.map((q) => q.question_no), all.map((q) => q.questionNo));
});

test("a broken locate reply never discards grading results", async (t) => {
  mockProvider(t, (body) => (gradeGroup(body) ? resultFor(expected(2)) : "不是 JSON"));
  const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: expected(2) });
  assert.equal(graded.result.questions.length, 2);
});

test("part scores override a lenient question total when every sub-item is accounted for", () => {
  const raw = resultFor(expected(2));
  raw.questions[0].score = 5;
  raw.questions[0].parts = [
    { label: "(1)", student_answer: "3x", max_score: 2.5, score: 2.5, correct: true },
    { label: "(2)", student_answer: "-2y", max_score: 2.5, score: 0, correct: false },
  ];
  const checked = validateWholePaperResult(raw, expected(2));
  assert.equal(checked.questions[0].score, 2.5);
  assert.deepEqual(checked.questions[0].parts.map((part) => part.correct), [true, false]);
});

test("incomplete part breakdowns do not override the question total", () => {
  const raw = resultFor(expected(2));
  raw.questions[0].score = 4;
  raw.questions[0].parts = [{ label: "(1)", student_answer: "3x", max_score: 2, score: 2, correct: true }];
  const checked = validateWholePaperResult(raw, expected(2));
  assert.equal(checked.questions[0].score, 4);
});

test("a question that stays malformed fails the paper and names the question", async (t) => {
  const all = expected(3);
  const calls = mockProvider(t, () => "不是 JSON");
  await assert.rejects(gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: all }), (error) => {
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /题号 1/);
    return true;
  });
  assert.equal(calls.length, 2); // whole batch, then the first single-question retry
});

test("parser tolerates prose and braces around the JSON answer", () => {
  const raw = `${JSON.stringify(resultFor(expected(2)))}\n注意：{这里只是说明}`;
  assert.deepEqual(parseAiResult(raw).questions.map((q) => q.question_no), ["1", "2"]);
});

test("parser prefers the real answer over an echoed prompt example", () => {
  const echoed = [
    '好的，格式示例：{"questions":[{"question_no":"1","max_score":5,"score":4}],"overall_analysis":"示例"}',
    "实际批改结果：",
    JSON.stringify(resultFor(expected(3))),
  ].join("\n");
  assert.equal(parseAiResult(echoed).questions.length, 3);
});

test("truncated JSON is rejected instead of being partially accepted", () => {
  assert.equal(parseAiResult('{"questions":[{"question_no":"1","max_score":5,"score":'), null);
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

const badResults = {
  missing: (r) => r.questions.pop(),
  duplicate: (r) => { r.questions[1].question_no = "1"; },
  unknown: (r) => { r.questions[1].question_no = "999"; },
  extra: (r) => { r.questions.push({ ...r.questions[0] }); },
  nullScore: (r) => { r.questions[0].score = null; },
  absentScore: (r) => { delete r.questions[0].score; },
  stringScore: (r) => { r.questions[0].score = "0"; },
  infiniteScore: (r) => { r.questions[0].score = Infinity; },
  negativeScore: (r) => { r.questions[0].score = -1; },
  overMax: (r) => { r.questions[0].score = 6; },
  wrongMax: (r) => { r.questions[0].max_score = 10; },
  badConfidence: (r) => { r.questions[0].confidence = 2; },
  stringReview: (r) => { r.questions[0].needs_review = "false"; },
};
for (const [name, mutate] of Object.entries(badResults)) {
  test(`strict grading rejects ${name} without fabricating scores`, () => {
    const raw = resultFor(expected(2));
    mutate(raw);
    assert.throws(() => validateWholePaperResult(raw, expected(2)), { statusCode: 502 });
  });
}

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
