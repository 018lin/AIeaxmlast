const { gradeImages } = require("./ai-grader");

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

async function handleGet(db, request, response, query) {
  const action = getAction(request, query);

  if (action === "bootstrap") {
    const [classes, students, exams, batches] = await Promise.all([
      db.listClasses(),
      db.listStudents(),
      db.listExams(),
      db.listScanBatches(),
    ]);
    sendJson(response, 200, { classes, students, exams, batches });
    return;
  }

  if (action === "students") {
    const students = await db.listStudents(getQueryValue(request, query, "classId"));
    sendJson(response, 200, { students });
    return;
  }

  if (action === "questions") {
    const questions = await db.listExamQuestions(getQueryValue(request, query, "examId"));
    sendJson(response, 200, { questions });
    return;
  }

  if (action === "templates") {
    const templates = await db.listPaperTemplates(getQueryValue(request, query, "examId"));
    sendJson(response, 200, { templates });
    return;
  }

  if (action === "regions") {
    const regions = await db.listTemplateRegions(getQueryValue(request, query, "templateId"));
    sendJson(response, 200, { regions });
    return;
  }

  if (action === "batches") {
    const batches = await db.listScanBatches(getQueryValue(request, query, "examId"));
    sendJson(response, 200, { batches });
    return;
  }

  if (action === "pages") {
    const pages = await db.listScannedPages(getQueryValue(request, query, "batchId"));
    sendJson(response, 200, { pages });
    return;
  }

  if (action === "results") {
    const results = await db.getBatchResults(getQueryValue(request, query, "batchId"));
    sendJson(response, 200, results);
    return;
  }

  sendJson(response, 400, { message: "未知的 MVP 查询动作。" });
}

async function handlePost(db, readJsonBody, request, response, query) {
  const action = getAction(request, query);
  const payload = await readJsonBody(request);

  if (action === "create-class") {
    sendJson(response, 201, { classItem: await db.createClass(payload) });
    return;
  }

  if (action === "create-student") {
    sendJson(response, 201, { student: await db.createStudent(payload) });
    return;
  }

  if (action === "create-exam") {
    sendJson(response, 201, { exam: await db.createExam(payload) });
    return;
  }

  if (action === "create-question") {
    sendJson(response, 201, { question: await db.createExamQuestion(payload) });
    return;
  }

  if (action === "create-template") {
    sendJson(response, 201, { template: await db.createPaperTemplate(payload) });
    return;
  }

  if (action === "save-region") {
    sendJson(response, 201, { region: await db.saveTemplateRegion(payload) });
    return;
  }

  if (action === "create-batch") {
    sendJson(response, 201, { batch: await db.createScanBatch(payload) });
    return;
  }

  if (action === "upload-page") {
    sendJson(response, 201, { page: await db.createScannedPage(payload) });
    return;
  }

  if (action === "process-batch") {
    sendJson(response, 200, await db.processScanBatch(payload.batchId));
    return;
  }

  if (action === "grade-next") {
    const batchId = payload.batchId;
    const jobId = await db.claimNextGradingJob(batchId);

    if (!jobId) {
      sendJson(response, 200, {
        done: true,
        results: await db.getBatchResults(batchId),
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
      });
    } catch (error) {
      await db.failGradingJob(jobId, error.message);
      sendJson(response, 200, {
        done: false,
        failed: true,
        message: error.message || "评分失败。",
        results: await db.getBatchResults(batchId),
      });
    }
    return;
  }

  sendJson(response, 400, { message: "未知的 MVP 提交动作。" });
}

async function handleMvpRequest({ db, ensureDatabase, readJsonBody, request, response, query }) {
  try {
    await ensureDatabase();

    if (request.method === "GET") {
      await handleGet(db, request, response, query);
      return;
    }

    if (request.method === "POST") {
      await handlePost(db, readJsonBody, request, response, query);
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
