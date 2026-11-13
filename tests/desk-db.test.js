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
    { match: /INSERT INTO exam_questions/, run: (v) => { assert.equal(v[7], true); return []; } },
    rowStep(/INSERT INTO exam_sub_questions/),
    { match: /INSERT INTO exam_questions/, run: (v) => { assert.equal(v[7], true); return []; } },
    rowStep(/INSERT INTO exam_sub_questions/), rowStep(/UPDATE exams SET total_score/),
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
    const mock = loadDb([recordStep(record(patch)),
      rowStep(/SELECT id, student_id, page_no, capture_order FROM scanned_pages/, [{ id: pageId, student_id: studentId, page_no: 1 }])]);
    await assert.rejects(mock.db.startDeskGrading({ examId }, "teacher-A"), { statusCode: 409 });
    assert.ok(!mock.queries.some((q) => /INSERT INTO grading_jobs/.test(q.sql))); mock.check();
  }
});

test("start enqueues paper_group tasks and commits immutable grading start", async () => {
  const mock = loadDb([
    recordStep(record({ confirmed_version: 2, confirmed_page_ids: [pageId] })),
    rowStep(/SELECT id, student_id, page_no, capture_order FROM scanned_pages/, [{ id: pageId, student_id: studentId, page_no: 1 }]),
    rowStep(/SELECT COUNT\(\*\) AS count FROM student_page_regions/, [{ count: "0" }]),
    rowStep(/FROM exam_questions q/, [{ id: id(20), question_no: "1", title: "Q", max_score: "5", question_type: "计算题", subs: [] }]),
    rowStep(/SELECT student_id, scanned_page_id, page_no, regions FROM student_page_regions/, []),
    { match: /INSERT INTO grading_jobs.*'paper_group'.*ON CONFLICT/, run: (v) => {
      assert.equal(v[2], studentId); assert.deepEqual(JSON.parse(v[4]), [pageId]);
      assert.deepEqual(JSON.parse(v[5]), [id(20)]); return [];
    } },
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
  const mock = loadDb([recordStep(),
    rowStep(/DELETE FROM uploaded_images i USING exam_questions q/),
    rowStep(/DELETE FROM uploaded_images i USING exam_sub_questions s/),
    rowStep(/DELETE FROM page_layout_templates/), rowStep(/DELETE FROM student_page_regions/),
    rowStep(/DELETE FROM exam_questions/),
    { match: /INSERT INTO exam_questions/, run: (v) => { assert.equal(v[2], "1-2"); assert.equal(v[4], 15); assert.equal(v[7], false); return []; } },
    rowStep(/INSERT INTO exam_sub_questions/), rowStep(/UPDATE exams SET total_score/),
    rowStep(/capture_version = capture_version \+ 1/),
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
  for (const method of ["getDeskDetail", "getDeskImage", "getDeskAnswerImage", "captureDeskPage", "confirmDeskPages", "updateDeskQuestions", "startDeskGrading", "retryDeskGrading"]) {
    const mock = loadDb([{ match: /e.teacher_account = \$2 AND e.desk_managed/, run: (v) => { assert.equal(v[1], "teacher-B"); return []; } }]);
    let call;
    if (method === "getDeskDetail") call = mock.db[method](examId, "teacher-B");
    else if (method === "getDeskImage") call = mock.db[method](examId, studentId, "teacher-B");
    else if (method === "getDeskAnswerImage") call = mock.db[method](examId, "teacher-B");
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
    assert.equal(v[0], "teacher-A"); assert.match(sql, /FROM grading_sub_results gs WHERE gs.result_id = r.id AND gs.needs_review AND NOT gs.reviewed/);
    return [{ id: examId, name: "Test", class_name: "Class", exam_date: "2026-01-01", batch_id: batchId, status: "grading", student_count: "10", pages_per_student: "2", captured_count: "5", done_count: "3", review_count: "2", average_score: "8.5" }];
  } }]);
  const { assignments: [item] } = await mock.db.listDeskAssignments("teacher-A");
  assert.deepEqual(item, { id: examId, name: "Test", className: "Class", examDate: "2026-01-01", batchId, status: "grading", studentCount: 10, pagesPerStudent: 2, capturedCount: 5, doneCount: 3, reviewCount: 2, averageScore: 8.5 }); mock.check();
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
    rowStep(/FROM scanned_pages p LEFT JOIN LATERAL/, [{ id: pageId, student_id: studentId, capture_order: 0, page_no: 1, status: "done", error: "", region_status: "ok", region_issue: "", region_confidence: "0.92" }]),
    rowStep(/SELECT q\.id, q\.question_no, q\.max_score, q\.title, q\.question_type/, questionRows),
    rowStep(/SELECT r\.\*, q\.question_no/, [{ id: id(40), student_id: studentId, question_id: id(20), question_no: "1", question_type: "", final_score: null, score: "4", max_score: "5", analysis: "Good", suggestions: [], ai_result: { knowledge_points: ["Math"], bbox: [0.1, 0.2, 0.3, 0.4] }, needs_review: true }]),
    rowStep(/FROM grading_sub_results WHERE batch_id/, []),
  ]);
  const detail = await mock.db.getDeskDetail(examId, "teacher-A");
  assert.deepEqual(Object.keys(detail), ["exam", "batch", "students", "pages", "questions", "results"]);
  assert.deepEqual(detail.students, record().student_order_snapshot);
  assert.deepEqual(detail.pages[0], { id: pageId, studentId, captureOrder: 0, pageNo: 1, status: "done", error: "", regionStatus: "ok", regionIssue: "", regionConfidence: 0.92 });
  assert.deepEqual(detail.results[0], { studentId, questionId: id(20), questionNo: "1", score: 4, maxScore: 5, analysis: "Good", suggestions: [], knowledgePoints: ["Math"], needsReview: true, bbox: [0.1, 0.2, 0.3, 0.4], subs: [] });
  assert.equal(mock.queries[0].sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); mock.check();
});

test("desk image loads only the requested student's private photo on demand", async () => {
  const mock = loadDb([recordStep(), { match: /FROM scanned_pages p .*p\.page_no = \$3/, run: (v) => {
    assert.deepEqual(v, [batchId, studentId, 1]); return [{ id: pageId, mime_type: "image/png", image_data: Buffer.from("synthetic") }];
  } }]);
  assert.deepEqual(await mock.db.getDeskImage(examId, studentId, "teacher-A"), { image: "data:image/png;base64,c3ludGhldGlj", pageNo: 1 }); mock.check();
});

test("desk image can return boxes aligned to the student's real ink rows", async () => {
  const rows = [120, 260, 400].map((top) => `<rect x="30" y="${top}" width="420" height="30" fill="#111"/>`);
  const title = `<rect x="30" y="40" width="200" height="30" fill="#111"/>`;
  const source = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
    <rect width="100%" height="100%" fill="#fff"/>${title}${rows.join("")}</svg>`)).png().toBuffer();
  const mock = loadDb([recordStep(),
    rowStep(/FROM scanned_pages p .*p\.page_no = \$3/, [{ id: pageId, mime_type: "image/png", image_data: source }]),
    rowStep(/FROM student_page_regions WHERE scanned_page_id/, []),
    rowStep(/FROM grading_results r JOIN exam_questions q/, [1, 2, 3].map((n) => ({ question_no: String(n), bbox: [0.05, 0.1 * n, 0.8, 0.08] }))),
  ]);
  const result = await mock.db.getDeskImage(examId, studentId, "teacher-A", false, false, true);
  assert.ok(result.image.startsWith("data:image/png;base64,"));
  assert.deepEqual(Object.keys(result.boxes), ["1", "2", "3"]);
  assert.ok(result.boxes["1"][1] > 0.17 && result.boxes["1"][1] < 0.22);
  assert.ok(result.boxes["3"][1] > 0.63 && result.boxes["3"][1] < 0.7);
  mock.check();
});

test("desk answer image returns a bounded preview of the stored teacher answer", async () => {
  const sharp = require("sharp");
  const source = await sharp({ create: { width: 1200, height: 1600, channels: 3, background: "white" } }).png().toBuffer();
  const mock = loadDb([recordStep(), rowStep(/SELECT mime_type, image_data FROM uploaded_images WHERE id = \$1/, [{ mime_type: "image/png", image_data: source }])]);
  const { image } = await mock.db.getDeskAnswerImage(examId, "teacher-A");
  const metadata = await sharp(Buffer.from(image.split(",")[1], "base64")).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 1600);
  mock.check();
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

test("paper-group claiming caps per-student concurrency and marks claimed batches grading", async () => {
  const mock = loadDb([
    { match: /WITH running AS .*ROW_NUMBER\(\) OVER \(PARTITION BY j\.batch_id, j\.student_id/, run: (v) => {
      assert.deepEqual(v, [3, 2, 4]);
      return [{ id: jobId, batch_id: batchId, student_id: studentId }, { id: id(9), batch_id: batchId, student_id: id(10) }];
    } },
    { match: /UPDATE grading_jobs SET status = 'running', attempts = attempts \+ 1/, run: (v) => {
      assert.equal(v[0], jobId); assert.equal(v[2], 120); assert.match(v[1], /^[0-9a-f-]{36}$/);
      return [{ id: jobId, batch_id: batchId, student_id: studentId }];
    } },
    { match: /UPDATE grading_jobs SET status = 'running', attempts = attempts \+ 1/, run: (v) => {
      assert.equal(v[0], id(9)); return [{ id: id(9), batch_id: batchId, student_id: id(10) }];
    } },
    rowStep(/UPDATE scan_batches SET status = 'grading' WHERE id = \$1/),
  ]);
  const claimed = await mock.db.claimPaperGroupJobs(4, 2);
  assert.equal(claimed.length, 2);
  assert.equal(claimed[0].batchId, batchId);
  assert.ok(claimed[0].leaseToken);
  assert.equal(mock.queries.at(-1).sql, "COMMIT");
  mock.check();
});

test("paper-group restart recovery requeues expired leases and settles their batches", async () => {
  const mock = loadDb([
    rowStep(/FROM \( SELECT batch_id, created_at FROM grading_jobs/, [{ batch_id: batchId }]),
    { match: /status = CASE WHEN attempts < \$2 THEN 'pending' ELSE 'failed' END/, run: (v, sql) => {
      assert.equal(v[0], batchId); assert.equal(v[1], 3);
      assert.match(sql, /job_kind = 'paper_group' AND status = 'running'/);
      return [];
    } },
    rowStep(/UPDATE scan_batches b SET status = CASE.*THEN 'failed'/),
  ]);
  await mock.db.recoverPaperGroupJobs();
  assert.equal(mock.queries.at(-1).sql, "COMMIT"); mock.check();
});

test("paper-group completion replaces the old result and writes one sub row per sub question", async () => {
  const questionId = id(20), resultId = id(50), subA = id(40), subB = id(41);
  const paperGrade = { model: "mock", result: { questions: [{
    question_no: "1", max_score: 5, score: 3, confidence: 0.9,
    parts: [{ label: "(1)", score: 2, max_score: 3, correct: false }, { label: "(2)", score: 1, max_score: 2, correct: false }],
  }] } };
  const mock = loadDb([
    rowStep(/SELECT id FROM scan_batches .*FOR UPDATE/, [{ id: batchId }]),
    { match: /j\.lease_token = \$3.*j\.job_kind = 'paper_group'/, run: () => [{ ...jobRow, exam_id: examId, question_ids: [questionId] }] },
    rowStep(/FROM exam_questions q LEFT JOIN exam_sub_questions/, [{ id: questionId, question_no: "1", title: "Q1", max_score: "5", question_type: "解答", subs: [
      { id: subA, label: "(1)", maxScore: "3", ordinal: 0 }, { id: subB, label: "(2)", maxScore: "2", ordinal: 1 },
    ] }]),
    { match: /DELETE FROM grading_results WHERE batch_id = \$1 AND student_id = \$2 AND question_id = \$3/, run: (v) => {
      assert.deepEqual(v, [batchId, studentId, questionId]); return [];
    } },
    { match: /INSERT INTO grading_results/, run: () => [{ id: resultId }] },
    { match: /INSERT INTO grading_sub_results/, run: (v) => {
      assert.deepEqual([v[1], v[5], v[6], v[7], v[8], v[9]], [resultId, questionId, subA, "(1)", 2, 3]); return [];
    } },
    { match: /INSERT INTO grading_sub_results/, run: (v) => {
      assert.deepEqual([v[6], v[7], v[8], v[9]], [subB, "(2)", 1, 2]); return [];
    } },
    rowStep(/SET status = 'done'.*overall_feedback/),
    rowStep(/UPDATE scan_batches b SET status = CASE/),
  ]);
  assert.equal(await mock.db.completePaperGroupJob({ ...job, studentId }, paperGrade), true);
  assert.equal(mock.queries.at(-1).sql, "COMMIT");
  assert.ok(mock.queries.some((q) => /DELETE FROM grading_results WHERE batch_id/.test(q.sql)));
  mock.check();
});

test("stale paper-group lease cannot write results or settle a batch", async () => {
  const mock = loadDb([rowStep(/SELECT id FROM scan_batches .*FOR UPDATE/, [{ id: batchId }]), rowStep(/j\.job_kind = 'paper_group'.*FOR UPDATE OF j/)]);
  assert.equal(await mock.db.completePaperGroupJob({ ...job, studentId }, grade), false);
  assert.ok(!mock.queries.some((q) => /^(INSERT|UPDATE|DELETE)/.test(q.sql)));
  mock.check();
});

test("sub score edit rolls the total up to the parent question and settles review state", async () => {
  const resultId = id(50), subResultId = id(60);
  const mock = loadDb([
    recordStep(),
    rowStep(/SELECT gs\.\*, r\.needs_review AS result_needs_review/, [{ id: subResultId, result_id: resultId, max_score: "5", needs_review: true }]),
    { match: /UPDATE grading_sub_results SET final_score = \$2, reviewed = true, needs_review = false/, run: (v) => {
      assert.deepEqual(v, [subResultId, 3.5]); return [];
    } },
    rowStep(/SELECT COALESCE\(SUM\(COALESCE\(final_score, score, 0\)\), 0\) AS total/, [{ total: "7.5", pending: false }]),
    { match: /UPDATE grading_results SET score = \$2, final_score = \$2, needs_review = \$3/, run: (v) => {
      assert.deepEqual(v, [resultId, 7.5, false]); return [];
    } },
    rowStep(/UPDATE scan_batches b SET status = CASE/),
  ]);
  assert.deepEqual(await mock.db.saveDeskSubScore({ examId, studentId, subResultId, score: 3.5 }, "teacher-A"), { score: 7.5, needsReview: false });
  assert.equal(mock.queries.at(-1).sql, "COMMIT"); mock.check();
});

test("sub score above its maximum is rejected before any write", async () => {
  const mock = loadDb([recordStep(), rowStep(/SELECT gs\.\*, r\.needs_review AS result_needs_review/, [{ id: id(60), result_id: id(50), max_score: "5" }])]);
  await assert.rejects(mock.db.saveDeskSubScore({ examId, studentId, subResultId: id(60), score: 6 }, "teacher-A"), { statusCode: 400 });
  assert.equal(mock.queries.at(-1).sql, "ROLLBACK");
  assert.ok(!mock.queries.some((q) => /UPDATE grading_sub_results/.test(q.sql))); mock.check();
});

test("saving manual page regions normalizes boxes against the exam question structure", async () => {
  const questionId = id(20), subA = id(40), subB = id(41);
  const mock = loadDb([
    recordStep(),
    rowStep(/SELECT id FROM scanned_pages WHERE batch_id = \$1 AND student_id = \$2 AND page_no = \$3/, [{ id: pageId }]),
    rowStep(/FROM exam_questions q LEFT JOIN exam_sub_questions/, [{ id: questionId, question_no: "1", title: "Q1", max_score: "5", question_type: "解答", subs: [
      { id: subA, label: "(1)", maxScore: "3", ordinal: 0 }, { id: subB, label: "(2)", maxScore: "2", ordinal: 1 },
    ] }]),
    { match: /INSERT INTO student_page_regions/, run: (v) => {
      assert.equal(v[3], pageId); assert.equal(v[4], 1);
      const regions = JSON.parse(v[5]);
      assert.equal(regions.length, 1);
      assert.deepEqual(regions[0].bbox, [0.1, 0.2, 0.6, 0.4]);
      assert.deepEqual(regions[0].subs.map((sub) => sub.subId), [subA, subB]);
      assert.deepEqual(regions[0].subs[1].bbox, [0.1, 0.45, 0.6, 0.15]);
      assert.equal(JSON.parse(v[6]).method, "manual");
      assert.equal(v[7], "manual");
      return [];
    } },
  ]);
  const output = await mock.db.saveDeskRegions({ examId, studentId, pageNo: 1, regions: [{
    questionId, bbox: [0.1, 0.2, 0.6, 0.4],
    subs: [{ subId: subA, bbox: [0.1, 0.2, 0.6, 0.2] }, { subId: subB, bbox: [0.1, 0.45, 0.6, 0.15] }],
  }] }, "teacher-A");
  assert.deepEqual(output, { count: 1 });
  assert.ok(!mock.queries.some((q) => /^(BEGIN|COMMIT)/.test(q.sql))); mock.check();
});

test("regrading one question enqueues a fresh paper-group job scoped to that question", async () => {
  const questionId = id(20);
  const mock = loadDb([
    recordStep(record({ grading_started_at: new Date() })),
    rowStep(/SELECT id FROM exam_questions WHERE id = \$1 AND exam_id = \$2/, [{ id: questionId }]),
    rowStep(/SELECT COALESCE\(MAX\(task_no\), 0\) \+ 1 AS next/, [{ next: 3 }]),
    rowStep(/SELECT p\.id, r\.regions FROM scanned_pages p/, [{ id: pageId, regions: [{ questionId, bbox: [0.1, 0.2, 0.6, 0.4] }] }]),
    { match: /INSERT INTO grading_jobs/, run: (v) => {
      assert.equal(v[3], 3);
      assert.deepEqual(JSON.parse(v[4]), [pageId]);
      assert.deepEqual(JSON.parse(v[5]), [questionId]);
      return [];
    } },
    rowStep(/UPDATE scan_batches SET status = 'grading' WHERE id = \$1/),
  ]);
  assert.deepEqual(await mock.db.regradeDeskQuestion({ examId, studentId, questionId }, "teacher-A"), {});
  assert.equal(mock.queries.at(-1).sql, "COMMIT"); mock.check();
});

test("preflight on a batch without pages reports an empty summary and releases the client", async () => {
  const mock = loadDb([
    recordStep(),
    rowStep(/FROM exam_questions q LEFT JOIN exam_sub_questions/, []),
    rowStep(/FROM scanned_pages WHERE batch_id = \$1 ORDER BY capture_order, page_no/, []),
    rowStep(/SELECT \* FROM page_layout_templates/, []),
    rowStep(/FROM scanned_pages p LEFT JOIN student_page_regions r/, []),
  ]);
  assert.deepEqual(await mock.db.preflightDeskBatch({ examId }, "teacher-A", async () => null),
    { pageNumbers: [], built: [], invalid: 0, check: 0, pages: [] });
  assert.equal(mock.released, 1); mock.check();
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
