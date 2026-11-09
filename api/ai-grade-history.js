const { db, ensureDatabase, sendDatabaseError, sendJson } = require("../lib/api-shared");
const { getRequestAccount } = require("../lib/auth");

module.exports = async function handler(request, response) {
  const account = getRequestAccount(request);

  if (!account) {
    sendJson(response, 401, { message: "登录已过期，请重新登录。" });
    return;
  }

  try {
    await ensureDatabase();
  } catch (error) {
    sendDatabaseError(response, error);
    return;
  }

  if (request.method === "GET") {
    try {
      const history = await db.listAiGradingHistory(account);
      response.setHeader("Cache-Control", "no-store");
      sendJson(response, 200, { history });
    } catch (error) {
      sendDatabaseError(response, error);
    }
    return;
  }

  if (request.method === "DELETE") {
    try {
      await db.deleteAiGradingHistory(account);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendDatabaseError(response, error);
    }
    return;
  }

  sendJson(response, 405, { message: "Method not allowed" });
};
