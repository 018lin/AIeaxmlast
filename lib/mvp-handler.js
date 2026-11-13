const { analyzeBatchErrors, gradeImages, gradeWholePaper, recognizeAnswerQuestions } = require("./ai-grader");
const { getRequestAccount } = require("./auth");

function sendJson(response, statusCode, payload) {
  if (typeof response.writeHead === "function") {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
    return;
  }

  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function getAction(request, query) {
  if (query?.action) {
    return query.action;
  }

  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  return requestUrl.searchParams.get("action") || "";
}

function getQueryValue(request, query, key) {
  if (query && Object.prototype.hasOwnProperty.call(query, key)) {
    return query[key];
  }

  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  return requestUrl.searchParams.get(key) || "";
}

async function handleGet(db, request, response, query, account) {
  const action = getAction(request, query);

  if (action === "desk-list") {
    sendJson(response, 200, await db.listDeskAssignments(account));
    return;
  }
  if (action === "desk-detail") {
    sendJson(response, 200, await db.getDeskDetail(getQueryValue(request, query, "examId"), account));
    return;
  }
  if (action === "desk-image") {
    sendJson(response, 200, await db.getDeskImage(getQueryValue(request, query, "examId"), getQueryValue(request, query, "studentId"), account, getQueryValue(request, query, "thumbnail") === "1"));
    return;
  }

  if (action === "bootstrap") {
    const [classes, students, exams, batches] = await Promise.all([
      db.listClasses(account),
      db.listStudents(undefined, account),
      db.listExams(account),
      db.listScanBatches(undefined, account),
    ]);
    sendJson(response, 200, { classes, students, exams, batches });
    return;
  }

  if (action === "students") {
    const classId = getQueryValue(request, query, "classId");

    if (classId) {
      await db.assertClassOwnership(classId, account);
    }

    const students = await db.listStudents(classId, account);
    sendJson(response, 200, { students });
    return;
  }

  if (action === "exam-progress") {
    const progress = await db.listExamProgress(account);
    sendJson(response, 200, { progress });
    return;
  }

  if (action === "questions") {
    const examId = getQueryValue(request, query, "examId");
    await db.assertExamOwnership(examId, account);
    const questions = await db.listExamQuestions(examId);
    sendJson(response, 200, { questions });
    return;
  }

  if (action === "templates") {
    const examId = getQueryValue(request, query, "examId");
    await db.assertExamOwnership(examId, account);
    const templates = await db.listPaperTemplates(examId);
    sendJson(response, 200, { templates });
    return;
  }

  if (action === "regions") {
    const templateId = getQueryValue(request, query, "templateId");
    await db.assertTemplateOwnership(templateId, account);
    const regions = await db.listTemplateRegions(templateId);
    sendJson(response, 200, { regions });
    return;
  }

  if (action === "batches") {
    const examId = getQueryValue(request, query, "examId");

    if (examId) {
      await db.assertExamOwnership(examId, account);
    }

    const batches = await db.listScanBatches(examId, account);
    sendJson(response, 200, { batches });
    return;
  }

  if (action === "pages") {
    const batchId = getQueryValue(request, query, "batchId");
    await db.assertBatchOwnership(batchId, account);
    const pages = await db.listScannedPages(batchId);
    sendJson(response, 200, { pages });
    return;
  }

  if (action === "results") {
    const batchId = getQueryValue(request, query, "batchId");
    await db.assertBatchOwnership(batchId, account);
    const results = await db.getBatchResults(batchId);
    sendJson(response, 200, results);
    return;
  }

  if (action === "assignment-overview") {
    const examId = getQueryValue(request, query, "examId");
    await db.assertExamOwnership(examId, account);
    const overview = await db.getAssignmentOverview(examId);
    sendJson(response, 200, overview);
    return;
  }

  if (action === "student-submission") {
    const batchId = getQueryValue(request, query, "batchId");
    const studentId = getQueryValue(request, query, "studentId");
    await db.assertBatchOwnership(batchId, account);
    await db.assertStudentOwnership(studentId, account);
    const submission = await db.getStudentSubmission(
      batchId,
      studentId,
      getQueryValue(request, query, "includeImages") === "1"
    );
    sendJson(response, 200, submission);
    return;
  }

  if (action === "batch-analysis") {
    const batchId = getQueryValue(request, query, "batchId");
    await db.assertBatchOwnership(batchId, account);
    const analysis = await db.getBatchAnalysis(batchId);
    sendJson(response, 200, analysis);
    return;
  }

  if (action === "student-history") {
    const studentId = getQueryValue(request, query, "studentId");
    await db.assertStudentOwnership(studentId, account);
    const analysis = await db.getStudentHistoryAnalysis(studentId);
    sendJson(response, 200, analysis);
    return;
  }

  if (action === "class-history") {
    const classId = getQueryValue(request, query, "classId");
    await db.assertClassOwnership(classId, account);
    const analysis = await db.getClassHistoryAnalysis(classId);
    sendJson(response, 200, analysis);
    return;
  }

  sendJson(response, 400, { message: "未知的 MVP 查询动作。" });
}

async function handlePost(db, readJsonBody, request, response, query, account, workerAvailable) {
  const action = getAction(request, query);
  let payload;
  try {
    payload = await readJsonBody(request);
  } catch {
    sendJson(response, 400, { message: "请求数据必须为有效 JSON。" });
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    sendJson(response, 400, { message: "请求数据必须为 JSON 对象。" });
    return;
  }
  if (action === "desk-create") {
    sendJson(response, 201, await db.createDeskExam(payload, account, recognizeAnswerQuestions));
    return;
  }
  const deskActions = {
    "desk-capture": "captureDeskPage", "desk-confirm": "confirmDeskPages", "desk-start": "startDeskGrading",
    "desk-retry": "retryDeskGrading", "desk-questions": "updateDeskQuestions",
  };
  if (Object.prototype.hasOwnProperty.call(deskActions, action)) {
    if ((action === "desk-start" || action === "desk-retry") && !(await workerAvailable())) {
      sendJson(response, 503, { message: "后台批改工作进程不可用。请在持久 Node 服务启动工作进程；无服务器环境不支持开始或重试批改。" });
      return;
    }
    sendJson(response, 200, await db[deskActions[action]](payload, account));
    return;
  }

  // Managed desk exams are immutable to ALL legacy grading/template/upload routes.
  await db.assertLegacyMutationAllowed(action, payload, account);

  if (action === "create-class") {
    sendJson(response, 201, { classItem: await db.createClass(payload, account) });
    return;
  }

  if (action === "create-student") {
    sendJson(response, 201, { student: await db.createStudent(payload, account) });
    return;
  }

  if (action === "import-students") {
    sendJson(response, 201, await db.importStudents(payload, account));
    return;
  }

  if (action === "create-exam") {
    await db.assertClassOwnership(payload.classId, account);
    sendJson(response, 201, { exam: await db.createExam(payload, account) });
    return;
  }

  if (action === "create-question") {
    await db.assertExamOwnership(payload.examId, account);
    sendJson(response, 201, { question: await db.createExamQuestion(payload) });
    return;
  }

  if (action === "create-template") {
    await db.assertExamOwnership(payload.examId, account);
    sendJson(response, 201, { template: await db.createPaperTemplate(payload) });
    return;
  }

  if (action === "save-region") {
    await db.assertTemplateOwnership(payload.templateId, account);
    await db.assertQuestionOwnership(payload.questionId, account);
    sendJson(response, 201, { region: await db.saveTemplateRegion(payload) });
    return;
  }

  if (action === "create-batch") {
    await db.assertExamOwnership(payload.examId, account);
    sendJson(response, 201, { batch: await db.createScanBatch(payload) });
    return;
  }

  if (action === "upload-page") {
    await db.assertBatchOwnership(payload.batchId, account);
    await db.assertStudentOwnership(payload.studentId, account);
    sendJson(response, 201, { page: await db.createScannedPage(payload) });
    return;
  }

  if (action === "process-batch") {
    await db.assertBatchOwnership(payload.batchId, account);
    sendJson(response, 200, await db.processScanBatch(payload.batchId));
    return;
  }

  if (action === "grade-student") {
    const examId = payload.examId;
    const studentId = payload.studentId;

    if (!examId || !studentId) {
      sendJson(response, 400, { message: "请选择作业和学生。" });
      return;
    }

    await db.assertExamOwnership(examId, account);
    await db.assertStudentOwnership(studentId, account);

    const batch = await db.getOrCreateExamBatch(examId);
    await db.replaceStudentSubmission(batch.id, studentId, payload);

    if (!(await db.examHasTemplateRegions(examId))) {
      const page = await db.getStudentPageImage(batch.id, studentId);

      if (!page) {
        sendJson(response, 400, { message: "请先上传学生作业图片。" });
        return;
      }

      const [knowledgePoints, expectedQuestions] = await Promise.all([
        db.getExamKnowledgePoints(examId),
        db.listExamQuestions(examId),
      ]);
      const grade = await gradeWholePaper({
        examName: batch.examName || "",
        knowledgePoints,
        expectedQuestions,
        answerImage: page.image,
        answerName: payload.name || "",
      });
      const saved = await db.saveWholePaperResults({
        batchId: batch.id,
        examId,
        studentId,
        gradeResult: grade.result,
        rawContent: grade.rawContent,
      });
      sendJson(response, 200, { batchId: batch.id, wholePaper: true, jobCount: saved.count });
      return;
    }

    const processed = await db.processStudentSubmission(batch.id, studentId);
    sendJson(response, 200, { batchId: batch.id, ...processed });
    return;
  }

  if (action === "analyze-batch") {
    const batchId = payload.batchId;

    if (!batchId) {
      sendJson(response, 400, { message: "请选择作业批次。" });
      return;
    }

    await db.assertBatchOwnership(batchId, account);

    const aiPayload = await db.getBatchAnalysisAiPayload(batchId);

    if (!aiPayload.questions.length) {
      sendJson(response, 400, { message: "本次作业还没有错误作答，暂时无法生成错因分析。" });
      return;
    }

    const grade = await analyzeBatchErrors({
      examName: aiPayload.analysis.exam.name,
      subject: aiPayload.analysis.exam.subject,
      batchName: aiPayload.analysis.batch.name,
      questions: aiPayload.questions,
    });
    const saved = await db.saveBatchAnalysis(batchId, grade.result, grade.model);
    sendJson(response, 200, {
      analysis: grade.result,
      model: grade.model,
      savedAt: saved.created_at,
    });
    return;
  }

  if (action === "grade-next") {
    const batchId = payload.batchId;
    const studentId = payload.studentId || "";

    if (!batchId) {
      sendJson(response, 400, { message: "请选择作业批次。" });
      return;
    }

    await db.assertBatchOwnership(batchId, account);

    if (studentId) {
      await db.assertStudentOwnership(studentId, account);
    }

    const jobId = await db.claimNextGradingJob(batchId, studentId || undefined);

    if (!jobId) {
      sendJson(response, 200, {
        done: true,
        results: await db.getBatchResults(batchId),
        studentProgress: studentId ? await db.getStudentGradingProgress(batchId, studentId) : null,
      });
      return;
    }

    try {
      const jobPayload = await db.getGradingJobPayload(jobId);
      const grade = await gradeImages({
        examName: jobPayload.examName,
        questionNo: jobPayload.questionNo,
        questionTitle: jobPayload.questionTitle,
        questionImage: jobPayload.questionImage,
        answerImage: jobPayload.answerImage,
        answerName: jobPayload.answerName,
        maxScore: jobPayload.maxScore,
        rubric: jobPayload.rubric,
        knowledgePoints: jobPayload.knowledgePoints,
      });
      await db.completeGradingJob(jobPayload, grade);
      sendJson(response, 200, {
        done: false,
        job: {
          id: jobPayload.jobId,
          studentName: jobPayload.studentName,
          questionNo: jobPayload.questionNo,
          score: grade.result?.score ?? null,
          maxScore: jobPayload.maxScore,
        },
        results: await db.getBatchResults(batchId),
        studentProgress: studentId ? await db.getStudentGradingProgress(batchId, studentId) : null,
      });
    } catch (error) {
      await db.failGradingJob(jobId, error.message);
      sendJson(response, 200, {
        done: false,
        failed: true,
        message: error.message || "评分失败。",
        results: await db.getBatchResults(batchId),
        studentProgress: studentId ? await db.getStudentGradingProgress(batchId, studentId) : null,
      });
    }
    return;
  }

  sendJson(response, 400, { message: "未知的 MVP 提交动作。" });
}

async function handleMvpRequest({ db, ensureDatabase, readJsonBody, request, response, query, workerAvailable = () => false }) {
  try {
    const account = getRequestAccount(request);

    if (!account) {
      sendJson(response, 401, { message: "登录已过期，请重新登录。" });
      return;
    }

    await ensureDatabase();

    if (request.method === "GET") {
      await handleGet(db, request, response, query, account);
      return;
    }

    if (request.method === "POST") {
      await handlePost(db, readJsonBody, request, response, query, account, workerAvailable);
      return;
    }

    sendJson(response, 405, { message: "Method not allowed" });
  } catch (error) {
    const message = error.message || "MVP 接口请求失败。";
    const isDatabaseConfigError = message.includes("DATABASE_URL") || message.includes("POSTGRES_URL");

    sendJson(response, isDatabaseConfigError ? 503 : error.statusCode || 500, {
      message: isDatabaseConfigError ? "服务端未配置数据库连接。" : message,
    });
  }
}

module.exports = {
  handleMvpRequest,
};
