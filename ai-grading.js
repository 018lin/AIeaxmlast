(function () {
  const state = {
    question: null,
    answer: null,
    busy: false,
  };

  const $ = (selector) => document.querySelector(selector);

  const elements = {
    questionUpload: $("#aiQuestionUpload"),
    answerUpload: $("#aiAnswerUpload"),
    questionFileName: $("#aiQuestionFileName"),
    answerFileName: $("#aiAnswerFileName"),
    questionPreview: $("#aiQuestionPreview"),
    answerPreview: $("#aiAnswerPreview"),
    maxScore: $("#aiMaxScore"),
    rubric: $("#aiRubric"),
    gradeButton: $("#aiGradeButton"),
    statusText: $("#aiGradeStatus"),
    resultArea: $("#aiGradeResult"),
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
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

  function renderPreview(target) {
    const image = target === "question" ? state.question : state.answer;
    const container = target === "question" ? elements.questionPreview : elements.answerPreview;

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

  function updateState() {
    if (state.busy) {
      return;
    }

    const maxScore = Number(elements.maxScore.value);
    const ready = Boolean(state.question && state.answer && Number.isFinite(maxScore) && maxScore > 0);
    elements.gradeButton.disabled = !ready;

    if (!state.question) {
      elements.statusText.textContent = "请上传试题图片";
    } else if (!state.answer) {
      elements.statusText.textContent = "请上传学生作答图片";
    } else if (!Number.isFinite(maxScore) || maxScore <= 0) {
      elements.statusText.textContent = "请填写大于 0 的满分";
    } else {
      elements.statusText.textContent = "可以开始 AI 批改";
    }
  }

  async function handleImage(event, target) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      const compressed = await compressImageDataUrl(dataUrl);
      const image = { name: file.name, src: compressed };

      if (target === "question") {
        state.question = image;
        elements.questionFileName.textContent = file.name;
      } else {
        state.answer = image;
        elements.answerFileName.textContent = file.name;
      }

      renderPreview(target);
      updateState();
    } catch (error) {
      alert(error.message || "图片读取失败。");
    } finally {
      event.target.value = "";
    }
  }

  function renderResult(result, rawContent) {
    const deductions = Array.isArray(result?.deductions) ? result.deductions : [];
    const suggestions = Array.isArray(result?.suggestions) ? result.suggestions : [];

    if (!result) {
      elements.resultArea.innerHTML = `
        <article class="ai-result-card is-error">
          <h3>AI 返回内容未能解析</h3>
          <pre>${escapeHtml(rawContent || "AI 没有返回评分内容，请确认服务端配置的是支持图片输入的视觉模型。")}</pre>
        </article>
      `;
      return;
    }

    const maxScore = result.max_score ?? elements.maxScore.value;
    const hasComment = Boolean(result.analysis || deductions.length || suggestions.length);

    elements.resultArea.innerHTML = `
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

  async function handleGrade() {
    if (state.busy) {
      return;
    }

    if (!state.question || !state.answer) {
      alert("请先上传试题和学生作答图片。");
      return;
    }

    const maxScore = Number(elements.maxScore.value);

    if (!Number.isFinite(maxScore) || maxScore <= 0) {
      alert("请填写大于 0 的满分。");
      return;
    }

    state.busy = true;
    elements.gradeButton.disabled = true;
    elements.gradeButton.textContent = "AI 批改中...";
    elements.statusText.textContent = "正在调用 DeepSeek 分析试题与作答";
    elements.resultArea.innerHTML = '<p class="empty-text">正在分析作答，请稍候...</p>';

    try {
      const response = await fetch("/api/ai-grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionImage: state.question.src,
          questionName: state.question.name,
          questionKind: "single_question",
          answerImage: state.answer.src,
          answerName: state.answer.name,
          maxScore,
          rubric: elements.rubric.value.trim(),
        }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.message || `AI 批改请求失败：HTTP ${response.status}`);
      }

      renderResult(payload.result, payload.rawContent);
      elements.statusText.textContent = payload.historyError
        ? `批改完成，历史保存失败（${payload.model || "AI"}）`
        : `批改完成，已保存历史（${payload.model || "AI"}）`;
    } catch (error) {
      elements.resultArea.innerHTML = `
        <article class="ai-result-card is-error">
          <h3>无法完成 AI 批改</h3>
          <p>${escapeHtml(error.message || "请检查网络连接或稍后重试。")}</p>
        </article>
      `;
      elements.statusText.textContent = "批改失败";
    } finally {
      state.busy = false;
      elements.gradeButton.textContent = "开始 AI 批改";
      const latestMaxScore = Number(elements.maxScore.value);
      elements.gradeButton.disabled = !(
        state.question &&
        state.answer &&
        Number.isFinite(latestMaxScore) &&
        latestMaxScore > 0
      );
    }
  }

  elements.questionUpload.addEventListener("change", (event) => handleImage(event, "question"));
  elements.answerUpload.addEventListener("change", (event) => handleImage(event, "answer"));
  elements.maxScore.addEventListener("input", updateState);
  elements.gradeButton.addEventListener("click", handleGrade);
  updateState();
})();
