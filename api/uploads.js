const { db, ensureDatabase, readJsonBody, sendDatabaseError, sendJson } = require("../lib/api-shared");

module.exports = async function handler(request, response) {
  try {
    await ensureDatabase();
  } catch (error) {
    sendDatabaseError(response, error);
    return;
  }

  if (request.method === "GET") {
    const kind = request.query?.kind || "";

    try {
      const uploads = await db.listUploads(kind);
      sendJson(response, 200, { uploads });
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

      sendDatabaseError(response, error);
    }
    return;
  }

  if (request.method === "DELETE") {
    const kind = request.query?.kind || "";

    try {
      await db.deleteUploads(kind);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendDatabaseError(response, error);
    }
    return;
  }

  sendJson(response, 405, { message: "Method not allowed" });
};
