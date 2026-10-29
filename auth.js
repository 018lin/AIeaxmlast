(function () {
  const SESSION_KEY = "aihw.auth.session.v1";
  const CLASS_STORAGE_KEY = "aihw.defaultClassId.v1";
  const AVATAR_KEY_PREFIX = "aihw.avatar.v1.";
  const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  const ALLOWED_PAGES = ["teacher.html", "homework.html", "batch-grading.html", "class-setup.html"];

  function readStorage(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  function removeStorage(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      // Ignore storage failures in private browsing modes.
    }
  }

  function getSession() {
    const raw = readStorage(SESSION_KEY);

    if (!raw) {
      return null;
    }

    try {
      const session = JSON.parse(raw);

      if (!session || !session.account || !session.expiresAt || session.expiresAt <= Date.now()) {
        removeStorage(SESSION_KEY);
        return null;
      }

      return session;
    } catch (error) {
      removeStorage(SESSION_KEY);
      return null;
    }
  }

  function isLoggedIn() {
    return Boolean(getSession());
  }

  function setSession(teacher) {
    const now = Date.now();
    const session = {
      account: teacher.account,
      name: teacher.name || teacher.account,
      issuedAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    writeStorage(SESSION_KEY, JSON.stringify(session));
    return session;
  }

  function resolveNextPage(rawValue) {
    const value = String(rawValue || "").trim();

    if (!value) {
      return "./teacher.html";
    }

    const [pathname, query = ""] = value.split("?");

    if (!ALLOWED_PAGES.includes(pathname)) {
      return "./teacher.html";
    }

    return `./${pathname}${query ? `?${query.replace(/[#]/g, "")}` : ""}`;
  }

  function requireAuth() {
    if (isLoggedIn()) {
      return true;
    }

    const current = `${window.location.pathname.split("/").pop() || "teacher.html"}${window.location.search}`;
    window.location.replace(`./index.html?next=${encodeURIComponent(current)}`);
    return false;
  }

  async function login(account, password) {
    let response;

    try {
      response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ account, password }),
      });
    } catch (error) {
      throw new Error("无法连接登录服务，请确认服务已启动。");
    }

    const payload = await response.json().catch(() => ({}));

    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || "登录失败，请稍后重试。");
    }

    return setSession(payload.teacher);
  }

  function logout() {
    removeStorage(SESSION_KEY);
    window.location.replace("./index.html");
  }

  function getDefaultClassId() {
    return readStorage(CLASS_STORAGE_KEY) || "";
  }

  function setDefaultClassId(classId) {
    if (classId) {
      writeStorage(CLASS_STORAGE_KEY, classId);
    } else {
      removeStorage(CLASS_STORAGE_KEY);
    }
  }

  function getAvatar(account) {
    return account ? readStorage(`${AVATAR_KEY_PREFIX}${account}`) || "" : "";
  }

  function setAvatar(account, dataUrl) {
    if (!account) {
      return;
    }

    if (!writeStorage(`${AVATAR_KEY_PREFIX}${account}`, dataUrl)) {
      throw new Error("头像保存失败，请选择更小的图片。");
    }
  }

  function clearAvatar(account) {
    if (account) {
      removeStorage(`${AVATAR_KEY_PREFIX}${account}`);
    }
  }

  window.AppAuth = {
    AVATAR_KEY_PREFIX,
    CLASS_STORAGE_KEY,
    SESSION_KEY,
    clearAvatar,
    getAvatar,
    getDefaultClassId,
    getSession,
    isLoggedIn,
    login,
    logout,
    requireAuth,
    resolveNextPage,
    setAvatar,
    setDefaultClassId,
  };
})();
