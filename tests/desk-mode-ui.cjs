// Temporary browser check for the grading-mode picker. Run: node tests/tmp-mode-check.cjs
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-check-'));
const PORT = 9224;
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${temp}/profile`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore'] });

const fixture = () => {
  localStorage.setItem('aihw.auth.session.v1', JSON.stringify({ account: 'synthetic', name: '测试教师', token: 'fixture-not-real', expiresAt: Date.now() + 3600000 }));
  const detail = {
    exam: { id: 'e1', name: '合成练习' }, batch: { id: 'b1', status: 'draft' },
    students: [{ id: 's1', studentNo: '001', name: '测试甲' }],
    pages: [{ id: 'p1', studentId: 's1', captureOrder: 0, status: 'ready', error: '' }],
    questions: [{ id: 'q1', questionNo: '1', title: '合成题 1', maxScore: 5 }],
    results: [{ id: 'r1', studentId: 's1', questionNo: '1', score: 3, maxScore: 5, analysis: '合成评语', suggestions: [], knowledgePoints: [], needsReview: false, reviewed: false, teacherComment: '', bbox: null, agreement: 'arbitrated', passes: [{ pass: 'A', score: 3, confidence: 0.9, analysis: 'A', reason: '' }, { pass: 'B', score: 4, confidence: 0.9, analysis: 'B', reason: '' }, { pass: 'arbiter', score: 3, confidence: 0.9, analysis: '', reason: '采纳第一次', resolved: true }] }],
  };
  const modes = [
    { value: 'fast', label: '高效模式', note: '每份作业评判一次，速度快。' },
    { value: 'fine', label: '精批模式', note: '同一份作业独立评判两次，不一致的题目再由第三次复核，耗时约两倍。' },
  ];
  const f = window.__fixture = { gradingMode: 'fast', log: [] };
  window.fetch = async (url, opt = {}) => {
    const u = new URL(url, location.href);
    const action = u.searchParams.get('action');
    const body = opt.body ? JSON.parse(opt.body) : null;
    f.log.push({ action, body });
    let result = {};
    if (action === 'desk-list') result = { gradingMode: f.gradingMode, modes, assignments: [{ id: 'e1', name: '合成练习', className: '测试班', examDate: '2026-11-14', status: 'draft', capturedCount: 1, studentCount: 1, doneCount: 0 }] };
    else if (action === 'desk-mode') { f.gradingMode = body.gradingMode; result = { gradingMode: body.gradingMode, modes }; }
    else if (action === 'desk-detail') result = detail;
    else if (action === 'desk-confirm') result = {};
    else if (action === 'desk-start') result = { gradingMode: f.gradingMode };
    else if (action === 'desk-answer-image' || action === 'desk-image') result = { image: '' };
    else throw new Error('Unhandled fixture action ' + action);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
};

(async () => {
  let ws, seq = 0; const pending = new Map(); const errors = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await delay(50); }
    throw new Error('Timed out: ' + expression);
  };
  const ok = (name, condition = true) => { assert.ok(condition, name); console.log('PASS', name); };
  const shots = [];
  const shot = async (name, width = 1440, height = 900) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await delay(120);
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = path.join(__dirname, '..', `.workbuddy/shot-${name}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    shots.push(file);
  };

  let endpoint = null;
  for (let i = 0; i < 60 && !endpoint; i++) {
    try { endpoint = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await delay(200); }
  }
  if (!endpoint) throw new Error('Chrome did not expose a debugging endpoint');
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(JSON.stringify(m.params.args));
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${fixture.toString()})()` });
  await send('Page.navigate', { url: 'http://localhost:8081/desk.html#list' });
  await wait(`!!document.querySelector('.mode-picker')`);

  ok('mode picker renders two options', await evaluate(`[...document.querySelectorAll('.mode-tabs button')].map(b=>b.textContent).join('|')==='高效模式|精批模式'`));
  ok('default mode is the saved one', await evaluate(`document.querySelector('.mode-tabs button.is-active').textContent==='高效模式'`));
  ok('note explains the tradeoff', await evaluate(`document.querySelector('.mode-note').textContent.includes('速度快')`));

  await evaluate(`document.querySelector('[data-mode=fine]').click()`);
  await wait(`__fixture.gradingMode==='fine' && !!__fixture.log.find(x=>x.action==='desk-mode')`);
  ok('switching writes the teacher setting', await evaluate(`JSON.stringify(__fixture.log.find(x=>x.action==='desk-mode').body)==='{"gradingMode":"fine"}'`));
  await wait(`document.querySelector('.mode-tabs button.is-active').textContent==='精批模式'`);
  ok('active tab follows the saved value', await evaluate(`document.querySelector('.mode-note').textContent.includes('耗时约两倍')`));
  await shot('mode-list');

  await evaluate(`location.hash='#review/e1'`);
  await wait(`!!document.querySelector('.sticky-actions')`);
  ok('review page states the mode before grading starts', await evaluate(`document.querySelector('.mode-hint')?.textContent.includes('精批模式')`));

  await evaluate(`document.querySelector('[data-action=start]').click()`);
  await wait(`!!__fixture.log.find(x=>x.action==='desk-start')`);
  ok('start snapshots the chosen mode', await evaluate(`JSON.stringify(__fixture.log.find(x=>x.action==='desk-start').body)==='{"examId":"e1","gradingMode":"fine"}'`));

  await evaluate(`location.hash='#student/e1/s1'`);
  await wait(`!!document.querySelector('.result-question')`);
  ok('arbitrated question shows its own badge', await evaluate(`document.querySelector('.result-question .badge')?.textContent==='已仲裁'`));
  ok('pass detail exposes all three opinions', await evaluate(`document.querySelectorAll('.passes li').length===3 && document.querySelector('.passes li:nth-child(3) em').textContent==='采纳第一次'`));
  ok('contested filter is offered', await evaluate(`!!document.querySelector('[data-action=contested]')`));
  await evaluate(`document.querySelector('[data-action=contested]').click()`);
  await wait(`document.querySelector('[data-action=contested]').getAttribute('aria-pressed')==='true'`);
  ok('filter keeps disputed questions visible', await evaluate(`document.querySelectorAll('.result-question').length===1`));
  await evaluate(`document.querySelector('.passes').open=true`);
  await delay(120);
  await shot('mode-detail');

  ok('no console errors', errors.length === 0 || (console.log(JSON.stringify(errors)), false));
  console.log('ALL CHECKS PASSED');
})().catch((error) => { console.error('FAILED', error.message); process.exitCode = 1; })
  .finally(() => { try { ws?.close(); } catch {} chrome.kill(); setTimeout(() => process.exit(), 200); });
