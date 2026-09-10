(function () {
  const state = {
    classes: [],
    students: [],
    exams: [],
    questions: [],
    templates: [],
    regions: [],
    batches: [],
    pages: [],
    pendingFiles: [],
    currentTemplate: null,
    templateSelection: null,
    grading: false,
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const elements = {
    refreshButton: $("#refreshButton"),
    classForm: $("#classForm"),
    studentForm: $("#studentForm"),
    examForm: $("#examForm"),
    questionForm: $("#questionForm"),
    studentList: $("#studentList"),
    examList: $("#examList"),
    templateExamSelect: $("#templateExamSelect"),
    templateUpload: $("#templateUpload"),
    templateFileName: $("#templateFileName"),
    templateStage: $("#templateStage"),
    templateImage: $("#templateImage"),
    regionQuestionSelect: $("#regionQuestionSelect"),
    saveRegionButton: $("#saveRegionButton"),
    regionList: $("#regionList"),
    batchForm: $("#batchForm"),
    batchExamSelect: $("#batchExamSelect"),
    scanUpload: $("#scanUpload"),
    scanFileName: $("#scanFileName"),
    activeBatchSelect: $("#activeBatchSelect"),
    uploadPagesButton: $("#uploadPagesButton"),
    processBatchButton: $("#processBatchButton"),
    startBatchGradeButton: $("#startBatchGradeButton"),
    batchStatusText: $("#batchStatusText"),
    pendingScanList: $("#pendingScanList"),
    uploadedPageList: $("#uploadedPageList"),
    gradeProgressBar: $("#gradeProgressBar"),
    resultSummary: $("#resultSummary"),
    resultDetails: $("#resultDetails"),
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
    const url = action.includes("&") ? `/api/mvp?action=${action}` : `/api/mvp?action=${encodeURIComponent(action)}`;
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

  function setStatus(message) {
    elements.batchStatusText.textContent = message;
  }

  function fillSelect(select, items, getLabel, placeholder) {
    const currentValue = select.value;
    select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` + items
      .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(getLabel(item))}</option>`)
      .join("");

    if (items.some((item) => item.id === currentValue)) {
      select.value = currentValue;
    } else if (items.length) {
      select.value = items[0].id;
    }
  }

  function renderCoreSelects() {
    $$('[data-select="classes"]').forEach((select) => {
      fillSelect(select, state.classes, (item) => item.grade ? `${item.name}（${item.grade}）` : item.name, "请选择班级");
    });
    $$('[data-select="exams"]').forEach((select) => {
      fillSelect(select, state.exams, (item) => `${item.name}${item.subject ? `｜${item.subject}` : ""}`, "请选择考试");
    });
  }

  function renderStudents() {
    if (!state.students.length) {
      elements.studentList.innerHTML = '<p class="empty-text">暂无学生</p>';
      return;
    }

    elements.studentList.innerHTML = state.students
      .map((student) => `
        <div class="mini-item">
          <strong>${escapeHtml(student.name)}</strong>
          <span>${escapeHtml(student.studentNo || "未填学号")}｜${escapeHtml(student.className || "未分班")}</span>
        </div>
      `)
      .join("");
  }

  function renderExams() {
    if (!state.exams.length) {
      elements.examList.innerHTML = '<p class="empty-text">暂无考试</p>';
      return;
    }

    elements.examList.innerHTML = state.exams
      .map((exam) => `
        <div class="mini-item">
          <strong>${escapeHtml(exam.name)}</strong>
          <span>${escapeHtml(exam.className || "未绑定班级")}｜${escapeHtml(exam.subject || "未填科目")}｜${exam.questionCount} 题｜${exam.totalScore} 分</span>
        </div>
      `)
      .join("");
  }

  function renderQuestionSelect() {
    fillSelect(
      elements.regionQuestionSelect,
      state.questions,
      (item) => `${item.questionNo}（${item.maxScore} 分）`,
      "请选择题目"
    );
  }

  function renderRegions() {
    if (!state.regions.length) {
      elements.regionList.innerHTML = '<p class="empty-text">暂无模板区域</p>';
      return;
    }

    elements.regionList.innerHTML = state.regions
      .map((region) => `
        <div class="mini-item">
          <strong>${escapeHtml(region.questionNo)}</strong>
          <span>${Math.round(region.widthRatio * 100)}% x ${Math.round(region.heightRatio * 100)}%</span>
        </div>
      `)
      .join("");
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

  function renderPendingScans() {
    if (!state.pendingFiles.length) {
      elements.pendingScanList.innerHTML = '<p class="empty-text">暂无待上传扫描答卷</p>';
      elements.uploadPagesButton.disabled = true;
      return;
    }

    const studentOptions = state.students
      .map((student) => `<option value="${escapeHtml(student.id)}">${escapeHtml(student.name)}${student.studentNo ? `｜${escapeHtml(student.studentNo)}` : ""}</option>`)
      .join("");

    elements.pendingScanList.innerHTML = state.pendingFiles
      .map((file, index) => `
        <div class="scan-row" data-index="${index}">
          <span>${escapeHtml(file.name)}</span>
          <select data-student-for="${index}">
            <option value="">绑定学生</option>
            ${studentOptions}
          </select>
        </div>
      `)
      .join("");
    elements.uploadPagesButton.disabled = !elements.activeBatchSelect.value || !state.students.length;
  }

  function renderBatchSelect() {
    fillSelect(elements.activeBatchSelect, state.batches, (batch) => `${batch.name}｜${batch.examName || "考试"}`, "请选择批次");
    elements.processBatchButton.disabled = !elements.activeBatchSelect.value;
    elements.startBatchGradeButton.disabled = !elements.activeBatchSelect.value;
  }

  function renderUploadedPages() {
    if (!state.pages.length) {
      elements.uploadedPageList.innerHTML = '<p class="empty-text">当前批次暂无扫描答卷</p>';
      return;
    }

    elements.uploadedPageList.innerHTML = state.pages
      .map((page) => `
        <div class="mini-item">
          <strong>${escapeHtml(page.studentName || "未绑定")}</strong>
          <span>${escapeHtml(page.originalName)}${page.studentNo ? `｜${escapeHtml(page.studentNo)}` : ""}</span>
        </div>
      `)
      .join("");
  }

  function renderResults(results) {
    const progress = results?.progress || { total: 0, done: 0, failed: 0 };
    const percent = progress.total ? Math.round(((progress.done + progress.failed) / progress.total) * 100) : 0;
    elements.gradeProgressBar.style.width = `${percent}%`;

    if (!results?.summary?.length) {
      elements.resultSummary.innerHTML = '<p class="empty-text">暂无成绩汇总</p>';
    } else {
      elements.resultSummary.innerHTML = `
        <table class="result-table">
          <thead><tr><th>学生</th><th>学号</th><th>总分</th><th>题数</th></tr></thead>
          <tbody>
            ${results.summary.map((row) => `
              <tr>
                <td>${escapeHtml(row.studentName)}</td>
                <td>${escapeHtml(row.studentNo || "-")}</td>
                <td>${row.totalScore} / ${row.maxScore}</td>
                <td>${row.questionCount}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;
    }

    if (!results?.details?.length) {
      elements.resultDetails.innerHTML = '<p class="empty-text">暂无题目明细</p>';
      return;
    }

    elements.resultDetails.innerHTML = `
      <table class="result-table">
        <thead><tr><th>学生</th><th>题号</th><th>得分</th><th>等级</th><th>AI 分析</th></tr></thead>
        <tbody>
          ${results.details.map((row) => `
            <tr>
              <td>${escapeHtml(row.studentName)}</td>
              <td>${escapeHtml(row.questionNo)}</td>
              <td>${row.score ?? "-"} / ${row.maxScore}</td>
              <td>${escapeHtml(row.level || "-")}</td>
              <td>${escapeHtml(row.analysis || "")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  async function loadBootstrap() {
    const payload = await apiRequest("bootstrap", { cache: "no-store" });
    state.classes = payload.classes || [];
    state.students = payload.students || [];
    state.exams = payload.exams || [];
    state.batches = payload.batches || [];
    renderCoreSelects();
    renderStudents();
    renderExams();
    renderBatchSelect();
    await loadSelectedExam();
    await loadSelectedBatch();
  }

  async function loadSelectedExam() {
    const examId = elements.templateExamSelect.value || elements.batchExamSelect.value || state.exams[0]?.id || "";
    if (!examId) {
      state.questions = [];
      state.templates = [];
      state.currentTemplate = null;
      state.regions = [];
      renderQuestionSelect();
      renderTemplate();
      renderRegions();
      return;
    }

    const [questionPayload, templatePayload, batchPayload] = await Promise.all([
      apiRequest(`questions&examId=${encodeURIComponent(examId)}`, { cache: "no-store" }),
      apiRequest(`templates&examId=${encodeURIComponent(examId)}`, { cache: "no-store" }),
      apiRequest(`batches&examId=${encodeURIComponent(examId)}`, { cache: "no-store" }),
    ]);
    state.questions = questionPayload.questions || [];
    state.templates = templatePayload.templates || [];
    state.currentTemplate = state.templates[0] || null;
    state.batches = batchPayload.batches || state.batches;
    renderQuestionSelect();
    renderTemplate();
    renderBatchSelect();

    if (state.currentTemplate) {
      const regionPayload = await apiRequest(`regions&templateId=${encodeURIComponent(state.currentTemplate.id)}`, { cache: "no-store" });
      state.regions = regionPayload.regions || [];
    } else {
      state.regions = [];
    }
    renderRegions();
  }

  async function loadSelectedBatch() {
    const batchId = elements.activeBatchSelect.value;
    if (!batchId) {
      state.pages = [];
      renderUploadedPages();
      renderResults(null);
      return;
    }

    const [pagesPayload, results] = await Promise.all([
      apiRequest(`pages&batchId=${encodeURIComponent(batchId)}`, { cache: "no-store" }),
      apiRequest(`results&batchId=${encodeURIComponent(batchId)}`, { cache: "no-store" }),
    ]);
    state.pages = pagesPayload.pages || [];
    renderUploadedPages();
    renderResults(results);
  }

  function clearSelectionBox() {
    elements.templateStage.querySelector(".selection-box")?.remove();
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

  function bindForm(form, action, getExtraPayload, afterSave) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector("button[type='submit']");
      button.disabled = true;

      try {
        await apiRequest(action, {
          method: "POST",
          body: JSON.stringify({
            ...formPayload(form),
            ...(getExtraPayload ? getExtraPayload() : {}),
          }),
        });
        form.reset();
        await loadBootstrap();
        if (afterSave) {
          await afterSave();
        }
      } catch (error) {
        alert(error.message);
      } finally {
        button.disabled = false;
      }
    });
  }

  async function uploadPendingPages() {
    const batchId = elements.activeBatchSelect.value;
    if (!batchId) {
      alert("请先选择批次。");
      return;
    }

    elements.uploadPagesButton.disabled = true;
    try {
      for (const [index, file] of state.pendingFiles.entries()) {
        const studentId = $(`[data-student-for="${index}"]`)?.value || "";
        if (!studentId) {
          throw new Error(`${file.name} 未绑定学生。`);
        }

        setStatus(`正在上传 ${file.name}`);
        await apiRequest("upload-page", {
          method: "POST",
          body: JSON.stringify({
            batchId,
            studentId,
            name: file.name,
            image: await readFileAsDataUrl(file),
            pageNo: index + 1,
          }),
        });
      }

      state.pendingFiles = [];
      elements.scanUpload.value = "";
      elements.scanFileName.textContent = "可多选图片";
      renderPendingScans();
      await loadSelectedBatch();
      setStatus("扫描答卷已上传");
    } catch (error) {
      alert(error.message);
      setStatus("上传失败");
    } finally {
      elements.uploadPagesButton.disabled = !state.pendingFiles.length;
    }
  }

  async function processCurrentBatch() {
    const batchId = elements.activeBatchSelect.value;
    if (!batchId) {
      alert("请先选择批次。");
      return;
    }

    elements.processBatchButton.disabled = true;
    setStatus("正在按模板裁切题目");
    try {
      const result = await apiRequest("process-batch", {
        method: "POST",
        body: JSON.stringify({ batchId }),
      });
      await loadSelectedBatch();
      setStatus(`已生成 ${result.jobCount} 个逐题评分任务`);
    } catch (error) {
      alert(error.message);
      setStatus("裁切失败");
    } finally {
      elements.processBatchButton.disabled = false;
    }
  }

  async function startBatchGrading() {
    const batchId = elements.activeBatchSelect.value;
    if (!batchId || state.grading) {
      return;
    }

    state.grading = true;
    elements.startBatchGradeButton.disabled = true;
    elements.processBatchButton.disabled = true;

    try {
      while (state.grading) {
        const payload = await apiRequest("grade-next", {
          method: "POST",
          body: JSON.stringify({ batchId }),
        });
        renderResults(payload.results);

        if (payload.done) {
          setStatus("批量阅卷完成");
          break;
        }

        if (payload.failed) {
          setStatus(`有题目评分失败：${payload.message}`);
        } else {
          setStatus(`已批阅：${payload.job.studentName} ${payload.job.questionNo}，${payload.job.score ?? "-"} / ${payload.job.maxScore}`);
        }
      }
    } catch (error) {
      alert(error.message);
      setStatus("批量阅卷中断");
    } finally {
      state.grading = false;
      elements.startBatchGradeButton.disabled = false;
      elements.processBatchButton.disabled = false;
      await loadSelectedBatch();
    }
  }

  function bindEvents() {
    bindForm(elements.classForm, "create-class");
    bindForm(elements.studentForm, "create-student");
    bindForm(elements.examForm, "create-exam");
    bindForm(elements.questionForm, "create-question");
    bindForm(elements.batchForm, "create-batch");

    elements.refreshButton.addEventListener("click", () => loadBootstrap().catch((error) => alert(error.message)));
    elements.templateExamSelect.addEventListener("change", () => loadSelectedExam().catch((error) => alert(error.message)));
    elements.batchExamSelect.addEventListener("change", () => loadSelectedExam().catch((error) => alert(error.message)));
    elements.activeBatchSelect.addEventListener("change", () => loadSelectedBatch().catch((error) => alert(error.message)));
    elements.regionQuestionSelect.addEventListener("change", () => {
      elements.saveRegionButton.disabled = !state.templateSelection || !elements.regionQuestionSelect.value;
    });

    elements.templateUpload.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      const examId = elements.templateExamSelect.value;

      if (!file || !examId) {
        return;
      }

      try {
        const image = await readFileAsDataUrl(file);
        const size = await getImageSize(image);
        const payload = await apiRequest("create-template", {
          method: "POST",
          body: JSON.stringify({
            examId,
            name: file.name,
            image,
            width: size.width,
            height: size.height,
          }),
        });
        state.currentTemplate = payload.template;
        elements.templateFileName.textContent = file.name;
        renderTemplate();
        await loadSelectedExam();
      } catch (error) {
        alert(error.message);
      }
    });

    elements.saveRegionButton.addEventListener("click", async () => {
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
        const payload = await apiRequest(`regions&templateId=${encodeURIComponent(state.currentTemplate.id)}`, { cache: "no-store" });
        state.regions = payload.regions || [];
        renderRegions();
        clearSelectionBox();
        state.templateSelection = null;
      } catch (error) {
        alert(error.message);
      } finally {
        elements.saveRegionButton.disabled = true;
      }
    });

    elements.scanUpload.addEventListener("change", (event) => {
      state.pendingFiles = Array.from(event.target.files || []);
      elements.scanFileName.textContent = state.pendingFiles.length ? `${state.pendingFiles.length} 张图片` : "可多选图片";
      renderPendingScans();
    });

    elements.uploadPagesButton.addEventListener("click", () => uploadPendingPages());
    elements.processBatchButton.addEventListener("click", () => processCurrentBatch());
    elements.startBatchGradeButton.addEventListener("click", () => startBatchGrading());
  }

  setupTemplateSelection();
  bindEvents();
  loadBootstrap().catch((error) => {
    setStatus(error.message);
    elements.resultSummary.innerHTML = `<p class="empty-text">${escapeHtml(error.message)}</p>`;
  });
})();
