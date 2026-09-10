const { db, ensureDatabase, readJsonBody, sendJson } = require("../lib/api-shared");
const { gradeImages } = require("../lib/ai-grader");

function validateGradeRequest(payload) {
  const maxScore = Number(payload.maxScore);

  if (!payload.questionImage || !payload.answerImage) {
    return "请上传题目图片和学生作答图片。";
  }

  if (!Number.isFinite(maxScore) || maxScore <= 0) {
    return "满分必须大于 0。";
  }

  if (!String(payload.questionImage).startsWith("data:image/") || !String(payload.answerImage).startsWith("data:image/")) {
    return "图片格式不正确，请上传 PNG、JPG 或 JPEG 图片。";
  }

  return "";
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { message: "Method not allowed" });
    return;
  }

  let payload;

  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { message: "请求数据格式不正确。" });
    return;
  }

  const validationMessage = validateGradeRequest(payload);

  if (validationMessage) {
    sendJson(response, 400, { message: validationMessage });
    return;
  }

  const maxScore = Number(payload.maxScore);
  const rubric = String(payload.rubric || "").trim();

  try {
    const grade = await gradeImages({
      questionImage: payload.questionImage,
      questionName: payload.questionName,
      answerImage: payload.answerImage,
      answerName: payload.answerName,
      maxScore,
      rubric,
    });
    let history = null;
    let historyError = "";

    try {
      await ensureDatabase();
      history = await db.createAiGradingHistory({
        questionImageId: payload.questionImageId,
        answerImageId: payload.answerImageId,
        questionKind: payload.questionKind,
        questionImage: payload.questionImage,
        questionName: payload.questionName,
        answerImage: payload.answerImage,
        answerName: payload.answerName,
        maxScore,
        rubric,
        model: grade.model,
        result: grade.result,
        rawContent: grade.rawContent,
      });
    } catch (error) {
      historyError = error.message || "AI 阅卷历史保存失败。";
    }

    sendJson(response, 200, {
      model: grade.model,
      result: grade.result,
      rawContent: grade.rawContent,
      history,
      historyError,
    });
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      message: error.message || "AI 阅卷服务暂时不可用。",
    });
  }
};
