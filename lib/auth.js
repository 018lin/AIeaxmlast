const crypto = require("crypto");

const DEFAULT_ACCOUNT = "018";
const DEFAULT_PASSWORD = "018018";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getTokenSecret() {
  const explicit = String(process.env.AUTH_SECRET || "").trim();

  if (explicit) {
    return explicit;
  }

  const derived = [process.env.TEACHERS, process.env.TEACHER_ACCOUNT, process.env.TEACHER_PASSWORD]
    .filter(Boolean)
    .join("|");

  return derived || "aihw-local-dev-secret";
}

function signToken(account, ttlMs = TOKEN_TTL_MS) {
  const expiresAt = Date.now() + ttlMs;
  const payload = Buffer.from(JSON.stringify({ account, expiresAt })).toString("base64url");
  const signature = crypto.createHmac("sha256", getTokenSecret()).update(payload).digest("base64url");

  return { token: `${payload}.${signature}`, expiresAt };
}

function verifyToken(token) {
  const [payload, signature] = String(token || "").split(".");

  if (!payload || !signature) {
    return null;
  }

  const expected = crypto.createHmac("sha256", getTokenSecret()).update(payload).digest("base64url");

  if (!safeEqual(signature, expected)) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

    if (!data?.account || !data?.expiresAt || Number(data.expiresAt) <= Date.now()) {
      return null;
    }

    return { account: String(data.account), expiresAt: Number(data.expiresAt) };
  } catch (error) {
    return null;
  }
}

function getRequestAccount(request) {
  const header = request?.headers?.authorization || request?.headers?.Authorization || "";
  const [scheme, token] = String(header).split(" ");

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return "";
  }

  return verifyToken(token)?.account || "";
}

function parseTeachers(raw) {
  return String(raw || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [account = "", password = "", ...nameParts] = entry.split(":");
      return {
        account: account.trim(),
        password,
        name: nameParts.join(":").trim(),
      };
    })
    .filter((entry) => entry.account && entry.password);
}

function listTeachers() {
  const configured = parseTeachers(process.env.TEACHERS);

  if (configured.length) {
    return configured;
  }

  return [
    {
      account: String(process.env.TEACHER_ACCOUNT || DEFAULT_ACCOUNT).trim(),
      password: String(process.env.TEACHER_PASSWORD || DEFAULT_PASSWORD),
      name: String(process.env.TEACHER_NAME || "").trim(),
    },
  ];
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

  const teacher = listTeachers().find((entry) => entry.account === account);

  if (!teacher || !safeEqual(password, teacher.password)) {
    return {
      statusCode: 401,
      payload: { message: "账号或密码不正确。" },
    };
  }

  const session = signToken(teacher.account);

  return {
    statusCode: 200,
    payload: {
      ok: true,
      teacher: {
        account: teacher.account,
        name: teacher.name || `${teacher.account}老师`,
      },
      token: session.token,
      expiresAt: session.expiresAt,
    },
  };
}

module.exports = {
  authenticate,
  DEFAULT_ACCOUNT,
  DEFAULT_PASSWORD,
  getRequestAccount,
  listTeachers,
  signToken,
  verifyToken,
};
