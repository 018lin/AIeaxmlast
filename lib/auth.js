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

  return {
    statusCode: 200,
    payload: {
      ok: true,
      teacher: {
        account: teacher.account,
        name: teacher.name || `${teacher.account}老师`,
      },
    },
  };
}

module.exports = {
  authenticate,
  DEFAULT_ACCOUNT,
  DEFAULT_PASSWORD,
  listTeachers,
};
