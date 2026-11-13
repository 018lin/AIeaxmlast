(() => {
  const app = document.querySelector('#app');
  const notice = document.querySelector('#notice');
  const fileInput = document.querySelector('#photoFile');
  const session = window.AppAuth.getSession();
  if (!session) return;
  document.querySelector('#teacherName').textContent = `${session.name || session.account} · 菜单`;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state = { detail: null, stream: null, cameraReady: false, busy: false, route: 0, timer: null, photoTarget: null, fileTarget: null, pendingRoute: null, questionDrafts: new Map(), answerFiles: [], answerStitched: '', paper: null, gradingMode: null, modes: [], contestedOnly: false };
  const statusText = { draft: '待拍照', ready: '待批改', queued: '排队中', pending: '排队中', grading: '批改中', running: '批改中', done: '已完成', failed: '批改失败', needs_review: '需查看' };
  const ANSWER_MAX_SOURCE = 30 * 1024 * 1024;
  const STITCH_MAX_WIDTH = 2400; // 与单图压缩的最长边一致，避免拼接后被二次缩小。
  const STITCH_MIN_WIDTH = 1400; // 低于此宽度宁可不提交，提示教师裁剪后重选。
  const STITCH_MAX_PIXELS = 12000000; // iOS Safari 画布面积有上限，留出余量。
  // Vercel 请求体上限 4.5MB；base64 比二进制大约 1/3，预留 JSON 字段余量。
  const UPLOAD_MAX_DATA_URL = 4.3 * 1024 * 1024;
  const UPLOAD_MAX_BYTES = Math.floor(UPLOAD_MAX_DATA_URL * 3 / 4) - 1024;
  const activeStatus = (status) => ['grading', 'queued', 'pending', 'running'].includes(status);
  const statusTone = (status) => status === 'done' ? ' good' : ['failed', 'needs_review'].includes(status) ? ' warning' : activeStatus(status) ? ' active' : '';
  function captureTicks(captured, total) {
    if (!total) return '';
    const size = Math.min(total, 80);
    const filled = total > 80 ? Math.round(captured / total * size) : captured;
    return `<div class="assignment-rail" aria-hidden="true">${Array.from({ length: size }, (_, i) => `<span class="${i < filled ? 'on' : ''}"></span>`).join('')}</div>`;
  }
  const go = (view, examId = '', studentId = '') => { if (state.pendingRoute === null) location.hash = [view, examId, studentId].filter(Boolean).join('/'); };
  const route = () => location.hash.slice(1).split('/');
  const editable = () => ['draft', 'ready', 'capturing', 'confirmed'].includes(state.detail?.batch.status);
  let noticeTimer = null;
  function message(text = '') {
    clearTimeout(noticeTimer);
    notice.textContent = text;
    notice.hidden = !text;
    if (text) noticeTimer = setTimeout(message, 4000);
  }
  const gradeProgress = new Map();
  let gradeTimer = null;
  function progressValue(key) {
    if (!gradeProgress.has(key)) gradeProgress.set(key, 6);
    return gradeProgress.get(key);
  }
  function tickProgress() {
    const bars = [...app.querySelectorAll('[data-progress]')];
    if (!bars.length) { clearInterval(gradeTimer); gradeTimer = null; return; }
    for (const bar of bars) {
      const key = bar.dataset.progress, current = progressValue(key);
      const next = Math.min(92, current + Math.max(0.8, (92 - current) * 0.045));
      gradeProgress.set(key, next);
      bar.querySelector('i').style.width = `${next.toFixed(1)}%`;
      bar.setAttribute('aria-valuenow', String(Math.round(next)));
    }
  }
  function trackProgress() {
    if (!gradeTimer && app.querySelector('[data-progress]')) gradeTimer = setInterval(tickProgress, 400);
  }
  const busyOverlay = document.querySelector('#busyOverlay');
  const busyRing = busyOverlay.querySelector('.busy-ring-value');
  const busyPercent = document.querySelector('#busyPercent');
  const busyLabel = document.querySelector('#busyLabel');
  const RING_LENGTH = 2 * Math.PI * 58;
  let busyTimer = null;
  function startBusy() {
    clearInterval(busyTimer);
    let progress = 0.06;
    const stages = [[0.62, '正在识别题目与分值…'], [0.86, '正在整理题目清单…']];
    const paint = () => {
      busyRing.style.strokeDashoffset = String(RING_LENGTH * (1 - progress));
      busyPercent.textContent = `${Math.round(progress * 100)}%`;
      busyLabel.textContent = stages.find(([threshold]) => progress >= threshold)?.[1] || '正在上传标准答案…';
    };
    busyRing.style.strokeDasharray = String(RING_LENGTH);
    paint();
    busyOverlay.hidden = false;
    document.body.classList.add('is-busy');
    busyTimer = setInterval(() => { progress += (0.9 - progress) * 0.06; paint(); }, 320);
  }
  function finishBusy() {
    clearInterval(busyTimer);
    busyRing.style.strokeDashoffset = '0';
    busyPercent.textContent = '100%';
    busyLabel.textContent = '识别完成';
    return new Promise(resolve => setTimeout(resolve, 260));
  }
  function stopBusy() {
    clearInterval(busyTimer);
    busyOverlay.hidden = true;
    document.body.classList.remove('is-busy');
  }
  async function api(action, payload, query = {}) {
    const params = new URLSearchParams({ action, ...query });
    const response = await window.AppAuth.request(`/api/mvp?${params}`, payload === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.message || (response.status === 413 ? '上传内容过大，请裁剪标准答案图片后重试。' : '请求失败，请重试。'));
    if (!data) throw new Error('服务响应异常，请重试。');
    return data;
  }
  function stopCamera() { state.stream?.getTracks().forEach(track => track.stop()); state.stream = null; state.cameraReady = false; }
  function back(label = '返回作业列表', target = '#list') { return `<a class="back" href="${target}">${label}</a>`; }
  function pageFor(studentId) { return state.detail.pages.find(page => page.studentId === studentId); }
  // 模式文案与说明由服务端下发，前端不再各自维护一份。
  function modePicker() {
    const list = state.modes.length ? state.modes : [{ value:'fast', label:'高效模式', note:'' }, { value:'fine', label:'精批模式', note:'' }];
    const current = list.find(item => item.value === state.gradingMode) || list[0];
    const tabs = list.map(item => `<button type="button" role="radio" aria-checked="${item.value === current.value}" class="${item.value === current.value ? 'is-active' : ''}" data-action="mode" data-mode="${esc(item.value)}">${esc(item.label)}</button>`).join('');
    return `<section class="mode-picker"><div class="mode-tabs" role="radiogroup" aria-label="批改模式">${tabs}</div><p class="mode-note">${esc(current.note || '')}</p></section>`;
  }
  const modeLabel = (value) => (state.modes.find(item => item.value === value)?.label) || (value === 'fine' ? '精批模式' : '高效模式');
  function resultsFor(studentId) { return state.detail.results.filter(result => result.studentId === studentId); }
  function isDone(studentId) { const p = pageFor(studentId); return p?.status === 'done' || (resultsFor(studentId).length >= state.detail.questions.length && state.detail.questions.length > 0); }
  async function loadList(token) {
    const data = await api('desk-list');
    if (token !== state.route) return;
    state.gradingMode = data.gradingMode || 'fast';
    state.modes = Array.isArray(data.modes) ? data.modes : [];
    const active = data.assignments.filter(item => activeStatus(item.status)).length;
    const review = data.assignments.reduce((sum, item) => sum + Number(item.reviewCount || 0), 0);
    const summary = data.assignments.length ? `<div class="summary-strip"><span><b>${data.assignments.length}</b> 份作业</span>${active ? `<span><b>${active}</b> 份进行中</span>` : ''}${review ? `<span class="review"><b>${review}</b> 题待复核</span>` : ''}</div>` : '';
    app.innerHTML = `<div class="heading"><div><h1>作业</h1><p>按名单顺序拍照，拍完统一批改。</p></div><a class="button primary" href="#new">新建作业</a></div>${modePicker()}${summary}<div class="assignment-list">${data.assignments.map(item => `<a class="assignment" href="#results/${esc(item.id)}"><header><h2>${esc(item.name)}</h2><span class="badge${statusTone(item.status)}">${esc(statusText[item.status] || item.status)}</span></header><p>${esc(item.className)} · ${esc(String(item.examDate || '').slice(0,10).replace(/-/g,'.'))}</p>${captureTicks(Number(item.capturedCount), Number(item.studentCount))}<footer><span>已拍 <b>${Number(item.capturedCount)}</b> / ${Number(item.studentCount)}</span><span>完成 <b>${Number(item.doneCount)}</b> 人</span>${item.reviewCount ? `<span class="review">待复核 <b>${Number(item.reviewCount)}</b> 题</span>` : ''}${item.averageScore != null ? `<span>平均 <b>${Number(item.averageScore).toFixed(1)}</b> 分</span>` : ''}</footer>${activeStatus(item.status) ? `<progress max="${Number(item.capturedCount) || 1}" value="${Number(item.doneCount)}" aria-label="批改进度"></progress>` : ''}</a>`).join('') || '<section class="empty"><h2>还没有作业</h2><p>选一个班级，拍下标准答案，就可以开始。</p><a class="button primary" href="#new">创建第一份作业</a></section>'}</div>`;
    if (data.assignments.some(item => activeStatus(item.status))) state.timer = setTimeout(() => loadList(token).catch(error => message(error.message)), 6000);
  }
  async function newAssignment(token) {
    const { classes } = await api('bootstrap');
    if (token !== state.route) return;
    clearAnswerFiles();
    app.innerHTML = `${back()}<div class="heading"><div><h1>新建作业</h1><p>拍 1–2 张标准答案，自动拼成一份。</p></div></div>${classes.length ? `<form class="form" id="createForm"><label class="field"><span class="field-label">班级</span><select name="classId" required>${classes.map(item => `<option value="${esc(item.id)}" ${item.id === window.AppAuth.getDefaultClassId() ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label><label class="field"><span class="field-label">作业名称</span><input name="name" required maxlength="120" placeholder="例如：第三单元课后练习"></label><label class="field"><span class="field-label">日期</span><input name="examDate" type="date" required value="${new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10)}"></label><div class="field"><span class="field-label">标准答案<em>必填</em></span><div class="upload"><p class="upload-title" id="answerTitle">拍下标准答案（1–2 张）</p><p class="upload-note">先选的在上，后选的在下，两张会自动拼接成一张再识别。保留完整题号。未标分的题默认 10 分，创建后可在核对页删题、合并或调整满分。</p><div class="upload-actions" id="answerPicker"><label class="button primary"><span id="answerCameraLabel">拍摄答案</span><input id="answerCamera" type="file" accept="image/*" capture="environment" aria-label="拍摄标准答案"></label><label class="button"><span id="answerFileLabel">从图库选择</span><input id="answerFile" type="file" accept="image/*" multiple aria-label="从图库选择标准答案，最多两张"></label></div><div id="answerPreview" class="answer-previews" hidden aria-live="polite"></div></div></div><button class="primary" type="submit">识别答案并创建</button><p class="muted form-note" id="createHint">创建时按学号冻结名单，后续名单变动不会打乱拍摄顺序。</p></form>` : '<section class="empty"><h2>先准备一份班级名单</h2><p>拍照时会按学号依次对应学生。</p><a class="button primary" href="./class-setup.html">管理班级</a></section>'}`;
  }
  function studentRow(student, review = false) {
    const page = pageFor(student.id), results = resultsFor(student.id), done = isDone(student.id);
    const score = results.reduce((sum, item) => sum + Number(item.score ?? 0), 0);
    const scored = results.filter(item => item.score != null).length;
    const needsReview = results.filter(item => item.needsReview).length;
    const waiting = Boolean(page) && !done && !page.error && activeStatus(page.status);
    const progressKey = `${state.detail.exam.id}:${student.id}`;
    if (!waiting) gradeProgress.delete(progressKey);
    const percent = waiting ? progressValue(progressKey) : 0;
    const status = !page ? '未拍' : page.error ? page.error : done ? (needsReview ? `${needsReview} 题待复核` : '已完成') : review ? '已拍 · 请核对' : (statusText[page.status] || '已拍');
    const thumb = review ? (page ? `<img class="thumb" data-thumb="${esc(student.id)}" alt="${esc(student.name)}的作业照片">` : '<span class="thumb thumb-empty" aria-hidden="true">未拍</span>') : '';
    return `<div class="student${page ? '' : ' is-missing'}${waiting ? ' is-grading' : ''}"><span class="student-no">${esc(student.studentNo || '—')}</span>${thumb}<div class="identity"><strong>${esc(student.name)}</strong>${waiting ? '' : `<small${page?.error ? ` title="${esc(page.error)}"` : ''}${done && needsReview ? ' class="needs-review"' : ''}>${esc(status)}</small>`}</div>${done && !review ? `<span class="score">${scored ? `${score}<small>分</small>` : '—'}</span>` : ''}<div class="actions">${page ? `<button data-action="photo" data-student="${esc(student.id)}">看照片</button>` : ''}${review && editable() ? `<button data-action="capture-one" data-student="${esc(student.id)}">${page ? '替换' : '补拍'}</button>` : done ? `<a class="button" href="#student/${esc(state.detail.exam.id)}/${esc(student.id)}">详情</a>` : ''}</div>${waiting ? `<span class="student-progress" data-progress="${esc(progressKey)}" role="progressbar" aria-label="批改进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}"><i style="width:${percent.toFixed(1)}%"></i></span>` : ''}</div>`;
  }
  function renderReview() {
    const d = state.detail, count = d.pages.length;
    const draft = state.questionDrafts.get(d.exam.id), questions = draft || d.questions;
    app.innerHTML = `${back()}<div class="heading"><div><h1>核对照片</h1><p>${esc(d.exam.name)} · 已拍 ${count} / 未拍 ${d.students.length-count}</p></div></div><p class="muted roster-note">逐人核对姓名与照片；缺交的学生保留未拍，不会把后面的照片前移。</p><div class="roster review"><div class="roster-head"><span>学号</span><span>照片</span><span>姓名</span><span class="end">核对</span></div>${d.students.map(student => studentRow(student, true)).join('')}</div>${editable() ? `<details class="question-editor"><summary>核对题目 · ${questions.length} 题 · 满分 ${questions.reduce((sum,q)=>sum+Number(q.maxScore),0)} 分</summary><p>勾选多题后可合并，合并题号请保留原题号信息。</p><form id="questionForm" data-dirty="${Boolean(draft)}"><div id="questionRows">${questions.map(q => questionRow(q)).join('')}</div><div class="actions"><button type="button" data-action="merge">合并所选题</button><button type="submit">保存题目调整</button></div></form></details><div class="sticky-actions"><a class="button" href="#capture/${esc(d.exam.id)}">继续拍照</a>${state.gradingMode ? `<small class="mode-hint">按${esc(modeLabel(state.gradingMode))}批改</small>` : ''}<button class="primary" data-action="start" ${!count ? 'disabled' : ''}>已核对 ${count} 人，开始批改</button></div>` : `<div class="sticky-actions"><a class="button primary" href="#results/${esc(d.exam.id)}">查看批改进度</a></div>`}`;
    trackProgress();
  }
  function questionRow(q) { return `<div class="question-row"><input type="checkbox" aria-label="选择合并题目"><input name="questionNo" aria-label="题号" required value="${esc(q.questionNo)}"><input name="title" aria-label="题目说明" value="${esc(q.title)}"><input name="maxScore" aria-label="满分" type="number" min="0.5" max="1000" step="0.5" required value="${Number(q.maxScore)}"><button type="button" data-action="delete-question">删除</button></div>`; }
  function renderResults() {
    const d = state.detail, done = d.students.filter(s => isDone(s.id)).length, failed = d.pages.some(p => p.status === 'failed');
    app.innerHTML = `${back()}<div class="heading"><div><h1>${esc(d.exam.name)}</h1><p>已完成 ${done} 人 · ${d.results.filter(r=>r.needsReview).length} 题待复核</p></div><button data-action="refresh">刷新</button></div>${editable() ? `<div class="actions result-actions"><a class="button primary" href="#capture/${esc(d.exam.id)}">${d.pages.length ? '继续拍照' : '开始拍照'}</a><a class="button" href="#review/${esc(d.exam.id)}">核对照片 (${d.pages.length}/${d.students.length})</a></div>` : `<div class="progress-panel"><div class="progress-copy"><span>批改进度</span><b>${done} / ${d.students.length}</b></div><progress max="${d.pages.length || 1}" value="${done}" aria-label="已完成学生数"></progress><p class="muted">${['done','needs_review','failed'].includes(d.batch.status) ? '批改已结束，可逐人查看每题得分与评语。' : '后台正在批改，可以锁屏或离开，回来后继续查看。'}</p>${failed ? '<button data-action="retry">重试失败作业</button>' : ''}</div>`}<div class="roster results"><div class="roster-head"><span>学号</span><span>姓名</span><span class="end">得分</span><span class="end">操作</span></div>${d.students.map(s=>studentRow(s)).join('')}</div>`;
    trackProgress();
  }
  async function pollResults() {
    const token = state.route, examId = state.detail?.exam.id;
    if (!examId) return;
    try {
      const detail = await api('desk-detail', undefined, { examId });
      if (token !== state.route || state.detail?.exam.id !== examId || route()[0] !== 'results') return;
      state.detail = detail;
      renderResults();
      if (activeStatus(detail.batch.status)) state.timer = setTimeout(pollResults, 6000);
    } catch (error) {
      if (token !== state.route) return;
      message(error.message);
      state.timer = setTimeout(pollResults, 6000);
    }
  }
  function paperBoxes(studentId, positions) {
    return resultsFor(studentId).map(r => {
      const bbox = positions?.[r.questionNo] || r.bbox;
      if (!Array.isArray(bbox) || bbox.length !== 4) return '';
      const [x, y, width, height] = bbox.map(Number);
      const scored = r.score == null ? null : Number(r.score);
      const tone = scored == null ? 'part' : scored >= Number(r.maxScore) - 0.001 ? 'good' : scored <= 0.001 ? 'bad' : 'part';
      return `<span class="paper-box ${tone}" style="left:${(x*100).toFixed(2)}%;top:${(y*100).toFixed(2)}%;width:${(width*100).toFixed(2)}%;height:${(height*100).toFixed(2)}%" title="${esc(r.analysis || '')}"><span class="paper-box-label"><b>${esc(r.questionNo)}</b><em>${scored == null ? '待复核' : `${scored}/${Number(r.maxScore)}`}</em></span></span>`;
    }).join('');
  }
  function renderPaperStage() {
    const stage = app.querySelector('#paperStage');
    if (!stage || !state.paper) return;
    const paper = state.paper, hint = app.querySelector('#paperHint');
    const student = state.detail.students.find(s=>s.id===paper.studentId);
    const source = paper.mode === 'answer' ? paper.answer : paper.student;
    if (!source) {
      const text = paper.mode === 'answer'
        ? (paper.loading ? '正在加载标准答案…' : '这份作业没有可用的标准答案图片。')
        : !pageFor(paper.studentId)
          ? '该学生尚未拍摄答卷照片。'
          : (paper.loading ? '正在加载答卷…' : '答卷照片加载失败，可点击下方“查看作业照片”重试。');
      stage.innerHTML = `<p class="paper-note">${text}</p>`;
      if (hint) hint.textContent = '';
      return;
    }
    if (paper.mode === 'answer') {
      stage.innerHTML = `<img class="paper-image" src="${source}" alt="${esc(state.detail.exam.name)}的标准答案">`;
      if (hint) hint.textContent = '标准答案原图，不叠加学生作答标注。';
      return;
    }
    const boxes = paperBoxes(paper.studentId, paper.boxes);
    stage.innerHTML = `<div class="paper-frame"><img class="paper-image" src="${source}" alt="${esc(student?.name || '')}的答卷">${boxes}</div>`;
    if (hint) hint.textContent = boxes
      ? '框内为题号与得分：绿色正确、橙色部分正确、红色错误。'
      : resultsFor(paper.studentId).length ? '本次未能可靠定位题目位置，已隐藏标注；请以逐题得分和评语为准。' : '';
  }
  function setPaperMode(mode) {
    if (!state.paper || !['student','answer'].includes(mode)) return;
    state.paper.mode = mode;
    app.querySelectorAll('[data-action="paper"]').forEach(button => {
      const active = button.dataset.mode === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    renderPaperStage();
  }
  async function loadPaperImages(studentId, token) {
    const paper = state.paper;
    if (!paper || paper.studentId !== studentId) return;
    const examId = state.detail.exam.id;
    const [studentResult, answerResult] = await Promise.allSettled([
      pageFor(studentId) ? api('desk-image', undefined, {examId, studentId, preview:'1', boxes:'1'}) : Promise.resolve({image:''}),
      api('desk-answer-image', undefined, {examId}),
    ]);
    if (token !== state.route || state.paper !== paper) return;
    paper.student = studentResult.status === 'fulfilled' ? String(studentResult.value.image || '') : '';
    paper.boxes = studentResult.status === 'fulfilled' ? studentResult.value.boxes : null;
    paper.answer = answerResult.status === 'fulfilled' ? String(answerResult.value.image || '') : '';
    paper.loading = false;
    renderPaperStage();
  }
  function studentScore(studentId) {
    const results = resultsFor(studentId);
    return {
      total: results.reduce((sum, r) => sum + Number(r.score ?? 0), 0),
      max: results.reduce((sum, r) => sum + Number(r.maxScore), 0),
      scored: results.filter(r => r.score != null).length,
    };
  }
  function reviewForm(r) {
    return `<form class="review-form" data-question="${esc(r.questionNo)}"><label class="review-field"><span>得分</span><input name="score" type="number" inputmode="decimal" min="0" max="${Number(r.maxScore)}" step="any" required value="${r.score == null ? '' : Number(r.score)}" aria-label="第 ${esc(r.questionNo)} 题得分"></label><label class="review-field grow"><span>教师评语</span><input name="comment" maxlength="500" placeholder="选填，补充说明" value="${esc(r.teacherComment || '')}" aria-label="第 ${esc(r.questionNo)} 题教师评语"></label><button type="submit">保存复核</button></form>`;
  }
  // 待复核的题目优先排在最前，其余保持原始题号顺序（排序稳定）。
  function orderedResults(studentId) {
    return resultsFor(studentId).slice().sort((a, b) => Number(!a.needsReview) - Number(!b.needsReview));
  }
  const isContested = (r) => r.agreement === 'arbitrated' || r.agreement === 'disputed';
  function contestedLabel(studentId) {
    const count = resultsFor(studentId).filter(isContested).length;
    return state.contestedOnly ? `显示全部 ${resultsFor(studentId).length} 题` : `只看争议题（${count}）`;
  }
  // 一致、已仲裁、待复核三档语义不同：已仲裁说明有争议但已定分，不占用教师复核队列。
  function agreementBadge(r) {
    if (r.reviewed) return '<span class="badge good">已复核</span>';
    if (r.needsReview) return '<span class="badge warning">待复核</span>';
    if (r.agreement === 'arbitrated') return '<span class="badge info">已仲裁</span>';
    if (r.agreement === 'agree') return '<span class="badge quiet">双评一致</span>';
    return '';
  }
  function passesHtml(r) {
    const passes = Array.isArray(r.passes) ? r.passes : [];
    if (passes.length < 2) return '';
    const name = { A: '第一次', B: '第二次', arbiter: '复核' };
    const rows = passes.map(p => `<li><b>${name[p.pass] || p.pass || '评判'}</b><span>${p.score == null ? '未判定' : `${Number(p.score)} 分`}</span><em>${esc(p.reason || p.analysis || '')}</em></li>`).join('');
    return `<details class="passes"><summary>${passes.length} 次评判详情</summary><ul>${rows}</ul></details>`;
  }
  function resultListHtml(studentId) {
    const all = orderedResults(studentId);
    if (!all.length) return '<p class="empty">还没有批改结果。</p>';
    const results = state.contestedOnly ? all.filter(r => isContested(r) || r.needsReview) : all;
    const pending = all.filter(r => r.needsReview).length;
    const contested = all.filter(isContested).length;
    const note = [pending ? `${pending} 题待复核，已排在前面。` : '', contested ? `${contested} 题两次评判不一致。` : ''].filter(Boolean).join(' ');
    const empty = state.contestedOnly && !results.length ? '<p class="empty">没有争议题，两次评判结论一致。</p>' : '';
    return (note ? `<p class="result-note">${note}</p>` : '') + empty + results.map(r => `<section class="result-question" data-question="${esc(r.questionNo)}"><header><h2>第 ${esc(r.questionNo)} 题</h2><span>${r.score == null ? '—' : Number(r.score)} / ${Number(r.maxScore)} 分 ${agreementBadge(r)}<em class="review-hint">点按复核</em></span></header><p>${esc(r.analysis || '暂无评语')}</p>${passesHtml(r)}${(r.suggestions || []).map(s=>`<p class="muted">${esc(s)}</p>`).join('')}<small>${r.score != null && Number(r.score) < Number(r.maxScore) ? '需巩固：' : '知识点：'}${esc((r.knowledgePoints || []).join('、') || '未标注')}</small>${reviewForm(r)}</section>`).join('');
  }
  function renderStudentResults(studentId) {
    const open = new Set([...app.querySelectorAll('.result-question.is-open')].map(card => card.dataset.question));
    const list = app.querySelector('.result-list');
    if (list) {
      list.innerHTML = resultListHtml(studentId);
      list.querySelectorAll('.result-question').forEach(card => card.classList.toggle('is-open', open.has(card.dataset.question)));
    }
    const score = app.querySelector('.heading .score');
    if (score) {
      const { total, max, scored } = studentScore(studentId);
      score.innerHTML = `${scored ? total : '—'}<small> / ${max}</small>`;
    }
    renderPaperStage();
  }
  function renderStudent(id) {
    const d = state.detail, student = d.students.find(s=>s.id===id);
    if (!student) throw new Error('名单快照中没有该学生。');
    const { total, max, scored } = studentScore(id);
    state.paper = { studentId:id, mode:'student', student:'', answer:'', loading:true };
    app.innerHTML = `${back('返回班级结果', `#results/${esc(d.exam.id)}`)}<div class="heading"><div><h1>${esc(student.name)}</h1><p>学号 ${esc(student.studentNo)} · ${esc(d.exam.name)}</p></div><span class="score">${scored ? total : '—'}<small> / ${max}</small></span></div><section class="paper-viewer" aria-label="原卷与标注"><div class="paper-tabs" role="tablist"><button type="button" role="tab" aria-selected="true" data-action="paper" data-mode="student" class="is-active">学生答卷</button><button type="button" role="tab" aria-selected="false" data-action="paper" data-mode="answer">标准答案</button></div><div class="paper-stage" id="paperStage"><p class="paper-note">正在加载答卷…</p></div><p class="paper-hint" id="paperHint"></p></section><div class="actions result-actions">${pageFor(id) ? `<button data-action="photo" data-student="${esc(id)}">查看作业照片</button>` : ''}${resultsFor(id).some(isContested) ? `<button data-action="contested" aria-pressed="${state.contestedOnly}" class="${state.contestedOnly ? 'is-active' : ''}">${contestedLabel(id)}</button>` : ''}</div><div class="result-list">${resultListHtml(id)}</div>`;
  }
  async function renderCapture(requestedId, token) {
    const d = state.detail;
    if (!editable()) { go('results',d.exam.id); return; }
    const index = requestedId ? d.students.findIndex(s=>s.id===requestedId) : d.students.findIndex(s=>!pageFor(s.id));
    if (index < 0) { go('review',d.exam.id); return; }
    const student = d.students[index];
    state.photoTarget = { examId:d.exam.id, studentId:student.id, captureOrder:index, name:student.name, replacement:!!pageFor(student.id) };
    document.body.classList.add('camera-mode');
    const rail = d.students.map((item, i) => `<span class="${i === index ? 'now' : pageFor(item.id) ? 'taken' : ''}"></span>`).join('');
    app.innerHTML = `<section class="camera"><header class="camera-head"><div class="camera-top"><span>第 <b>${index+1}</b> / ${d.students.length} 位</span><a class="back" href="#review/${esc(d.exam.id)}">核对照片</a></div><div class="camera-who"><h1>${esc(student.name)}</h1><span class="number">${esc(student.studentNo || index+1)}</span></div><div class="capture-rail" aria-hidden="true">${rail}</div></header><div class="viewfinder"><video id="cameraVideo" autoplay playsinline muted></video><p class="camera-hint" id="cameraHint">正在打开后置摄像头…</p></div><footer><div class="camera-controls"><button data-action="gallery">从图库选</button><button class="shutter" data-action="shutter" aria-label="拍摄当前学生作业" disabled>拍照</button><button data-action="skip">${pageFor(student.id) ? '下一位' : '未交跳过'}</button></div><p class="camera-status">${pageFor(student.id) ? '正在替换此学生照片；保存成功后才覆盖。' : '请将整张作业放入画面，保存成功后自动进入下一位。'}</p></footer></section>`;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境无法打开摄像头，请使用 HTTPS 或从图库选择。');
      const stream = await navigator.mediaDevices.getUserMedia({ video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:2560}},audio:false });
      if (token !== state.route) { stream.getTracks().forEach(t=>t.stop()); return; }
      state.stream = stream;
      const video = document.querySelector('#cameraVideo'); video.srcObject = stream; await video.play();
      if (token !== state.route) return;
      document.querySelector('#cameraHint').hidden = true;
      state.cameraReady = true;
      document.querySelector('[data-action="shutter"]').disabled = state.busy;
    } catch (error) {
      if (token === state.route) document.querySelector('#cameraHint').textContent = `${error.name === 'NotAllowedError' ? '相机权限未开启。请在浏览器中允许相机，或从图库选择。' : error.message}`;
    }
  }
  async function navigate() {
    if (state.busy) { state.pendingRoute = location.hash; return; }
    const token = ++state.route;
    state.photoTarget = null;
    state.paper = null;
    clearTimeout(state.timer); stopCamera(); clearAnswerFiles(); message(); document.body.classList.remove('camera-mode');
    app.innerHTML = '<p class="empty">正在加载…</p>';
    const [view = 'list', examId, studentId] = route();
    try {
      if (view === 'list' || !view) return await loadList(token);
      if (view === 'new') return await newAssignment(token);
      if (!examId) { go('list'); return; }
      const detail = await api('desk-detail', undefined, {examId});
      if (token !== state.route) return;
      state.detail = detail;
      if (view === 'capture') return await renderCapture(studentId,token);
      if (view === 'review') { renderReview(); loadThumbnails(token, examId); }
      else if (view === 'student') { renderStudent(studentId); loadPaperImages(studentId, token).catch(error => message(error.message)); }
      else { renderResults(); if (activeStatus(detail.batch.status)) state.timer = setTimeout(pollResults, 6000); }
    } catch (error) { if (token === state.route) { message(error.message); app.innerHTML = `${back()}<section class="empty"><p>加载失败，已保存的作业不会丢失。</p><button data-action="refresh">重新加载</button></section>`; } }
  }
  async function loadThumbnails(token, examId) {
    const images = [...app.querySelectorAll('[data-thumb]')];
    for (const image of images) {
      if (token !== state.route) return;
      try {
        const result = await api('desk-image', undefined, {examId, studentId:image.dataset.thumb, thumbnail:'1'});
        if (token !== state.route) return;
        if (/^data:image\/(jpeg|png|webp);base64,/.test(result.image)) image.src = result.image;
      } catch { image.alt = '加载失败，请点看照片重试'; }
    }
  }
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('图片无法读取，请重新选择 JPG 或 PNG 图片。'));
      image.src = url;
    });
  }
  function clearAnswerFiles() {
    for (const item of state.answerFiles) URL.revokeObjectURL(item.url);
    state.answerFiles = [];
    state.answerStitched = '';
  }
  function renderAnswerFiles() {
    const box = document.querySelector('#answerPreview');
    if (!box) return;
    const files = state.answerFiles, picker = document.querySelector('#answerPicker');
    const two = files.length === 2;
    const title = document.querySelector('#answerTitle');
    const cameraLabel = document.querySelector('#answerCameraLabel');
    const fileLabel = document.querySelector('#answerFileLabel');
    box.hidden = !files.length;
    box.classList.toggle('is-single', files.length === 1);
    if (picker) picker.hidden = two;
    if (title) title.textContent = two ? '已添加 2 张，按上、下拼接' : files.length ? '已添加 1 张，还可添加第 2 张' : '拍下标准答案（1–2 张）';
    if (cameraLabel) cameraLabel.textContent = files.length ? '拍摄第二张' : '拍摄答案';
    if (fileLabel) fileLabel.textContent = files.length ? '从图库添加第二张' : '从图库选择';
    box.innerHTML = files.map((item, index) => `<div class="answer-shot"><div class="answer-shot-head"><b>${two ? (index ? '下' : '上') : '上'}</b><span>${two ? `第 ${index + 1} 张 · ${index ? '拼在下方' : '拼在上方'}` : '第 1 张 · 已添加'}</span></div><img src="${item.url}" alt="标准答案第 ${index + 1} 张预览"><button type="button" data-answer-action="remove" data-index="${index}">删除</button></div>`).join('') + (two ? '<div class="answer-stitch-bar"><span>按上、下顺序拼接成一张</span><button type="button" data-answer-action="swap">交换顺序</button></div>' : files.length ? '<div class="answer-stitch-bar"><span>可以只传这一张，或再添加第 2 张（下）</span></div>' : '');
  }
  async function addAnswerFiles(files) {
    const room = 2 - state.answerFiles.length;
    if (room <= 0) throw new Error('标准答案最多 2 张，请先删除一张再添加。');
    if (files.length > room) throw new Error(`最多还能添加 ${room} 张，请重新选择。`);
    const accepted = [];
    try {
      for (const file of files) {
        if (file.type && !file.type.startsWith('image/')) throw new Error('请选择图片文件。');
        if (file.size > ANSWER_MAX_SOURCE) throw new Error('单张图片超过 30MB，请选择较小的照片。');
        const url = URL.createObjectURL(file);
        try { await loadImage(url); }
        catch (error) { URL.revokeObjectURL(url); throw error; }
        accepted.push({ file, url });
      }
    } catch (error) {
      for (const item of accepted) URL.revokeObjectURL(item.url);
      throw error;
    }
    state.answerFiles.push(...accepted);
    state.answerStitched = '';
    renderAnswerFiles();
    message();
  }
  async function imageData(file) {
    if (!file || (file.type && !file.type.startsWith('image/'))) throw new Error('请选择图片文件。');
    if (file.size > ANSWER_MAX_SOURCE) throw new Error('图片超过 30MB，请选择较小的照片。');
    const url = URL.createObjectURL(file);
    try {
      const image = await loadImage(url);
      const ratio = Math.min(1,2400/Math.max(image.naturalWidth,image.naturalHeight));
      const canvas = document.createElement('canvas'); canvas.width = Math.round(image.naturalWidth*ratio); canvas.height = Math.round(image.naturalHeight*ratio);
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
      try { ctx.drawImage(image,0,0,canvas.width,canvas.height); }
      catch { throw new Error('图片无法读取，请重新选择 JPG 或 PNG 图片。'); }
      return canvas.toDataURL('image/jpeg',.9);
    } finally { URL.revokeObjectURL(url); }
  }
  function stitchCanvas(images, width) {
    const [top, bottom] = images;
    const topHeight = Math.max(1, Math.round(top.naturalHeight * width / top.naturalWidth));
    const bottomHeight = Math.max(1, Math.round(bottom.naturalHeight * width / bottom.naturalWidth));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = topHeight + bottomHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器无法处理图片，请改用系统相册裁剪后上传。');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    try {
      ctx.drawImage(top, 0, 0, width, topHeight);
      ctx.drawImage(bottom, 0, topHeight, width, bottomHeight);
    } catch {
      throw new Error('图片无法读取，请重新选择 JPG 或 PNG 图片。');
    }
    return canvas;
  }
  function canvasBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('拼接失败，请重试。')), 'image/jpeg', quality);
    });
  }
  async function stitchAnswers(files) {
    const images = [];
    for (const file of files) {
      const url = URL.createObjectURL(file);
      try { images.push(await loadImage(url)); }
      finally { URL.revokeObjectURL(url); }
    }
    const [top, bottom] = images;
    if (!top?.naturalWidth || !bottom?.naturalWidth) throw new Error('图片尺寸无效，请重新选择。');
    const aspectSum = top.naturalHeight / top.naturalWidth + bottom.naturalHeight / bottom.naturalWidth;
    const baseWidth = Math.min(STITCH_MAX_WIDTH, Math.max(top.naturalWidth, bottom.naturalWidth));
    let width = Math.min(baseWidth, Math.floor(Math.sqrt(STITCH_MAX_PIXELS / aspectSum)));
    width = Math.max(2, Math.floor(width / 2) * 2);
    if (width < STITCH_MIN_WIDTH && width < baseWidth) throw new Error('两张答案拼接后尺寸过长，请裁掉多余边距后重新选择。');
    let quality = 0.9;
    for (let attempt = 0; attempt < 8; attempt++) {
      const canvas = stitchCanvas(images, width);
      let blob;
      try { blob = await canvasBlob(canvas, quality); }
      finally { canvas.width = 1; canvas.height = 1; }
      if (blob.size <= UPLOAD_MAX_BYTES) return blob;
      if (quality > 0.85) quality = 0.85;
      else if (quality > 0.8) quality = 0.8;
      else {
        const next = Math.floor(width * 0.9 / 2) * 2;
        if (next < STITCH_MIN_WIDTH) break;
        width = next;
      }
    }
    throw new Error('两张答案拼接后仍超过上传大小，请裁掉多余边距后重新选择更清晰的图片。');
  }
  function blobDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('生成上传图片失败，请重试。'));
      reader.readAsDataURL(blob);
    });
  }
  async function answerImagePayload() {
    const files = state.answerFiles;
    if (!files.length) throw new Error('请先选择 1–2 张清晰的标准答案图片。');
    if (files.length === 1) return imageData(files[0].file);
    if (!state.answerStitched) {
      message('正在拼接两张答案…');
      const dataUrl = await blobDataUrl(await stitchAnswers(files.map(item => item.file)));
      if (dataUrl.length > UPLOAD_MAX_DATA_URL) throw new Error('两张答案拼接后仍超过上传大小，请裁掉多余边距后重新选择更清晰的图片。');
      state.answerStitched = dataUrl;
    }
    return state.answerStitched;
  }
  async function busyWork(fn) {
    if (state.busy) return;
    state.busy = true; const disabled = [...app.querySelectorAll('button,input,select')].map(el=>[el,el.disabled]); disabled.forEach(([el])=>el.disabled=true);
    try { await fn(); } catch(error) { message(error.message); }
    finally {
      state.busy=false;
      disabled.forEach(([el,value])=>{ if(el.isConnected) el.disabled=value; });
      const shutter=app.querySelector('[data-action="shutter"]');
      if(shutter) shutter.disabled=!state.cameraReady;
      if(state.pendingRoute !== null) {
        const destination=state.pendingRoute; state.pendingRoute=null;
        if(location.hash !== destination) location.hash=destination;
        else await navigate();
      }
    }
  }
  async function savePhoto(image, target = {...state.photoTarget}) {
    await api('desk-capture',{...target,image});
    const index = state.detail.students.findIndex(s=>s.id===target.studentId);
    const next = state.detail.students[index+1];
    message(`${target.name}的照片已保存。`);
    const destination = target.replacement || !next ? `#review/${target.examId}` : `#capture/${target.examId}/${next.id}`;
    if (state.pendingRoute !== null) return;
    state.busy=false;
    if (location.hash === destination) await navigate(); else location.hash=destination;
  }
  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-answer-action]');
    if (!trigger) return;
    event.preventDefault();
    if (state.busy) return;
    const action = trigger.dataset.answerAction;
    if (action === 'remove') {
      const [removed] = state.answerFiles.splice(Number(trigger.dataset.index), 1);
      if (!removed) return;
      URL.revokeObjectURL(removed.url);
    } else if (action === 'swap' && state.answerFiles.length === 2) {
      state.answerFiles.reverse();
    } else return;
    state.answerStitched = '';
    renderAnswerFiles();
  });
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]'); if (!button || state.busy) return;
    const action = button.dataset.action;
    if(action==='logout') { stopCamera(); window.AppAuth.logout(); return; }
    if(action==='refresh') return navigate();
    if(action==='capture-one') return go('capture',state.detail.exam.id,button.dataset.student);
    if(action==='paper') return setPaperMode(button.dataset.mode);
    if(action==='gallery') { state.fileTarget={...state.photoTarget, route:state.route}; fileInput.value=''; fileInput.click(); return; }
    if(action==='skip') { const i=state.detail.students.findIndex(s=>s.id===state.photoTarget.studentId); const next=state.detail.students[i+1]; go(next?'capture':'review',state.detail.exam.id,next?.id); return; }
    if(action==='delete-question') { button.closest('.question-row').remove(); markQuestionsDirty(); return; }
    if(action==='merge') {
      const rows=[...app.querySelectorAll('.question-row')].filter(row=>row.querySelector('[type=checkbox]').checked);
      if(rows.length<2) return message('请至少勾选两道题。');
      const no=rows.map(r=>r.querySelector('[name=questionNo]').value).join('+'), title=rows.map(r=>r.querySelector('[name=title]').value).filter(Boolean).join('；'), max=rows.reduce((sum,r)=>sum+Number(r.querySelector('[name=maxScore]').value),0);
      rows[0].outerHTML=questionRow({questionNo:no,title,maxScore:max}); rows.slice(1).forEach(r=>r.remove()); markQuestionsDirty(); return;
    }
    if(action==='contested') {
      state.contestedOnly=!state.contestedOnly;
      const studentId=state.paper?.studentId; if(!studentId) return;
      const list=app.querySelector('.result-list');
      if(list) list.innerHTML=resultListHtml(studentId);
      const toggle=app.querySelector('[data-action="contested"]');
      if(toggle) { toggle.classList.toggle('is-active', state.contestedOnly); toggle.setAttribute('aria-pressed', String(state.contestedOnly)); toggle.textContent=contestedLabel(studentId); }
      return;
    }
    if(action==='mode') {
      const mode=button.dataset.mode;
      if(!mode || mode===state.gradingMode) return;
      button.disabled=true;
      try { await api('desk-mode',{gradingMode:mode}); state.gradingMode=mode; clearTimeout(state.timer); await loadList(state.route); }
      catch(error) { button.disabled=false; message(error.message); }
      return;
    }
    await busyWork(async()=>{
      if(action==='shutter') {
        const video=document.querySelector('#cameraVideo'); if(!video.videoWidth) throw new Error('相机尚未就绪，请稍后重试。');
        const canvas=document.createElement('canvas'); canvas.width=video.videoWidth; canvas.height=video.videoHeight; canvas.getContext('2d').drawImage(video,0,0);
        message('正在保存，请不要切换学生…'); await savePhoto(canvas.toDataURL('image/jpeg',.9));
      }
      if(action==='photo') {
        const {image}=await api('desk-image',undefined,{examId:state.detail.exam.id,studentId:button.dataset.student});
        if(!/^data:image\/(jpeg|png|webp);base64,/.test(image)) throw new Error('照片无法显示。');
        document.querySelector('#fullPhoto').src=image; document.querySelector('#photoDialog').showModal();
      }
      if(action==='start') {
        if(document.querySelector('#questionForm')?.dataset.dirty==='true') throw new Error('请先保存题目调整，再开始批改。');
        await api('desk-confirm',{examId:state.detail.exam.id,pageIds:state.detail.pages.map(p=>p.id)});
        // 模式在开始这一刻快照进任务；未加载过设置时交给服务端用教师默认值。
        await api('desk-start',{examId:state.detail.exam.id,...(state.gradingMode?{gradingMode:state.gradingMode}:{})}); state.busy=false; go('results',state.detail.exam.id);
      }
      if(action==='retry') { await api('desk-retry',{examId:state.detail.exam.id}); state.busy=false; await navigate(); }
    });
  });
  fileInput.addEventListener('change',()=>{
    const target=state.fileTarget, file=fileInput.files[0]; state.fileTarget=null;
    if(!file) return;
    if(!target || target.route !== state.route || target.studentId !== state.photoTarget?.studentId) return message('拍照位置已切换，请为当前学生重新选择照片。');
    busyWork(async()=>{ message('正在保存照片…'); const image=await imageData(file); await savePhoto(image,target); });
  });
  document.addEventListener('change',event=>{
    if(!['answerFile','answerCamera'].includes(event.target.id)) return;
    const input=event.target, files=[...input.files];
    if(!files.length || state.busy) { input.value=''; return; }
    busyWork(async()=>{ message('正在读取图片…'); try { await addAnswerFiles(files); } finally { input.value=''; } });
  });
  function markQuestionsDirty() {
    const form=app.querySelector('#questionForm');
    if(!form) return;
    form.dataset.dirty='true';
    state.questionDrafts.set(state.detail.exam.id,[...form.querySelectorAll('.question-row')].map(row=>({questionNo:row.querySelector('[name=questionNo]').value,title:row.querySelector('[name=title]').value,maxScore:row.querySelector('[name=maxScore]').value})));
  }
  app.addEventListener('input',event=>{ if(event.target.closest('#questionForm') && event.target.name) markQuestionsDirty(); });
  app.addEventListener('submit',event=>{
    event.preventDefault(); const form=event.target;
    const fields=new FormData(form);
    busyWork(async()=>{
      if(form.classList.contains('review-form')) {
        const studentId = state.paper?.studentId;
        if(!studentId) throw new Error('请返回重新打开学生详情。');
        const questionNo = form.dataset.question, score = Number(form.querySelector('[name=score]').value), comment = form.querySelector('[name=comment]').value.trim();
        if(!Number.isFinite(score)) throw new Error('请输入有效的得分。');
        await api('desk-result',{examId:state.detail.exam.id,studentId,questionNo,score,comment});
        const result = resultsFor(studentId).find(r=>r.questionNo===questionNo);
        if(result) { result.score=score; result.needsReview=false; result.reviewed=true; result.teacherComment=comment; }
        form.closest('.result-question')?.classList.remove('is-open');
        renderStudentResults(studentId);
        message(`第 ${questionNo} 题已保存复核结果。`);
        return;
      }
      if(form.id==='createForm') {
        const answerImage=await answerImagePayload();
        message();
        startBusy();
        try {
          const created=await api('desk-create',{classId:fields.get('classId'),name:fields.get('name'),examDate:fields.get('examDate'),answerImage});
          await finishBusy();
          stopBusy();
          state.busy=false; go('capture',created.examId);
        } catch (error) { stopBusy(); throw error; }
      }
      if(form.id==='questionForm') {
        const questions=[...form.querySelectorAll('.question-row')].map(row=>({questionNo:row.querySelector('[name=questionNo]').value.trim(),title:row.querySelector('[name=title]').value.trim(),maxScore:Number(row.querySelector('[name=maxScore]').value)}));
        if(!questions.length) throw new Error('至少保留一道题。');
        await api('desk-questions',{examId:state.detail.exam.id,questions}); state.questionDrafts.delete(state.detail.exam.id); state.busy=false; await navigate(); message('题目调整已保存，请重新核对后开始批改。');
      }
    });
  });
  app.addEventListener('click', event => {
    const card = event.target.closest('.result-question');
    if (!card || event.target.closest('form, button, input, label, a')) return;
    card.classList.toggle('is-open');
  });
  document.querySelector('#closePhoto').onclick=()=>document.querySelector('#photoDialog').close();
  let holdTimer;
  app.addEventListener('pointerdown', event => {
    const image = event.target.closest('[data-thumb]');
    if (!image || state.busy || !editable()) return;
    holdTimer = setTimeout(() => go('capture', state.detail.exam.id, image.dataset.thumb), 650);
  });
  ['pointerup','pointercancel','pointermove'].forEach(type => app.addEventListener(type, () => clearTimeout(holdTimer)));
  document.addEventListener('click', event => {
    if (state.busy && event.target.closest('a')) { event.preventDefault(); message('正在保存，请稍候再切换页面。'); }
  }, true);
  window.addEventListener('hashchange',navigate);
  window.addEventListener('pagehide',stopCamera);
  window.addEventListener('beforeunload',event=>{if(state.busy || state.questionDrafts.size){event.preventDefault();event.returnValue='';}});
  navigate();
})();
