const db = require("../db");

let initPromise;

function ensureDatabase() {
  if (!initPromise) {
    initPromise = db.initDatabase();
  }

  return initPromise;
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function getDatabaseErrorPayload(error) {
  const message = error.message || "";
  const isConfigError = message.includes("DATABASE_URL") || message.includes("POSTGRES_URL");

  return {
    statusCode: isConfigError ? 503 : 500,
    payload: {
      message: isConfigError ? "服务端未配置数据库连接。" : "数据库服务暂时不可用。",
    },
  };
}

function sendDatabaseError(response, error) {
  const { statusCode, payload } = getDatabaseErrorPayload(error);
  sendJson(response, statusCode, payload);
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === "object") {
    return request.body;
  }

  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

module.exports = {
  db,
  ensureDatabase,
  readJsonBody,
  sendDatabaseError,
  sendJson,
};
