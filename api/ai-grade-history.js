const { db, ensureDatabase, sendDatabaseError, sendJson } = require("../lib/api-shared");

module.exports = async function handler(request, response) {
  try {
    await ensureDatabase();
  } catch (error) {
    sendDatabaseError(response, error);
    return;
  }

  if (request.method === "GET") {
    try {
      const history = await db.listAiGradingHistory();
      sendJson(response, 200, { history });
    } catch (error) {
      sendDatabaseError(response, error);
    }
    return;
  }

  if (request.method === "DELETE") {
    try {
      await db.deleteAiGradingHistory();
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendDatabaseError(response, error);
    }
    return;
  }

  sendJson(response, 405, { message: "Method not allowed" });
};
