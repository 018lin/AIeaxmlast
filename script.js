(function () {
  const form = document.querySelector("#loginForm");
  const errorBox = document.querySelector("#loginError");
  const passwordInput = form?.elements.password;
  const passwordToggle = document.querySelector("#passwordToggle");
  const submitButton = form?.querySelector(".login-submit");
  const nextPage = window.AppAuth.resolveNextPage(new URLSearchParams(window.location.search).get("next"));

  if (!form || !window.AppAuth) {
    return;
  }

  if (window.AppAuth.isLoggedIn()) {
    window.location.replace(nextPage);
    return;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  passwordToggle?.addEventListener("click", () => {
    const isPassword = passwordInput.type === "password";
    passwordInput.type = isPassword ? "text" : "password";
    passwordToggle.textContent = isPassword ? "隐藏" : "显示";
    passwordToggle.setAttribute("aria-label", isPassword ? "隐藏密码" : "显示密码");
    passwordInput.focus();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    showError("");

    const account = form.elements.account.value.trim();
    const password = form.elements.password.value;

    if (!account) {
      showError("请输入教师账号。");
      form.elements.account.focus();
      return;
    }

    if (!password) {
      showError("请输入登录密码。");
      passwordInput.focus();
      return;
    }

    submitButton.disabled = true;
    submitButton.querySelector("span").textContent = "正在登录…";

    try {
      await window.AppAuth.login(account, password);
      window.location.replace(nextPage);
    } catch (error) {
      showError(error.message);
      passwordInput.select();
      submitButton.disabled = false;
      submitButton.querySelector("span").textContent = "进入教师控制台";
    }
  });

  form.addEventListener("input", () => {
    if (!errorBox.hidden) {
      showError("");
    }
  });
})();
