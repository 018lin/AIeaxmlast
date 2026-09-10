const roleButtons = document.querySelectorAll(".role-option[data-role]");

roleButtons.forEach((button) => {
  button.addEventListener("click", () => {
    roleButtons.forEach((item) => item.classList.remove("is-active"));
    button.classList.add("is-active");

    const role = button.dataset.role;
    document.documentElement.dataset.selectedRole = role;

    if (role === "teacher") {
      window.location.href = "./teacher.html";
    }
  });
});

const gradingRoot = document.querySelector(".grading-shell:not(.ai-review-shell)");

if (gradingRoot) {
  const state = {
    images: {
      paper: null,
      answer: null,
    },
    selections: {
      paper: null,
      answer: null,
    },
    history: [],
  };

  const elements = {
    paperUpload: document.querySelector("#paperUpload"),
    answerUpload: document.querySelector("#answerUpload"),
    paperImage: document.querySelector("#paperImage"),
    answerImage: document.querySelector("#answerImage"),
    paperStage: document.querySelector("#paperStage"),
    answerStage: document.querySelector("#answerStage"),
    paperFileName: document.querySelector("#paperFileName"),
    answerFileName: document.querySelector("#answerFileName"),
    paperCropState: document.querySelector("#paperCropState"),
    answerCropState: document.querySelector("#answerCropState"),
    savePairButton: document.querySelector("#savePairButton"),
    clearCropButton: document.querySelector("#clearCropButton"),
    historyList: document.querySelector("#historyList"),
    clearHistoryButton: document.querySelector("#clearHistoryButton"),
    historyModal: document.querySelector("#historyModal"),
    historyModalTime: document.querySelector("#historyModalTime"),
    historyModalBody: document.querySelector("#historyModalBody"),
  };

  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (character) => {
      const entities = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      };
      return entities[character];
    });

  const formatTime = (date) => {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const apiRequest = async (url, options = {}) => {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.message || `请求失败：HTTP ${response.status}`);
    }

    return payload;
  };

  const readFileAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  const loadImage = (src) =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });

  const makeCompressedImage = async (src, maxWidth = 900) => {
    const image = await loadImage(src);
    const scale = Math.min(1, maxWidth / image.naturalWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.78);
  };

  const savePaperToHistory = async (fileName, src) => {
    const compressed = await makeCompressedImage(src);

    const payload = await apiRequest("/api/uploads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        kind: "paper",
        name: fileName,
        image: compressed,
      }),
    });

    return payload.upload;
  };

  const saveUploadedImage = async (kind, fileName, src) => {
    const compressed = await makeCompressedImage(src);
    const payload = await apiRequest("/api/uploads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        kind,
        name: fileName,
        image: compressed,
      }),
    });

    return payload.upload;
  };

  const savePairToDatabase = async (pair) => {
    const payload = await apiRequest("/api/pairs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(pair),
    });

    return payload.pair;
  };

  const toHistoryItem = (item) => {
    const createdAt = item.createdAt ? new Date(item.createdAt) : null;
    const score = item.score ?? "-";
    const maxScore = item.maxScore ?? "-";
    const deductions = Array.isArray(item.deductions) ? item.deductions : [];
    const suggestions = Array.isArray(item.suggestions) ? item.suggestions : [];
    const reviewParts = [
      item.analysis || "",
      deductions.length ? `扣分点：${deductions.join("；")}` : "",
      suggestions.length ? `建议：${suggestions.join("；")}` : "",
    ].filter(Boolean);

    return {
      id: item.id,
      questionName: item.questionName || "未命名题目",
      answerName: item.answerName || "未命名作答",
      questionImage: item.questionImage || "",
      answerImage: item.answerImage || "",
      scoreText: `${score} / ${maxScore}`,
      level: item.level || "AI评分",
      analysis: item.analysis || "",
      deductions,
      suggestions,
      rubric: item.rubric || "",
      rawContent: item.rawContent || "",
      model: item.model || "",
      review: reviewParts.join("\n") || item.rawContent || "暂无点评。",
      time: createdAt && !Number.isNaN(createdAt.getTime()) ? formatTime(createdAt) : "",
    };
  };

  const cropToDataUrl = (kind) => {
    const imageElement = kind === "paper" ? elements.paperImage : elements.answerImage;
    const selection = state.selections[kind];

    if (!imageElement || !selection) {
      return "";
    }

    const canvas = document.createElement("canvas");
    const sourceX = selection.x * imageElement.naturalWidth;
    const sourceY = selection.y * imageElement.naturalHeight;
    const sourceWidth = selection.width * imageElement.naturalWidth;
    const sourceHeight = selection.height * imageElement.naturalHeight;

    canvas.width = Math.max(1, Math.round(sourceWidth));
    canvas.height = Math.max(1, Math.round(sourceHeight));

    const context = canvas.getContext("2d");
    context.drawImage(
      imageElement,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height
    );

    return canvas.toDataURL("image/jpeg", 0.82);
  };

  const renderSelection = (kind) => {
    const stage = kind === "paper" ? elements.paperStage : elements.answerStage;
    const image = kind === "paper" ? elements.paperImage : elements.answerImage;
    const selection = state.selections[kind];
    const oldBox = stage.querySelector(".selection-box");

    if (oldBox) {
      oldBox.remove();
    }

    if (!selection || !image.complete) {
      return;
    }

    const box = document.createElement("div");
    box.className = "selection-box";
    box.style.left = `${image.offsetLeft + selection.x * image.clientWidth}px`;
    box.style.top = `${image.offsetTop + selection.y * image.clientHeight}px`;
    box.style.width = `${selection.width * image.clientWidth}px`;
    box.style.height = `${selection.height * image.clientHeight}px`;
    stage.appendChild(box);
  };

  const setCropState = (kind, ready) => {
    const element = kind === "paper" ? elements.paperCropState : elements.answerCropState;
    element.textContent = ready ? "已框选" : state.images[kind] ? "可框选" : "未选择";
    element.classList.toggle("is-ready", ready);
  };

  const updatePairButton = () => {
    elements.savePairButton.disabled = !(state.selections.paper && state.selections.answer);
  };

  const clearSelection = (kind) => {
    state.selections[kind] = null;
    const stage = kind === "paper" ? elements.paperStage : elements.answerStage;
    const box = stage.querySelector(".selection-box");

    if (box) {
      box.remove();
    }

    setCropState(kind, false);
    updatePairButton();
  };

  const setupCropStage = (stage, kind) => {
    let start = null;
    let liveBox = null;

    const getClientPosition = (event) => {
      const touch = event.touches?.[0] || event.changedTouches?.[0];
      return {
        clientX: touch ? touch.clientX : event.clientX,
        clientY: touch ? touch.clientY : event.clientY,
      };
    };

    const getPoint = (event) => {
      const image = kind === "paper" ? elements.paperImage : elements.answerImage;
      const rect = image.getBoundingClientRect();
      const position = getClientPosition(event);
      const x = Math.min(Math.max(position.clientX - rect.left, 0), rect.width);
      const y = Math.min(Math.max(position.clientY - rect.top, 0), rect.height);
      return { x, y, rect, image };
    };

    const beginSelection = (event) => {
      const image = kind === "paper" ? elements.paperImage : elements.answerImage;

      if (!state.images[kind] || !image.complete || image.naturalWidth === 0) {
        return;
      }

      const point = getPoint(event);

      if (point.rect.width === 0 || point.rect.height === 0) {
        return;
      }

      event.preventDefault();
      start = point;
      clearSelection(kind);
      liveBox = document.createElement("div");
      liveBox.className = "selection-box";
      stage.appendChild(liveBox);
      drawSelection(event);
    };

    const drawSelection = (event) => {
      if (!start || !liveBox) {
        return;
      }

      event.preventDefault();
      const point = getPoint(event);
      const left = Math.min(start.x, point.x);
      const top = Math.min(start.y, point.y);
      const width = Math.abs(point.x - start.x);
      const height = Math.abs(point.y - start.y);

      liveBox.style.left = `${start.image.offsetLeft + left}px`;
      liveBox.style.top = `${start.image.offsetTop + top}px`;
      liveBox.style.width = `${width}px`;
      liveBox.style.height = `${height}px`;
    };

    const finishSelection = (event) => {
      if (!start || !liveBox) {
        return;
      }

      event.preventDefault();
      const point = getPoint(event);
      const left = Math.min(start.x, point.x);
      const top = Math.min(start.y, point.y);
      const width = Math.abs(point.x - start.x);
      const height = Math.abs(point.y - start.y);
      const selectionIsValid = width > 12 && height > 12;

      if (selectionIsValid) {
        state.selections[kind] = {
          x: left / point.rect.width,
          y: top / point.rect.height,
          width: width / point.rect.width,
          height: height / point.rect.height,
        };
        setCropState(kind, true);
        renderSelection(kind);
      } else {
        liveBox.remove();
        setCropState(kind, false);
      }

      start = null;
      liveBox = null;
      updatePairButton();
    };

    stage.addEventListener("pointerdown", beginSelection);
    window.addEventListener("pointermove", drawSelection);
    window.addEventListener("pointerup", finishSelection);
    window.addEventListener("pointercancel", finishSelection);

    stage.addEventListener("mousedown", beginSelection);
    window.addEventListener("mousemove", drawSelection);
    window.addEventListener("mouseup", finishSelection);

    stage.addEventListener("touchstart", beginSelection, { passive: false });
    window.addEventListener("touchmove", drawSelection, { passive: false });
    window.addEventListener("touchend", finishSelection, { passive: false });
    window.addEventListener("touchcancel", finishSelection, { passive: false });
  };

  const handleUpload = async (event, kind) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const dataUrl = await readFileAsDataUrl(file);
    const imageElement = kind === "paper" ? elements.paperImage : elements.answerImage;
    const stage = kind === "paper" ? elements.paperStage : elements.answerStage;
    const fileName = kind === "paper" ? elements.paperFileName : elements.answerFileName;

    state.images[kind] = {
      name: file.name,
      src: dataUrl,
      uploadId: null,
    };

    imageElement.src = dataUrl;
    stage.classList.add("has-image");
    fileName.textContent = file.name;
    clearSelection(kind);

    try {
      const upload = kind === "paper" ? await savePaperToHistory(file.name, dataUrl) : await saveUploadedImage("answer", file.name, dataUrl);
      state.images[kind].uploadId = upload.id;
    } catch (error) {
      if (kind === "paper") {
        elements.historyList.innerHTML = `<p class="empty-text">${escapeHtml(error.message)}</p>`;
      }
    }
  };

  const renderHistory = async () => {
    let history = [];

    try {
      const payload = await apiRequest("/api/ai-grade-history");
      history = (payload.history || []).map(toHistoryItem);
      state.history = history;
    } catch (error) {
      elements.historyList.innerHTML = `<p class="empty-text">${escapeHtml(error.message)}</p>`;
      return;
    }

    if (history.length === 0) {
      elements.historyList.innerHTML = '<p class="empty-text">暂无阅卷历史</p>';
      return;
    }

    elements.historyList.innerHTML = history
      .map(
        (item) => `
          <article class="history-item ai-history-summary">
            <div>
              <div class="history-title-row">
                <strong>${escapeHtml(item.scoreText)}</strong>
                <span>${escapeHtml(item.time)}</span>
              </div>
              <p>${escapeHtml(item.questionName)}</p>
              <small>${escapeHtml(item.answerName)} · ${escapeHtml(item.level)}</small>
            </div>
            <button class="ghost-button history-detail-button" type="button" data-history-id="${escapeHtml(item.id)}">查看详情</button>
          </article>
        `
      )
      .join("");
  };

  const renderList = (items, emptyText) =>
    items.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p>${escapeHtml(emptyText)}</p>`;

  const renderModalImage = (src, label, name) =>
    src
      ? `<img src="${src}" alt="${escapeHtml(name)}" />`
      : `<div class="history-modal-image-empty">${escapeHtml(label)}</div>`;

  const closeHistoryModal = () => {
    elements.historyModal?.classList.remove("is-open");
    elements.historyModal?.setAttribute("aria-hidden", "true");
    document.body.classList.remove("has-history-modal");
  };

  const openHistoryModal = (historyId) => {
    const item = state.history.find((historyItem) => historyItem.id === historyId);

    if (!item || !elements.historyModal || !elements.historyModalBody) {
      return;
    }

    elements.historyModalTime.textContent = item.time || item.model || "";
    elements.historyModalBody.innerHTML = `
      <section class="history-modal-score">
        <span>AI评分</span>
        <strong>${escapeHtml(item.scoreText)}</strong>
        <small>${escapeHtml(item.level)}</small>
      </section>
      <section class="history-modal-images">
        <article>
          <h3>原题目</h3>
          ${renderModalImage(item.questionImage, "原题目", item.questionName)}
          <p>${escapeHtml(item.questionName)}</p>
        </article>
        <article>
          <h3>学生作答</h3>
          ${renderModalImage(item.answerImage, "学生作答", item.answerName)}
          <p>${escapeHtml(item.answerName)}</p>
        </article>
      </section>
      <section class="history-modal-section">
        <h3>相关点评</h3>
        <p>${escapeHtml(item.analysis || item.rawContent || "暂无点评。")}</p>
      </section>
      <section class="history-modal-section">
        <h3>扣分点</h3>
        ${renderList(item.deductions, "暂无明确扣分点。")}
      </section>
      <section class="history-modal-section">
        <h3>改进建议</h3>
        ${renderList(item.suggestions, "暂无建议。")}
      </section>
      ${
        item.rubric
          ? `<section class="history-modal-section"><h3>评分标准</h3><p>${escapeHtml(item.rubric)}</p></section>`
          : ""
      }
    `;

    elements.historyModal.classList.add("is-open");
    elements.historyModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("has-history-modal");
  };

  elements.paperUpload.addEventListener("change", (event) => handleUpload(event, "paper"));
  elements.answerUpload.addEventListener("change", (event) => handleUpload(event, "answer"));

  elements.historyList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-history-id]");

    if (button) {
      openHistoryModal(button.dataset.historyId);
    }
  });

  elements.historyModal?.addEventListener("click", (event) => {
    if (event.target.closest("[data-close-history-modal]")) {
      closeHistoryModal();
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.historyModal?.classList.contains("is-open")) {
      closeHistoryModal();
    }
  });

  elements.clearCropButton.addEventListener("click", () => {
    clearSelection("paper");
    clearSelection("answer");
  });

  elements.savePairButton.addEventListener("click", async () => {
    if (!state.selections.paper || !state.selections.answer) {
      return;
    }

    const pair = {
      paperImageId: state.images.paper?.uploadId,
      answerImageId: state.images.answer?.uploadId,
      paperCrop: cropToDataUrl("paper"),
      answerCrop: cropToDataUrl("answer"),
      paperSelection: state.selections.paper,
      answerSelection: state.selections.answer,
      paperCropName: `${state.images.paper?.name || "试卷"}-题目区域`,
      answerCropName: `${state.images.answer?.name || "答案"}-答案区域`,
    };

    elements.savePairButton.disabled = true;

    try {
      await savePairToDatabase(pair);
      clearSelection("paper");
      clearSelection("answer");
    } catch (error) {
      elements.savePairButton.textContent = "保存失败";
      elements.savePairButton.title = error.message || "保存对应关系失败。";
      window.setTimeout(() => {
        elements.savePairButton.textContent = "保存对应关系";
        elements.savePairButton.title = "";
      }, 2400);
      updatePairButton();
    }
  });

  elements.clearHistoryButton.addEventListener("click", async () => {
    try {
      await apiRequest("/api/ai-grade-history", { method: "DELETE" });
      renderHistory();
    } catch (error) {
      elements.historyList.innerHTML = `<p class="empty-text">${escapeHtml(error.message)}</p>`;
    }
  });

  window.addEventListener("resize", () => {
    renderSelection("paper");
    renderSelection("answer");
  });

  setupCropStage(elements.paperStage, "paper");
  setupCropStage(elements.answerStage, "answer");
  renderHistory();
}

const aiReviewRoot = document.querySelector(".ai-review-shell");

if (aiReviewRoot) {
  const DEEPSEEK_MODEL = "deepseek-flash";

  const state = {
    mode: "paper",
    savedPapers: [],
    selectedPaper: null,
    singleQuestion: null,
    studentAnswer: null,
  };

  const elements = {
    form: document.querySelector("#aiReviewForm"),
    savedPaperList: document.querySelector("#savedPaperList"),
    segmentButtons: document.querySelectorAll(".segment-button"),
    modePanels: document.querySelectorAll(".mode-panel"),
    singleQuestionUpload: document.querySelector("#singleQuestionUpload"),
    studentAnswerUpload: document.querySelector("#studentAnswerUpload"),
    singleQuestionFileName: document.querySelector("#singleQuestionFileName"),
    studentAnswerFileName: document.querySelector("#studentAnswerFileName"),
    questionPreview: document.querySelector("#questionPreview"),
    answerPreview: document.querySelector("#answerPreview"),
    maxScoreInput: document.querySelector("#maxScoreInput"),
    rubricInput: document.querySelector("#rubricInput"),
    startAiGradeButton: document.querySelector("#startAiGradeButton"),
    aiStatusText: document.querySelector("#aiStatusText"),
    aiResult: document.querySelector("#aiResult"),
  };

  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (character) => {
      const entities = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      };
      return entities[character];
    });

  const apiRequest = async (url, options = {}) => {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.message || `请求失败：HTTP ${response.status}`);
    }

    return payload;
  };

  const readFileAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  const loadImage = (src) =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });

  const makeCompressedImage = async (src, maxWidth = 1200) => {
    const image = await loadImage(src);
    const scale = Math.min(1, maxWidth / image.naturalWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  };

  const getActiveQuestion = () => (state.mode === "paper" ? state.selectedPaper : state.singleQuestion);

  const renderImagePreview = (container, image, emptyText) => {
    if (!image) {
      container.innerHTML = `<p class="empty-text">${escapeHtml(emptyText)}</p>`;
      return;
    }

    container.innerHTML = `
      <img src="${image.src}" alt="${escapeHtml(image.name)}" />
      <div>
        <strong>${escapeHtml(image.name)}</strong>
        <span>${escapeHtml(image.meta || "")}</span>
      </div>
    `;
  };

  const renderQuestionPreview = () => {
    renderImagePreview(elements.questionPreview, getActiveQuestion(), "请选择试卷或上传试题");
  };

  const renderAnswerPreview = () => {
    renderImagePreview(elements.answerPreview, state.studentAnswer, "请上传学生作答图片");
  };

  const selectSavedPaper = (paperId) => {
    const paper = state.savedPapers.find((item) => item.id === paperId);

    if (!paper) {
      return;
    }

    state.selectedPaper = {
      id: paper.id,
      name: paper.name,
      src: paper.src,
      meta: paper.meta,
    };

    renderSavedPapers();
    renderQuestionPreview();
  };

  const formatUploadTime = (upload) => {
    const createdAt = upload.createdAt ? new Date(upload.createdAt) : null;

    if (!createdAt || Number.isNaN(createdAt.getTime())) {
      return upload.time || "";
    }

    const pad = (value) => String(value).padStart(2, "0");
    return `${createdAt.getFullYear()}-${pad(createdAt.getMonth() + 1)}-${pad(createdAt.getDate())} ${pad(createdAt.getHours())}:${pad(createdAt.getMinutes())}`;
  };

  const loadSavedPapers = async () => {
    const payload = await apiRequest("/api/uploads?kind=paper");
    state.savedPapers = (payload.uploads || []).map((upload) => ({
      id: upload.id,
      name: upload.name,
      src: upload.image,
      meta: formatUploadTime(upload),
    }));

    if (!state.savedPapers.some((paper) => paper.id === state.selectedPaper?.id)) {
      state.selectedPaper = state.savedPapers[0] || null;
    }
  };

  const renderSavedPapers = async () => {
    try {
      await loadSavedPapers();
    } catch (error) {
      elements.savedPaperList.innerHTML = `<p class="empty-text">${escapeHtml(error.message)}</p>`;
      return;
    }

    if (state.savedPapers.length === 0) {
      elements.savedPaperList.innerHTML = '<p class="empty-text">暂无已有试卷，请先返回智能阅卷上传试卷。</p>';
      return;
    }

    elements.savedPaperList.innerHTML = state.savedPapers
      .map((item) => {
        const isActive = state.selectedPaper?.id === item.id;
        return `
          <button class="saved-paper-card${isActive ? " is-active" : ""}" type="button" data-paper-id="${escapeHtml(item.id)}">
            <img src="${item.src}" alt="${escapeHtml(item.name)}" />
            <span>
              <strong>${escapeHtml(item.name)}</strong>
              <small>${escapeHtml(item.meta)}</small>
            </span>
          </button>
        `;
      })
      .join("");
    renderQuestionPreview();
  };

  const setMode = (mode) => {
    state.mode = mode;

    elements.segmentButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.mode === mode);
    });

    elements.modePanels.forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.modePanel === mode);
    });

    renderQuestionPreview();
  };

  const handleImageUpload = async (event, target) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const dataUrl = await readFileAsDataUrl(file);
    const compressed = await makeCompressedImage(dataUrl);
    const image = {
      name: file.name,
      src: compressed,
      meta: "本次上传",
      uploadId: null,
    };

    if (target === "question") {
      state.singleQuestion = image;
      elements.singleQuestionFileName.textContent = file.name;
      setMode("question");
    } else {
      state.studentAnswer = image;
      elements.studentAnswerFileName.textContent = file.name;
      renderAnswerPreview();
    }

    try {
      const payload = await apiRequest("/api/uploads", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: target === "question" ? "single_question" : "student_answer",
          name: file.name,
          image: compressed,
        }),
      });

      image.uploadId = payload.upload?.id || null;
    } catch (error) {
      elements.aiStatusText.textContent = error.message;
    }
  };

  const parseAiResult = (content) => {
    const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

    try {
      return JSON.parse(normalized);
    } catch {
      return null;
    }
  };

  const renderAiResult = (result, rawContent = "") => {
    if (!result) {
      elements.aiResult.innerHTML = `
        <article class="ai-result-card">
          <h3>AI 返回内容</h3>
          <pre>${escapeHtml(rawContent || "未能解析评分结果。")}</pre>
        </article>
      `;
      return;
    }

    const deductions = Array.isArray(result.deductions) ? result.deductions : [];
    const suggestions = Array.isArray(result.suggestions) ? result.suggestions : [];

    elements.aiResult.innerHTML = `
      <article class="ai-score-card">
        <span>得分</span>
        <strong>${escapeHtml(result.score ?? "-")} / ${escapeHtml(result.max_score ?? elements.maxScoreInput.value)}</strong>
        <small>${escapeHtml(result.level || "AI评分建议")}</small>
      </article>
      <article class="ai-result-card">
        <h3>作答分析</h3>
        <p>${escapeHtml(result.analysis || "暂无分析。")}</p>
      </article>
      <article class="ai-result-card">
        <h3>扣分点</h3>
        ${
          deductions.length
            ? `<ul>${deductions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
            : '<p>暂无明确扣分点。</p>'
        }
      </article>
      <article class="ai-result-card">
        <h3>改进建议</h3>
        ${
          suggestions.length
            ? `<ul>${suggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
            : '<p>暂无建议。</p>'
        }
      </article>
    `;
  };

  const setBusy = (busy) => {
    elements.startAiGradeButton.disabled = busy;
    elements.startAiGradeButton.textContent = busy ? "AI阅卷中..." : "开始 AI 阅卷";
    elements.aiStatusText.textContent = busy ? "正在调用 DeepSeek 分析图片与评分标准" : `模型：${DEEPSEEK_MODEL}`;
  };

  const requestAiGrade = async () => {
    const question = getActiveQuestion();
    const answer = state.studentAnswer;
    const maxScore = Number(elements.maxScoreInput.value);
    const rubric = elements.rubricInput.value.trim();

    if (!question) {
      throw new Error("请先选择已有试卷或上传单独试题。");
    }

    if (!answer) {
      throw new Error("请上传学生作答图片。");
    }

    if (!Number.isFinite(maxScore) || maxScore <= 0) {
      throw new Error("请填写大于 0 的满分。");
    }

    const response = await fetch("/api/ai-grade", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        questionImage: question.src,
        questionName: question.name,
        questionImageId: question.uploadId || question.id || null,
        questionKind: state.mode === "paper" ? "paper" : "single_question",
        answerImage: answer.src,
        answerName: answer.name,
        answerImageId: answer.uploadId || null,
        maxScore,
        rubric,
      }),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = payload?.message || payload?.error || `AI 阅卷请求失败：HTTP ${response.status}`;
      throw new Error(message);
    }

    const content = payload?.rawContent || "";
    return { parsed: payload?.result || parseAiResult(content), raw: content, historyError: payload?.historyError || "" };
  };

  elements.segmentButtons.forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });

  elements.savedPaperList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-paper-id]");

    if (button) {
      selectSavedPaper(button.dataset.paperId);
    }
  });

  elements.singleQuestionUpload.addEventListener("change", (event) => handleImageUpload(event, "question"));
  elements.studentAnswerUpload.addEventListener("change", (event) => handleImageUpload(event, "answer"));

  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    elements.aiResult.innerHTML = '<p class="empty-text">正在分析作答，请稍候...</p>';
    setBusy(true);

    try {
      const result = await requestAiGrade();
      renderAiResult(result.parsed, result.raw);
      elements.aiStatusText.textContent = result.historyError ? "评分完成，历史保存失败" : "评分完成，已保存历史";
    } catch (error) {
      elements.aiResult.innerHTML = `
        <article class="ai-result-card is-error">
          <h3>无法完成 AI 阅卷</h3>
          <p>${escapeHtml(error.message || "请检查网络连接或稍后重试。")}</p>
        </article>
      `;
      elements.aiStatusText.textContent = "评分失败";
    } finally {
      setBusy(false);
    }
  });

  renderSavedPapers().catch(() => {});
  renderAnswerPreview();
}
