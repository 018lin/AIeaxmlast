(function () {
  const state = {
    classes: [],
    students: [],
    exams: [],
    examProgress: {},
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
    view: "list",
    analysisTab: "students",
    lastBatchAnalysis: null,
    historyMode: "student",
    drawerMode: "create",
    wizardStep: 1,
    drawerTimer: null,
    examDrawerTimer: null,
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const elements = {
    className: $("#hwClassName"),
    classMeta: $("#hwClassMeta"),
    examCards: $("#hwExamCards"),
    listRefreshButton: $("#listRefreshButton"),
    newExamButton: $("#newExamButton"),
    examForm: $("#hwExamForm"),
    examClassHint: $("#hwExamClassHint"),
    examDrawer: $("#examDrawer"),
    examDrawerTitle: $("#examDrawerTitle"),
    examDrawerHint: $("#examDrawerHint"),
    wizardSteps: $("#wizardSteps"),
    questionForm: $("#hwQuestionForm"),
    questionList: $("#hwQuestionList"),
    wizardBackButton: $("#wizardBackButton"),
    wizardNextButton: $("#wizardNextButton"),
    wizardSkipTemplateButton: $("#wizardSkipTemplateButton"),
    wizardBackToQuestionsButton: $("#wizardBackToQuestionsButton"),
    wizardFinishButton: $("#wizardFinishButton"),
    templateUpload: $("#hwTemplateUpload"),
    templateFileName: $("#hwTemplateFileName"),
    templateStage: $("#hwTemplateStage"),
    templateImage: $("#hwTemplateImage"),
    regionQuestionSelect: $("#hwRegionQuestionSelect"),
    saveRegionButton: $("#hwSaveRegionButton"),
    regionList: $("#hwRegionList"),
    workHeaderTitle: $("#workHeaderTitle"),
    workHeaderMeta: $("#workHeaderMeta"),
    workExamSelect: $("#workExamSelect"),
    workRefreshButton: $("#workRefreshButton"),
    editExamButton: $("#editExamButton"),
    workSummary: $("#workSummary"),
    studentCardGrid: $("#studentCardGrid"),
    studentDrawer: $("#studentDrawer"),
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
    assignmentOverview: $("#assignmentOverview"),
    assignmentQuestions: $("#assignmentQuestions"),
    assignmentKnowledge: $("#assignmentKnowledge"),
    historyClassSelect: $("#historyClassSelect"),
    historyStudentSelect: $("#historyStudentSelect"),
    loadHistoryButton: $("#loadHistoryButton"),
    historyAnalysis: $("#historyAnalysis"),
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

  function renderClassContext() {
    const classItem = state.classes.find((item) => item.id === state.defaultClassId);
    const studentCount = state.students.filter((student) => student.classId === state.defaultClassId).length;

    elements.className.textContent = classItem ? classItem.name : "还没有班级";
    elements.classMeta.textContent = classItem
      ? `${studentCount} 名学生${classItem.grade ? ` · ${classItem.grade}` : ""}`
      : "去班级管理创建班级并导入名单";
  }

  function examStatusInfo(exam, progress) {
    const configured = exam.questionCount > 0 || (exam.knowledgePoints || []).length > 0;

    if (!configured) {
      return { label: "待完善", tone: "draft" };
    }

    if (!progress || !progress.studentCount) {
      return { label: "缺学生名单", tone: "muted" };
    }

    if (progress.gradedStudentCount >= progress.studentCount) {
      return { label: "已完成", tone: "graded" };
    }

    if (progress.submittedCount > 0) {
      return { label: "批改中", tone: "grading" };
    }

    return { label: "未开始", tone: "not_submitted" };
  }

  function renderExamCards() {
    if (!state.exams.length) {
      elements.examCards.innerHTML = `
        <div class="hw-empty-card">
          <strong>还没有作业</strong>
          <p>新建一份作业，只需填写名称、日期和知识点，即可开始拍照批改。</p>
          <button class="primary-button" type="button" data-exam-action="create">新建作业</button>
        </div>
      `;
      return;
    }

    elements.examCards.innerHTML = state.exams
      .map((exam) => {
        const progress = state.examProgress[exam.id] || null;
        const status = examStatusInfo(exam, progress);
        const studentCount = progress?.studentCount || 0;
        const gradedCount = progress?.gradedStudentCount || 0;
        const percent = studentCount ? Math.round((gradedCount / studentCount) * 100) : 0;
        const meta = [
          exam.className || "未绑定班级",
          exam.subject || "",
          exam.examDate ? formatDate(exam.examDate) : "",
          exam.questionCount ? `${exam.questionCount} 题` : "整卷 AI 批改",
          exam.totalScore ? `${formatNumber(exam.totalScore)} 分` : "",
        ]
          .filter(Boolean)
          .join(" · ");

        return `
          <article class="hw-exam-card ${exam.id === state.activeExamId ? "is-active" : ""}">
            <div class="hw-exam-main">
              <div class="hw-exam-title">
                <strong>${escapeHtml(exam.name)}</strong>
                <span class="status-badge status-${status.tone}">${status.label}</span>
              </div>
              <p class="hw-exam-meta">${escapeHtml(meta)}</p>
              <div class="hw-exam-progress">
                <div class="hw-bar"><i style="width: ${percent}%"></i></div>
                <span>${studentCount ? `已批改 ${gradedCount} / ${studentCount}` : "暂无学生名单"}</span>
              </div>
            </div>
            <div class="hw-exam-actions">
              <button class="primary-button" type="button" data-exam-action="work" data-exam-id="${escapeHtml(
                exam.id
              )}">继续批改</button>
              <button class="ghost-button" type="button" data-exam-action="analysis" data-exam-id="${escapeHtml(
                exam.id
              )}">查看分析</button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  async function loadExamProgress() {
    try {
      const payload = await apiRequest("exam-progress", { cache: "no-store" });
      state.examProgress = Object.fromEntries(
        (payload.progress || []).map((item) => [item.examId, item])
      );
    } catch {
      state.examProgress = {};
    }

    renderExamCards();
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
    renderClassContext();
    renderExamCards();
    await Promise.all([loadExamScope(state.activeExamId), loadExamProgress()]);

    if (state.overview && state.overview.exam?.id !== state.activeExamId) {
      state.overview = null;
      state.lastBatchAnalysis = null;
      closeStudentPanel();
    }
  }

  async function handleExamChange(examId) {
    state.activeExamId = examId || "";
    syncExamSelects();
    renderExamCards();
    state.overview = null;
    state.lastBatchAnalysis = null;
    closeStudentPanel();
    await loadExamScope(state.activeExamId);

    if (state.view === "assignment") {
      await loadAssignment();
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
    const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
    const MIN_SIZE = 20;
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    let drag = null;
    let box = null;
    let selection = null;

    function imagePoint(event) {
      const rect = elements.templateImage.getBoundingClientRect();

      return {
        x: clamp(event.clientX - rect.left, 0, rect.width),
        y: clamp(event.clientY - rect.top, 0, rect.height),
      };
    }

    function imageSize() {
      return {
        width: elements.templateImage.clientWidth,
        height: elements.templateImage.clientHeight,
        left: elements.templateImage.offsetLeft,
        top: elements.templateImage.offsetTop,
      };
    }

    function applyBox() {
      if (!box || !selection) {
        return;
      }

      const image = imageSize();
      Object.assign(box.style, {
        left: `${image.left + selection.left}px`,
        top: `${image.top + selection.top}px`,
        width: `${selection.width}px`,
        height: `${selection.height}px`,
      });
    }

    function commitSelection() {
      const image = imageSize();

      if (
        !selection ||
        !image.width ||
        !image.height ||
        selection.width < 8 ||
        selection.height < 8
      ) {
        state.templateSelection = null;
        elements.saveRegionButton.disabled = true;
        return;
      }

      state.templateSelection = {
        xRatio: clamp(selection.left / image.width, 0, 1),
        yRatio: clamp(selection.top / image.height, 0, 1),
        widthRatio: clamp(selection.width / image.width, 0, 1),
        heightRatio: clamp(selection.height / image.height, 0, 1),
      };
      elements.saveRegionButton.disabled = !elements.regionQuestionSelect.value;
    }

    function createBox() {
      box = document.createElement("div");
      box.className = "selection-box";
      box.innerHTML = HANDLES.map(
        (handle) => `<span class="selection-handle handle-${handle}" data-handle="${handle}"></span>`
      ).join("");
      elements.templateStage.appendChild(box);
    }

    elements.templateStage.addEventListener("pointerdown", (event) => {
      if (!state.currentTemplate?.image) {
        return;
      }

      const point = imagePoint(event);
      const handleNode = event.target.closest?.(".selection-handle");
      const boxNode = event.target.closest?.(".selection-box");

      if (event.target === elements.templateImage) {
        clearSelectionBox();
        createBox();
        selection = { left: point.x, top: point.y, width: 0, height: 0 };
        drag = { type: "draw", startX: point.x, startY: point.y };
      } else if (handleNode && box?.isConnected && selection) {
        drag = { type: "resize", handle: handleNode.dataset.handle, origin: { ...selection } };
      } else if (boxNode && box?.isConnected && selection) {
        drag = { type: "move", origin: { ...selection }, startX: point.x, startY: point.y };
      } else {
        return;
      }

      state.templateSelection = null;
      elements.saveRegionButton.disabled = true;
      applyBox();
      elements.templateStage.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    elements.templateStage.addEventListener("pointermove", (event) => {
      if (!drag || !box?.isConnected) {
        return;
      }

      const point = imagePoint(event);
      const image = imageSize();

      if (drag.type === "draw") {
        selection = {
          left: Math.min(drag.startX, point.x),
          top: Math.min(drag.startY, point.y),
          width: Math.abs(point.x - drag.startX),
          height: Math.abs(point.y - drag.startY),
        };
      } else if (drag.type === "move") {
        selection = {
          ...drag.origin,
          left: clamp(
            drag.origin.left + (point.x - drag.startX),
            0,
            Math.max(0, image.width - drag.origin.width)
          ),
          top: clamp(
            drag.origin.top + (point.y - drag.startY),
            0,
            Math.max(0, image.height - drag.origin.height)
          ),
        };
      } else if (drag.type === "resize") {
        const origin = drag.origin;
        const right = origin.left + origin.width;
        const bottom = origin.top + origin.height;
        let left = origin.left;
        let top = origin.top;
        let width = origin.width;
        let height = origin.height;

        if (drag.handle.includes("w")) {
          left = clamp(point.x, 0, right - MIN_SIZE);
          width = right - left;
        }

        if (drag.handle.includes("e")) {
          width = clamp(point.x, left + MIN_SIZE, image.width) - left;
        }

        if (drag.handle.includes("n")) {
          top = clamp(point.y, 0, bottom - MIN_SIZE);
          height = bottom - top;
        }

        if (drag.handle.includes("s")) {
          height = clamp(point.y, top + MIN_SIZE, image.height) - top;
        }

        selection = { left, top, width, height };
      }

      applyBox();
      event.preventDefault();
    });

    function endDrag(event) {
      if (!drag) {
        return;
      }

      if (selection && (selection.width < MIN_SIZE || selection.height < MIN_SIZE)) {
        clearSelectionBox();
        box = null;
        selection = null;
      }

      commitSelection();
      drag = null;

      if (elements.templateStage.hasPointerCapture?.(event.pointerId)) {
        elements.templateStage.releasePointerCapture(event.pointerId);
      }
    }

    elements.templateStage.addEventListener("pointerup", endDrag);
    elements.templateStage.addEventListener("pointercancel", endDrag);
  }

  function switchView(view) {
    state.view = view;
    $$(".hw-tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === view));
    $$("[data-view-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.viewPanel !== view;
      panel.classList.toggle("is-active", panel.dataset.viewPanel === view);
    });

    if (view === "list") {
      loadExamProgress().catch(() => {});
    }

    if (view === "assignment") {
      loadAssignment().catch((error) => alert(error.message));
    }

    if (view === "history") {
      renderHistoryStudentSelect();
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function applyAnalysisTabUI(tab) {
    $$(".hw-subtab").forEach((button) =>
      button.classList.toggle("is-active", button.dataset.analysisTab === tab)
    );
    $$("[data-analysis-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.analysisPanel !== tab;
    });
  }

  function switchAnalysisTab(tab) {
    state.analysisTab = tab;
    applyAnalysisTabUI(tab);

    if (tab !== "students") {
      state.lastBatchAnalysis = null;
      loadBatchAnalysis(true).catch((error) => emptyAnalysis(error.message));
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

  async function loadAssignment() {
    if (!state.activeExamId) {
      elements.workHeaderTitle.textContent = "本次作业";
      elements.workHeaderMeta.textContent = "先在作业列表新建或选择一份作业。";
      elements.workSummary.innerHTML = "";
      elements.studentCardGrid.innerHTML = '<p class="empty-text">暂无作业，请先在作业列表新建。</p>';
      emptyAnalysis("暂无学情数据。");
      return;
    }

    const payload = await apiRequest(`assignment-overview&examId=${encodeURIComponent(state.activeExamId)}`, {
      cache: "no-store",
    });
    state.overview = payload;
    renderAssignmentHeader();
    renderWorkSummary();
    renderStudentCards();

    if (state.analysisTab !== "students") {
      await loadBatchAnalysis();
    }

    if (state.activeStudentId) {
      const student = payload.students.find((item) => item.id === state.activeStudentId);

      if (student) {
        updateStudentHeader(student);
      } else {
        closeStudentPanel();
      }
    }
  }

  function renderAssignmentHeader() {
    const exam = state.overview?.exam;

    if (!exam) {
      return;
    }

    elements.workHeaderTitle.textContent = exam.name;
    elements.workHeaderMeta.textContent = [
      exam.className || "未绑定班级",
      exam.subject || "",
      exam.examDate ? formatDate(exam.examDate) : "",
      exam.questionCount ? `${exam.questionCount} 题` : "整卷 AI 批改",
      exam.totalScore ? `总分 ${formatNumber(exam.totalScore)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
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
    const percent = summary.studentCount
      ? Math.round((summary.gradedCount / summary.studentCount) * 100)
      : 0;

    elements.workSummary.innerHTML = `
      <div class="hw-metrics">
        <div class="hw-metric"><span>班级学生</span><strong>${summary.studentCount}</strong></div>
        <div class="hw-metric"><span>已上传</span><strong>${summary.submittedCount}</strong></div>
        <div class="hw-metric"><span>已批改</span><strong>${summary.gradedCount}</strong></div>
        <div class="hw-metric"><span>平均得分率</span><strong>${formatPercent(averageRate)}</strong></div>
      </div>
      <div class="hw-progress-card">
        <div class="hw-progress-head">
          <span>批改进度</span>
          <strong>${summary.gradedCount} / ${summary.studentCount}</strong>
        </div>
        <div class="hw-bar"><i style="width: ${percent}%"></i></div>
        <p>${
          summary.questionCount
            ? `共 ${summary.questionCount} 题 · 总分 ${formatNumber(summary.maxScore)}`
            : "整卷 AI 批改 · 批改后自动生成题目与分数"
        }</p>
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
      elements.studentCardGrid.innerHTML = '<p class="empty-text">当前作业没有绑定班级，请先到班级管理创建班级。</p>';
      return;
    }

    if (!overview.students.length) {
      elements.studentCardGrid.innerHTML = '<p class="empty-text">该班级暂无学生，请到班级管理导入名单。</p>';
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

  function showStudentDrawer() {
    window.clearTimeout(state.drawerTimer);
    elements.studentDrawer.hidden = false;
    requestAnimationFrame(() => {
      elements.studentDrawer.classList.add("is-open");
      document.body.classList.add("hw-drawer-open");
    });
  }

  function hideStudentDrawer() {
    elements.studentDrawer.classList.remove("is-open");
    document.body.classList.remove("hw-drawer-open");
    window.clearTimeout(state.drawerTimer);
    state.drawerTimer = window.setTimeout(() => {
      if (!state.activeStudentId) {
        elements.studentDrawer.hidden = true;
      }
    }, 200);
  }

  function closeStudentPanel() {
    state.activeStudentId = "";
    hideStudentDrawer();
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
    showStudentDrawer();
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
    } finally {
      event.target.value = "";
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
    setWorkStatus("正在上传作业，AI 正在辨认题目并批改…");

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
        throw new Error(
          processResult.wholePaper
            ? "AI 没有识别出可批改的题目，请换一张更清晰的作业图片。"
            : "没有生成可批改的题目，请检查模板区域是否覆盖题目。"
        );
      }

      let failedCount = 0;

      if (processResult.wholePaper) {
        setWorkStatus(`AI 已批改 ${processResult.jobCount} 道题，正在刷新结果…`);
      } else {
        setWorkStatus(`已生成 ${processResult.jobCount} 个题目任务，开始 AI 批改…`);
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
      }

      state.lastBatchAnalysis = null;
      await loadSubmission();
      await loadAssignment();
      await loadExamProgress();
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

  function emptyAnalysis(message) {
    const html = `<p class="empty-text">${escapeHtml(message)}</p>`;
    elements.assignmentOverview.innerHTML = html;
    elements.assignmentQuestions.innerHTML = html;
    elements.assignmentKnowledge.innerHTML = html;
  }

  async function loadBatchAnalysis(force = false) {
    if (!state.activeExamId) {
      emptyAnalysis("请先选择作业。");
      return;
    }

    try {
      if (!state.overview || state.overview.exam?.id !== state.activeExamId) {
        state.overview = await apiRequest(
          `assignment-overview&examId=${encodeURIComponent(state.activeExamId)}`,
          { cache: "no-store" }
        );
        renderAssignmentHeader();
        renderWorkSummary();
        renderStudentCards();
      }

      if (!state.overview.batch) {
        emptyAnalysis("当前作业还没有学生提交，完成批改后即可查看学情分析。");
        return;
      }

      const batchId = state.overview.batch.id;

      if (!force && state.lastBatchAnalysis?.batch?.id === batchId) {
        renderAnalysisPanels(state.lastBatchAnalysis);
        return;
      }

      const data = await apiRequest(`batch-analysis&batchId=${encodeURIComponent(batchId)}`, {
        cache: "no-store",
      });
      state.lastBatchAnalysis = data;
      renderAnalysisPanels(data);
    } catch (error) {
      emptyAnalysis(error.message);
    }
  }

  function renderAnalysisPanels(data) {
    if (!data.overview.gradedResultCount) {
      emptyAnalysis("本次作业还没有批改结果，请先完成学生批改。");
      return;
    }

    const distribution = `
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

    elements.assignmentOverview.innerHTML = `
      <div class="hw-subsection">${aiBlock}</div>
      <div class="hw-subsection">
        <div class="hw-section-title">成绩分布</div>
        <div class="hw-quickstats">
          <div><span>及格率</span><strong>${formatPercent(data.overview.passRate)}</strong></div>
          <div><span>未全对作答</span><strong>${data.overview.wrongResultCount}</strong></div>
        </div>
        ${distribution}
      </div>
    `;

    elements.assignmentQuestions.innerHTML = `
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
    `;

    elements.assignmentKnowledge.innerHTML = `
      <div class="hw-subsection">
        <div class="hw-section-title">知识点掌握情况</div>
        <div class="kp-grid">${knowledgeCards}</div>
      </div>
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

    const button = elements.assignmentOverview.querySelector('[data-action="analyze-batch"]');

    if (button) {
      button.disabled = true;
      button.textContent = "AI 分析中，请稍候…";
    }

    try {
      await apiRequest("analyze-batch", {
        method: "POST",
        body: JSON.stringify({ batchId }),
      });
      await loadBatchAnalysis(true);
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

  function openExamDrawer(mode) {
    if (mode === "manage" && !state.activeExamId) {
      alert("请先选择一份作业。");
      return;
    }

    state.drawerMode = mode;
    state.wizardStep = mode === "create" ? 1 : 2;
    elements.examDrawer.hidden = false;
    document.body.classList.add("hw-drawer-open");
    requestAnimationFrame(() => elements.examDrawer.classList.add("is-open"));

    if (mode === "create") {
      elements.examDrawerTitle.textContent = "新建作业";
      elements.examForm.reset();
      const dateInput = elements.examForm.elements.examDate;

      if (dateInput) {
        dateInput.value = formatDate(new Date());
      }

      const classItem = state.classes.find((item) => item.id === state.defaultClassId);
      elements.examClassHint.textContent = classItem
        ? `当前班级：${classItem.name}${classItem.grade ? `（${classItem.grade}）` : ""}`
        : "还没有班级，请先到班级管理创建班级并导入名单。";
    } else {
      elements.examDrawerTitle.textContent = "高级设置";
    }

    renderWizardStep();
  }

  function closeExamDrawer() {
    elements.examDrawer.classList.remove("is-open");
    window.clearTimeout(state.examDrawerTimer);
    state.examDrawerTimer = window.setTimeout(() => {
      elements.examDrawer.hidden = true;
    }, 200);
    document.body.classList.remove("hw-drawer-open");
  }

  function renderWizardStep() {
    const step = state.wizardStep;
    const exam = state.exams.find((item) => item.id === state.activeExamId);

    $$(".hw-wizard-step").forEach((panel) => {
      panel.hidden = Number(panel.dataset.step) !== step;
    });

    const drawerBody = elements.examDrawer.querySelector(".hw-drawer-body");

    if (drawerBody) {
      drawerBody.scrollTop = 0;
    }

    $$("[data-step-chip]").forEach((chip) => {
      const chipStep = Number(chip.dataset.stepChip);
      chip.hidden = state.drawerMode === "manage" ? chipStep === 1 : chipStep !== 1;
      chip.classList.toggle("is-active", chipStep === step);
      chip.classList.toggle("is-done", chipStep < step);
    });

    if (state.drawerMode === "create") {
      elements.examDrawerHint.textContent = "填写作业名称、日期和知识点，创建后即可拍照或上传学生作业，由 AI 整卷批改。";
    } else {
      elements.examDrawerHint.textContent =
        step === 2
          ? `${exam?.name || "当前作业"} · 可选：维护题目，不设置也能整卷批改。`
          : `${exam?.name || "当前作业"} · 可选：上传标准作业并框选题目区域，用于精确裁题。`;
    }

    elements.wizardBackButton.hidden = state.drawerMode === "manage";
  }

  function finishWizard() {
    const isCreate = state.drawerMode === "create";
    closeExamDrawer();
    loadExamProgress().catch(() => {});
    loadExamScope(state.activeExamId).catch(() => {});

    if (isCreate) {
      state.analysisTab = "students";
      applyAnalysisTabUI("students");
      switchView("assignment");
    } else if (state.view === "assignment") {
      state.overview = null;
      state.lastBatchAnalysis = null;
      loadAssignment().catch((error) => alert(error.message));
    }
  }

  async function handleExamSubmit(event) {
    event.preventDefault();

    if (!state.defaultClassId) {
      alert("请先在班级管理中创建班级并导入学生名单。");
      return;
    }

    const button = elements.examForm.querySelector("button[type='submit']");
    button.disabled = true;

    try {
      const form = formPayload(elements.examForm);
      const payload = await apiRequest("create-exam", {
        method: "POST",
        body: JSON.stringify({
          classId: state.defaultClassId,
          name: form.name,
          examDate: form.examDate || null,
          knowledgePoints: form.knowledgePoints,
        }),
      });
      state.activeExamId = payload.exam.id;
      state.overview = null;
      state.lastBatchAnalysis = null;
      await loadBootstrap();
      await loadExamProgress();
      finishWizard();
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function handleQuestionSubmit(event) {
    event.preventDefault();

    if (!state.activeExamId) {
      alert("请先完成第 1 步，保存作业信息。");
      return;
    }

    const button = elements.questionForm.querySelector("button[type='submit']");
    button.disabled = true;

    try {
      await apiRequest("create-question", {
        method: "POST",
        body: JSON.stringify({ ...formPayload(elements.questionForm), examId: state.activeExamId }),
      });
      elements.questionForm.reset();
      await loadBootstrap();
      await loadExamProgress();
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  }

  function bindEvents() {
    elements.listRefreshButton.addEventListener("click", () => {
      Promise.all([loadBootstrap(), loadExamProgress()]).catch((error) => alert(error.message));
    });

    elements.newExamButton.addEventListener("click", () => openExamDrawer("create"));
    elements.editExamButton.addEventListener("click", () => {
      if (!state.activeExamId) {
        openExamDrawer("manage");
        return;
      }

      loadExamScope(state.activeExamId)
        .then(() => openExamDrawer("manage"))
        .catch((error) => alert(error.message));
    });

    $$("[data-close-exam-drawer]").forEach((node) => {
      node.addEventListener("click", closeExamDrawer);
    });

    elements.examForm.addEventListener("submit", handleExamSubmit);
    elements.questionForm.addEventListener("submit", handleQuestionSubmit);

    elements.wizardBackButton.addEventListener("click", () => {
      state.wizardStep = 1;
      renderWizardStep();
    });

    elements.wizardNextButton.addEventListener("click", () => {
      if (!state.questions.length) {
        alert("请先添加至少一道题目。");
        return;
      }

      state.wizardStep = 3;
      renderWizardStep();
    });

    elements.wizardSkipTemplateButton.addEventListener("click", finishWizard);
    elements.wizardBackToQuestionsButton.addEventListener("click", () => {
      state.wizardStep = 2;
      renderWizardStep();
    });
    elements.wizardFinishButton.addEventListener("click", finishWizard);

    $$(".hw-tab").forEach((tab) => {
      tab.addEventListener("click", () => switchView(tab.dataset.view));
    });

    $$(".hw-subtab").forEach((tab) => {
      tab.addEventListener("click", () => switchAnalysisTab(tab.dataset.analysisTab));
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

    elements.examCards.addEventListener("click", (event) => {
      const actionNode = event.target.closest("[data-exam-action]");

      if (!actionNode) {
        return;
      }

      const action = actionNode.dataset.examAction;
      const examId = actionNode.dataset.examId;

      if (action === "create") {
        openExamDrawer("create");
        return;
      }

      state.activeExamId = examId;
      syncExamSelects();
      state.overview = null;
      state.lastBatchAnalysis = null;
      state.analysisTab = action === "analysis" ? "overview" : "students";
      applyAnalysisTabUI(state.analysisTab);
      switchView("assignment");
    });

    elements.workRefreshButton.addEventListener("click", () => {
      state.lastBatchAnalysis = null;
      loadAssignment()
        .then(() => (state.analysisTab !== "students" ? loadBatchAnalysis(true) : null))
        .catch((error) => alert(error.message));
    });

    elements.studentCardGrid.addEventListener("click", (event) => {
      const card = event.target.closest("[data-student-id]");

      if (card) {
        openStudent(card.dataset.studentId).catch((error) => alert(error.message));
      }
    });

    elements.closeWorkPanel.addEventListener("click", closeStudentPanel);
    $$("[data-close-student-drawer]").forEach((node) => {
      node.addEventListener("click", closeStudentPanel);
    });

    elements.workImageInput.addEventListener("change", handleWorkImage);
    elements.cameraButton.addEventListener("click", openCamera);
    elements.closeCameraButton.addEventListener("click", closeCamera);
    elements.captureButton.addEventListener("click", capturePhoto);
    elements.gradeStudentButton.addEventListener("click", gradeSelectedStudent);

    elements.assignmentOverview.addEventListener("click", (event) => {
      if (event.target.closest('[data-action="analyze-batch"]')) {
        analyzeBatch();
      }
    });

    $$('input[name="historyMode"]').forEach((radio) => {
      radio.addEventListener("change", updateHistoryMode);
    });
    elements.historyClassSelect.addEventListener("change", renderHistoryStudentSelect);
    elements.loadHistoryButton.addEventListener("click", loadHistory);

    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }

      if (!elements.studentDrawer.hidden) {
        closeStudentPanel();
        return;
      }

      if (!elements.examDrawer.hidden) {
        closeExamDrawer();
      }
    });

    window.addEventListener("default-class-changed", (event) => {
      const classId = event.detail?.classId || "";

      if (classId === state.defaultClassId) {
        return;
      }

      state.defaultClassId = classId;
      renderCoreSelects();
      renderClassContext();
      const classExam = state.exams.find((exam) => exam.classId === classId);
      handleExamChange(classExam?.id || "").catch((error) => alert(error.message));
    });
  }

  setupTemplateSelection();
  bindEvents();
  updateHistoryMode();

  const initialParams = new URLSearchParams(window.location.search);
  const viewParam = initialParams.get("view") || "";
  const initialExamId = initialParams.get("examId") || "";
  const viewMap = {
    list: "list",
    setup: "list",
    assignment: "assignment",
    work: "assignment",
    analysis: "assignment",
    history: "history",
  };
  const initialView = viewMap[viewParam] || "list";

  if (viewParam === "quick") {
    window.location.replace("./ai-grading.html");
    return;
  }

  if (viewParam === "analysis") {
    state.analysisTab = "overview";
    applyAnalysisTabUI("overview");
  }

  loadBootstrap()
    .then(async () => {
      if (initialExamId && state.exams.some((exam) => exam.id === initialExamId)) {
        state.activeExamId = initialExamId;
        syncExamSelects();
        await loadExamScope(initialExamId);
      }

      switchView(initialView);
    })
    .catch((error) => {
      elements.examCards.innerHTML = `<p class="empty-text">${escapeHtml(error.message)}</p>`;
    });
})();
