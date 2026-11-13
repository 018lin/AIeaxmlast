(() => {
  const app = document.querySelector('#app');
  const notice = document.querySelector('#notice');
  const fileInput = document.querySelector('#photoFile');
  const session = window.AppAuth.getSession();
  if (!session) return;
  document.querySelector('#teacherName').textContent = `${session.name || session.account} · 菜单`;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state = { detail: null, stream: null, cameraReady: false, busy: false, route: 0, timer: null, photoTarget: null, fileTarget: null, pendingRoute: null, questionDrafts: new Map(), answer: '', paper: null, region: null, flash: '' };
  const statusText = { draft: '待拍照', ready: '待批改', queued: '排队中', pending: '排队中', grading: '批改中', running: '批改中', done: '已完成', failed: '批改失败', needs_review: '需查看' };
  const activeStatus = (status) => ['grading', 'queued', 'pending', 'running'].includes(status);
  const statusTone = (status) => status === 'done' ? ' good' : ['failed', 'needs_review'].includes(status) ? ' warning' : activeStatus(status) ? ' active' : '';
  function captureTicks(captured, total) {
    if (!total) return '';
    const size = Math.min(total, 80);
    const filled = total > 80 ? Math.round(captured / total * size) : captured;
    return `<div class="assignment-rail" aria-hidden="true">${Array.from({ length: size }, (_, i) => `<span class="${i < filled ? 'on' : ''}"></span>`).join('')}</div>`;
  }
  const go = (view, examId = '', studentId = '', pageNo = '') => { if (state.pendingRoute === null) location.hash = [view, examId, studentId, pageNo].filter(Boolean).join('/'); };
  const route = () => location.hash.slice(1).split('/');
  const editable = () => ['draft', 'ready', 'capturing', 'confirmed'].includes(state.detail?.batch.status);
  function message(text = '') { notice.textContent = text; notice.hidden = !text; }
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
  function holdBusyLabel(text) {
    clearInterval(busyTimer);
    busyPercent.textContent = '92%';
    busyRing.style.strokeDashoffset = String(RING_LENGTH * 0.08);
    busyLabel.textContent = text;
  }
  function stopBusy() {
    clearInterval(busyTimer);
    busyOverlay.hidden = true;
    document.body.classList.remove('is-busy');
  }
  function httpMessage(status) {
    if (status === 413) return '上传的图片超过服务器大小限制，请换一张更小的照片。';
    if (status === 504 || status === 502) return '服务器处理超时，请重试；若多次失败请换一张更小的照片。';
    return `服务暂时不可用（HTTP ${status}），请稍后重试。`;
  }
  async function api(action, payload, query = {}) {
    const params = new URLSearchParams({ action, ...query });
    const response = await window.AppAuth.request(`/api/mvp?${params}`, payload === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
    if (!response.ok) throw new Error(data?.message || httpMessage(response.status));
    if (!data) throw new Error('服务器返回了无法识别的响应，请稍后重试。');
    return data;
  }
  function stopCamera() { state.stream?.getTracks().forEach(track => track.stop()); state.stream = null; state.cameraReady = false; }
  function back(label = '返回作业列表', target = '#list') { return `<a class="back" href="${target}">${label}</a>`; }
  function pagesFor(studentId) { return state.detail.pages.filter(page => page.studentId === studentId).sort((a, b) => a.pageNo - b.pageNo); }
  function pageFor(studentId, pageNo = 1) { return pagesFor(studentId).find(page => page.pageNo === pageNo); }
  function pagesPerStudent() { return Math.max(1, Number(state.detail?.batch?.pagesPerStudent) || 1); }
  function studentComplete(studentId) { return pagesFor(studentId).length >= pagesPerStudent(); }
  function nextCapture(fromOrder = 0) {
    const d = state.detail, per = pagesPerStudent();
    for (let order = Math.max(0, fromOrder); order < d.students.length * per; order += 1) {
      const student = d.students[Math.floor(order / per)], pageNo = order % per + 1;
      if (!pageFor(student.id, pageNo)) return { student, captureOrder: order, pageNo };
    }
    return null;
  }
  function firstMissingPage(studentId) {
    for (let pageNo = 1; pageNo <= pagesPerStudent(); pageNo += 1) if (!pageFor(studentId, pageNo)) return pageNo;
    return null;
  }
  function resultsFor(studentId) { return state.detail.results.filter(result => result.studentId === studentId); }
  function isDone(studentId) { const pages = pagesFor(studentId); return pages.length > 0 && pages.every(page => page.status === 'done') || (resultsFor(studentId).length >= state.detail.questions.length && state.detail.questions.length > 0); }
  async function loadList(token) {
    const data = await api('desk-list');
    if (token !== state.route) return;
    const active = data.assignments.filter(item => activeStatus(item.status)).length;
    const review = data.assignments.reduce((sum, item) => sum + Number(item.reviewCount || 0), 0);
    const summary = data.assignments.length ? `<div class="summary-strip"><span><b>${data.assignments.length}</b> 份作业</span>${active ? `<span><b>${active}</b> 份进行中</span>` : ''}${review ? `<span class="review"><b>${review}</b> 题待复核</span>` : ''}</div>` : '';
    app.innerHTML = `<div class="heading"><div><h1>作业</h1><p>按名单顺序拍照，拍完统一批改。</p></div><a class="button primary" href="#new">新建作业</a></div>${summary}<div class="assignment-list">${data.assignments.map(item => { const per = Math.max(1, Number(item.pagesPerStudent) || 1), captured = Number(item.capturedCount), students = Number(item.studentCount), total = students * per; return `<a class="assignment" href="#results/${esc(item.id)}"><header><h2>${esc(item.name)}</h2><span class="badge${statusTone(item.status)}">${esc(statusText[item.status] || item.status)}</span></header><p>${esc(item.className)} · ${esc(String(item.examDate || '').slice(0,10).replace(/-/g,'.'))}</p>${captureTicks(captured, total)}<footer><span>已拍 <b>${captured}</b> / ${per > 1 ? `${total} 页` : students}</span><span>完成 <b>${Number(item.doneCount)}</b> 人</span>${item.reviewCount ? `<span class="review">待复核 <b>${Number(item.reviewCount)}</b> 题</span>` : ''}${item.averageScore != null ? `<span>平均 <b>${Number(item.averageScore).toFixed(1)}</b> 分</span>` : ''}</footer>${activeStatus(item.status) ? `<progress max="${captured || 1}" value="${Number(item.doneCount)}" aria-label="批改进度"></progress>` : ''}</a>`}).join('') || '<section class="empty"><h2>还没有作业</h2><p>选一个班级，拍下标准答案，就可以开始。</p><a class="button primary" href="#new">创建第一份作业</a></section>'}</div>`;
    if (data.assignments.some(item => activeStatus(item.status))) state.timer = setTimeout(() => loadList(token).catch(error => message(error.message)), 6000);
  }
  async function newAssignment(token) {
    const { classes } = await api('bootstrap');
    if (token !== state.route) return;
    state.answer = '';
    app.innerHTML = `${back()}<div class="heading"><div><h1>新建作业</h1><p>一张标准答案，定下这份作业的题目。</p></div></div>${classes.length ? `<form class="form" id="createForm"><label class="field"><span class="field-label">班级</span><select name="classId" required>${classes.map(item => `<option value="${esc(item.id)}" ${item.id === window.AppAuth.getDefaultClassId() ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label><label class="field"><span class="field-label">作业名称</span><input name="name" required maxlength="120" placeholder="例如：第三单元课后练习"></label><div class="field-pair"><label class="field"><span class="field-label">日期</span><input name="examDate" type="date" required value="${new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10)}"></label><label class="field"><span class="field-label">每人页数</span><select name="pagesPerStudent"><option value="1">1 页</option><option value="2">2 页</option><option value="3">3 页</option><option value="4">4 页</option></select></label></div><div class="field"><span class="field-label">标准答案<em>必填</em></span><div class="upload"><p class="upload-title">拍下标准答案（也可上传教师手写答案）</p><p class="upload-note">识别后按大题和小题拆分答案，创建后可在核对页删题、合并、调整满分与小题分值。</p><div class="upload-actions"><label class="button primary">拍摄答案<input id="answerCamera" type="file" accept="image/*" capture="environment" aria-label="拍摄标准答案"></label><label class="button">从图库选择<input id="answerFile" type="file" accept="image/*" aria-label="从图库选择标准答案"></label></div><img id="answerPreview" class="answer-preview" hidden alt="标准答案预览"></div></div><button class="primary" type="submit">识别答案并创建</button><p class="muted form-note" id="createHint">创建时按学号冻结名单；每人页数决定拍摄顺序，后续名单变动不会打乱。</p></form>` : '<section class="empty"><h2>先准备一份班级名单</h2><p>拍照时会按学号依次对应学生。</p><a class="button primary" href="./class-setup.html">管理班级</a></section>'}`;
  }
  function studentRow(student, review = false) {
    const pages = pagesFor(student.id), first = pages[0], results = resultsFor(student.id), done = isDone(student.id);
    const score = results.reduce((sum, item) => sum + Number(item.score || 0), 0);
    const needsReview = results.filter(item => item.needsReview).length;
    const waiting = pages.some(page => !page.error && activeStatus(page.status)) && !done;
    const invalid = pages.filter(page => page.regionStatus === 'invalid');
    const check = pages.filter(page => page.regionStatus === 'check');
    const missingPage = Array.from({ length: pagesPerStudent() }, (_, i) => i + 1).find(no => !pageFor(student.id, no));
    const progressKey = `${state.detail.exam.id}:${student.id}`;
    if (!waiting) gradeProgress.delete(progressKey);
    const percent = waiting ? progressValue(progressKey) : 0;
    const status = !pages.length ? '未拍'
      : invalid.length ? `第 ${invalid.map(page => page.pageNo).join('、')} 页定位异常`
      : first.error ? first.error
      : missingPage ? `已拍 ${pages.length} / ${pagesPerStudent()} 页`
      : done ? (needsReview ? `${needsReview} 题待复核` : '已完成')
      : review ? (check.length ? '对齐置信度偏低' : '已拍 · 请核对')
      : (statusText[first.status] || '已拍');
    const thumb = review ? (first ? `<img class="thumb" data-thumb="${esc(student.id)}" data-thumb-page="${first.pageNo}" alt="${esc(student.name)}的作业照片">` : '<span class="thumb thumb-empty" aria-hidden="true">未拍</span>') : '';
    return `<div class="student${pages.length ? '' : ' is-missing'}${waiting ? ' is-grading' : ''}${invalid.length ? ' is-invalid' : ''}"><span class="student-no">${esc(student.studentNo || '—')}</span>${thumb}<div class="identity"><strong>${esc(student.name)}</strong>${waiting ? '' : `<small${first?.error ? ` title="${esc(first.error)}"` : ''}${(done && needsReview) || invalid.length ? ' class="needs-review"' : ''}>${esc(status)}</small>`}</div>${done && !review ? `<span class="score">${score}<small>分</small></span>` : ''}<div class="actions">${first ? `<button data-action="photo" data-student="${esc(student.id)}" data-page="${first.pageNo}">看照片</button>` : ''}${review && editable() ? `<button data-action="capture-one" data-student="${esc(student.id)}" data-page="${missingPage || 1}">${pages.length ? '替换' : '补拍'}</button>` : ''}${review && editable() && pages.length ? `<button data-action="regions" data-student="${esc(student.id)}" data-page="${(invalid[0] || check[0] || first).pageNo}">${invalid.length ? '校正' : '框位'}</button>` : done ? `<a class="button" href="#student/${esc(state.detail.exam.id)}/${esc(student.id)}">详情</a>` : ''}</div>${waiting ? `<span class="student-progress" data-progress="${esc(progressKey)}" role="progressbar" aria-label="批改进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}"><i style="width:${percent.toFixed(1)}%"></i></span>` : ''}</div>`;
  }
  function renderReview() {
    const d = state.detail, count = d.pages.length, total = d.students.length * pagesPerStudent();
    const draft = state.questionDrafts.get(d.exam.id), questions = draft || d.questions;
    const invalid = d.pages.filter(page => page.regionStatus === 'invalid').length;
    const check = d.pages.filter(page => page.regionStatus === 'check').length;
    const preflight = invalid ? `<p class="roster-note warning">有 ${invalid} 页自动定位异常，点学生行的“校正”拖动题框后再开始批改。</p>` : check ? `<p class="roster-note">有 ${check} 页对齐置信度偏低，可直接批改，也可点“框位”微调。</p>` : '';
    app.innerHTML = `${back()}<div class="heading"><div><h1>核对照片</h1><p>${esc(d.exam.name)} · 已拍 ${count} / ${total} 页 · 每人 ${pagesPerStudent()} 页</p></div></div><p class="muted roster-note">逐人核对姓名与照片；缺交的学生保留未拍，不会把后面的照片前移。多页学生按页号顺序登记。</p>${preflight}<div class="roster review"><div class="roster-head"><span>学号</span><span>照片</span><span>姓名</span><span class="end">核对</span></div>${d.students.map(student => studentRow(student, true)).join('')}</div>${editable() ? `<details class="question-editor"><summary>核对题目 · ${questions.length} 题 · 满分 ${questions.reduce((sum,q)=>sum+Number(q.maxScore),0)} 分</summary><p>勾选多题后可合并；有小题的题可调整小题数与分值，保存后按小题批改。</p><form id="questionForm" data-dirty="${Boolean(draft)}"><div id="questionRows">${questions.map(q => questionRow(q)).join('')}</div><div class="actions"><button type="button" data-action="merge">合并所选题</button><button type="submit">保存题目调整</button></div></form></details><div class="sticky-actions"><a class="button" href="#capture/${esc(d.exam.id)}">继续拍照</a><button class="primary" data-action="start" ${!count ? 'disabled' : ''}>检查对齐并批改 ${count} 页</button></div>` : `<div class="sticky-actions"><a class="button primary" href="#results/${esc(d.exam.id)}">查看批改进度</a></div>`}`;
    trackProgress();
  }
  function equalSubScores(maxScore, count) {
    const base = Math.round(maxScore / count * 100) / 100;
    return Array.from({ length: count }, (_, i) => i === count - 1 ? Math.round((maxScore - base * (count - 1)) * 100) / 100 : base);
  }
  function readQuestionRow(row, strict = false) {
    const questionNo = row.querySelector('[name=questionNo]').value;
    const title = row.querySelector('[name=title]').value;
    const maxScore = Number(row.querySelector('[name=maxScore]').value) || 0;
    const count = Math.max(1, Math.min(20, Math.round(Number(row.querySelector('[name=subCount]').value) || 1)));
    const labels = JSON.parse(row.dataset.subLabels || '[]');
    const text = row.querySelector('[name=subScores]').value.trim();
    const raw = text ? text.split(/[,，\s]+/).filter(Boolean).map(Number) : [];
    const valid = raw.length === count && raw.every(n => Number.isFinite(n) && n > 0) &&
      Math.abs(raw.reduce((sum, n) => sum + n, 0) - maxScore) <= 0.01;
    if (strict && raw.length && !valid) {
      throw new Error(`第 ${questionNo.trim() || '?'} 题需填 ${count} 个小题分值，且合计等于 ${maxScore} 分。`);
    }
    const scores = valid ? raw : equalSubScores(maxScore, count);
    const subs = Array.from({ length: count }, (_, index) => ({
      label: count === 1 ? '' : (labels.length === count && labels[index] ? labels[index] : `(${index + 1})`),
      maxScore: scores[index],
    }));
    return { questionNo, title, maxScore, subs };
  }
  function questionRow(q) {
    const subs = q.subQuestions || q.subs || [];
    const count = Math.max(1, subs.length || Number(q.subCount) || 1);
    const scores = subs.length ? subs.map(sub => Number(sub.maxScore)) : equalSubScores(Number(q.maxScore) || 0, count);
    const labels = subs.map(sub => sub.label || '');
    return `<div class="question-row" data-sub-labels="${esc(JSON.stringify(labels))}"><input type="checkbox" aria-label="选择合并题目"><input name="questionNo" aria-label="题号" required value="${esc(q.questionNo)}"><input name="title" aria-label="题目说明" value="${esc(q.title)}"><input name="maxScore" aria-label="满分" type="number" min="0.5" max="1000" step="0.5" required value="${Number(q.maxScore)}"><button type="button" data-action="delete-question">删除</button><div class="sub-edit"><label>小题 <input name="subCount" type="number" min="1" max="20" inputmode="numeric" value="${count}" aria-label="小题数"></label><input name="subScores" aria-label="各小题分值" value="${scores.join(',')}" placeholder="小题分值，如 2,2,1"></div></div>`;
  }
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
  function scoreTone(score, max) {
    if (score === null || score === undefined) return 'bad';
    return Number(score) >= Number(max) - 0.001 ? 'good' : Number(score) <= 0.001 ? 'bad' : 'part';
  }
  function boxMarkup(bbox, label, score, max, title) {
    if (!Array.isArray(bbox) || bbox.length !== 4) return '';
    const [x, y, width, height] = bbox.map(Number);
    const value = score === null || score === undefined ? '—' : Number(score);
    return `<span class="paper-box ${scoreTone(score, max)}" style="left:${(x*100).toFixed(2)}%;top:${(y*100).toFixed(2)}%;width:${(width*100).toFixed(2)}%;height:${(height*100).toFixed(2)}%" title="${esc(title || '')}"><span class="paper-box-label"><b>${esc(label)}</b><em>${value}/${Number(max)}</em></span></span>`;
  }
  function paperBoxes(studentId) {
    const regions = state.paper?.regions, results = resultsFor(studentId);
    if (Array.isArray(regions) && regions.length) {
      const marks = [];
      for (const region of regions) {
        const result = results.find(r => r.questionNo === region.questionNo);
        if (Array.isArray(region.subs) && region.subs.length) {
          for (const sub of region.subs) {
            if (!sub.bbox) continue;
            const subResult = result?.subs?.find(item => (sub.subId && item.subQuestionId === sub.subId) || (sub.label && item.label === sub.label));
            marks.push(boxMarkup(sub.bbox, `${region.questionNo}${sub.label || ''}`,
              subResult?.score === undefined ? null : subResult?.score, subResult?.maxScore ?? result?.maxScore, subResult?.analysis || result?.analysis));
          }
        } else {
          marks.push(boxMarkup(region.bbox, region.questionNo, result?.score, result?.maxScore, result?.analysis));
        }
      }
      return marks.join('');
    }
    return results.map(r => boxMarkup(r.bbox, r.questionNo, r.score, r.maxScore, r.analysis)).join('');
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
        : !pageFor(paper.studentId, paper.pageNo)
          ? '该学生尚未拍摄这一页。'
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
    const boxes = paperBoxes(paper.studentId);
    stage.innerHTML = `<div class="paper-frame"><img class="paper-image" src="${source}" alt="${esc(student?.name || '')}的答卷">${boxes}</div>`;
    if (hint) hint.textContent = boxes
      ? '每个小题一个框：绿色正确、橙色部分正确、红色错误。'
      : resultsFor(paper.studentId).length ? '本次批改未记录题目位置，暂无法在图上框题。' : '';
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
  function setPaperPage(pageNo) {
    if (!state.paper) return;
    state.paper.pageNo = pageNo;
    state.paper.loading = true;
    app.querySelectorAll('[data-action="paper-page"]').forEach(button => {
      button.classList.toggle('is-active', Number(button.dataset.page) === pageNo);
    });
    renderPaperStage();
    loadPaperImages(state.paper.studentId, state.route, pageNo).catch(error => message(error.message));
  }
  async function loadPaperImages(studentId, token, pageNo = 1) {
    const paper = state.paper;
    if (!paper || paper.studentId !== studentId) return;
    const examId = state.detail.exam.id;
    const [studentResult, answerResult] = await Promise.allSettled([
      pageFor(studentId, pageNo) ? api('desk-image', undefined, {examId, studentId, pageNo:String(pageNo), preview:'1', boxes:'1'}) : Promise.resolve({image:''}),
      api('desk-answer-image', undefined, {examId}),
    ]);
    if (token !== state.route || state.paper !== paper) return;
    paper.student = studentResult.status === 'fulfilled' ? String(studentResult.value.image || '') : '';
    paper.boxes = studentResult.status === 'fulfilled' ? studentResult.value.boxes : null;
    paper.regions = studentResult.status === 'fulfilled' ? studentResult.value.regions : null;
    paper.answer = answerResult.status === 'fulfilled' ? String(answerResult.value.answer ?? answerResult.value.image ?? '') : '';
    paper.loading = false;
    renderPaperStage();
  }
  function subRows(result) {
    const subs = result.subs || [];
    if (!subs.length) return '';
    return `<div class="sub-list">${subs.map(sub => `<div class="sub-row${sub.needsReview ? ' is-review' : ''}"><span class="sub-label">${esc(sub.label || '整题')}</span><span class="sub-score">${sub.score === null ? '—' : Number(sub.score)} / ${Number(sub.maxScore)}</span><span class="sub-answer" title="${esc(sub.studentAnswer || '')}">${esc(sub.studentAnswer || sub.analysis || '')}</span><form class="sub-score-form" data-action="sub-score" data-sub="${esc(sub.id)}" data-student="${esc(result.studentId)}"><input type="number" name="score" min="0" max="${Number(sub.maxScore)}" step="0.5" value="${sub.score === null ? '' : Number(sub.score)}" aria-label="第${esc(result.questionNo)}题${esc(sub.label || '')}得分"><button type="submit">改分</button></form>${sub.needsReview ? '<span class="badge warning">待复核</span>' : ''}</div>`).join('')}</div>`;
  }
  function resultCard(result) {
    return `<section class="result-question" data-question="${esc(result.questionId)}"><header><h2>第 ${esc(result.questionNo)} 题</h2><span>${Number(result.score)} / ${Number(result.maxScore)} 分 ${result.needsReview ? '<span class="badge warning">待复核</span>' : ''}</span></header>${subRows(result)}<p>${esc(result.analysis || '暂无评语')}</p>${(result.suggestions || []).map(s=>`<p class="muted">${esc(s)}</p>`).join('')}<small>${Number(result.score)<Number(result.maxScore) ? '需巩固：' : '知识点：'}${esc((result.knowledgePoints || []).join('、') || '未标注')}</small><div class="actions result-question-actions"><button data-action="regrade" data-student="${esc(result.studentId)}" data-question="${esc(result.questionId)}">重批本题</button></div></section>`;
  }
  function renderStudent(id, requestedPage) {
    const d = state.detail, student = d.students.find(s=>s.id===id);
    if (!student) throw new Error('名单快照中没有该学生。');
    const results = resultsFor(id), total = results.reduce((sum,r)=>sum+Number(r.score),0), max = results.reduce((sum,r)=>sum+Number(r.maxScore),0);
    const pages = pagesFor(id);
    const pageNo = pages.some(page => page.pageNo === Number(requestedPage)) ? Number(requestedPage) : (pages[0]?.pageNo || 1);
    state.paper = { studentId:id, pageNo, mode:'student', student:'', answer:'', regions:null, loading:true };
    app.innerHTML = `${back('返回班级结果', `#results/${esc(d.exam.id)}`)}<div class="heading"><div><h1>${esc(student.name)}</h1><p>学号 ${esc(student.studentNo)} · ${esc(d.exam.name)}</p></div><span class="score">${total}<small> / ${max}</small></span></div><section class="paper-viewer" aria-label="原卷与标注"><div class="paper-tabs" role="tablist"><button type="button" role="tab" aria-selected="true" data-action="paper" data-mode="student" class="is-active">学生答卷</button><button type="button" role="tab" aria-selected="false" data-action="paper" data-mode="answer">标准答案</button></div>${pages.length > 1 ? `<div class="paper-pages">${pages.map(page => `<button type="button" data-action="paper-page" data-page="${page.pageNo}" class="${page.pageNo === pageNo ? 'is-active' : ''}">第 ${page.pageNo} 页</button>`).join('')}</div>` : ''}<div class="paper-stage" id="paperStage"><p class="paper-note">正在加载答卷…</p></div><p class="paper-hint" id="paperHint"></p></section><div class="actions result-actions">${pages.length ? `<button data-action="photo" data-student="${esc(id)}" data-page="${pageNo}">查看作业照片</button>` : ''}</div><div class="result-list">${results.map(resultCard).join('') || '<p class="empty">还没有批改结果。</p>'}</div>`;
    return pageNo;
  }
  async function renderCapture(requestedId, token, requestedPage) {
    const d = state.detail;
    if (!editable()) { go('results',d.exam.id); return; }
    const per = pagesPerStudent();
    let target = null;
    if (requestedId) {
      const index = d.students.findIndex(s => s.id === requestedId);
      if (index < 0) { go('review',d.exam.id); return; }
      const student = d.students[index];
      const wanted = Number(requestedPage);
      const pageNo = wanted >= 1 && wanted <= per ? wanted : (firstMissingPage(student.id) || 1);
      target = { student, index, captureOrder:index * per + pageNo - 1, pageNo };
    } else {
      const next = nextCapture();
      if (!next) { go('review',d.exam.id); return; }
      target = { ...next, index:d.students.indexOf(next.student) };
    }
    const { student, index, captureOrder, pageNo } = target;
    const existing = pageFor(student.id, pageNo), hasPages = pagesFor(student.id).length > 0;
    state.photoTarget = { examId:d.exam.id, studentId:student.id, captureOrder, pageNo, name:student.name, replacement:!!existing };
    document.body.classList.add('camera-mode');
    const rail = d.students.map(item => `<span class="${item.id === student.id ? 'now' : studentComplete(item.id) ? 'taken' : pagesFor(item.id).length ? 'part' : ''}"></span>`).join('');
    const pageLabel = per > 1 ? ` · 第 <b>${pageNo}</b> / ${per} 页` : '';
    app.innerHTML = `<section class="camera"><header class="camera-head"><div class="camera-top"><span>第 <b>${index+1}</b> / ${d.students.length} 位${pageLabel}</span><a class="back" href="#review/${esc(d.exam.id)}">核对照片</a></div><div class="camera-who"><h1>${esc(student.name)}</h1><span class="number">${esc(student.studentNo || index+1)}</span></div><div class="capture-rail" aria-hidden="true">${rail}</div></header><div class="viewfinder"><video id="cameraVideo" autoplay playsinline muted></video><p class="camera-hint" id="cameraHint">正在打开后置摄像头…</p></div><footer><div class="camera-controls"><button data-action="gallery">从图库选</button><button class="shutter" data-action="shutter" aria-label="拍摄当前学生作业" disabled>拍照</button><button data-action="skip">${hasPages ? '跳过此页' : '未交跳过'}</button></div><p class="camera-status">${existing ? `正在替换此学生的第 ${pageNo} 页照片；保存成功后才覆盖。` : per > 1 ? `请将第 ${pageNo} 页作业放入画面，保存成功后自动进入下一张。` : '请将整张作业放入画面，保存成功后自动进入下一位。'}</p></footer></section>`;
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
    state.region = null;
    clearTimeout(state.timer); stopCamera(); message(); document.body.classList.remove('camera-mode');
    app.innerHTML = '<p class="empty">正在加载…</p>';
    const [view = 'list', examId, studentId, pageNo] = route();
    try {
      if (view === 'list' || !view) return await loadList(token);
      if (view === 'new') return await newAssignment(token);
      if (!examId) { go('list'); return; }
      const detail = await api('desk-detail', undefined, {examId});
      if (token !== state.route) return;
      state.detail = detail;
      if (view === 'capture') return await renderCapture(studentId, token, pageNo);
      if (view === 'review') { renderReview(); loadThumbnails(token, examId); }
      else if (view === 'student') {
        const shown = renderStudent(studentId, pageNo);
        loadPaperImages(studentId, token, shown).catch(error => message(error.message));
      }
      else { renderResults(); if (activeStatus(detail.batch.status)) state.timer = setTimeout(pollResults, 6000); }
      if (state.flash) { const text = state.flash; state.flash = ''; message(text); }
    } catch (error) { if (token === state.route) { message(error.message); app.innerHTML = `${back()}<section class="empty"><p>加载失败，已保存的作业不会丢失。</p><button data-action="refresh">重新加载</button></section>`; } }
  }
  async function loadThumbnails(token, examId) {
    const images = [...app.querySelectorAll('[data-thumb]')];
    for (const image of images) {
      if (token !== state.route) return;
      try {
        const result = await api('desk-image', undefined, {examId, studentId:image.dataset.thumb, pageNo:image.dataset.thumbPage || '1', thumbnail:'1'});
        if (token !== state.route) return;
        if (/^data:image\/(jpeg|png|webp);base64,/.test(result.image)) image.src = result.image;
      } catch { image.alt = '加载失败，请点看照片重试'; }
    }
  }
  const MAX_SIDE = 2200, JPEG_QUALITY = .86;
  function canvasJpeg(source, width = source.naturalWidth || source.videoWidth || source.width,
    height = source.naturalHeight || source.videoHeight || source.height, maxSide = MAX_SIDE, quality = JPEG_QUALITY) {
    const ratio = Math.min(1, maxSide / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(source,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/jpeg',quality);
  }
  async function imageData(file) {
    if (!file || !file.type.startsWith('image/')) throw new Error('请选择图片文件。');
    if (file.size > 30*1024*1024) throw new Error('图片超过 30MB，请选择较小的照片。');
    const url = URL.createObjectURL(file);
    try {
      const image = new Image(); image.src = url; await image.decode();
      return canvasJpeg(image);
    } finally { URL.revokeObjectURL(url); }
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
    const next = target.replacement ? null : nextCapture(target.captureOrder + 1);
    message(`${target.name}${pagesPerStudent() > 1 ? `第 ${target.pageNo} 页` : ''}照片已保存。`);
    const destination = next
      ? pagesPerStudent() > 1 ? `#capture/${target.examId}/${next.student.id}/${next.pageNo}` : `#capture/${target.examId}/${next.student.id}`
      : `#review/${target.examId}`;
    if (state.pendingRoute !== null) return;
    state.busy=false;
    if (location.hash === destination) await navigate(); else location.hash=destination;
  }
  const clamp01 = (value) => Math.min(1, Math.max(0, value));
  function splitSubBox(bbox, count, index) {
    if (!bbox) return null;
    if (count <= 1) return bbox;
    const row = bbox[3] / count;
    return [bbox[0], clamp01(bbox[1] + row * index), bbox[2], Math.max(0.01, row - 0.006)];
  }
  async function openRegionEditor(studentId, pageNo) {
    const examId = state.detail.exam.id;
    const student = state.detail.students.find(item => item.id === studentId);
    if (!student) throw new Error('名单快照中没有该学生。');
    if (!pageFor(studentId, pageNo)) throw new Error('该学生此页尚未拍摄。');
    message('正在加载答卷与题框…');
    const image = await api('desk-image', undefined, {examId, studentId, pageNo:String(pageNo), preview:'1', boxes:'1'});
    const stored = Array.isArray(image.regions) ? image.regions : [];
    const regions = state.detail.questions.map(question => {
      const saved = stored.find(region => region.questionId === question.id);
      const bbox = saved?.bbox || (image.boxes && image.boxes[question.questionNo]) || null;
      const list = question.subQuestions || [];
      const subs = list.map((sub, index) => {
        const found = saved?.subs?.find(item => (item.subId && item.subId === sub.id) || (item.label && item.label === sub.label));
        return {
          subId: sub.id, label: sub.label || (list.length > 1 ? `(${index + 1})` : ''),
          bbox: found?.bbox || splitSubBox(bbox, list.length, index),
        };
      });
      return { questionId:question.id, questionNo:question.questionNo, bbox, subs };
    });
    state.region = { examId, studentId, pageNo, studentName:student.name, image:String(image.image || ''), regions,
      selected: regions.find(region => !region.bbox)?.questionId || regions[0]?.questionId || '', drag:null };
    renderRegionEditor();
    const dialog = document.querySelector('#regionDialog');
    if (dialog && !dialog.open) dialog.showModal();
    message();
  }
  function closeRegionEditor() {
    const dialog = document.querySelector('#regionDialog');
    if (dialog?.open) dialog.close();
    state.region = null;
  }
  function selectRegion(questionId) {
    const editor = state.region;
    if (!editor) return;
    editor.selected = questionId;
    const region = editor.regions.find(item => item.questionId === questionId);
    const hint = document.querySelector('#regionHint');
    if (hint) hint.textContent = region && !region.bbox
      ? `第 ${region.questionNo} 题还没有框：请在照片上拖动画出作答区域。`
      : '拖动题号标签移动整题，拖动小题框单独微调。';
    renderRegionChips();
    renderRegionLayer();
  }
  function applyRelocatedRegions(result) {
    const editor = state.region;
    if (!editor) return;
    const incoming = Array.isArray(result.regions) ? result.regions : [];
    editor.regions = editor.regions.map(region => {
      const found = incoming.find(item => (item.questionId && item.questionId === region.questionId) || item.questionNo === region.questionNo);
      if (!found) return region;
      const bbox = Array.isArray(found.bbox) && found.bbox.length === 4 ? found.bbox : null;
      const subs = region.subs.map((sub, index) => {
        const match = (found.subs || []).find(item => (sub.subId && item.subId === sub.subId) || (sub.label && item.label === sub.label));
        return { ...sub, bbox: match?.bbox || splitSubBox(bbox, region.subs.length, index) };
      });
      return { ...region, bbox, subs };
    });
    renderRegionEditor();
  }
  function roundBox(bbox) { return bbox.map(value => Math.round(Number(value) * 10000) / 10000); }
  async function saveRegionEditor() {
    const editor = state.region;
    if (!editor) return;
    const regions = editor.regions.filter(region => Array.isArray(region.bbox) && region.bbox.length === 4).map(region => ({
      questionId: region.questionId,
      bbox: roundBox(region.bbox),
      subs: region.subs.map((sub, index) => ({
        subId: sub.subId,
        bbox: roundBox(sub.bbox || splitSubBox(region.bbox, region.subs.length, index)),
      })),
    }));
    if (!regions.length) throw new Error('至少为一题画出作答区域。');
    await api('desk-regions',{examId:editor.examId,studentId:editor.studentId,pageNo:editor.pageNo,regions});
    closeRegionEditor();
    state.busy = false;
    await navigate();
    message('框位已保存，该页会按新框位批改。');
  }
  function boxStyle(bbox) {
    const [x, y, width, height] = bbox.map(Number);
    return `left:${(x*100).toFixed(2)}%;top:${(y*100).toFixed(2)}%;width:${(width*100).toFixed(2)}%;height:${(height*100).toFixed(2)}%`;
  }
  function renderRegionChips() {
    const editor = state.region, chips = document.querySelector('#regionChips');
    if (!editor || !chips) return;
    chips.innerHTML = editor.regions.map(region => `<button type="button" role="option" aria-selected="${region.questionId === editor.selected}" class="region-chip${region.questionId === editor.selected ? ' is-active' : ''}${region.bbox ? '' : ' is-empty'}" data-action="region-select" data-region="${esc(region.questionId)}">第 ${esc(region.questionNo)} 题${region.subs.length > 1 ? ` · ${region.subs.length} 小题` : ''}${region.bbox ? '' : ' · 待画框'}</button>`).join('');
  }
  function renderRegionLayer() {
    const editor = state.region, layer = document.querySelector('#regionLayer');
    if (!editor || !layer) return;
    layer.innerHTML = editor.regions.map(region => {
      if (!region.bbox) return '';
      const active = region.questionId === editor.selected;
      const subs = region.subs.filter(sub => sub.bbox).map(sub => `<span class="region-box sub" style="${boxStyle(sub.bbox)}" data-region-sub="${esc(region.questionId)}" data-sub="${esc(sub.subId)}"><em>${esc(sub.label || '整题')}</em></span>`).join('');
      return `<span class="region-box question${active ? ' is-active' : ''}" style="${boxStyle(region.bbox)}" data-region-move="${esc(region.questionId)}"></span><span class="region-tag${active ? ' is-active' : ''}" style="${boxStyle(region.bbox)}" data-region-move="${esc(region.questionId)}">第 ${esc(region.questionNo)} 题</span>${subs}`;
    }).join('');
  }
  function renderRegionEditor() {
    const editor = state.region;
    if (!editor) return;
    const title = document.querySelector('#regionTitle');
    if (title) title.textContent = `${editor.studentName} · 第 ${editor.pageNo} 页 · 校正题框`;
    const missing = editor.regions.filter(region => !region.bbox).length;
    document.querySelector('#regionHint').textContent = missing
      ? `有 ${missing} 题还没有框：点下方题号选中，再在照片上拖动画出作答区域。`
      : '拖动题号标签移动整题，拖动小题框单独微调。';
    const image = document.querySelector('#regionImage');
    if (image && image.getAttribute('src') !== editor.image) image.src = editor.image;
    renderRegionChips();
    renderRegionLayer();
  }
  function startRegionDrag(event) {
    const editor = state.region, canvas = document.querySelector('#regionCanvas');
    if (!editor || !canvas || !event.target.closest('#regionCanvas') || event.target.closest('button')) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const point = { x:(event.clientX - rect.left) / rect.width, y:(event.clientY - rect.top) / rect.height };
    if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return;
    const subTarget = event.target.closest('[data-region-sub]');
    const moveTarget = event.target.closest('[data-region-move]');
    if (subTarget) {
      const region = editor.regions.find(item => item.questionId === subTarget.dataset.regionSub);
      const sub = region?.subs.find(item => item.subId === subTarget.dataset.sub);
      if (!region || !sub?.bbox) return;
      editor.selected = region.questionId;
      editor.drag = { mode:'sub', regionId:region.questionId, subId:sub.subId, start:point, origin:[...sub.bbox] };
    } else if (moveTarget) {
      const region = editor.regions.find(item => item.questionId === moveTarget.dataset.regionMove);
      if (!region?.bbox) return;
      editor.selected = region.questionId;
      editor.drag = { mode:'question', regionId:region.questionId, start:point, origin:[...region.bbox],
        subs:region.subs.filter(sub => sub.bbox).map(sub => ({ subId:sub.subId, origin:[...sub.bbox] })) };
    } else {
      const region = editor.regions.find(item => item.questionId === editor.selected);
      if (!region || region.bbox) return;
      editor.drag = { mode:'draw', regionId:region.questionId, start:point };
      region.bbox = [point.x, point.y, 0, 0];
      region.subs = region.subs.map(sub => ({ ...sub, bbox:null }));
    }
    renderRegionChips();
    renderRegionLayer();
    canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }
  function moveRegionDrag(event) {
    const editor = state.region, canvas = document.querySelector('#regionCanvas');
    if (!editor?.drag || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const point = { x:(event.clientX - rect.left) / rect.width, y:(event.clientY - rect.top) / rect.height };
    const drag = editor.drag;
    if (drag.mode === 'draw') {
      const region = editor.regions.find(item => item.questionId === drag.regionId);
      if (!region) return;
      const x = clamp01(Math.min(drag.start.x, point.x)), y = clamp01(Math.min(drag.start.y, point.y));
      region.bbox = [x, y,
        Math.max(0, Math.min(Math.abs(point.x - drag.start.x), 1 - x)),
        Math.max(0, Math.min(Math.abs(point.y - drag.start.y), 1 - y))];
    } else if (drag.mode === 'question') {
      const region = editor.regions.find(item => item.questionId === drag.regionId);
      if (!region) return;
      const [x, y, width, height] = drag.origin;
      const dx = Math.min(1 - x - width, Math.max(-x, point.x - drag.start.x));
      const dy = Math.min(1 - y - height, Math.max(-y, point.y - drag.start.y));
      region.bbox = [x + dx, y + dy, width, height];
      for (const entry of drag.subs) {
        const sub = region.subs.find(item => item.subId === entry.subId);
        if (!sub) continue;
        sub.bbox = [clamp01(entry.origin[0] + dx), clamp01(entry.origin[1] + dy), entry.origin[2], entry.origin[3]];
      }
    } else {
      const region = editor.regions.find(item => item.questionId === drag.regionId);
      const sub = region?.subs.find(item => item.subId === drag.subId);
      if (!sub) return;
      const [x, y, width, height] = drag.origin;
      sub.bbox = [Math.min(1 - width, Math.max(0, x + point.x - drag.start.x)), Math.min(1 - height, Math.max(0, y + point.y - drag.start.y)), width, height];
    }
    renderRegionLayer();
    event.preventDefault();
  }
  function endRegionDrag() {
    const editor = state.region;
    if (!editor?.drag) return;
    if (editor.drag.mode === 'draw') {
      const region = editor.regions.find(item => item.questionId === editor.drag.regionId);
      if (region && (!region.bbox || region.bbox[2] < 0.02 || region.bbox[3] < 0.02)) region.bbox = null;
    }
    editor.drag = null;
    renderRegionEditor();
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]'); if (!button || state.busy) return;
    const action = button.dataset.action;
    if(action==='logout') { stopCamera(); window.AppAuth.logout(); return; }
    if(action==='refresh') return navigate();
    if(action==='capture-one') return go('capture',state.detail.exam.id,button.dataset.student,pagesPerStudent() > 1 ? button.dataset.page || '' : '');
    if(action==='regions') return busyWork(() => openRegionEditor(button.dataset.student, Number(button.dataset.page) || 1));
    if(action==='paper') return setPaperMode(button.dataset.mode);
    if(action==='paper-page') return setPaperPage(Number(button.dataset.page) || 1);
    if(action==='region-close') return closeRegionEditor();
    if(action==='region-select') return selectRegion(button.dataset.region);
    if(action==='gallery') { state.fileTarget={...state.photoTarget, route:state.route}; fileInput.value=''; fileInput.click(); return; }
    if(action==='skip') {
      const target = state.photoTarget;
      if (!target) return;
      const per = pagesPerStudent();
      const from = pagesFor(target.studentId).length ? target.captureOrder + 1 : Math.floor(target.captureOrder / per) * per + per;
      const next = nextCapture(from);
      go(next ? 'capture' : 'review', state.detail.exam.id, next?.student.id, per > 1 ? next?.pageNo : '');
      return;
    }
    if(action==='delete-question') { button.closest('.question-row').remove(); markQuestionsDirty(); return; }
    if(action==='merge') {
      const rows=[...app.querySelectorAll('.question-row')].filter(row=>row.querySelector('[type=checkbox]').checked);
      if(rows.length<2) return message('请至少勾选两道题。');
      const no=rows.map(r=>r.querySelector('[name=questionNo]').value).join('+'), title=rows.map(r=>r.querySelector('[name=title]').value).filter(Boolean).join('；'), max=rows.reduce((sum,r)=>sum+Number(r.querySelector('[name=maxScore]').value),0);
      rows[0].outerHTML=questionRow({questionNo:no,title,maxScore:max}); rows.slice(1).forEach(r=>r.remove()); markQuestionsDirty(); return;
    }
    await busyWork(async()=>{
      if(action==='shutter') {
        const video=document.querySelector('#cameraVideo'); if(!video.videoWidth) throw new Error('相机尚未就绪，请稍后重试。');
        message('正在保存，请不要切换学生…'); await savePhoto(canvasJpeg(video));
      }
      if(action==='photo') {
        const {image}=await api('desk-image',undefined,{examId:state.detail.exam.id,studentId:button.dataset.student,pageNo:button.dataset.page || '1'});
        if(!/^data:image\/(jpeg|png|webp);base64,/.test(image)) throw new Error('照片无法显示。');
        document.querySelector('#fullPhoto').src=image; document.querySelector('#photoDialog').showModal();
      }
      if(action==='start') {
        if(document.querySelector('#questionForm')?.dataset.dirty==='true') throw new Error('请先保存题目调整，再开始批改。');
        const examId = state.detail.exam.id;
        message('正在对齐每页并检查作答区域…');
        await api('desk-confirm',{examId,pageIds:state.detail.pages.map(p=>p.id)});
        const pageNos=[...new Set(state.detail.pages.map(p => p.pageNo || 1))].sort((a,b)=>a-b);
        for (const pageNo of pageNos) { message(`正在定位第 ${pageNo} 页的题框…`); await api('desk-preflight',{examId,pageNo}); }
        const preflight = await api('desk-preflight',{examId});
        if (Number(preflight.invalid) > 0) {
          state.busy=false;
          await navigate();
          throw new Error(`有 ${preflight.invalid} 页自动定位异常，已在学生行标红，请点“校正”拖好题框后再开始。`);
        }
        state.flash = Number(preflight.check) > 0 ? `有 ${preflight.check} 页对齐置信度偏低，已按模板框批改，可逐人核对。` : '';
        await api('desk-start',{examId}); state.busy=false; go('results',examId);
      }
      if(action==='retry') { await api('desk-retry',{examId:state.detail.exam.id}); state.busy=false; await navigate(); }
      if(action==='regrade') {
        await api('desk-regrade',{examId:state.detail.exam.id,studentId:button.dataset.student,questionId:button.dataset.question});
        state.busy=false; state.flash='已重新提交本题批改，结果会自动刷新。'; go('results',state.detail.exam.id);
      }
      if(action==='region-relocate') {
        const editor = state.region;
        if (!editor) throw new Error('请先打开学生照片。');
        message('正在视觉重定位题框…');
        const result = await api('desk-relocate',{examId:editor.examId,studentId:editor.studentId,pageNo:editor.pageNo});
        applyRelocatedRegions(result);
        message(result.status === 'ok' ? '已重定位，请核对后保存。' : '自动重定位仍不确定，请拖动题框校正。');
      }
      if(action==='region-save') { await saveRegionEditor(); }
    });
  });
  fileInput.addEventListener('change',()=>{
    const target=state.fileTarget, file=fileInput.files[0]; state.fileTarget=null;
    if(!file) return;
    if(!target || target.route !== state.route || target.studentId !== state.photoTarget?.studentId) return message('拍照位置已切换，请为当前学生重新选择照片。');
    busyWork(async()=>{ message('正在保存照片…'); const image=await imageData(file); await savePhoto(image,target); });
  });
  document.addEventListener('change',async event=>{
    if(['answerFile','answerCamera'].includes(event.target.id)) {
      const file=event.target.files[0]; state.answer='';
      if(!file) return;
      await busyWork(async()=>{ state.answer=await imageData(file); const preview=document.querySelector('#answerPreview'); preview.src=state.answer; preview.hidden=false; message(); });
    }
  });
  function markQuestionsDirty() {
    const form=app.querySelector('#questionForm');
    if(!form) return;
    form.dataset.dirty='true';
    state.questionDrafts.set(state.detail.exam.id,[...form.querySelectorAll('.question-row')].map(row=>readQuestionRow(row)));
  }
  app.addEventListener('input',event=>{
    if(!event.target.closest('#questionForm') || !event.target.name) return;
    if(event.target.name==='subCount') {
      const row=event.target.closest('.question-row');
      const count=Math.max(1,Math.min(20,Math.round(Number(event.target.value)||1)));
      const maxScore=Number(row.querySelector('[name=maxScore]').value)||0;
      row.querySelector('[name=subScores]').value=equalSubScores(maxScore,count).join(',');
      row.dataset.subLabels=JSON.stringify(Array.from({length:count},(_,i)=>count===1?'':`(${i+1})`));
    }
    markQuestionsDirty();
  });
  app.addEventListener('submit',event=>{
    event.preventDefault(); const form=event.target;
    const fields=new FormData(form);
    busyWork(async()=>{
      if(form.dataset.action==='sub-score') {
        const score = Number(fields.get('score'));
        const result = await api('desk-sub-score',{examId:state.detail.exam.id,studentId:form.dataset.student,subResultId:form.dataset.sub,score});
        state.busy=false;
        await navigate();
        message(`已改分：该题现为 ${result.score} 分${result.needsReview ? '，仍有小题待复核' : '。'}`);
        return;
      }
      if(form.id==='createForm') {
        if(!state.answer) throw new Error('请先选择一张清晰的标准答案图片。');
        startBusy();
        try {
          const created=await api('desk-create',{classId:fields.get('classId'),name:fields.get('name'),examDate:fields.get('examDate'),pagesPerStudent:Number(fields.get('pagesPerStudent')) || 1,answerImage:state.answer});
          holdBusyLabel('正在定位答案区域…');
          try { await api('desk-answer-locate',{examId:created.examId}); }
          catch (error) { state.flash=`${error.message} 可稍后在核对页手动校正题框。`; }
          await finishBusy();
          stopBusy();
          state.busy=false; go('capture',created.examId);
        } catch (error) { stopBusy(); throw error; }
      }
      if(form.id==='questionForm') {
        const questions=[...form.querySelectorAll('.question-row')].map(row=>{
          const question=readQuestionRow(row,true);
          return { questionNo:question.questionNo.trim(), title:question.title.trim(), maxScore:question.maxScore, subs:question.subs };
        });
        if(!questions.length) throw new Error('至少保留一道题。');
        await api('desk-questions',{examId:state.detail.exam.id,questions}); state.questionDrafts.delete(state.detail.exam.id); state.busy=false; await navigate(); message('题目调整已保存，请重新核对后开始批改。');
      }
    });
  });
  document.querySelector('#closePhoto').onclick=()=>document.querySelector('#photoDialog').close();
  const regionDialog = document.querySelector('#regionDialog');
  if (regionDialog) {
    regionDialog.addEventListener('pointerdown', startRegionDrag);
    regionDialog.addEventListener('pointermove', moveRegionDrag);
    regionDialog.addEventListener('pointerup', endRegionDrag);
    regionDialog.addEventListener('pointercancel', endRegionDrag);
    regionDialog.addEventListener('close', () => { state.region = null; });
  }
  let holdTimer;
  app.addEventListener('pointerdown', event => {
    const image = event.target.closest('[data-thumb]');
    if (!image || state.busy || !editable()) return;
    holdTimer = setTimeout(() => go('capture', state.detail.exam.id, image.dataset.thumb, image.dataset.thumbPage || ''), 650);
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
