(function () {
  const state = {
    classes: [],
    students: [],
    exams: [],
    defaultClassId: "",
    questions: [],
    templates: [],
    regions: [],
    currentTemplate: null,
    templateSelection: null,
    activeExamId: "",
    overview: null,
    activeStudentId: "",
    pendingImage: "",
    captureStream: null,
    grading: false,
    historyMode: "student",
    quickQuestion: null,
    quickAnswer: null,
    quickBusy: false,
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const elements = {
    refreshButton: $("#hwRefreshButton"),
    classForm: $("#hwClassForm"),
    importForm: $("#hwImportForm"),
    importFile: $("#hwImportFile"),
    importFileName: $("#hwImportFileName"),
    importClassSelect: $("#importClassSelect"),
    classList: $("#hwClassList"),
    studentList: $("#hwStudentList"),
    studentCount: $("#hwStudentCount"),
    examForm: $("#hwExamForm"),
    examList: $("#hwExamList"),
    questionForm: $("#hwQuestionForm"),
    questionList: $("#hwQuestionList"),
    templateUpload: $("#hwTemplateUpload"),
    templateFileName: $("#hwTemplateFileName"),
    templateStage: $("#hwTemplateStage"),
    templateImage: $("#hwTemplateImage"),
    regionQuestionSelect: $("#hwRegionQuestionSelect"),
    saveRegionButton: $("#hwSaveRegionButton"),
    regionList: $("#hwRegionList"),
    workExamSelect: $("#workExamSelect"),
    workRefreshButton: $("#workRefreshButton"),
    workSummary: $("#workSummary"),
    studentCardGrid: $("#studentCardGrid"),
    studentWorkPanel: $("#studentWorkPanel"),
    workStudentName: $("#workStudentName"),
    workStudentMeta: $("#workStudentMeta"),
    closeWorkPanel: $("#closeWorkPanel"),
    cameraButton: $("#cameraButton"),
    workImageInput: $("#workImageInput"),
    workPreviewWrap: $("#workPreviewWrap"),
    workPreview: $("#workPreview"),
    gradeStudentButton: $("#gradeStudentButton"),
    workStatusText: $("#workStatusText"),
    studentResultArea: $("#studentResultArea"),
    analysisExamSelect: $("#analysisExamSelect"),
    loadAnalysisButton: $("#loadAnalysisButton"),
    assignmentAnalysis: $("#assignmentAnalysis"),
    historyClassSelect: $("#historyClassSelect"),
    historyStudentSelect: $("#historyStudentSelect"),
    loadHistoryButton: $("#loadHistoryButton"),
    historyAnalysis: $("#historyAnalysis"),
    quickQuestionUpload: $("#quickQuestionUpload"),
    quickAnswerUpload: $("#quickAnswerUpload"),
    quickQuestionFileName: $("#quickQuestionFileName"),
    quickAnswerFileName: $("#quickAnswerFileName"),
    quickQuestionPreview: $("#quickQuestionPreview"),
    quickAnswerPreview: $("#quickAnswerPreview"),
    quickMaxScore: $("#quickMaxScore"),
    quickRubric: $("#quickRubric"),
    quickGradeButton: $("#quickGradeButton"),
    quickStatusText: $("#quickStatusText"),
    quickResultArea: $("#quickResultArea"),
    cameraModal: $("#cameraModal"),
    cameraVideo: $("#cameraVideo"),
    cameraHint: $("#cameraHint"),
    closeCameraButton: $("#closeCameraButton"),
    captureButton: $("#captureButton"),
    captureCanvas: $("#captureCanvas"),
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function apiRequest(action, options = {}) {
    const url = `/api/mvp?action=${action}`;
    const response = await fetch(url, {
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

  function formPayload(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function getImageSize(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = reject;
      image.src = src;
    });
  }

  function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  async function compressImageDataUrl(src, maxWidth = 1400) {
    const image = await loadImageElement(src);
    const scale = Math.min(1, maxWidth / image.naturalWidth);

    if (scale >= 1) {
      return src;
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  }

  function formatPercent(rate) {
    const value = Number(rate);
    return `${Number.isFinite(value) ? Math.round(value * 100) : 0}%`;
  }

  function formatNumber(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return "0";
    }

    return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(1);
  }

  function formatDate(value) {
    if (!value) {
      return "-";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return String(value).slice(0, 10);
    }

    const pad = (part) => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function setWorkStatus(message) {
    elements.workStatusText.textContent = message;
  }

  function fillSelect(select, items, getLabel, placeholder, autoSelect = true) {
    if (!select) {
      return;
    }

    const previous = select.value;
    select.innerHTML =
      `<option value="">${escapeHtml(placeholder)}</option>` +
      items
        .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(getLabel(item))}</option>`)
        .join("");

    if (previous && items.some((item) => item.id === previous)) {
      select.value = previous;
    } else if (autoSelect && items.length) {
      select.value = items[0].id;
    } else {
      select.value = "";
    }
  }

  function resolveDefaultClassId() {
    const stored = window.AppAuth?.getDefaultClassId?.() || "";

    if (stored && state.classes.some((item) => item.id === stored)) {
      return stored;
    }

    const fallback = state.classes[0]?.id || "";
    window.AppAuth?.setDefaultClassId?.(fallback);
    return fallback;
  }

  function getScopedStudents() {
    if (!state.defaultClassId) {
      return state.students;
    }

    return state.students.filter((student) => student.classId === state.defaultClassId);
  }

  function renderCoreSelects() {
    $$('[data-select="classes"]').forEach((select) => {
      fillSelect(
        select,
        state.classes,
        (item) => (item.grade ? `${item.name}（${item.grade}）` : item.name),
        "请选择班级",
        select.dataset.optional !== "true"
      );

      if (state.defaultClassId && state.classes.some((item) => item.id === state.defaultClassId)) {
        select.value = state.defaultClassId;
      }
    });

    $$('[data-select="exams"]').forEach((select) => {
      fillSelect(
        select,
        state.exams,
        (item) => `${item.name}${item.subject ? `｜${item.subject}` : ""}`,
        "请选择作业",
        true
      );

      if (state.activeExamId && state.exams.some((item) => item.id === state.activeExamId)) {
        select.value = state.activeExamId;
      }
    });

    renderHistoryStudentSelect();
  }

  function syncExamSelects() {
    $$('[data-select="exams"]').forEach((select) => {
      if (state.activeExamId && state.exams.some((item) => item.id === state.activeExamId)) {
        select.value = state.activeExamId;
      } else {
        select.value = "";
      }
    });
  }

  function renderClassList() {
    if (!state.classes.length) {
      elements.classList.innerHTML = '<p class="empty-text">暂无班级，请先新增或导入。</p>';
      return;
    }

    const orderedClasses = [...state.classes].sort(
      (left, right) =>
        Number(right.id === state.defaultClassId) - Number(left.id === state.defaultClassId)
    );

    elements.classList.innerHTML = orderedClasses
      .map((classItem) => {
        const count = state.students.filter((student) => student.classId === classItem.id).length;
        const isDefault = classItem.id === state.defaultClassId;
        return `
          <div class="mini-item">
            <strong>${escapeHtml(classItem.name)}${isDefault ? '<span class="default-class-tag">默认</span>' : ""}</strong>
            <span>${escapeHtml(classItem.grade || "未填年级")}｜${count} 名学生</span>
          </div>
        `;
      })
      .join("");
  }

  function renderStudentRoster() {
    const students = getScopedStudents();
    const currentClass = state.classes.find((item) => item.id === state.defaultClassId);

    elements.studentCount.textContent = `${students.length} 人`;

    if (!students.length) {
      elements.studentList.innerHTML = currentClass
        ? `<p class="empty-text">「${escapeHtml(currentClass.name)}」暂无学生，请导入 Excel 名单或手动添加。</p>`
        : '<p class="empty-text">暂无学生，请导入 Excel 名单。</p>';
      return;
    }

    elements.studentList.innerHTML = students
      .map(
        (student) => `
          <span class="roster-chip" title="${escapeHtml(student.className || "未分班")}">
            <strong>${escapeHtml(student.name)}</strong>
            <small>${escapeHtml(student.studentNo || "无学号")}</small>
          </span>
        `
      )
      .join("");
  }

  function renderExamList() {
    if (!state.exams.length) {
      elements.examList.innerHTML = '<p class="empty-text">暂无作业，请先新建作业。</p>';
      return;
    }

    elements.examList.innerHTML = state.exams
      .map(
        (exam) => `
          <button class="mini-item exam-list-item ${exam.id === state.activeExamId ? "is-active" : ""}" type="button" data-exam-id="${escapeHtml(exam.id)}">
            <strong>${escapeHtml(exam.name)}</strong>
            <span>${escapeHtml(exam.className || "未绑定班级")}｜${escapeHtml(exam.subject || "未填科目")}｜${exam.questionCount} 题｜${formatNumber(exam.totalScore)} 分</span>
          </button>
        `
      )
      .join("");
  }

  function renderQuestionList() {
    if (!state.activeExamId) {
      elements.questionList.innerHTML = '<p class="empty-text">请先选择作业。</p>';
      return;
    }

    if (!state.questions.length) {
      elements.questionList.innerHTML = '<p class="empty-text">暂无题目，请先录入题目和知识点。</p>';
      return;
    }

    elements.questionList.innerHTML = state.questions
      .map((question) => {
        const knowledgePoints = (question.knowledgePoints || []).join("、") || "未标注知识点";
        return `
          <div class="mini-item">
            <strong>${escapeHtml(question.questionNo)}｜${escapeHtml(question.questionType || "未标注题型")}</strong>
            <span>${formatNumber(question.maxScore)} 分｜${escapeHtml(knowledgePoints)}</span>
            ${question.title ? `<span>${escapeHtml(question.title)}</span>` : ""}
          </div>
        `;
      })
      .join("");
  }

  function renderRegionQuestionSelect() {
    fillSelect(
      elements.regionQuestionSelect,
      state.questions,
      (question) => `${question.questionNo}（${formatNumber(question.maxScore)} 分）`,
      "请选择题目",
      true
    );
  }

  function renderRegions() {
    if (!state.regions.length) {
      elements.regionList.innerHTML = '<p class="empty-text">暂无题目区域</p>';
      return;
    }

    elements.regionList.innerHTML = state.regions
      .map(
        (region) => `
          <div class="mini-item">
            <strong>${escapeHtml(region.questionNo)}</strong>
            <span>区域 ${Math.round(region.widthRatio * 100)}% × ${Math.round(region.heightRatio * 100)}%</span>
          </div>
        `
      )
      .join("");
  }

  function clearSelectionBox() {
    elements.templateStage.querySelector(".selection-box")?.remove();
  }

  function renderTemplate() {
    const template = state.currentTemplate;
    const empty = elements.templateStage.querySelector(".crop-empty");

    clearSelectionBox();
    state.templateSelection = null;
    elements.saveRegionButton.disabled = true;

    if (!template?.image) {
      elements.templateImage.removeAttribute("src");
      elements.templateImage.classList.remove("is-visible");
      empty.style.display = "grid";
      return;
    }

    elements.templateImage.src = template.image;
    elements.templateImage.classList.add("is-visible");
    empty.style.display = "none";
  }

  async function loadExamScope(examId) {
    if (!examId) {
      state.questions = [];
      state.templates = [];
      state.currentTemplate = null;
      state.regions = [];
      renderQuestionList();
      renderRegionQuestionSelect();
      renderTemplate();
      renderRegions();
      return;
    }

    const [questionPayload, templatePayload] = await Promise.all([
      apiRequest(`questions&examId=${encodeURIComponent(examId)}`, { cache: "no-store" }),
      apiRequest(`templates&examId=${encodeURIComponent(examId)}`, { cache: "no-store" }),
    ]);

    state.questions = questionPayload.questions || [];
    state.templates = templatePayload.templates || [];
    state.currentTemplate = state.templates[0] || null;
    renderQuestionList();
    renderRegionQuestionSelect();
    renderTemplate();
    renderExamList();

    if (state.currentTemplate) {
      const regionPayload = await apiRequest(
        `regions&templateId=${encodeURIComponent(state.currentTemplate.id)}`,
        { cache: "no-store" }
      );
      state.regions = regionPayload.regions || [];
    } else {
      state.regions = [];
    }

    renderRegions();
  }

  async function loadBootstrap() {
    const payload = await apiRequest("bootstrap", { cache: "no-store" });
    state.classes = payload.classes || [];
    state.students = payload.students || [];
    state.exams = payload.exams || [];
    state.defaultClassId = resolveDefaultClassId();

    if (!state.exams.some((exam) => exam.id === state.activeExamId)) {
      const classExam = state.exams.find((exam) => exam.classId === state.defaultClassId);
      state.activeExamId = (classExam || state.exams[0])?.id || "";
    }

    renderCoreSelects();
    syncExamSelects();
    renderClassList();
    renderStudentRoster();
    renderExamList();
    await loadExamScope(state.activeExamId);

    if (state.overview && state.overview.exam?.id !== state.activeExamId) {
      state.overview = null;
      closeStudentPanel();
    }
  }

  async function handleExamChange(examId) {
    state.activeExamId = examId || "";
    syncExamSelects();
    renderExamList();
    state.overview = null;
    closeStudentPanel();
    await loadExamScope(state.activeExamId);

    if (!document.querySelector('[data-view-panel="work"]')?.hidden) {
      await loadWorkOverview();
    }

    if (!document.querySelector('[data-view-panel="analysis"]')?.hidden) {
      await loadBatchAnalysis();
    }
  }

  function bindForm(form, action, getExtraPayload, afterSave) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector("button[type='submit']");
      button.disabled = true;

      try {
        const payload = await apiRequest(action, {
          method: "POST",
          body: JSON.stringify({
            ...formPayload(form),
            ...(getExtraPayload ? getExtraPayload() : {}),
          }),
        });
        form.reset();
        if (afterSave) {
          await afterSave(payload);
        } else {
          await loadBootstrap();
        }
      } catch (error) {
        alert(error.message);
      } finally {
        button.disabled = false;
      }
    });
  }

  async function handleImportStudents(event) {
    event.preventDefault();
    const button = elements.importForm.querySelector("button[type='submit']");
    const file = elements.importFile.files?.[0];
    const classId = elements.importForm.elements.classId.value;
    const className = elements.importForm.elements.className.value.trim();

    if (!file) {
      alert("请选择 Excel 学生名单文件。");
      return;
    }

    if (!classId && !className) {
      alert("请选择已有班级，或填写新班级名称。");
      return;
    }

    button.disabled = true;

    try {
      const payload = await apiRequest("import-students", {
        method: "POST",
        body: JSON.stringify({
          classId,
          className,
          grade: elements.importForm.elements.grade.value,
          name: file.name,
          file: await readFileAsDataUrl(file),
        }),
      });
      alert(`导入完成：新增 ${payload.created} 人，跳过重复 ${payload.skipped} 人。`);
      window.AppAuth?.setDefaultClassId?.(payload.classItem.id);
      elements.importForm.reset();
      elements.importFile.value = "";
      elements.importFileName.textContent = "支持 .xlsx、.xls、.csv";
      elements.importClassSelect.value = payload.classItem.id;
      await loadBootstrap();
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function handleTemplateUpload(event) {
    const file = event.target.files?.[0];
    const examId = state.activeExamId;

    if (!file) {
      return;
    }

    if (!examId) {
      alert("请先选择作业。");
      return;
    }

    try {
      const image = await readFileAsDataUrl(file);
      const size = await getImageSize(image);
      await apiRequest("create-template", {
        method: "POST",
        body: JSON.stringify({
          examId,
          name: file.name,
          image,
          width: size.width,
          height: size.height,
        }),
      });
      elements.templateFileName.textContent = file.name;
      await loadExamScope(examId);
    } catch (error) {
      alert(error.message);
    }
  }

  async function handleSaveRegion() {
    if (!state.currentTemplate || !state.templateSelection || !elements.regionQuestionSelect.value) {
      return;
    }

    elements.saveRegionButton.disabled = true;

    try {
      await apiRequest("save-region", {
        method: "POST",
        body: JSON.stringify({
          templateId: state.currentTemplate.id,
          questionId: elements.regionQuestionSelect.value,
          selection: state.templateSelection,
        }),
      });
      const payload = await apiRequest(
        `regions&templateId=${encodeURIComponent(state.currentTemplate.id)}`,
        { cache: "no-store" }
      );
      state.regions = payload.regions || [];
      renderRegions();
      clearSelectionBox();
      state.templateSelection = null;
    } catch (error) {
      alert(error.message);
    } finally {
      elements.saveRegionButton.disabled = true;
    }
  }

  function setupTemplateSelection() {
    let start = null;
    let box = null;

    elements.templateStage.addEventListener("pointerdown", (event) => {
      if (!state.currentTemplate?.image || event.target !== elements.templateImage) {
        return;
      }

      const rect = elements.templateImage.getBoundingClientRect();
      start = {
        x: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
        y: Math.min(Math.max(event.clientY - rect.top, 0), rect.height),
        rect,
      };
      clearSelectionBox();
      box = document.createElement("div");
      box.className = "selection-box";
      elements.templateStage.appendChild(box);
      elements.templateStage.setPointerCapture(event.pointerId);
    });

    elements.templateStage.addEventListener("pointermove", (event) => {
      if (!start || !box) {
        return;
      }

      const x = Math.min(Math.max(event.clientX - start.rect.left, 0), start.rect.width);
      const y = Math.min(Math.max(event.clientY - start.rect.top, 0), start.rect.height);
      const left = Math.min(start.x, x);
      const top = Math.min(start.y, y);
      const width = Math.abs(x - start.x);
      const height = Math.abs(y - start.y);

      Object.assign(box.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
      });
    });

    elements.templateStage.addEventListener("pointerup", (event) => {
      if (!start || !box) {
        return;
      }

      const boxRect = box.getBoundingClientRect();
      const imgRect = elements.templateImage.getBoundingClientRect();
      const width = boxRect.width;
      const height = boxRect.height;

      if (width < 8 || height < 8) {
        clearSelectionBox();
        state.templateSelection = null;
        elements.saveRegionButton.disabled = true;
      } else {
        state.templateSelection = {
          xRatio: (boxRect.left - imgRect.left) / imgRect.width,
          yRatio: (boxRect.top - imgRect.top) / imgRect.height,
          widthRatio: width / imgRect.width,
          heightRatio: height / imgRect.height,
        };
        elements.saveRegionButton.disabled = !elements.regionQuestionSelect.value;
      }

      elements.templateStage.releasePointerCapture(event.pointerId);
      start = null;
      box = null;
    });
  }

  function switchView(view) {
    $$(".hw-tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === view));
    $$("[data-view-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.viewPanel !== view;
      panel.classList.toggle("is-active", panel.dataset.viewPanel === view);
    });

    if (view === "work") {
      loadWorkOverview().catch((error) => alert(error.message));
    }

    if (view === "analysis") {
      loadBatchAnalysis().catch((error) => alert(error.message));
    }

    if (view === "setup") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function statusLabel(status) {
    const labels = {
      not_submitted: "未提交",
      submitted: "已上传",
      grading: "批改中",
      graded: "已批改",
      needs_review: "需复核",
    };

    return labels[status] || "未提交";
  }

  async function loadWorkOverview() {
    if (!state.activeExamId) {
      elements.workSummary.innerHTML = '<p class="empty-text">请先在作业设置中新建作业。</p>';
      elements.studentCardGrid.innerHTML = "";
      return;
    }

    const payload = await apiRequest(`assignment-overview&examId=${encodeURIComponent(state.activeExamId)}`, {
      cache: "no-store",
    });
    state.overview = payload;
    renderWorkSummary();
    renderStudentCards();

    if (state.activeStudentId) {
      const student = payload.students.find((item) => item.id === state.activeStudentId);

      if (student) {
        updateStudentHeader(student);
      } else {
        closeStudentPanel();
      }
    }
  }

  function renderWorkSummary() {
    const overview = state.overview;

    if (!overview) {
      elements.workSummary.innerHTML = "";
      return;
    }

    const summary = overview.summary;
    const averageRate = summary.gradedCount && summary.maxScore
      ? summary.totalAchieved / (summary.gradedCount * summary.maxScore)
      : 0;

    elements.workSummary.innerHTML = `
      <div class="hw-metric">
        <span>班级学生</span>
        <strong>${summary.studentCount}</strong>
      </div>
      <div class="hw-metric">
        <span>已上传</span>
        <strong>${summary.submittedCount}</strong>
      </div>
      <div class="hw-metric">
        <span>已批改</span>
        <strong>${summary.gradedCount}</strong>
      </div>
      <div class="hw-metric">
        <span>平均得分率</span>
        <strong>${formatPercent(averageRate)}</strong>
      </div>
      <div class="hw-metric hw-metric-action">
        <span>本次作业</span>
        <button class="ghost-button" type="button" data-action="open-analysis">查看学情分析</button>
      </div>
    `;
  }

  function renderStudentCards() {
    const overview = state.overview;

    if (!overview) {
      elements.studentCardGrid.innerHTML = "";
      return;
    }

    if (!overview.exam.classId) {
      elements.studentCardGrid.innerHTML = '<p class="empty-text">当前作业没有绑定班级，请先在作业设置中选择班级。</p>';
      return;
    }

    if (!overview.students.length) {
      elements.studentCardGrid.innerHTML = '<p class="empty-text">该班级暂无学生，请先导入名单。</p>';
      return;
    }

    elements.studentCardGrid.innerHTML = overview.students
      .map(
        (student) => `
          <button class="student-card ${student.id === state.activeStudentId ? "is-active" : ""}" type="button" data-student-id="${escapeHtml(student.id)}">
            <span class="student-card-top">
              <strong>${escapeHtml(student.name)}</strong>
              <span class="status-badge status-${escapeHtml(student.status)}">${statusLabel(student.status)}</span>
            </span>
            <span class="student-card-meta">${escapeHtml(student.studentNo || "无学号")}</span>
            <span class="student-card-score">
              ${
                student.status === "graded" || student.resultCount > 0
                  ? `${formatNumber(student.totalScore)} / ${formatNumber(student.maxScore)} 分`
                  : "点击进入批改"
              }
            </span>
            ${
              student.wrongCount
                ? `<span class="student-card-wrong">${student.wrongCount} 题未全对</span>`
                : ""
            }
          </button>
        `
      )
      .join("");
  }

  function resetPreview() {
    state.pendingImage = "";
    elements.workImageInput.value = "";
    elements.workPreview.hidden = true;
    elements.workPreview.removeAttribute("src");
    elements.workPreviewWrap.querySelector("span").hidden = false;
    elements.workPreviewWrap.querySelector("span").textContent = "尚未选择作业图片";
    elements.gradeStudentButton.disabled = true;
  }

  function updateStudentHeader(student) {
    elements.workStudentName.textContent = student.name;
    elements.workStudentMeta.textContent = `${student.studentNo || "无学号"}｜${statusLabel(student.status)}｜${formatNumber(
      student.totalScore
    )} / ${formatNumber(student.maxScore)} 分`;
  }

  function closeStudentPanel() {
    state.activeStudentId = "";
    elements.studentWorkPanel.hidden = true;
    resetPreview();
    setWorkStatus("等待上传作业图片");
    elements.studentResultArea.innerHTML =
      '<p class="empty-text">批改后在这里查看每题对错和 AI 分析。</p>';
    $$(".student-card").forEach((card) => card.classList.remove("is-active"));
  }

  async function openStudent(studentId) {
    const student = state.overview?.students.find((item) => item.id === studentId);

    if (!student) {
      return;
    }

    state.activeStudentId = studentId;
    elements.studentWorkPanel.hidden = false;
    elements.studentWorkPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    updateStudentHeader(student);
    resetPreview();
    $$(".student-card").forEach((card) => {
      card.classList.toggle("is-active", card.dataset.studentId === studentId);
    });

    if (state.overview?.batch) {
      setWorkStatus("正在读取历史批改结果");
      await loadSubmission();
    } else {
      setWorkStatus("请拍照或上传学生作业");
      elements.studentResultArea.innerHTML =
        '<p class="empty-text">尚未批改，请拍照或上传作业后点击“开始批改”。</p>';
    }
  }

  function getResultBadge(score, maxScore) {
    if (score === null || score === undefined) {
      return { label: "未批改", className: "pending" };
    }

    const numericScore = Number(score);
    const numericMax = Number(maxScore);

    if (numericScore >= numericMax - 0.001) {
      return { label: "正确", className: "correct" };
    }

    if (numericScore <= 0.001) {
      return { label: "错误", className: "wrong" };
    }

    return { label: "部分正确", className: "partial" };
  }

  function renderSubmission(submission) {
    const progress = submission.progress || { total: 0, done: 0, failed: 0 };
    const gradedCount = submission.results.length;
    const totalQuestions = gradedCount + submission.missingQuestions.length;

    if (progress.failed) {
      setWorkStatus(`共 ${totalQuestions} 题，已批改 ${gradedCount} 题，${progress.failed} 题评分失败`);
    } else if (submission.missingQuestions.length) {
      setWorkStatus(`共 ${totalQuestions} 题，已批改 ${gradedCount} 题，还有 ${submission.missingQuestions.length} 题未批改`);
    } else {
      setWorkStatus(`批改完成：共 ${gradedCount} 题，总分 ${formatNumber(submission.totalScore)} / ${formatNumber(submission.maxScore)}`);
    }

    const resultCards = submission.results
      .map((result) => {
        const badge = getResultBadge(result.score, result.maxScore);
        const knowledgePoints = (result.knowledgePoints || []).join("、") || "未标注知识点";
        const deductions = (result.deductions || [])
          .map((item) => `<li>${escapeHtml(item)}</li>`)
          .join("");
        const suggestions = (result.suggestions || [])
          .map((item) => `<li>${escapeHtml(item)}</li>`)
          .join("");

        return `
          <article class="graded-card">
            <header>
              <div>
                <strong>${escapeHtml(result.questionNo)}｜${escapeHtml(result.questionType || "未标注题型")}</strong>
                <span>${escapeHtml(knowledgePoints)}</span>
              </div>
              <span class="result-badge result-${badge.className}">${badge.label}</span>
            </header>
            <div class="graded-score">
              <strong>${result.score === null ? "-" : formatNumber(result.score)}</strong>
              <span>/ ${formatNumber(result.maxScore)} 分</span>
              ${result.level ? `<em>${escapeHtml(result.level)}</em>` : ""}
            </div>
            ${
              result.answerImage
                ? `<img class="graded-image" src="${result.answerImage}" alt="${escapeHtml(result.questionNo)}学生作答" loading="lazy" />`
                : ""
            }
            ${result.analysis ? `<p class="graded-analysis">${escapeHtml(result.analysis)}</p>` : ""}
            ${
              deductions
                ? `<div class="graded-block"><span>扣分点</span><ul>${deductions}</ul></div>`
                : ""
            }
            ${
              suggestions
                ? `<div class="graded-block"><span>改进建议</span><ul>${suggestions}</ul></div>`
                : ""
            }
          </article>
        `;
      })
      .join("");

    const missingCards = submission.missingQuestions
      .map(
        (question) => `
          <article class="graded-card is-pending">
            <header>
              <div>
                <strong>${escapeHtml(question.questionNo)}｜${escapeHtml(question.questionType || "未标注题型")}</strong>
                <span>${(question.knowledgePoints || []).join("、") || "未标注知识点"}</span>
              </div>
              <span class="result-badge result-pending">未批改</span>
            </header>
            <p class="graded-analysis">该题尚未生成批改结果，可重新上传后批改。</p>
          </article>
        `
      )
      .join("");

    elements.studentResultArea.innerHTML = `
      <div class="submission-summary">
        <div>
          <span>学生总分</span>
          <strong>${formatNumber(submission.totalScore)} / ${formatNumber(submission.maxScore)}</strong>
        </div>
        <div>
          <span>已批改题目</span>
          <strong>${gradedCount} / ${totalQuestions}</strong>
        </div>
      </div>
      <div class="graded-list">
        ${resultCards || '<p class="empty-text">暂无批改结果</p>'}
        ${missingCards}
      </div>
    `;
  }

  async function loadSubmission() {
    if (!state.overview?.batch || !state.activeStudentId) {
      return;
    }

    try {
      const submission = await apiRequest(
        `student-submission&batchId=${encodeURIComponent(state.overview.batch.id)}&studentId=${encodeURIComponent(
          state.activeStudentId
        )}&includeImages=1`,
        { cache: "no-store" }
      );
      renderSubmission(submission);
    } catch (error) {
      setWorkStatus(error.message);
    }
  }

  function setPendingImage(image) {
    state.pendingImage = image;
    elements.workPreview.src = image;
    elements.workPreview.hidden = false;
    const placeholder = elements.workPreviewWrap.querySelector("span");
    placeholder.hidden = true;
    elements.gradeStudentButton.disabled = false;
    setWorkStatus("已选择作业图片，点击“开始批改”");
  }

  async function handleWorkImage(event) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    try {
      setPendingImage(await readFileAsDataUrl(file));
    } catch {
      alert("图片读取失败，请重新选择。");
    }
  }

  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      elements.workImageInput.click();
      return;
    }

    elements.cameraModal.hidden = false;
    elements.cameraHint.textContent = "正在打开摄像头…";

    try {
      state.captureStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      elements.cameraVideo.srcObject = state.captureStream;
      elements.cameraHint.textContent = "请将作业完整放入画面";
    } catch {
      closeCamera();
      alert("无法打开摄像头，将改用文件选择和系统拍照。");
      elements.workImageInput.click();
    }
  }

  function closeCamera() {
    if (state.captureStream) {
      state.captureStream.getTracks().forEach((track) => track.stop());
      state.captureStream = null;
    }

    elements.cameraVideo.srcObject = null;
    elements.cameraModal.hidden = true;
  }

  function capturePhoto() {
    const video = elements.cameraVideo;

    if (!video.videoWidth || !video.videoHeight) {
      alert("摄像头画面还没有准备好，请稍后再试。");
      return;
    }

    const canvas = elements.captureCanvas;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    setPendingImage(canvas.toDataURL("image/jpeg", 0.9));
    closeCamera();
  }

  async function gradeSelectedStudent() {
    if (state.grading || !state.pendingImage || !state.activeStudentId || !state.activeExamId) {
      return;
    }

    const student = state.overview?.students.find((item) => item.id === state.activeStudentId);

    if (!student) {
      return;
    }

    state.grading = true;
    elements.gradeStudentButton.disabled = true;
    setWorkStatus("正在上传作业并按模板裁题…");

    try {
      const processResult = await apiRequest("grade-student", {
        method: "POST",
        body: JSON.stringify({
          examId: state.activeExamId,
          studentId: state.activeStudentId,
          name: `${student.name}-作业`,
          image: state.pendingImage,
        }),
      });

      if (!processResult.jobCount) {
        throw new Error("没有生成可批改的题目，请检查模板区域是否覆盖题目。");
      }

      setWorkStatus(`已生成 ${processResult.jobCount} 个题目任务，开始 AI 批改…`);
      let failedCount = 0;
      let loops = 0;

      while (loops < 100) {
        loops += 1;
        const payload = await apiRequest("grade-next", {
          method: "POST",
          body: JSON.stringify({
            batchId: processResult.batchId,
            studentId: state.activeStudentId,
          }),
        });
        const progress = payload.studentProgress;

        if (progress) {
          setWorkStatus(
            `批改中 ${progress.done + progress.failed} / ${progress.total}${
              progress.failed ? `，失败 ${progress.failed}` : ""
            }`
          );
        }

        if (payload.failed) {
          failedCount += 1;
        }

        if (payload.done) {
          break;
        }
      }

      await loadSubmission();
      await loadWorkOverview();
      state.pendingImage = "";
      elements.workPreview.hidden = true;
      elements.workPreview.removeAttribute("src");
      const placeholder = elements.workPreviewWrap.querySelector("span");
      placeholder.hidden = false;
      placeholder.textContent = "如需重新批改，请重新拍照或上传";
      elements.gradeStudentButton.disabled = true;

      if (failedCount) {
        alert(`批改完成，但有 ${failedCount} 个题目评分失败，可重新批改。`);
      }
    } catch (error) {
      alert(error.message);
      setWorkStatus(error.message);
    } finally {
      state.grading = false;
      elements.gradeStudentButton.disabled = !state.pendingImage;
    }
  }

  async function loadBatchAnalysis() {
    if (!state.activeExamId) {
      elements.assignmentAnalysis.innerHTML = '<p class="empty-text">请先在作业设置中新建作业。</p>';
      return;
    }

    try {
      if (!state.overview || state.overview.exam?.id !== state.activeExamId) {
        state.overview = await apiRequest(
          `assignment-overview&examId=${encodeURIComponent(state.activeExamId)}`,
          { cache: "no-store" }
        );
        renderWorkSummary();
        renderStudentCards();
      }

      if (!state.overview.batch) {
        elements.assignmentAnalysis.innerHTML =
          '<p class="empty-text">当前作业还没有学生提交，完成批改后即可查看学情分析。</p>';
        return;
      }

      const data = await apiRequest(
        `batch-analysis&batchId=${encodeURIComponent(state.overview.batch.id)}`,
        { cache: "no-store" }
      );
      state.lastBatchAnalysis = data;
      renderBatchAnalysis(data);
    } catch (error) {
      elements.assignmentAnalysis.innerHTML = `<p class="empty-text">${escapeHtml(error.message)}</p>`;
    }
  }

  function renderBatchAnalysis(data) {
    if (!data.overview.gradedResultCount) {
      elements.assignmentAnalysis.innerHTML =
        '<p class="empty-text">本次作业还没有批改结果，请先完成学生批改。</p>';
      return;
    }

    const metrics = `
      <div class="hw-metrics">
        <div class="hw-metric"><span>参与学生</span><strong>${data.overview.studentCount}</strong></div>
        <div class="hw-metric"><span>完成批改</span><strong>${data.overview.gradedStudentCount}</strong></div>
        <div class="hw-metric"><span>整体得分率</span><strong>${formatPercent(data.overview.rate)}</strong></div>
        <div class="hw-metric"><span>及格率</span><strong>${formatPercent(data.overview.passRate)}</strong></div>
        <div class="hw-metric"><span>未全对作答</span><strong>${data.overview.wrongResultCount}</strong></div>
      </div>
    `;

    const distribution = `
      <div class="hw-subsection">
        <div class="hw-section-title">成绩分布</div>
        <div class="distribution-list">
          ${data.distribution
            .map(
              (item) => `
                <div class="distribution-item">
                  <span>${escapeHtml(item.label)}</span>
                  <div class="hw-bar"><i style="width: ${
                    data.overview.gradedStudentCount
                      ? Math.round((item.count / data.overview.gradedStudentCount) * 100)
                      : 0
                  }%"></i></div>
                  <strong>${item.count}</strong>
                </div>
              `
            )
            .join("")}
        </div>
      </div>
    `;

    const questionRows = data.questions
      .map((question) => {
        const wrongStudents = question.wrongStudents.length
          ? question.wrongStudents
              .map(
                (student) =>
                  `<span class="wrong-chip">${escapeHtml(student.studentName)} ${formatNumber(student.score)}/${formatNumber(
                    student.maxScore
                  )}</span>`
              )
              .join("")
          : '<span class="hw-ok-text">全部正确</span>';

        return `
          <tr>
            <td>
              <strong>${escapeHtml(question.questionNo)}</strong>
              <div class="hw-muted">${escapeHtml(question.questionType || "未标注题型")}</div>
            </td>
            <td>${(question.knowledgePoints || []).map((item) => `<span class="kp-chip">${escapeHtml(item)}</span>`).join("") || "未标注"}</td>
            <td>${formatNumber(question.maxScore)}</td>
            <td>${question.gradedCount}</td>
            <td><strong class="${question.wrongCount ? "text-danger" : ""}">${question.wrongCount}</strong></td>
            <td>${formatNumber(question.avgScore)}</td>
            <td><div class="wrong-chip-list">${wrongStudents}</div></td>
          </tr>
        `;
      })
      .join("");

    const knowledgeCards = data.knowledgePoints.length
      ? data.knowledgePoints
          .map(
            (knowledgePoint) => `
              <div class="kp-stat-card kp-${escapeHtml(knowledgePoint.classification)}">
                <div class="kp-stat-head">
                  <strong>${escapeHtml(knowledgePoint.name)}</strong>
                  <span class="kp-rate">${formatPercent(knowledgePoint.rate)}</span>
                </div>
                <div class="hw-bar"><i style="width: ${Math.round(knowledgePoint.rate * 100)}%"></i></div>
                <div class="kp-stat-meta">
                  <span>${knowledgePoint.questionCount} 道题｜${knowledgePoint.attempts} 次作答</span>
                  <span>${knowledgePoint.wrongCount} 次未全对</span>
                </div>
                ${
                  knowledgePoint.wrongStudents.length
                    ? `<div class="kp-wrong-names">未掌握学生：${knowledgePoint.wrongStudents
                        .map((name) => escapeHtml(name))
                        .join("、")}</div>`
                    : '<div class="kp-wrong-names">暂无错误学生</div>'
                }
              </div>
            `
          )
          .join("")
      : '<p class="empty-text">题目还没有标注知识点。</p>';

    const aiBlock = data.savedAnalysis
      ? renderAiSummary(data.savedAnalysis.summary, data.savedAnalysis.createdAt)
      : `
        <div class="ai-analysis-panel">
          <div>
            <strong>AI 错因分析</strong>
            <p>根据错误作答图片和每题批改结果，归纳可能错因与未掌握知识点。</p>
          </div>
          <button class="primary-button" type="button" data-action="analyze-batch">AI 分析可能错因</button>
        </div>
      `;

    elements.assignmentAnalysis.innerHTML = `
      ${metrics}
      ${distribution}
      <div class="hw-subsection">
        <div class="hw-section-title">逐题错误统计</div>
        <div class="result-table-wrap hw-table-wrap">
          <table class="result-table">
            <thead>
              <tr>
                <th>题目</th>
                <th>知识点</th>
                <th>满分</th>
                <th>已批改</th>
                <th>错误人数</th>
                <th>平均分</th>
                <th>错误学生</th>
              </tr>
            </thead>
            <tbody>${questionRows}</tbody>
          </table>
        </div>
      </div>
      <div class="hw-subsection">
        <div class="hw-section-title">知识点掌握情况</div>
        <div class="kp-grid">${knowledgeCards}</div>
      </div>
      <div class="hw-subsection">${aiBlock}</div>
    `;
  }

  function renderAiSummary(summary, createdAt) {
    const safeSummary = summary && typeof summary === "object" ? summary : {};
    const overview = String(safeSummary.overview || "");
    const questions = Array.isArray(safeSummary.questions) ? safeSummary.questions : [];
    const knowledgeGaps = Array.isArray(safeSummary.knowledgeGaps) ? safeSummary.knowledgeGaps : [];
    const teachingSuggestions = Array.isArray(safeSummary.teachingSuggestions)
      ? safeSummary.teachingSuggestions
      : [];

    return `
      <div class="ai-analysis-panel is-filled">
        <div class="ai-analysis-head">
          <div>
            <strong>AI 错因分析</strong>
            <p>生成时间：${escapeHtml(formatDate(createdAt))}</p>
          </div>
          <button class="ghost-button" type="button" data-action="analyze-batch">重新分析</button>
        </div>
        ${overview ? `<p class="ai-overview">${escapeHtml(overview)}</p>` : ""}
        ${
          questions.length
            ? `<div class="ai-question-list">
                ${questions
                  .map(
                    (question) => `
                      <div class="ai-question-item">
                        <strong>${escapeHtml(question.questionNo || "题目")}</strong>
                        ${
                          (question.errorCauses || []).length
                            ? `<ul>${question.errorCauses
                                .map((item) => `<li>${escapeHtml(item)}</li>`)
                                .join("")}</ul>`
                            : "<p>暂无错因描述</p>"
                        }
                        ${
                          (question.relatedKnowledgePoints || []).length
                            ? `<div class="ai-tags">${question.relatedKnowledgePoints
                                .map((item) => `<span class="kp-chip">${escapeHtml(item)}</span>`)
                                .join("")}</div>`
                            : ""
                        }
                        ${
                          (question.suggestions || []).length
                            ? `<div class="ai-suggestion">建议：${question.suggestions
                                .map((item) => escapeHtml(item))
                                .join("；")}</div>`
                            : ""
                        }
                      </div>
                    `
                  )
                  .join("")}
              </div>`
            : ""
        }
        ${
          knowledgeGaps.length
            ? `<div class="ai-gap-list">
                <div class="hw-section-title">未掌握知识点</div>
                ${knowledgeGaps
                  .map(
                    (gap) => `
                      <div class="ai-gap-item">
                        <strong>${escapeHtml(gap.knowledgePoint || "")}</strong>
                        <p>${escapeHtml(gap.reason || "")}</p>
                        ${gap.suggestion ? `<span>建议：${escapeHtml(gap.suggestion)}</span>` : ""}
                      </div>
                    `
                  )
                  .join("")}
              </div>`
            : ""
        }
        ${
          teachingSuggestions.length
            ? `<div class="ai-teaching">
                <div class="hw-section-title">教学建议</div>
                <ul>${teachingSuggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
              </div>`
            : ""
        }
      </div>
    `;
  }

  async function analyzeBatch() {
    const batchId = state.overview?.batch?.id || state.lastBatchAnalysis?.batch?.id;

    if (!batchId) {
      alert("当前作业还没有可分析的批次。");
      return;
    }

    const button = elements.assignmentAnalysis.querySelector('[data-action="analyze-batch"]');

    if (button) {
      button.disabled = true;
      button.textContent = "AI 分析中，请稍候…";
    }

    try {
      await apiRequest("analyze-batch", {
        method: "POST",
        body: JSON.stringify({ batchId }),
      });
      await loadBatchAnalysis();
    } catch (error) {
      alert(error.message);
      if (button) {
        button.disabled = false;
        button.textContent = "AI 分析可能错因";
      }
    }
  }

  function updateHistoryMode() {
    state.historyMode = document.querySelector('input[name="historyMode"]:checked')?.value || "student";
    elements.historyStudentSelect.hidden = state.historyMode !== "student";
    renderHistoryStudentSelect();
  }

  function renderHistoryStudentSelect() {
    const classId = elements.historyClassSelect?.value || "";
    const students = classId
      ? state.students.filter((student) => student.classId === classId)
      : state.students;
    fillSelect(
      elements.historyStudentSelect,
      students,
      (student) => `${student.name}${student.studentNo ? `｜${student.studentNo}` : ""}`,
      "请选择学生",
      true
    );
  }

  async function loadHistory() {
    const mode = document.querySelector('input[name="historyMode"]:checked')?.value || "student";
    const classId = elements.historyClassSelect.value;
    const studentId = elements.historyStudentSelect.value;

    if (mode === "student" && !studentId) {
      alert("请选择学生。");
      return;
    }

    if (mode === "class" && !classId) {
      alert("请选择班级。");
      return;
    }

    elements.loadHistoryButton.disabled = true;
    elements.historyAnalysis.innerHTML = '<p class="empty-text">正在分析历史作业…</p>';

    try {
      if (mode === "student") {
        const data = await apiRequest(`student-history&studentId=${encodeURIComponent(studentId)}`, {
          cache: "no-store",
        });
        renderStudentHistory(data);
      } else {
        const data = await apiRequest(`class-history&classId=${encodeURIComponent(classId)}`, {
          cache: "no-store",
        });
        renderClassHistory(data);
      }
    } catch (error) {
      elements.historyAnalysis.innerHTML = `<p class="empty-text">${escapeHtml(error.message)}</p>`;
    } finally {
      elements.loadHistoryButton.disabled = false;
    }
  }

  function renderBucketColumn(title, items, tone) {
    return `
      <div class="history-bucket bucket-${tone}">
        <header>
          <strong>${escapeHtml(title)}</strong>
          <span>${items.length}</span>
        </header>
        <div class="bucket-items">
          ${
            items.length
              ? items
                  .map(
                    (item) => `
                      <div class="bucket-item">
                        <div>
                          <strong>${escapeHtml(item.name)}</strong>
                          <span>${item.questionCount} 题｜${item.attempts} 次作答</span>
                        </div>
                        <em>${formatPercent(item.rate)}</em>
                      </div>
                    `
                  )
                  .join("")
              : '<p class="empty-text">暂无</p>'
          }
        </div>
      </div>
    `;
  }

  function renderStudentHistory(data) {
    if (!data.overview.questionCount) {
      elements.historyAnalysis.innerHTML = '<p class="empty-text">该学生还没有已批改的历史作业。</p>';
      return;
    }

    const recentExamRows = data.recentExams
      .map(
        (exam) => `
          <tr>
            <td>${escapeHtml(exam.name)}</td>
            <td>${escapeHtml(exam.subject || "-")}</td>
            <td>${escapeHtml(formatDate(exam.examDate))}</td>
            <td>${exam.questionCount}</td>
            <td>${formatNumber(exam.achieved)} / ${formatNumber(exam.max)}</td>
            <td>${formatPercent(exam.rate)}</td>
          </tr>
        `
      )
      .join("");

    const weakQuestionRows = data.weakQuestions.length
      ? data.weakQuestions
          .map(
            (question) => `
              <tr>
                <td>${escapeHtml(question.examName)}</td>
                <td>${escapeHtml(question.questionNo)}</td>
                <td>${escapeHtml(question.questionType || "未标注")}</td>
                <td>${(question.knowledgePoints || []).map((item) => `<span class="kp-chip">${escapeHtml(item)}</span>`).join("") || "-"}</td>
                <td>${formatNumber(question.score)} / ${formatNumber(question.maxScore)}</td>
                <td>${formatPercent(question.rate)}</td>
              </tr>
            `
          )
          .join("")
      : '<tr><td colspan="6">暂无明显薄弱题目</td></tr>';

    elements.historyAnalysis.innerHTML = `
      <div class="history-headline">
        <div>
          <strong>${escapeHtml(data.student.name)}</strong>
          <span>${escapeHtml(data.student.className || "未分班")}｜${escapeHtml(data.student.studentNo || "无学号")}</span>
        </div>
        <p>按多次历史作业的得分率聚合，掌握度分档：≥85% 完全掌握，45%-85% 尚未熟练掌握，&lt;45% 完全不会。</p>
      </div>
      <div class="hw-metrics">
        <div class="hw-metric"><span>历史作业</span><strong>${data.overview.examCount}</strong></div>
        <div class="hw-metric"><span>批改题目</span><strong>${data.overview.questionCount}</strong></div>
        <div class="hw-metric"><span>整体得分率</span><strong>${formatPercent(data.overview.rate)}</strong></div>
        <div class="hw-metric"><span>薄弱题目</span><strong>${data.weakQuestions.length}</strong></div>
      </div>
      <div class="hw-subsection">
        <div class="hw-section-title">知识点掌握分档</div>
        <div class="history-bucket-grid">
          ${renderBucketColumn("完全掌握", data.buckets.mastered, "mastered")}
          ${renderBucketColumn("尚未熟练掌握", data.buckets.developing, "developing")}
          ${renderBucketColumn("完全不会", data.buckets.weak, "weak")}
        </div>
      </div>
      <div class="hw-subsection">
        <div class="hw-section-title">题型掌握分档</div>
        <div class="history-bucket-grid">
          ${renderBucketColumn("完全掌握", data.typeBuckets.mastered, "mastered")}
          ${renderBucketColumn("尚未熟练掌握", data.typeBuckets.developing, "developing")}
          ${renderBucketColumn("完全不会", data.typeBuckets.weak, "weak")}
        </div>
      </div>
      <div class="hw-subsection">
        <div class="hw-section-title">历史作业表现</div>
        <div class="result-table-wrap hw-table-wrap">
          <table class="result-table">
            <thead><tr><th>作业</th><th>科目</th><th>日期</th><th>题数</th><th>得分</th><th>得分率</th></tr></thead>
            <tbody>${recentExamRows}</tbody>
          </table>
        </div>
      </div>
      <div class="hw-subsection">
        <div class="hw-section-title">薄弱题目</div>
        <div class="result-table-wrap hw-table-wrap">
          <table class="result-table">
            <thead><tr><th>作业</th><th>题号</th><th>题型</th><th>知识点</th><th>得分</th><th>得分率</th></tr></thead>
            <tbody>${weakQuestionRows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderClassHistory(data) {
    if (!data.overview.resultCount) {
      elements.historyAnalysis.innerHTML = '<p class="empty-text">该班级还没有已批改的历史作业。</p>';
      return;
    }

    const knowledgeRows = data.knowledgePoints
      .map(
        (item) => `
          <tr>
            <td><strong>${escapeHtml(item.name)}</strong><div class="hw-muted">${item.questionCount} 题</div></td>
            <td>
              <div class="hw-bar"><i style="width: ${Math.round(item.rate * 100)}%"></i></div>
              <span class="hw-muted">${formatPercent(item.rate)}</span>
            </td>
            <td><span class="class-label ${
              item.label === "大部分学生已掌握"
                ? "label-good"
                : item.label === "大部分学生还未掌握"
                  ? "label-bad"
                  : "label-mid"
            }">${escapeHtml(item.label)}</span></td>
            <td>${item.masteredCount} / ${item.studentCount}</td>
            <td>
              <details>
                <summary>${item.weakCount} 人未掌握</summary>
                <p>${item.weakStudents.length ? item.weakStudents.map((name) => escapeHtml(name)).join("、") : "暂无"}</p>
              </details>
            </td>
          </tr>
        `
      )
      .join("");

    const typeRows = data.questionTypes
      .map(
        (item) => `
          <tr>
            <td><strong>${escapeHtml(item.name)}</strong></td>
            <td>${formatPercent(item.rate)}</td>
            <td>${item.masteredCount} / ${item.studentCount}</td>
            <td>${item.weakCount} 人</td>
            <td>${escapeHtml(item.label)}</td>
          </tr>
        `
      )
      .join("");

    const studentRows = data.students
      .map(
        (student) => `
          <tr>
            <td><strong>${escapeHtml(student.name)}</strong><div class="hw-muted">${escapeHtml(student.studentNo || "无学号")}</div></td>
            <td>${formatNumber(student.achieved)} / ${formatNumber(student.max)}</td>
            <td>${formatPercent(student.rate)}</td>
            <td>${student.weakKnowledgePoints.length ? student.weakKnowledgePoints.map((item) => `<span class="kp-chip kp-chip-weak">${escapeHtml(item)}</span>`).join("") : "无"}</td>
            <td>${student.masteredKnowledgePoints.length ? student.masteredKnowledgePoints.map((item) => `<span class="kp-chip">${escapeHtml(item)}</span>`).join("") : "无"}</td>
          </tr>
        `
      )
      .join("");

    elements.historyAnalysis.innerHTML = `
      <div class="history-headline">
        <div>
          <strong>${escapeHtml(data.classInfo.name)}</strong>
          <span>${escapeHtml(data.classInfo.grade || "未填年级")}</span>
        </div>
        <p>按班级所有学生的历史批改结果聚合，判断知识点是“大部分学生已掌握”还是“大部分学生还未掌握”。</p>
      </div>
      <div class="hw-metrics">
        <div class="hw-metric"><span>学生数</span><strong>${data.overview.studentCount}</strong></div>
        <div class="hw-metric"><span>历史作业</span><strong>${data.overview.examCount}</strong></div>
        <div class="hw-metric"><span>批改题目</span><strong>${data.overview.resultCount}</strong></div>
        <div class="hw-metric"><span>整体得分率</span><strong>${formatPercent(data.overview.rate)}</strong></div>
      </div>
      <div class="hw-subsection">
        <div class="hw-section-title">全班知识点掌握情况</div>
        <div class="result-table-wrap hw-table-wrap">
          <table class="result-table">
            <thead><tr><th>知识点</th><th>掌握率</th><th>结论</th><th>已掌握人数</th><th>学生明细</th></tr></thead>
            <tbody>${knowledgeRows}</tbody>
          </table>
        </div>
      </div>
      <div class="hw-subsection">
        <div class="hw-section-title">全班题型掌握情况</div>
        <div class="result-table-wrap hw-table-wrap">
          <table class="result-table">
            <thead><tr><th>题型</th><th>掌握率</th><th>已掌握人数</th><th>未掌握人数</th><th>结论</th></tr></thead>
            <tbody>${typeRows}</tbody>
          </table>
        </div>
      </div>
      <div class="hw-subsection">
        <div class="hw-section-title">学生整体表现</div>
        <div class="result-table-wrap hw-table-wrap">
          <table class="result-table">
            <thead><tr><th>学生</th><th>得分</th><th>得分率</th><th>未掌握知识点</th><th>已掌握知识点</th></tr></thead>
            <tbody>${studentRows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderQuickPreview(target) {
    const image = target === "question" ? state.quickQuestion : state.quickAnswer;
    const container = target === "question" ? elements.quickQuestionPreview : elements.quickAnswerPreview;

    if (!image) {
      container.innerHTML = `<p class="empty-text">${target === "question" ? "尚未选择题图" : "尚未选择作答图"}</p>`;
      return;
    }

    container.innerHTML = `
      <img src="${image.src}" alt="${escapeHtml(image.name)}" />
      <div>
        <strong>${escapeHtml(image.name)}</strong>
        <span>本次上传</span>
      </div>
    `;
  }

  function updateQuickState() {
    if (state.quickBusy) {
      return;
    }

    const maxScore = Number(elements.quickMaxScore.value);
    const ready = Boolean(state.quickQuestion && state.quickAnswer && Number.isFinite(maxScore) && maxScore > 0);
    elements.quickGradeButton.disabled = !ready;

    if (!state.quickQuestion) {
      elements.quickStatusText.textContent = "请上传试题图片";
    } else if (!state.quickAnswer) {
      elements.quickStatusText.textContent = "请上传学生作答图片";
    } else if (!Number.isFinite(maxScore) || maxScore <= 0) {
      elements.quickStatusText.textContent = "请填写大于 0 的满分";
    } else {
      elements.quickStatusText.textContent = "可以开始 AI 批改";
    }
  }

  async function handleQuickImage(event, target) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      const compressed = await compressImageDataUrl(dataUrl);
      const image = { name: file.name, src: compressed };

      if (target === "question") {
        state.quickQuestion = image;
        elements.quickQuestionFileName.textContent = file.name;
      } else {
        state.quickAnswer = image;
        elements.quickAnswerFileName.textContent = file.name;
      }

      renderQuickPreview(target);
      updateQuickState();
    } catch (error) {
      alert(error.message || "图片读取失败。");
    } finally {
      event.target.value = "";
    }
  }

  function renderQuickResult(result, rawContent) {
    const deductions = Array.isArray(result?.deductions) ? result.deductions : [];
    const suggestions = Array.isArray(result?.suggestions) ? result.suggestions : [];

    if (!result) {
      elements.quickResultArea.innerHTML = `
        <article class="ai-result-card is-error">
          <h3>AI 返回内容未能解析</h3>
          <pre>${escapeHtml(rawContent || "AI 没有返回评分内容，请确认服务端配置的是支持图片输入的视觉模型。")}</pre>
        </article>
      `;
      return;
    }

    const maxScore = result.max_score ?? elements.quickMaxScore.value;
    const hasComment = Boolean(result.analysis || deductions.length || suggestions.length);

    elements.quickResultArea.innerHTML = `
      <article class="ai-score-card">
        <span>AI 评分</span>
        <strong>${escapeHtml(result.score ?? "-")} / ${escapeHtml(maxScore)}</strong>
        <small>${escapeHtml(result.level || "AI 评分建议")}</small>
      </article>
      ${result.analysis ? `<article class="ai-result-card"><h3>评语</h3><p>${escapeHtml(result.analysis)}</p></article>` : ""}
      ${deductions.length ? `<article class="ai-result-card"><h3>扣分点</h3><ul>${deductions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></article>` : ""}
      ${suggestions.length ? `<article class="ai-result-card"><h3>改进建议</h3><ul>${suggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></article>` : ""}
      ${
        hasComment
          ? ""
          : `<article class="ai-result-card"><h3>AI 原始返回</h3><pre>${escapeHtml(rawContent || "暂无点评内容。")}</pre></article>`
      }
    `;
  }

  async function handleQuickGrade() {
    if (state.quickBusy) {
      return;
    }

    if (!state.quickQuestion || !state.quickAnswer) {
      alert("请先上传试题和学生作答图片。");
      return;
    }

    const maxScore = Number(elements.quickMaxScore.value);

    if (!Number.isFinite(maxScore) || maxScore <= 0) {
      alert("请填写大于 0 的满分。");
      return;
    }

    state.quickBusy = true;
    elements.quickGradeButton.disabled = true;
    elements.quickGradeButton.textContent = "AI 批改中...";
    elements.quickStatusText.textContent = "正在调用 DeepSeek 分析试题与作答";
    elements.quickResultArea.innerHTML = '<p class="empty-text">正在分析作答，请稍候...</p>';

    try {
      const response = await fetch("/api/ai-grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionImage: state.quickQuestion.src,
          questionName: state.quickQuestion.name,
          questionKind: "single_question",
          answerImage: state.quickAnswer.src,
          answerName: state.quickAnswer.name,
          maxScore,
          rubric: elements.quickRubric.value.trim(),
        }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.message || `AI 批改请求失败：HTTP ${response.status}`);
      }

      renderQuickResult(payload.result, payload.rawContent);
      elements.quickStatusText.textContent = payload.historyError
        ? `批改完成，历史保存失败（${payload.model || "AI"}）`
        : `批改完成，已保存历史（${payload.model || "AI"}）`;
    } catch (error) {
      elements.quickResultArea.innerHTML = `
        <article class="ai-result-card is-error">
          <h3>无法完成 AI 批改</h3>
          <p>${escapeHtml(error.message || "请检查网络连接或稍后重试。")}</p>
        </article>
      `;
      elements.quickStatusText.textContent = "批改失败";
    } finally {
      state.quickBusy = false;
      elements.quickGradeButton.textContent = "开始 AI 批改";
      const latestMaxScore = Number(elements.quickMaxScore.value);
      elements.quickGradeButton.disabled = !(
        state.quickQuestion &&
        state.quickAnswer &&
        Number.isFinite(latestMaxScore) &&
        latestMaxScore > 0
      );
    }
  }

  function bindEvents() {
    bindForm(elements.classForm, "create-class", null, async (payload) => {
      window.AppAuth?.setDefaultClassId?.(payload.classItem.id);
      await loadBootstrap();
    });
    bindForm(elements.examForm, "create-exam", null, async (payload) => {
      state.activeExamId = payload.exam.id;
      await loadBootstrap();
    });
    bindForm(
      elements.questionForm,
      "create-question",
      () => ({ examId: state.activeExamId }),
      async () => {
        await loadBootstrap();
        await loadExamScope(state.activeExamId);
      }
    );

    elements.importForm.addEventListener("submit", handleImportStudents);
    elements.importFile.addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      elements.importFileName.textContent = file ? file.name : "支持 .xlsx、.xls、.csv";
    });

    elements.refreshButton.addEventListener("click", () => {
      loadBootstrap().catch((error) => alert(error.message));
    });

    $$(".hw-tab").forEach((tab) => {
      tab.addEventListener("click", () => switchView(tab.dataset.view));
    });

    $$('[data-select="exams"]').forEach((select) => {
      select.addEventListener("change", () => {
        handleExamChange(select.value).catch((error) => alert(error.message));
      });
    });

    elements.templateUpload.addEventListener("change", handleTemplateUpload);
    elements.saveRegionButton.addEventListener("click", handleSaveRegion);
    elements.regionQuestionSelect.addEventListener("change", () => {
      elements.saveRegionButton.disabled = !state.templateSelection || !elements.regionQuestionSelect.value;
    });

    elements.examList.addEventListener("click", (event) => {
      const item = event.target.closest("[data-exam-id]");

      if (item) {
        handleExamChange(item.dataset.examId).catch((error) => alert(error.message));
      }
    });

    elements.workRefreshButton.addEventListener("click", () => {
      loadWorkOverview().catch((error) => alert(error.message));
    });

    elements.studentCardGrid.addEventListener("click", (event) => {
      const card = event.target.closest("[data-student-id]");

      if (card) {
        openStudent(card.dataset.studentId).catch((error) => alert(error.message));
      }
    });

    elements.workSummary.addEventListener("click", (event) => {
      if (event.target.closest('[data-action="open-analysis"]')) {
        switchView("analysis");
      }
    });

    elements.closeWorkPanel.addEventListener("click", closeStudentPanel);
    elements.workImageInput.addEventListener("change", handleWorkImage);
    elements.cameraButton.addEventListener("click", openCamera);
    elements.closeCameraButton.addEventListener("click", closeCamera);
    elements.captureButton.addEventListener("click", capturePhoto);
    elements.gradeStudentButton.addEventListener("click", gradeSelectedStudent);

    elements.assignmentAnalysis.addEventListener("click", (event) => {
      if (event.target.closest('[data-action="analyze-batch"]')) {
        analyzeBatch();
      }
    });

    elements.loadAnalysisButton.addEventListener("click", () => {
      loadBatchAnalysis().catch((error) => alert(error.message));
    });

    $$('input[name="historyMode"]').forEach((radio) => {
      radio.addEventListener("change", updateHistoryMode);
    });
    elements.historyClassSelect.addEventListener("change", renderHistoryStudentSelect);
    elements.loadHistoryButton.addEventListener("click", loadHistory);

    elements.quickQuestionUpload.addEventListener("change", (event) => handleQuickImage(event, "question"));
    elements.quickAnswerUpload.addEventListener("change", (event) => handleQuickImage(event, "answer"));
    elements.quickMaxScore.addEventListener("input", updateQuickState);
    elements.quickGradeButton.addEventListener("click", handleQuickGrade);

    window.addEventListener("default-class-changed", (event) => {
      const classId = event.detail?.classId || "";

      if (classId === state.defaultClassId) {
        return;
      }

      state.defaultClassId = classId;
      renderCoreSelects();
      renderClassList();
      renderStudentRoster();
      const classExam = state.exams.find((exam) => exam.classId === classId);
      handleExamChange(classExam?.id || "").catch((error) => alert(error.message));
    });
  }

  setupTemplateSelection();
  bindEvents();
  updateHistoryMode();
  updateQuickState();

  const initialView = new URLSearchParams(window.location.search).get("view");
  const hasInitialView = ["setup", "work", "analysis", "quick"].includes(initialView);

  if (initialView === "quick") {
    switchView("quick");
  }

  loadBootstrap()
    .then(() => {
      if (hasInitialView && initialView !== "quick") {
        switchView(initialView);
      }
    })
    .catch((error) => {
      elements.assignmentAnalysis.innerHTML = `<p class="empty-text">${escapeHtml(error.message)}</p>`;
    });
})();
