const { db, ensureDatabase, readJsonBody, sendDatabaseError, sendJson } = require("../lib/api-shared");

module.exports = async function handler(request, response) {
  try {
    await ensureDatabase();
  } catch (error) {
    sendDatabaseError(response, error);
    return;
  }

  if (request.method === "GET") {
    try {
      const pairs = await db.listPairs();
      sendJson(response, 200, { pairs });
    } catch (error) {
      sendDatabaseError(response, error);
    }
    return;
  }

  if (request.method === "POST") {
    let payload;

    try {
      payload = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { message: "请求数据格式不正确。" });
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

      sendDatabaseError(response, error);
    }
    return;
  }

  sendJson(response, 405, { message: "Method not allowed" });
};
