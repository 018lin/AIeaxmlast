(function () {
  if (!window.AppAuth) {
    return;
  }

  const auth = window.AppAuth;
  const session = auth.getSession();
  const mount = document.querySelector("[data-topbar-actions]");

  if (!session || !mount) {
    return;
  }

  const state = {
    classes: [],
    students: [],
    classId: "",
    classesLoaded: false,
    classesError: "",
  };

  const icons = {
    building: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4.5 20.2h15M6.5 20.2V5.2h7.2v15M13.7 9.6h3.8v10.6" />
        <path d="M9 8.2h1.8M9 11.4h1.8M9 14.6h1.8M9 17.6h1.8" />
      </svg>`,
    chevron: `
      <svg class="class-pill-chevron" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 9l6 6 6-6" />
      </svg>`,
    check: `
      <svg class="class-option-check" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 12.5l4.2 4.2L19 6.8" />
      </svg>`,
  };

  mount.innerHTML = `
    <div class="class-switcher">
      <button class="class-pill" type="button" data-class-toggle aria-haspopup="listbox" aria-expanded="false">
        <span class="class-pill-icon">${icons.building}</span>
        <span class="class-pill-copy">
          <span>当前默认班级</span>
          <strong data-class-name>加载中…</strong>
        </span>
        ${icons.chevron}
      </button>
      <div class="class-menu" data-class-menu hidden>
        <div class="class-menu-head">
          <span>切换默认班级</span>
          <small data-class-count></small>
        </div>
        <div class="class-menu-list" data-class-options></div>
        <a class="class-menu-add" href="./class-setup.html">
          <span aria-hidden="true">+</span>
          增加班级
        </a>
      </div>
    </div>
    <div class="avatar-wrap">
      <button class="teacher-avatar" type="button" data-avatar-toggle aria-haspopup="menu" aria-expanded="false" title="账号与头像设置"></button>
      <div class="avatar-menu" data-avatar-menu hidden>
        <p class="avatar-menu-head">当前账号 <strong>${escapeHtml(session.account)}</strong></p>
        <button type="button" data-avatar-change>更换头像</button>
        <button type="button" data-avatar-reset>恢复默认头像</button>
        <button class="is-danger" type="button" data-logout>退出登录</button>
      </div>
      <input type="file" accept="image/*" data-avatar-input hidden />
    </div>
  `;

  const classToggle = mount.querySelector("[data-class-toggle]");
  const classNameLabel = mount.querySelector("[data-class-name]");
  const classMenu = mount.querySelector("[data-class-menu]");
  const classCount = mount.querySelector("[data-class-count]");
  const classOptions = mount.querySelector("[data-class-options]");
  const avatarToggle = mount.querySelector("[data-avatar-toggle]");
  const avatarMenu = mount.querySelector("[data-avatar-menu]");
  const avatarInput = mount.querySelector("[data-avatar-input]");

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function getClassById(classId) {
    return state.classes.find((item) => item.id === classId) || null;
  }

  function classDisplayName(classItem) {
    if (!classItem) {
      if (state.classesError) {
        return "班级加载失败";
      }

      return state.classesLoaded ? "还没有班级" : "加载中…";
    }

    return classItem.grade ? `${classItem.name}（${classItem.grade}）` : classItem.name;
  }

  function studentCountFor(classId) {
    return state.students.filter((student) => student.classId === classId).length;
  }

  function resolveClassId() {
    const stored = auth.getDefaultClassId();
    const storedExists = state.classes.some((item) => item.id === stored);

    if (storedExists) {
      return stored;
    }

    if (!state.classesLoaded) {
      return stored;
    }

    const fallback = state.classes[0]?.id || "";
    auth.setDefaultClassId(fallback);
    return fallback;
  }

  function renderClassSwitcher() {
    const current = getClassById(state.classId);
    classNameLabel.textContent = classDisplayName(current);
    classToggle.title = current ? `当前默认班级：${classDisplayName(current)}` : "设置默认班级";

    classCount.textContent = state.classes.length ? `${state.classes.length} 个班级` : "";

    if (state.classesError) {
      classOptions.innerHTML = `<p class="class-menu-empty">${escapeHtml(state.classesError)}</p>`;
      return;
    }

    if (!state.classesLoaded) {
      classOptions.innerHTML = '<p class="class-menu-empty">正在加载班级…</p>';
      return;
    }

    if (!state.classes.length) {
      classOptions.innerHTML = '<p class="class-menu-empty">还没有班级，点击下方按钮创建第一个班级。</p>';
      return;
    }

    classOptions.innerHTML = state.classes
      .map((classItem) => {
        const displayName = classItem.grade ? `${classItem.name}（${classItem.grade}）` : classItem.name;
        return `
          <button class="class-option ${classItem.id === state.classId ? "is-active" : ""}" type="button" data-class-id="${escapeHtml(classItem.id)}">
            <span class="class-option-name">${escapeHtml(classItem.name)}</span>
            <span class="class-option-meta">${escapeHtml(classItem.grade || "未填年级")} · ${studentCountFor(classItem.id)} 名学生</span>
            ${icons.check}
          </button>
        `;
      })
      .join("");

    if (current) {
      const activeOption = classOptions.querySelector(".class-option.is-active");

      if (activeOption) {
        classOptions.scrollTop =
          activeOption.offsetTop - classOptions.clientHeight / 2 + activeOption.offsetHeight / 2;
      }
    }
  }

  function renderAvatar() {
    const avatar = auth.getAvatar(session.account);

    if (avatar) {
      avatarToggle.classList.add("has-image");
      avatarToggle.innerHTML = `<img src="${escapeHtml(avatar)}" alt="教师头像" />`;
    } else {
      avatarToggle.classList.remove("has-image");
      avatarToggle.innerHTML = '<span class="avatar-fallback">教</span>';
    }
  }

  function closeMenus(except) {
    if (except !== "class") {
      classMenu.hidden = true;
      classToggle.setAttribute("aria-expanded", "false");
    }

    if (except !== "avatar") {
      avatarMenu.hidden = true;
      avatarToggle.setAttribute("aria-expanded", "false");
    }
  }

  function toggleClassMenu() {
    const willOpen = classMenu.hidden;
    closeMenus(willOpen ? "class" : "");
    classMenu.hidden = !willOpen;
    classToggle.setAttribute("aria-expanded", String(willOpen));
  }

  function toggleAvatarMenu() {
    const willOpen = avatarMenu.hidden;
    closeMenus(willOpen ? "avatar" : "");
    avatarMenu.hidden = !willOpen;
    avatarToggle.setAttribute("aria-expanded", String(willOpen));
  }

  function applyClass(classId, { silent = false } = {}) {
    const nextId = getClassById(classId)?.id || "";
    state.classId = nextId;
    auth.setDefaultClassId(nextId);
    renderClassSwitcher();

    if (!silent) {
      window.dispatchEvent(
        new CustomEvent("default-class-changed", {
          detail: { classId: nextId, classItem: getClassById(nextId) },
        })
      );
    }
  }

  async function loadClasses() {
    try {
      const response = await fetch("/api/mvp?action=bootstrap", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.message || "班级数据加载失败。");
      }

      state.classes = payload.classes || [];
      state.students = payload.students || [];
      state.classesLoaded = true;
      state.classesError = "";
    } catch (error) {
      state.classesLoaded = false;
      state.classesError = error.message || "班级数据加载失败。";
    }

    state.classId = resolveClassId();
    renderClassSwitcher();
  }

  function createAvatarImage(file) {
    return new Promise((resolve, reject) => {
      if (!file.type.startsWith("image/")) {
        reject(new Error("请选择图片文件。"));
        return;
      }

      const reader = new FileReader();
      reader.onerror = () => reject(new Error("头像读取失败，请重试。"));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error("头像图片无法识别，请换一张。"));
        image.onload = () => {
          const side = Math.min(image.naturalWidth, image.naturalHeight);
          const size = 256;
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const context = canvas.getContext("2d");
          context.drawImage(
            image,
            (image.naturalWidth - side) / 2,
            (image.naturalHeight - side) / 2,
            side,
            side,
            0,
            0,
            size,
            size
          );

          try {
            resolve(canvas.toDataURL("image/jpeg", 0.86));
          } catch (error) {
            reject(new Error("头像处理失败，请换一张图片。"));
          }
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  classToggle.addEventListener("click", toggleClassMenu);
  avatarToggle.addEventListener("click", toggleAvatarMenu);

  classOptions.addEventListener("click", (event) => {
    const option = event.target.closest("[data-class-id]");

    if (option) {
      applyClass(option.dataset.classId);
      closeMenus();
    }
  });

  mount.querySelector("[data-avatar-change]").addEventListener("click", () => {
    avatarInput.click();
  });

  mount.querySelector("[data-avatar-reset]").addEventListener("click", () => {
    auth.clearAvatar(session.account);
    renderAvatar();
    closeMenus();
  });

  mount.querySelector("[data-logout]").addEventListener("click", () => {
    auth.logout();
  });

  avatarInput.addEventListener("change", async () => {
    const file = avatarInput.files?.[0];

    if (!file) {
      return;
    }

    try {
      const avatar = await createAvatarImage(file);
      auth.setAvatar(session.account, avatar);
      renderAvatar();
      closeMenus();
    } catch (error) {
      window.alert(error.message);
    } finally {
      avatarInput.value = "";
    }
  });

  document.addEventListener("click", (event) => {
    if (!mount.contains(event.target)) {
      closeMenus();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenus();
    }
  });

  window.addEventListener("storage", (event) => {
    if (event.key === auth.CLASS_STORAGE_KEY) {
      state.classId = resolveClassId();
      renderClassSwitcher();
    }
  });

  window.AppShell = {
    applyClass: (classId) => applyClass(classId),
    getClassId: () => state.classId,
    refresh: loadClasses,
  };

  renderAvatar();
  renderClassSwitcher();
  loadClasses();
})();
