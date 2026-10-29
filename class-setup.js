(function () {
  const form = document.querySelector("#classSetupForm");
  const excelFileInput = document.querySelector("#classExcelFile");
  const excelFileName = document.querySelector("#classExcelFileName");
  const manualList = document.querySelector("#manualStudentList");
  const addRowButton = document.querySelector("#addStudentRow");
  const statusBox = document.querySelector("#classSetupStatus");
  const submitButton = form?.querySelector("button[type='submit']");

  if (!form) {
    return;
  }

  const state = {
    method: "excel",
    classes: [],
    file: null,
    saving: false,
  };

  async function apiRequest(action, options = {}) {
    const response = await fetch(`/api/mvp?action=${encodeURIComponent(action)}`, {
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.message || "请求失败。");
    }

    return payload;
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("文件读取失败，请重试。"));
      reader.readAsDataURL(file);
    });
  }

  function setStatus(message, tone = "") {
    statusBox.textContent = message;
    statusBox.classList.toggle("is-error", tone === "error");
    statusBox.classList.toggle("is-success", tone === "success");
  }

  function setMethod(method) {
    state.method = method;
    document.querySelectorAll(".method-tab").forEach((tab) => {
      const active = tab.dataset.method === method;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll("[data-method-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.methodPanel !== method;
    });
    setStatus("");
  }

  function updateRemoveButtons() {
    const rows = Array.from(manualList.querySelectorAll(".manual-student-row"));
    rows.forEach((row) => {
      const button = row.querySelector(".remove-student-row");
      if (button) {
        button.disabled = rows.length === 1;
      }
    });
  }

  function addManualRow({ focus = false } = {}) {
    const row = document.createElement("div");
    row.className = "manual-student-row";
    row.innerHTML = `
      <label class="field-control">
        <span>姓名</span>
        <input name="studentName" type="text" maxlength="40" placeholder="学生姓名" />
      </label>
      <label class="field-control">
        <span>学号</span>
        <input name="studentNo" type="text" maxlength="40" placeholder="学号（可选）" />
      </label>
      <button class="remove-student-row" type="button" aria-label="删除这名学生" title="删除">×</button>
    `;

    row.querySelector(".remove-student-row").addEventListener("click", () => {
      const rows = manualList.querySelectorAll(".manual-student-row");
      if (rows.length <= 1) {
        return;
      }

      row.remove();
      updateRemoveButtons();
      setStatus("");
    });

    manualList.appendChild(row);
    updateRemoveButtons();

    if (focus) {
      row.querySelector('input[name="studentName"]').focus();
    }
  }

  function collectManualStudents() {
    const rows = Array.from(manualList.querySelectorAll(".manual-student-row"));
    const students = [];
    const seen = new Set();
    let invalidRow = 0;

    rows.forEach((row, index) => {
      const name = row.querySelector('input[name="studentName"]').value.trim();
      const studentNo = row.querySelector('input[name="studentNo"]').value.trim();

      if (!name && !studentNo) {
        return;
      }

      if (!name) {
        invalidRow = index + 1;
        return;
      }

      if (name.length > 40 || studentNo.length > 40) {
        throw new Error(`第 ${index + 1} 行的姓名或学号过长。`);
      }

      const key = `${name}|${studentNo}`;

      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      students.push({ name, studentNo });
    });

    if (invalidRow) {
      throw new Error(`第 ${invalidRow} 行缺少学生姓名。`);
    }

    if (!students.length) {
      throw new Error("请至少填写一名学生。");
    }

    return students;
  }

  function validateClassName(name) {
    if (!name) {
      throw new Error("请填写班级名称。");
    }

    if (name.length > 40) {
      throw new Error("班级名称不能超过 40 个字符。");
    }

    const duplicate = state.classes.some(
      (classItem) => String(classItem.name || "").trim().toLowerCase() === name.toLowerCase()
    );

    if (duplicate) {
      throw new Error("已存在同名班级，请换一个班级名称。");
    }
  }

  async function loadClasses() {
    try {
      const payload = await apiRequest("bootstrap", { cache: "no-store" });
      state.classes = payload.classes || [];
    } catch (error) {
      state.classes = [];
    }
  }

  async function saveClassWithExcel(name, grade) {
    if (!state.file) {
      throw new Error("请选择 Excel 学生名单文件。");
    }

    const payload = await apiRequest("import-students", {
      method: "POST",
      body: JSON.stringify({
        className: name,
        grade,
        name: state.file.name,
        file: await readFileAsDataUrl(state.file),
      }),
    });

    return {
      classItem: payload.classItem,
      message: `班级已创建，导入 ${payload.created} 名学生，跳过重复 ${payload.skipped} 人。`,
    };
  }

  async function saveClassWithManual(name, grade, students) {
    const classPayload = await apiRequest("create-class", {
      method: "POST",
      body: JSON.stringify({ name, grade }),
    });
    const classItem = classPayload.classItem;
    let created = 0;
    let failed = 0;

    for (const student of students) {
      try {
        await apiRequest("create-student", {
          method: "POST",
          body: JSON.stringify({
            classId: classItem.id,
            name: student.name,
            studentNo: student.studentNo,
          }),
        });
        created += 1;
      } catch (error) {
        failed += 1;
      }
    }

    return {
      classItem,
      message: failed
        ? `班级已创建，成功添加 ${created} 名学生，${failed} 名添加失败。`
        : `班级已创建，已添加 ${created} 名学生。`,
    };
  }

  function finish(classItem, message) {
    window.AppAuth.setDefaultClassId(classItem.id);
    setStatus(`${message} 正在返回控制台…`, "success");
    submitButton.textContent = "已保存";
    submitButton.disabled = true;

    window.setTimeout(() => {
      window.location.href = "./teacher.html";
    }, 1200);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (state.saving) {
      return;
    }

    setStatus("");
    const name = form.elements.name.value.trim();
    const grade = form.elements.grade.value.trim();

    state.saving = true;
    submitButton.disabled = true;
    submitButton.textContent = "正在保存…";

    try {
      validateClassName(name);

      let result;

      if (state.method === "excel") {
        result = await saveClassWithExcel(name, grade);
      } else {
        result = await saveClassWithManual(name, grade, collectManualStudents());
      }

      finish(result.classItem, result.message);
    } catch (error) {
      state.saving = false;
      submitButton.disabled = false;
      submitButton.textContent = "保存班级并导入学生";
      setStatus(error.message, "error");
    }
  });

  document.querySelectorAll(".method-tab").forEach((tab) => {
    tab.addEventListener("click", () => setMethod(tab.dataset.method));
  });

  addRowButton.addEventListener("click", () => addManualRow({ focus: true }));

  excelFileInput.addEventListener("change", () => {
    state.file = excelFileInput.files?.[0] || null;
    excelFileName.textContent = state.file ? state.file.name : "选择 Excel 学生名单";
    setStatus("");
  });

  addManualRow();
  loadClasses();
})();
