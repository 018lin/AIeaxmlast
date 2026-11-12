const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const sharp = require("sharp");

// Compile db.js with a scripted pg Pool. No network/database connections are possible.
function loadDb(steps = []) {
  const queries = [];
  const remaining = [...steps];
  let released = 0;
  const query = async (sql, values = []) => {
    sql = sql.replace(/\s+/g, " ").trim();
    queries.push({ sql, values });
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rowCount: 0, rows: [] };
    const next = remaining.shift();
    assert.ok(next, `Unexpected SQL: ${sql}`);
    assert.match(sql, next.match);
    const rows = typeof next.run === "function" ? await next.run(values, sql) : next.rows || [];
    return { rowCount: next.rowCount ?? rows.length, rows };
  };
  class MockPool {
    query(...args) { return query(...args); }
    async connect() { return { query, release: () => { released++; } }; }
  }
  const filename = path.resolve(__dirname, "../db.js");
  const localRequire = Module.createRequire(filename);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.require = (name) => name === "pg" ? { Pool: MockPool } : localRequire(name);
  process.env.DATABASE_URL = "postgres://mock-only.invalid/no-network";
  loaded._compile(fs.readFileSync(filename, "utf8"), filename);
  return { db: loaded.exports, queries,
    check() { assert.equal(remaining.length, 0, `Unused SQL steps: ${remaining.map((s) => s.match).join(", ")}`); },
    get released() { return released; },
  };
}
const id = (n) => `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;
const examId = id(1), batchId = id(2), studentId = id(3), classId = id(4), pageId = id(5), imageId = id(6), jobId = id(7);
const record = (patch = {}) => ({ exam_id: examId, batch_id: batchId, name: "Test", status: "draft", answer_image_id: imageId,
  student_order_snapshot: [{ id: studentId, name: "Student", studentNo: "2" }], capture_version: 2,
  confirmed_version: null, confirmed_page_ids: [], grading_started_at: null, ...patch });
const recordStep = (value = record()) => ({ match: /FROM exams e JOIN scan_batches b/, rows: value ? [value] : [] });
const rowStep = (match, rows = []) => ({ match, rows });
const syntheticImage = async () => `data:image/png;base64,${(await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer()).toString("base64")}`;
const questions = [{ questionNo: "1", title: "Q1", maxScore: 5 }, { questionNo: "2", title: "Q2", maxScore: 10 }];
const questionRows = questions.map((q, i) => ({ id: id(20 + i), question_no: q.questionNo, title: q.title, max_score: String(q.maxScore) }));
const job = { id: jobId, batchId, leaseToken: id(8) };
const jobRow = { id: jobId, batch_id: batchId, student_id: studentId, exam_id: examId };
const grade = { result: { questions: questions.map((q) => ({ question_no: q.questionNo, max_score: q.maxScore, score: 1 })) }, model: "mock" };

function completionSteps() {
  return [rowStep(/SELECT id FROM scan_batches .*FOR UPDATE/, [{ id: batchId }]),
    rowStep(/j.lease_token = \$3.*lease_expires_at > now\(\).*FOR UPDATE OF j/, [jobRow]),
    rowStep(/SELECT id, question_no, title, max_score FROM exam_questions/, questionRows)];
}

test("desk-create atomically saves private answer, exam, sorted snapshot, batch and AI questions", async () => {
  let recognized = 0;
  const mock = loadDb([
    rowStep(/SELECT 1 FROM classes/, [{}]), rowStep(/FROM classes .*FOR UPDATE/, [{}]),
    rowStep(/FROM students .*FOR SHARE/, [
      { id: id(13), name: "Zed", student_no: "10" }, { id: studentId, name: "Bob", student_no: "2" },
      { id: id(12), name: "Amy", student_no: "02" }, { id: id(14), name: "Ann", student_no: "" },
    ]), rowStep(/INSERT INTO uploaded_images/), rowStep(/SET desk_private = true/),
    { match: /INSERT INTO exams/, run: (v) => {
      assert.equal(v[4], "teacher-A"); assert.equal(v[6], 15);
      assert.deepEqual(JSON.parse(v[7]).map((s) => s.name), ["Amy", "Bob", "Zed", "Ann"]);
      return [];
    } }, rowStep(/INSERT INTO scan_batches/),
    { match: /INSERT INTO exam_questions/, run: (v) => { assert.equal(v[5], true); return []; } },
    rowStep(/INSERT INTO exam_questions/), rowStep(/UPDATE exams SET total_score/),
  ]);
  const output = await mock.db.createDeskExam({ classId, name: "Test", examDate: "2026-01-01", answerImage: await syntheticImage() }, "teacher-A", async () => { recognized++; return { questions }; });
  assert.equal(recognized, 1);
  assert.deepEqual(Object.keys(output), ["examId", "batchId"]);
  assert.equal(mock.queries.at(-1).sql, "COMMIT");
  assert.equal(mock.released, 1);
  mock.check();
});

test("failed AI recognition creates no partial records", async () => {
  const mock = loadDb([rowStep(/SELECT 1 FROM classes/, [{}])]);
  await assert.rejects(mock.db.createDeskExam({ classId, name: "Test", examDate: "2026-01-01", answerImage: await syntheticImage() }, "teacher-A", async () => { throw new Error("recognition failed"); }), /recognition failed/);
  assert.ok(!mock.queries.some((q) => /INSERT|BEGIN/.test(q.sql)));
  mock.check();
});

test("invalid date and image return 400 without creating an exam", async () => {
  const mock = loadDb([rowStep(/SELECT 1 FROM classes/, [{}])]);
  const payload = { classId, name: "Test", examDate: "2026-02-30", answerImage: "bad" };
  await assert.rejects(mock.db.createDeskExam(payload, "teacher-A", () => assert.fail()), { statusCode: 400 });
  await assert.rejects(mock.db.createDeskExam({ ...payload, examDate: "2026-01-01" }, "teacher-A", () => assert.fail()), { statusCode: 400 });
  mock.check();
});

test("snapshot indices must match exact student, not current live roster order", async () => {
  const mock = loadDb([recordStep()]);
  await assert.rejects(mock.db.captureDeskPage({ examId, studentId: id(99), captureOrder: 0, image: "not-processed" }, "teacher-A"), { statusCode: 409 });
  assert.ok(!mock.queries.some((q) => q.sql === "BEGIN"));
  mock.check();
});

test("replacement uploads before deletion and rolls back if new page insertion fails", async () => {
  const mock = loadDb([
    recordStep(), recordStep(), rowStep(/FROM students .*FOR SHARE/, [{}]),
    rowStep(/INSERT INTO uploaded_images/), rowStep(/SET desk_private = true/),
    rowStep(/DELETE FROM scanned_pages.*RETURNING image_id/, [{ image_id: imageId }]),
    { match: /INSERT INTO scanned_pages/, run: () => { throw new Error("write failed"); } },
  ]);
  await assert.rejects(mock.db.captureDeskPage({ examId, studentId, captureOrder: 0, image: await syntheticImage(), name: "test" }, "teacher-A"), /write failed/);
  assert.equal(mock.queries.at(-1).sql, "ROLLBACK");
  assert.ok(!mock.queries.some((q) => /DELETE FROM uploaded_images/.test(q.sql)));
  assert.equal(mock.released, 1);
  mock.check();
});

test("successful replacement resets confirmation under batch lock", async () => {
  const mock = loadDb([recordStep(), recordStep(), rowStep(/FROM students .*FOR SHARE/, [{}]),
    rowStep(/INSERT INTO uploaded_images/), rowStep(/SET desk_private = true/),
    rowStep(/DELETE FROM scanned_pages/, [{ image_id: imageId }]), rowStep(/INSERT INTO scanned_pages/),
    rowStep(/DELETE FROM uploaded_images .*desk_private/), rowStep(/capture_version = capture_version \+ 1.*confirmed_version = NULL/),
  ]);
  assert.deepEqual(await mock.db.captureDeskPage({ examId, studentId, captureOrder: 0, image: await syntheticImage() }, "teacher-A"), {});
  assert.match(mock.queries[2].sql, /FOR UPDATE OF b/);
  assert.equal(mock.queries.at(-1).sql, "COMMIT");
  mock.check();
});

test("start/capture race rechecks grading lock after image validation", async () => {
  const mock = loadDb([recordStep(), recordStep(record({ grading_started_at: new Date() }))]);
  await assert.rejects(mock.db.captureDeskPage({ examId, studentId, captureOrder: 0, image: await syntheticImage() }, "teacher-A"), { statusCode: 409 });
  assert.equal(mock.queries.at(-1).sql, "ROLLBACK");
  mock.check();
});

for (const requested of [[pageId], [pageId, pageId], [pageId, id(99)]]) {
  test(`confirmation rejects stale/duplicate page set ${requested.join(",")}`, async () => {
    const mock = loadDb([recordStep(), rowStep(/SELECT id FROM scanned_pages/, [{ id: pageId }, { id: id(9) }])]);
    await assert.rejects(mock.db.confirmDeskPages({ examId, pageIds: requested }, "teacher-A"), { statusCode: 409 });
    assert.equal(mock.queries.at(-1).sql, "ROLLBACK"); mock.check();
  });
}

test("confirmation persists exact list/version; set order does not matter", async () => {
  const ids = [id(9), pageId];
  const mock = loadDb([recordStep(), rowStep(/SELECT id FROM scanned_pages/, [{ id: pageId }, { id: id(9) }]),
    { match: /confirmed_version = capture_version/, run: (v) => { assert.deepEqual(JSON.parse(v[1]), ids); return []; } }]);
  assert.deepEqual(await mock.db.confirmDeskPages({ examId, pageIds: ids }, "teacher-A"), {});
  mock.check();
});

test("empty confirmation and malformed IDs are 400", async () => {
  const mock = loadDb();
  await assert.rejects(mock.db.confirmDeskPages({ examId, pageIds: [] }, "teacher-A"), { statusCode: 400 });
  await assert.rejects(mock.db.getDeskDetail("bad-id", "teacher-A"), { statusCode: 400 });
  mock.check();
});

test("unconfirmed or stale version cannot enqueue", async () => {
  for (const patch of [{}, { confirmed_version: 1, confirmed_page_ids: [pageId] }, { confirmed_version: 2, confirmed_page_ids: [id(99)] }]) {
    const mock = loadDb([recordStep(record(patch)), rowStep(/SELECT id FROM scanned_pages/, [{ id: pageId }])]);
    await assert.rejects(mock.db.startDeskGrading({ examId }, "teacher-A"), { statusCode: 409 });
    assert.ok(!mock.queries.some((q) => /INSERT INTO grading_jobs/.test(q.sql))); mock.check();
  }
});

test("start enqueues a single whole-page job and commits immutable grading start", async () => {
  const mock = loadDb([
    recordStep(record({ confirmed_version: 2, confirmed_page_ids: [pageId] })), rowStep(/SELECT id FROM scanned_pages/, [{ id: pageId }]),
    rowStep(/SELECT question_no AS/, [{ questionNo: "1", title: "Q", max_score: "5" }]),
    { match: /INSERT INTO grading_jobs.*'whole_paper'.*ON CONFLICT/, run: (v) => { assert.equal(v[2], pageId); return []; } },
    rowStep(/grading_started_at = now\(\)/),
  ]);
  assert.deepEqual(await mock.db.startDeskGrading({ examId }, "teacher-A"), {});
  assert.equal(mock.queries.at(-1).sql, "COMMIT"); mock.check();
});

test("repeated start after grading or failure is idempotent", async () => {
  for (const status of ["grading", "failed", "done"]) {
    const mock = loadDb([recordStep(record({ status, grading_started_at: new Date() }))]);
    assert.deepEqual(await mock.db.startDeskGrading({ examId }, "teacher-A"), {});
    assert.ok(!mock.queries.some((q) => /INSERT INTO/.test(q.sql))); mock.check();
  }
});

test("question draft replacement supports merge/delete and clears confirmation", async () => {
  const mock = loadDb([recordStep(), rowStep(/DELETE FROM exam_questions/),
    { match: /INSERT INTO exam_questions/, run: (v) => { assert.equal(v[2], "1-2"); assert.equal(v[4], 15); assert.equal(v[5], false); return []; } },
    rowStep(/UPDATE exams SET total_score/), rowStep(/confirmed_version = NULL/),
  ]);
  await mock.db.updateDeskQuestions({ examId, questions: [{ questionNo: "1-2", title: "Merged", maxScore: 15 }] }, "teacher-A");
  mock.check();
});

test("question changes cannot alter a started assignment", async () => {
  const mock = loadDb([recordStep(record({ grading_started_at: new Date() }))]);
  await assert.rejects(mock.db.updateDeskQuestions({ examId, questions }, "teacher-A"), { statusCode: 409 }); mock.check();
});

test("retry updates only failed jobs with attempts below three and settles batch", async () => {
  const mock = loadDb([recordStep(record({ grading_started_at: new Date() })),
    { match: /status = 'failed' AND attempts < \$2/, run: (v, sql) => {
      assert.equal(v[1], 3); assert.ok(!sql.includes("attempts = 0")); return [{ id: jobId }];
    } }, rowStep(/UPDATE scan_batches b SET status = CASE/),
  ]);
  await mock.db.retryDeskGrading({ examId }, "teacher-A"); mock.check();
});

test("exhausted retry returns 409 and never resets attempts", async () => {
  const mock = loadDb([recordStep(record({ grading_started_at: new Date() })), rowStep(/UPDATE grading_jobs/), rowStep(/SELECT id FROM grading_jobs/, [{ id: jobId }])]);
  await assert.rejects(mock.db.retryDeskGrading({ examId }, "teacher-A"), { statusCode: 409 }); mock.check();
});

test("tenant-scoped desk reads and writes cannot use another teacher's exam", async () => {
  for (const method of ["getDeskDetail", "getDeskImage", "captureDeskPage", "confirmDeskPages", "updateDeskQuestions", "startDeskGrading", "retryDeskGrading"]) {
    const mock = loadDb([{ match: /e.teacher_account = \$2 AND e.desk_managed/, run: (v) => { assert.equal(v[1], "teacher-B"); return []; } }]);
    let call;
    if (method === "getDeskDetail") call = mock.db[method](examId, "teacher-B");
    else if (method === "getDeskImage") call = mock.db[method](examId, studentId, "teacher-B");
    else call = mock.db[method]({ examId, studentId, captureOrder: 0, pageIds: [pageId], questions }, "teacher-B");
    await assert.rejects(call, { statusCode: 403 }); mock.check();
  }
});

test("desk-image never returns another snapshot student's image", async () => {
  const mock = loadDb([recordStep()]);
  await assert.rejects(mock.db.getDeskImage(examId, id(99), "teacher-A"), { statusCode: 403 }); mock.check();
});

test("list contract uses snapshot counts, finished student averages and numeric JSON", async () => {
  const mock = loadDb([{ match: /jsonb_array_length\(e.student_order_snapshot\).*e.teacher_account = \$1/, run: (v, sql) => {
    assert.equal(v[0], "teacher-A"); assert.match(sql, /COUNT\(\*\) FROM grading_results r WHERE r.batch_id = b.id AND r.needs_review\) AS review_count/);
    return [{ id: examId, name: "Test", class_name: "Class", exam_date: "2026-01-01", batch_id: batchId, status: "grading", student_count: "10", captured_count: "5", done_count: "3", review_count: "2", average_score: "8.5" }];
  } }]);
  const { assignments: [item] } = await mock.db.listDeskAssignments("teacher-A");
  assert.deepEqual(item, { id: examId, name: "Test", className: "Class", examDate: "2026-01-01", batchId, status: "grading", studentCount: 10, capturedCount: 5, doneCount: 3, reviewCount: 2, averageScore: 8.5 }); mock.check();
});

test("legacy routes reject managed exam, batch, question and template targets", async () => {
  for (const [action, payload] of [
    ["create-question", { examId }], ["create-template", { examId }], ["create-batch", { examId }], ["grade-student", { examId }],
    ["upload-page", { batchId }], ["process-batch", { batchId }], ["grade-next", { batchId }], ["analyze-batch", { batchId }], ["save-region", { templateId: id(30) }],
  ]) {
    const mock = loadDb([rowStep(/SELECT e.desk_managed.*e.teacher_account = \$2/, [{ desk_managed: true }])]);
    await assert.rejects(mock.db.assertLegacyMutationAllowed(action, payload, "teacher-A"), { statusCode: 409 }); mock.check();
  }
  const mock = loadDb([rowStep(/SELECT e.desk_managed/, [{ desk_managed: false }]), rowStep(/FROM exam_questions/, [{ desk_managed: true }])]);
  await assert.rejects(mock.db.assertLegacyMutationAllowed("save-region", { templateId: id(30), questionId: id(31) }, "teacher-A"), { statusCode: 409 }); mock.check();
});

test("legacy image listing/deletion exclude private desk photos and history cannot reference them", async () => {
  const mock = loadDb([rowStep(/FROM uploaded_images WHERE NOT desk_private/), rowStep(/DELETE FROM uploaded_images WHERE NOT desk_private/),
    rowStep(/SELECT id FROM uploaded_images.*desk_private/, [{ id: imageId }]),
  ]);
  await mock.db.listUploads(); await mock.db.deleteUploads();
  await assert.rejects(mock.db.createAiGradingHistory({ questionImageId: imageId }, "teacher-B"), { statusCode: 403 }); mock.check();
});

test("claims lock batch then job, skip concurrent locks, and increment attempts with a lease", async () => {
  const mock = loadDb([
    rowStep(/FROM scan_batches b.*FOR UPDATE OF b SKIP LOCKED/, [{ id: batchId }]),
    rowStep(/FROM grading_jobs.*FOR UPDATE SKIP LOCKED/, [{ id: jobId }]),
    { match: /attempts = attempts \+ 1.*lease_token = \$2.*lease_expires_at/, run: (v) => {
      assert.equal(v[0], jobId); assert.equal(v[2], 120); return [{ id: jobId, batch_id: batchId }];
    } }, rowStep(/UPDATE scan_batches SET status = 'grading'/),
  ]);
  const claimed = await mock.db.claimWholePaperJob();
  assert.equal(claimed.id, jobId); assert.ok(claimed.leaseToken);
  assert.equal(mock.queries.at(-1).sql, "COMMIT"); mock.check();
});

test("restart recovery only requeues expired leases, failing exhausted jobs", async () => {
  const mock = loadDb([
    rowStep(/lease_expires_at <= now\(\).*FOR UPDATE OF b SKIP LOCKED/, [{ id: batchId }]),
    { match: /CASE WHEN attempts < \$2 THEN 'pending' ELSE 'failed' END.*lease_token = NULL/, run: (v, sql) => {
      assert.equal(v[1], 3); assert.match(sql, /status = 'running'.*lease_expires_at <= now\(\)/); return [];
    } }, rowStep(/UPDATE scan_batches b SET status = CASE/),
  ]);
  await mock.db.recoverWholePaperJobs(); mock.check();
});

test("atomic completion stores all per-question results and only then settles batch", async () => {
  const mock = loadDb([...completionSteps(),
    { match: /INSERT INTO grading_results.*ON CONFLICT \(job_id, question_id\) DO NOTHING/, run: (v) => { assert.equal(v[12], null); assert.equal(v[13], true); return []; } },
    rowStep(/INSERT INTO grading_results/), rowStep(/SET status = 'done'.*overall_feedback/),
    rowStep(/WHEN EXISTS .*'pending', 'running'.*THEN 'grading'.*THEN 'failed'.*THEN 'needs_review'/),
  ]);
  assert.equal(await mock.db.completeWholePaperJob(job, grade), true);
  assert.equal(mock.queries.at(-1).sql, "COMMIT"); mock.check();
});

test("partial result write failure rolls back all results and completion state", async () => {
  const mock = loadDb([...completionSteps(), rowStep(/INSERT INTO grading_results/),
    { match: /INSERT INTO grading_results/, run: () => { throw new Error("second insert failed"); } },
  ]);
  await assert.rejects(mock.db.completeWholePaperJob(job, grade), /second insert failed/);
  assert.equal(mock.queries.at(-1).sql, "ROLLBACK");
  assert.ok(!mock.queries.some((q) => /SET status = 'done'/.test(q.sql))); mock.check();
});

test("invalid complete result rolls back before any result insertion", async () => {
  const mock = loadDb(completionSteps());
  await assert.rejects(mock.db.completeWholePaperJob(job, { result: { questions: [grade.result.questions[0]] } }), { statusCode: 502 });
  assert.equal(mock.queries.at(-1).sql, "ROLLBACK"); mock.check();
});

test("stale lease or repeated completion/failure is fenced out with no writes", async () => {
  for (const method of ["completeWholePaperJob", "failWholePaperJob"]) {
    const mock = loadDb([rowStep(/SELECT id FROM scan_batches.*FOR UPDATE/, [{}]), rowStep(/lease_token = \$3.*status = 'running'.*FOR UPDATE OF j/)]);
    assert.equal(await mock.db[method](job, grade), false);
    assert.ok(!mock.queries.some((q) => /^(INSERT|UPDATE|DELETE)/.test(q.sql))); mock.check();
  }
});

test("heartbeat cannot revive an expired lease", async () => {
  const mock = loadDb([rowStep(/lease_token = \$2 AND status = 'running' AND lease_expires_at > now\(\)/)]);
  assert.equal(await mock.db.renewWholePaperLease(job), false); mock.check();
});

test("desk detail is a consistent metadata-only snapshot with short result fields", async () => {
  const mock = loadDb([recordStep(),
    rowStep(/FROM scanned_pages p LEFT JOIN grading_jobs/, [{ id: pageId, student_id: studentId, capture_order: 0, status: "done", error: "" }]),
    rowStep(/SELECT id, question_no, max_score, title/, questionRows),
    rowStep(/SELECT r\.\*, q.question_no/, [{ student_id: studentId, question_no: "1", final_score: null, score: "4", max_score: "5", analysis: "Good", suggestions: [], ai_result: { knowledge_points: ["Math"] }, needs_review: true }]),
  ]);
  const detail = await mock.db.getDeskDetail(examId, "teacher-A");
  assert.deepEqual(Object.keys(detail), ["exam", "batch", "students", "pages", "questions", "results"]);
  assert.deepEqual(detail.students, record().student_order_snapshot);
  assert.deepEqual(detail.pages[0], { id: pageId, studentId, captureOrder: 0, status: "done", error: "" });
  assert.deepEqual(detail.results[0], { studentId, questionNo: "1", score: 4, maxScore: 5, analysis: "Good", suggestions: [], knowledgePoints: ["Math"], needsReview: true });
  assert.equal(mock.queries[0].sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); mock.check();
});

test("desk image loads only the requested student's private photo on demand", async () => {
  const mock = loadDb([recordStep(), { match: /p.batch_id = \$1 AND p.student_id = \$2/, run: (v) => {
    assert.deepEqual(v, [batchId, studentId]); return [{ mime_type: "image/png", image_data: Buffer.from("synthetic") }];
  } }]);
  assert.deepEqual(await mock.db.getDeskImage(examId, studentId, "teacher-A"), { image: "data:image/png;base64,c3ludGhldGlj" }); mock.check();
});

test("review thumbnails are small JPEGs without changing original images", async () => {
  const sharp = require("sharp");
  const source = await sharp({ create: { width: 1200, height: 1600, channels: 3, background: "white" } }).png().toBuffer();
  const mock = loadDb([recordStep(), rowStep(/p.batch_id = \$1 AND p.student_id = \$2/, [{ mime_type: "image/png", image_data: source }])]);
  const { image } = await mock.db.getDeskImage(examId, studentId, "teacher-A", true);
  const metadata = await sharp(Buffer.from(image.split(",")[1], "base64")).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 240);
  assert.equal(metadata.height, 320);
  mock.check();
});

test("worker payload references the stored teacher answer and student page, not crops", async () => {
  const mock = loadDb([
    { match: /answer.id = e.answer_image_id.*student.id = p.image_id.*j.lease_token = \$2/, run: (v) => {
      assert.deepEqual(v, [jobId, job.leaseToken]);
      return [{ name: "Test", exam_id: examId, student_id: studentId, answer_mime: "image/png", answer_data: Buffer.from("answer"), student_mime: "image/png", student_data: Buffer.from("student") }];
    } }, rowStep(/FROM exam_questions/, questionRows),
  ]);
  const payload = await mock.db.getWholePaperJobPayload(job);
  assert.equal(payload.teacherAnswerImage, "data:image/png;base64,YW5zd2Vy");
  assert.equal(payload.studentImage, "data:image/png;base64,c3R1ZGVudA==");
  assert.equal(payload.expectedQuestions.length, 2); mock.check();
});

test("worker failure atomically settles a terminal failed batch rather than hanging", async () => {
  const mock = loadDb([
    rowStep(/SELECT id FROM scan_batches.*FOR UPDATE/, [{}]), rowStep(/lease_token = \$3.*FOR UPDATE OF j/, [jobRow]),
    { match: /SET status = 'failed'.*lease_token = NULL/, run: (v) => { assert.deepEqual(v, [jobId, "unreadable answer"]); return []; } },
    rowStep(/UPDATE scan_batches b SET status = CASE.*THEN 'failed'/),
  ]);
  assert.equal(await mock.db.failWholePaperJob(job, "unreadable answer"), true);
  assert.equal(mock.queries.at(-1).sql, "COMMIT"); mock.check();
});

test("schema preserves old crop defaults while enabling unique whole-page jobs and multi-result jobs", () => {
  const schema = fs.readFileSync(path.resolve(__dirname, "../schema.sql"), "utf8");
  for (const field of ["answer_image_id", "answer_total_score", "student_order_snapshot", "auto_generated", "capture_order", "confidence", "needs_review", "final_score", "teacher_comment", "confirmed_version", "confirmed_page_ids", "lease_token", "lease_expires_at"]) {
    assert.match(schema, new RegExp(`ADD COLUMN IF NOT EXISTS ${field} `));
  }
  assert.match(schema, /ALTER TABLE grading_jobs ALTER COLUMN answer_crop_id DROP NOT NULL/);
  assert.match(schema, /DEFAULT 'crop'/);
  assert.match(schema, /UNIQUE INDEX IF NOT EXISTS grading_jobs_whole_page_idx\s+ON grading_jobs \(scanned_page_id\) WHERE job_kind = 'whole_paper'/);
  assert.match(schema, /DROP CONSTRAINT IF EXISTS grading_results_job_id_key/);
  assert.match(schema, /UNIQUE INDEX IF NOT EXISTS grading_results_job_question_idx ON grading_results \(job_id, question_id\)/);
});
