const test = require("node:test");
const assert = require("node:assert/strict");
const { handleMvpRequest } = require("../lib/mvp-handler");
const { signToken } = require("../lib/auth");
const { createWholePaperWorker } = require("../lib/whole-paper-worker");

async function request(action, { db = {}, method = "POST", payload = {}, account = "teacher-A", workerAvailable, readJsonBody } = {}) {
  let status, body;
  const headers = { host: "test.invalid" };
  if (account) headers.authorization = `Bearer ${signToken(account).token}`;
  await handleMvpRequest({
    db, request: { method, url: `/api/mvp?action=${action}&examId=exam&studentId=student`, headers },
    response: { writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } },
    readJsonBody: readJsonBody || (async () => payload), ensureDatabase: async () => {}, workerAvailable,
  });
  return { status, body };
}

test("authentication is required before any desk operation", async () => {
  for (const action of ["desk-list", "desk-detail", "desk-image", "desk-answer-image", "desk-create", "desk-capture", "desk-confirm", "desk-start", "desk-retry", "desk-questions"]) {
    assert.equal((await request(action, { account: "" })).status, 401);
  }
});

test("desk GET contract is passed through with the authenticated tenant", async () => {
  for (const [action, method, args, body] of [
    ["desk-list", "listDeskAssignments", ["teacher-A"], { assignments: [] }],
    ["desk-detail", "getDeskDetail", ["exam", "teacher-A"], { exam: { id: "exam", name: "Test" }, batch: { id: "batch", status: "draft" }, students: [], pages: [], questions: [], results: [] }],
    ["desk-image", "getDeskImage", ["exam", "student", "teacher-A", false, false, false], { image: "synthetic-image" }],
    ["desk-answer-image", "getDeskAnswerImage", ["exam", "teacher-A"], { image: "synthetic-answer" }],
  ]) {
    const result = await request(action, { method: "GET", db: { [method]: async (...actual) => { assert.deepEqual(actual, args); return body; } } });
    assert.deepEqual(result, { status: 200, body });
  }
});

test("desk-create delegates AI recognition and returns only examId/batchId", async () => {
  const payload = { classId: "class", name: "Test", examDate: "2026-01-01", answerImage: "test" };
  assert.deepEqual(await request("desk-create", { payload, db: { createDeskExam: async (actual, account, recognize) => {
    assert.equal(actual, payload);
    assert.equal(account, "teacher-A");
    assert.equal(typeof recognize, "function");
    return { examId: "exam", batchId: "batch" };
  } } }), { status: 201, body: { examId: "exam", batchId: "batch" } });
});

test("desk writes preserve empty success response and authenticated account", async () => {
  const actions = { "desk-capture": "captureDeskPage", "desk-confirm": "confirmDeskPages", "desk-start": "startDeskGrading", "desk-retry": "retryDeskGrading", "desk-questions": "updateDeskQuestions" };
  for (const [action, method] of Object.entries(actions)) {
    const payload = { examId: "exam" };
    const result = await request(action, { payload, workerAvailable: () => true, db: { [method]: async (value, account) => {
      assert.equal(value, payload); assert.equal(account, "teacher-A"); return {};
    } } });
    assert.deepEqual(result, { status: 200, body: {} });
  }
});

test("serverless start and retry explicitly reject without enqueuing", async () => {
  for (const action of ["desk-start", "desk-retry"]) {
    const result = await request(action);
    assert.equal(result.status, 503);
    assert.match(result.body.message, /Node/);
  }
});

test("malformed request data returns 400", async () => {
  for (const payload of [null, [], "bad"]) assert.equal((await request("desk-confirm", { payload })).status, 400);
  assert.equal((await request("desk-confirm", { readJsonBody: async () => { throw new SyntaxError(); } })).status, 400);
});

test("400/409/403 user errors propagate without becoming 500", async () => {
  for (const statusCode of [400, 409, 403]) {
    const result = await request("desk-capture", { db: { captureDeskPage: async () => { throw Object.assign(new Error("rejected"), { statusCode }); } } });
    assert.equal(result.status, statusCode);
  }
});

test("every legacy mutating action checks managed-exam isolation before doing work", async () => {
  for (const action of ["create-question", "create-template", "save-region", "create-batch", "upload-page", "process-batch", "grade-student", "grade-next", "analyze-batch"]) {
    const result = await request(action, { db: { assertLegacyMutationAllowed: async (actual, _payload, account) => {
      assert.equal(actual, action); assert.equal(account, "teacher-A");
      throw Object.assign(new Error("managed"), { statusCode: 409 });
    } } });
    assert.equal(result.status, 409);
  }
});

function workerDb(overrides = {}) {
  const events = [];
  const job = { id: "job", batchId: "batch", leaseToken: "token" };
  return { events, job, db: {
    recoverWholePaperJobs: async () => { events.push("recover"); },
    claimWholePaperJob: async () => { events.push("claim"); return job; },
    getWholePaperJobPayload: async () => { events.push("payload"); return { teacherAnswerImage: "teacher", studentImage: "student" }; },
    renewWholePaperLease: async () => { events.push("renew"); return true; },
    completeWholePaperJob: async (value) => { assert.equal(value, job); events.push("complete"); return true; },
    failWholePaperJob: async (value, message) => { assert.equal(value, job); events.push(["fail", message]); return true; },
    ...overrides,
  } };
}

test("worker recovers, claims, grades and completes without browser calls", async () => {
  const { db, events } = workerDb();
  const worker = createWholePaperWorker({ db, grade: async (payload) => {
    assert.equal(payload.teacherAnswerImage, "teacher"); assert.equal(payload.studentImage, "student"); events.push("grade"); return {};
  } });
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(events, ["recover", "claim", "payload", "grade", "complete"]);
});

test("worker persists AI failure, never writes fabricated results", async () => {
  const { db, events } = workerDb();
  const worker = createWholePaperWorker({ db, grade: async () => { throw new Error("provider failed"); } });
  await worker.runOnce();
  assert.deepEqual(events.at(-1), ["fail", "provider failed"]);
  assert.ok(!events.includes("complete"));
});

test("worker timeout settles a nonresponding provider and releases the loop", async () => {
  const { db, events } = workerDb();
  const worker = createWholePaperWorker({ db, taskTimeoutMs: 10, grade: () => new Promise(() => {}) });
  await worker.runOnce();
  assert.equal(events.at(-1)[0], "fail");
  assert.ok(!events.includes("complete"));
});

test("lost lease aborts in-flight AI and does not complete", async () => {
  const { db, events } = workerDb({ renewWholePaperLease: async () => false });
  const worker = createWholePaperWorker({ db, heartbeatMs: 5, grade: () => new Promise(() => {}) });
  await worker.runOnce();
  assert.equal(events.at(-1)[0], "fail");
  assert.ok(!events.includes("complete"));
});

test("worker loop does not overlap claims", async () => {
  let finish;
  const { db, events } = workerDb();
  const worker = createWholePaperWorker({ db, grade: () => new Promise((resolve) => { finish = resolve; }) });
  const active = worker.runOnce();
  assert.equal(await worker.runOnce(), false);
  await new Promise((resolve) => setImmediate(resolve));
  finish({});
  await active;
  assert.equal(events.filter((e) => e === "claim").length, 1);
});

test("worker reports unavailable on database failure and can recover next tick", async () => {
  let bad = true;
  const { db } = workerDb({ recoverWholePaperJobs: async () => { if (bad) throw new Error("DB unavailable"); }, claimWholePaperJob: async () => null });
  const errors = [];
  const worker = createWholePaperWorker({ db, onError: (e) => errors.push(e.message) });
  worker.start();
  await worker.runOnce();
  assert.equal(worker.isAvailable(), false);
  bad = false;
  await worker.runOnce();
  assert.equal(worker.isAvailable(), true);
  worker.stop();
  assert.equal(worker.isAvailable(), false);
  assert.deepEqual(errors, ["DB unavailable"]);
});
