const { db, ensureDatabase, readJsonBody, sendJson } = require("../lib/api-shared");

const DEEPSEEK_ENDPOINT = process.env.DEEPSEEK_ENDPOINT || "https://api.deepseek.com/chat/completions";
const DEEPSEEK_VISION_MODEL = "deepseek-v4-flash-vision-exp";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL === "deepseek-flash" ? DEEPSEEK_VISION_MODEL : process.env.DEEPSEEK_MODEL || DEEPSEEK_VISION_MODEL;

function stripJsonFence(content) {
  return String(content || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function parseAiResult(content) {
  try {
    return JSON.parse(extractJsonContent(content));
  } catch {
    return null;
  }
}

function extractJsonContent(content) {
  const normalized = stripJsonFence(content);
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");

  if (start !== -1 && end > start) {
    return normalized.slice(start, end + 1);
  }

  return normalized;
}

function getAssistantContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => item?.text || item?.content || "")
      .filter(Boolean)
      .join("\n");
  }

  return payload?.choices?.[0]?.message?.reasoning_content || "";
}

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

  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    sendJson(response, 500, { message: "服务端未配置 DeepSeek API Key。" });
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
  const prompt = [
    "你是一名严格但公正的教师，请根据题目图片、学生作答图片、满分和评分标准进行阅卷。",
    `题目文件：${payload.questionName || "未命名题目"}`,
    `作答文件：${payload.answerName || "未命名作答"}`,
    `满分：${maxScore}`,
    `评分标准与备注：${rubric || "无额外备注，请按常规评分标准判断。"}`,
    "请只返回 JSON，不要添加 Markdown。",
    "JSON 字段必须为：score(number), max_score(number), level(string), analysis(string), deductions(string[]), suggestions(string[])。",
    "score 必须在 0 到满分之间。如果图片内容不清晰，请在 analysis 中说明，并给出谨慎评分。",
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const deepseekResponse = await fetch(DEEPSEEK_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: payload.questionImage } },
              { type: "image_url", image_url: { url: payload.answerImage } },
            ],
          },
        ],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    const deepseekPayload = await deepseekResponse.json().catch(() => ({}));

    if (!deepseekResponse.ok) {
      sendJson(response, deepseekResponse.status, {
        message: deepseekPayload?.error?.message || deepseekPayload?.message || "DeepSeek 阅卷请求失败。",
      });
      return;
    }

    const rawContent = getAssistantContent(deepseekPayload);

    if (!rawContent.trim()) {
      sendJson(response, 502, {
        message: `AI 没有返回评分内容。当前模型为 ${DEEPSEEK_MODEL}，请确认服务端使用支持图片输入的 DeepSeek 视觉模型。`,
      });
      return;
    }

    const result = parseAiResult(rawContent);
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
        model: DEEPSEEK_MODEL,
        result,
        rawContent,
      });
    } catch (error) {
      historyError = error.message || "AI 阅卷历史保存失败。";
    }

    sendJson(response, 200, {
      model: DEEPSEEK_MODEL,
      result,
      rawContent,
      history,
      historyError,
    });
  } catch (error) {
    const isTimeout = error.name === "AbortError";
    sendJson(response, isTimeout ? 504 : 500, {
      message: isTimeout ? "AI 阅卷超时，请稍后重试。" : "AI 阅卷服务暂时不可用。",
    });
  } finally {
    clearTimeout(timeout);
  }
};
