const { db, ensureDatabase, readJsonBody } = require("../lib/api-shared");
const { handleMvpRequest } = require("../lib/mvp-handler");

module.exports = async function handler(request, response) {
  await handleMvpRequest({
    db,
    ensureDatabase,
    readJsonBody,
    request,
    response,
    query: request.query || {},
  });
};
