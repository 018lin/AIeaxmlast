const crypto = require("crypto");

const DEFAULT_ACCOUNT = "018";
const DEFAULT_PASSWORD = "018018";

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function authenticate(payload) {
  const account = String(payload?.account || "").trim();
  const password = String(payload?.password || "");

  if (!account || !password) {
    return {
      statusCode: 400,
      payload: { message: "请输入账号和密码。" },
    };
  }

  const expectedAccount = process.env.TEACHER_ACCOUNT || DEFAULT_ACCOUNT;
  const expectedPassword = process.env.TEACHER_PASSWORD || DEFAULT_PASSWORD;

  if (!safeEqual(account, expectedAccount) || !safeEqual(password, expectedPassword)) {
    return {
      statusCode: 401,
      payload: { message: "账号或密码不正确。" },
    };
  }

  return {
    statusCode: 200,
    payload: {
      ok: true,
      teacher: {
        account,
        name: String(process.env.TEACHER_NAME || "").trim() || `${account}老师`,
      },
    },
  };
}

module.exports = {
  authenticate,
  DEFAULT_ACCOUNT,
  DEFAULT_PASSWORD,
};
