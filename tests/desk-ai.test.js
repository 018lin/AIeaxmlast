const test = require("node:test");
const assert = require("node:assert/strict");
const { gradeWholePaper, recognizeAnswerQuestions, validateWholePaperResult, validateDeskQuestions } = require("../lib/ai-grader");

const expected = (count) => Array.from({ length: count }, (_, i) => ({ questionNo: String(i + 1), title: "Test", maxScore: 5 }));
const resultFor = (questions) => ({ questions: questions.map((q) => ({ question_no: q.questionNo, max_score: q.maxScore, score: 3, confidence: 0.9, analysis: "Feedback" })) });

function mockProvider(t, respond) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(respond(body, calls.length)) } }] }) };
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

for (const count of [1, 15, 16, 20]) {
  test(`${count} questions use ${count <= 15 ? 1 : Math.ceil(count / 5)} exact-sized calls with both images`, async (t) => {
    const all = expected(count);
    const size = count <= 15 ? count : 5;
    const calls = mockProvider(t, (body, index) => {
      const text = body.messages[0].content[0].text;
      const group = JSON.parse(text.split("\n")[2]);
      assert.deepEqual(group, all.slice((index - 1) * size, index * size));
      assert.deepEqual(body.messages[0].content.slice(1).map((c) => c.image_url.url), ["teacher", "student"]);
      return resultFor(group);
    });
    const graded = await gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: all });
    assert.equal(calls.length, Math.ceil(count / size));
    assert.deepEqual(graded.result.questions.map((q) => q.question_no), all.map((q) => q.questionNo));
  });
}

test("a malformed later chunk rejects the entire paper instead of returning partial results", async (t) => {
  const all = expected(16);
  const calls = mockProvider(t, (_body, index) => index === 2 ? { questions: [] } : resultFor(all.slice(0, 5)));
  await assert.rejects(gradeWholePaper({ teacherAnswerImage: "teacher", studentImage: "student", expectedQuestions: all }), { statusCode: 502 });
  assert.equal(calls.length, 2);
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
