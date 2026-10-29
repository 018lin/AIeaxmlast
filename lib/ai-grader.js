const DEEPSEEK_ENDPOINT = process.env.DEEPSEEK_ENDPOINT || "https://api.deepseek.com/chat/completions";
const DEEPSEEK_VISION_MODEL = "deepseek-v4-flash-vision-exp";

function getDeepseekModel() {
  return process.env.DEEPSEEK_MODEL === "deepseek-flash"
    ? DEEPSEEK_VISION_MODEL
    : process.env.DEEPSEEK_MODEL || DEEPSEEK_VISION_MODEL;
}

function getTimeoutMs() {
  return Number(process.env.DEEPSEEK_TIMEOUT_MS || 55000);
}

function stripJsonFence(content) {
  return String(content || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
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

function parseAiResult(content) {
  try {
    return JSON.parse(extractJsonContent(content));
  } catch {
    return null;
  }
}

function getAssistantContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === "string" && content.trim()) {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => item?.text || item?.content || "")
      .filter(Boolean)
      .join("\n");
  }

  const reasoningContent = payload?.choices?.[0]?.message?.reasoning_content;

  if (typeof reasoningContent === "string" && reasoningContent.trim()) {
    return reasoningContent;
  }

  return "";
}

function buildGradePrompt(payload) {
  const maxScore = Number(payload.maxScore);
  const rubric = String(payload.rubric || "").trim();
  const knowledgePoints = Array.isArray(payload.knowledgePoints) && payload.knowledgePoints.length
    ? payload.knowledgePoints.join("、")
    : "未标注";

  return [
    "你是一名严格但公正的教师，请根据题目图片、学生作答图片、满分和评分标准进行阅卷。",
    `考试：${payload.examName || "未命名考试"}`,
    `题号：${payload.questionNo || payload.questionName || "未命名题目"}`,
    `题目说明：${payload.questionTitle || "无"}`,
    `作答文件：${payload.answerName || "未命名作答"}`,
    `满分：${maxScore}`,
    `知识点：${knowledgePoints}`,
    `评分标准与备注：${rubric || "无额外备注，请按常规评分标准判断。"}`,
    "请只返回 JSON，不要添加 Markdown。",
    "JSON 字段必须为：score(number), max_score(number), level(string), analysis(string), deductions(string[]), suggestions(string[])。",
    "score 必须在 0 到满分之间。如果图片内容不清晰，请在 analysis 中说明，并给出谨慎评分。",
    "analysis 控制在 80 字以内；deductions 和 suggestions 各最多 3 条，每条控制在 40 字以内。",
  ].join("\n");
}

function buildBatchAnalysisPrompt(payload, questions) {
  const lines = [
    "你是一名教研员。请根据本次作业的题目、知识点、学生错误作答图片以及每题已有的 AI 批改文字，归纳本次作业的学情。",
    `作业名称：${payload.examName || "未命名作业"}`,
    `科目：${payload.subject || "未填写"}`,
    "下面是各题的统计和错误学生信息：",
  ];

  questions.forEach((question) => {
    lines.push(
      `\n题号：${question.questionNo}｜题型：${question.questionType || "未标注"}｜知识点：${(question.knowledgePoints || []).join("、") || "未标注"}｜满分：${question.maxScore}｜错误人数：${question.wrongCount}`
    );

    question.wrongAnswers.forEach((wrong) => {
      const detail = [
        `学生：${wrong.studentName}`,
        `得分：${wrong.score}/${wrong.maxScore}`,
        wrong.analysis ? `AI批改分析：${wrong.analysis}` : "",
        wrong.deductions && wrong.deductions.length ? `扣分点：${wrong.deductions.join("；")}` : "",
      ]
        .filter(Boolean)
        .join("｜");
      lines.push(`- ${detail}`);
    });
  });

  lines.push(
    "\n请只返回 JSON，不要添加 Markdown。JSON 字段必须为：",
    "overview(string，本次作业整体情况，100 字以内)，",
    "questions(array，每项 {questionNo(string), errorCauses(string[]，最多 3 条，分析学生为什么错), relatedKnowledgePoints(string[]), suggestions(string[]，最多 2 条)}),",
    "knowledgeGaps(array，每项 {knowledgePoint(string), reason(string，50 字以内), suggestion(string，50 字以内)}),",
    "teachingSuggestions(string[]，最多 4 条，面向教师下一步教学)。",
    "错因要结合学生作答图片和文字分析，避免空泛；如果图片不清晰，要明确说明。",
  );

  return lines.join("\n");
}

async function analyzeBatchErrors(payload) {
  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    const error = new Error("服务端未配置 DeepSeek API Key。");
    error.statusCode = 500;
    throw error;
  }

  const questions = Array.isArray(payload.questions) ? payload.questions : [];

  if (!questions.length) {
    const error = new Error("本次作业没有可分析的错误作答。");
    error.statusCode = 400;
    throw error;
  }

  const model = getDeepseekModel();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getTimeoutMs());
  const content = [
    { type: "text", text: buildBatchAnalysisPrompt(payload, questions) },
  ];

  questions.forEach((question) => {
    question.wrongAnswers.forEach((wrong) => {
      if (!wrong.image) {
        return;
      }

      content.push({
        type: "text",
        text: `【${question.questionNo} ${wrong.studentName} 的作答，得分 ${wrong.score}/${wrong.maxScore}】`,
      });
      content.push({ type: "image_url", image_url: { url: wrong.image } });
    });
  });

  try {
    const deepseekResponse = await fetch(DEEPSEEK_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        temperature: 0.2,
        max_tokens: 2200,
      }),
      signal: controller.signal,
    });

    const deepseekPayload = await deepseekResponse.json().catch(() => ({}));

    if (!deepseekResponse.ok) {
      const error = new Error(
        deepseekPayload?.error?.message || deepseekPayload?.message || "DeepSeek 学情分析请求失败。"
      );
      error.statusCode = deepseekResponse.status;
      throw error;
    }

    const rawContent = getAssistantContent(deepseekPayload);
    const result = parseAiResult(rawContent);

    if (!rawContent.trim() || !result) {
      const error = new Error("AI 没有返回有效的学情分析结果，请稍后重试。");
      error.statusCode = 502;
      throw error;
    }

    return { model, rawContent, result };
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("AI 学情分析超时，请稍后重试。");
      timeoutError.statusCode = 504;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function gradeImages(payload) {
  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    const error = new Error("服务端未配置 DeepSeek API Key。");
    error.statusCode = 500;
    throw error;
  }

  const maxScore = Number(payload.maxScore);

  if (!payload.questionImage || !payload.answerImage) {
    const error = new Error("请提供题目图片和学生作答图片。");
    error.statusCode = 400;
    throw error;
  }

  if (!Number.isFinite(maxScore) || maxScore <= 0) {
    const error = new Error("满分必须大于 0。");
    error.statusCode = 400;
    throw error;
  }

  const model = getDeepseekModel();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getTimeoutMs());

  try {
    const deepseekResponse = await fetch(DEEPSEEK_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: buildGradePrompt(payload) },
              { type: "image_url", image_url: { url: payload.questionImage } },
              { type: "image_url", image_url: { url: payload.answerImage } },
            ],
          },
        ],
        temperature: 0.2,
        max_tokens: 700,
      }),
      signal: controller.signal,
    });

    const deepseekPayload = await deepseekResponse.json().catch(() => ({}));

    if (!deepseekResponse.ok) {
      const error = new Error(deepseekPayload?.error?.message || deepseekPayload?.message || "DeepSeek 阅卷请求失败。");
      error.statusCode = deepseekResponse.status;
      throw error;
    }

    const rawContent = getAssistantContent(deepseekPayload);

    if (!rawContent.trim()) {
      const error = new Error(`AI 没有返回评分内容。当前模型为 ${model}，请确认服务端使用支持图片输入的 DeepSeek 视觉模型。`);
      error.statusCode = 502;
      throw error;
    }

    return {
      model,
      rawContent,
      result: parseAiResult(rawContent),
    };
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("AI 阅卷超时，请稍后重试。");
      timeoutError.statusCode = 504;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  analyzeBatchErrors,
  gradeImages,
  parseAiResult,
};
