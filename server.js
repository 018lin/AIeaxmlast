const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const db = require("./db");

const ROOT_DIR = __dirname;

loadEnvFile(path.join(ROOT_DIR, ".env"));

const PORT = Number(process.env.PORT || 8080);
const DEEPSEEK_ENDPOINT = process.env.DEEPSEEK_ENDPOINT || "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-flash";
const MAX_BODY_BYTES = 25 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  lines.forEach((line) => {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendServiceError(response, error) {
  const isDatabaseConfigError = error.message && (error.message.includes("DATABASE_URL") || error.message.includes("POSTGRES_URL"));
  sendJson(response, isDatabaseConfigError ? 503 : 500, {
    message: isDatabaseConfigError ? "服务端未配置数据库连接。" : "数据库服务暂时不可用。",
  });
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求内容过大，请压缩图片后重试。"));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function stripJsonFence(content) {
  return String(content || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function parseAiResult(content) {
  try {
    return JSON.parse(stripJsonFence(content));
  } catch {
    return null;
  }
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

async function handleAiGrade(request, response) {
  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    sendJson(response, 500, { message: "服务端未配置 DeepSeek API Key。" });
    return;
  }

  let payload;

  try {
    payload = JSON.parse(await readRequestBody(request));
  } catch (error) {
    sendJson(response, 400, { message: error.message || "请求数据格式不正确。" });
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

    const rawContent = deepseekPayload?.choices?.[0]?.message?.content || "";
    const result = parseAiResult(rawContent);
    let history = null;
    let historyError = "";

    try {
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
}

async function readJsonPayload(request) {
  return JSON.parse(await readRequestBody(request));
}

async function handleCreateUpload(request, response) {
  let payload;

  try {
    payload = await readJsonPayload(request);
  } catch (error) {
    sendJson(response, 400, { message: error.message || "请求数据格式不正确。" });
    return;
  }

  if (!payload.kind || !payload.image) {
    sendJson(response, 400, { message: "请提供图片类型和图片内容。" });
    return;
  }

  try {
    const upload = await db.createUpload({
      kind: payload.kind,
      name: payload.name,
      image: payload.image,
    });
    sendJson(response, 201, { upload });
  } catch (error) {
    if (error.message && error.message.includes("图片")) {
      sendJson(response, 400, { message: error.message });
      return;
    }

    sendServiceError(response, error);
  }
}

async function handleListUploads(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const kind = requestUrl.searchParams.get("kind") || "";

  try {
    const uploads = await db.listUploads(kind);
    sendJson(response, 200, { uploads });
  } catch (error) {
    sendServiceError(response, error);
  }
}

async function handleDeleteUploads(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const kind = requestUrl.searchParams.get("kind") || "";

  try {
    await db.deleteUploads(kind);
    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendServiceError(response, error);
  }
}

async function handleCreatePair(request, response) {
  let payload;

  try {
    payload = await readJsonPayload(request);
  } catch (error) {
    sendJson(response, 400, { message: error.message || "请求数据格式不正确。" });
    return;
  }

  if (!payload.paperCrop || !payload.answerCrop) {
    sendJson(response, 400, { message: "请提供题目区域和答案区域裁剪图片。" });
    return;
  }

  try {
    const pair = await db.createPair(payload);
    sendJson(response, 201, { pair });
  } catch (error) {
    if (error.message && error.message.includes("图片")) {
      sendJson(response, 400, { message: error.message });
      return;
    }

    sendServiceError(response, error);
  }
}

async function handleListPairs(request, response) {
  try {
    const pairs = await db.listPairs();
    sendJson(response, 200, { pairs });
  } catch (error) {
    sendServiceError(response, error);
  }
}

async function handleListAiGradeHistory(request, response) {
  try {
    const history = await db.listAiGradingHistory();
    sendJson(response, 200, { history });
  } catch (error) {
    sendServiceError(response, error);
  }
}

async function handleDeleteAiGradeHistory(request, response) {
  try {
    await db.deleteAiGradingHistory();
    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendServiceError(response, error);
  }
}

function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(ROOT_DIR, `.${normalizedPath}`);

  if (filePath !== ROOT_DIR && !filePath.startsWith(`${ROOT_DIR}${path.sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

const server = http.createServer((request, response) => {
  if (request.method === "POST" && request.url?.startsWith("/api/ai-grade")) {
    handleAiGrade(request, response);
    return;
  }

  if (request.method === "GET" && request.url?.startsWith("/api/ai-grade-history")) {
    handleListAiGradeHistory(request, response);
    return;
  }

  if (request.method === "DELETE" && request.url?.startsWith("/api/ai-grade-history")) {
    handleDeleteAiGradeHistory(request, response);
    return;
  }

  if (request.method === "GET" && request.url?.startsWith("/api/uploads")) {
    handleListUploads(request, response);
    return;
  }

  if (request.method === "POST" && request.url?.startsWith("/api/uploads")) {
    handleCreateUpload(request, response);
    return;
  }

  if (request.method === "DELETE" && request.url?.startsWith("/api/uploads")) {
    handleDeleteUploads(request, response);
    return;
  }

  if (request.method === "GET" && request.url?.startsWith("/api/pairs")) {
    handleListPairs(request, response);
    return;
  }

  if (request.method === "POST" && request.url?.startsWith("/api/pairs")) {
    handleCreatePair(request, response);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { message: "Method not allowed" });
    return;
  }

  serveStatic(request, response);
});

db.initDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`AI grading server running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  });
