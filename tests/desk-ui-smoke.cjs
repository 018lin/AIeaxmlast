// Dependency-free synthetic UI test. Run: node tests/desk-ui-smoke.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-ui-smoke-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${temp}/profile`,'about:blank'], {stdio:['ignore','ignore','pipe']});
const delay = ms => new Promise(r=>setTimeout(r,ms));
let ws, seq=0; const pending=new Map(), events=[], checks=[], shots=[];
function send(method,params={}) {return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression) {const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function wait(expression) {for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(50);}throw Error('Timed out: '+expression);}
async function click(selector) {await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);}
async function route(hash) {await evaluate(`location.hash=${JSON.stringify(hash)}`);await delay(80);await wait(`!document.querySelector('#app').textContent.includes('正在加载')`);}
function ok(name,condition=true) {assert.ok(condition,name);checks.push(name);console.log('PASS',name);}
async function shot(name,width=1440,height=1000) {await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await delay(80);const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});const file=path.join(temp,name+'.png');fs.writeFileSync(file,Buffer.from(r.data,'base64'));shots.push(file);const dimensions=await evaluate(`({width:innerWidth,scroll:document.documentElement.scrollWidth,height:innerHeight,scrollHeight:document.documentElement.scrollHeight})`);console.log('SCREEN',file,dimensions);return dimensions;}
function fixtures() {
 if(location.pathname!='/desk.html')return;
 if(!sessionStorage.getItem('fixture-seeded')) {localStorage.setItem('aihw.auth.session.v1',JSON.stringify({account:'synthetic',name:'测试教师',token:'fixture-not-real',expiresAt:Date.now()+3600000}));sessionStorage.setItem('fixture-seeded','1');}
 const canvas=document.createElement('canvas');canvas.width=600;canvas.height=800;const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,600,800);ctx.fillStyle='black';ctx.font='28px sans-serif';ctx.fillText('SYNTHETIC TEST ONLY',40,70);ctx.fillText('1. A  2. B  3. C',40,130);
 const image=canvas.toDataURL('image/png');
 const d={exam:{id:'e1',name:'合成练习',className:'测试班'},batch:{status:'draft',pagesPerStudent:1},students:[{id:'s1',studentNo:'001',name:'测试甲'},{id:'s2',studentNo:'002',name:'测试乙'},{id:'s3',studentNo:'003',name:'测试丙'}],pages:[],questions:[1,2,3].map(n=>({id:'q'+n,questionNo:String(n),title:'合成题 '+n,maxScore:5})),results:[]};
 const f=window.fixture={d,image,log:[],empty:false,noClasses:false,fail:'',failStatus:500,hold:'',release:null};
 navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Synthetic denied camera','NotAllowedError');};
 const original=window.fetch;
 window.fetch=async(url,opt={})=>{
  const u=new URL(url,location.href);if(!u.pathname.startsWith('/api/'))return original(url,opt);
  if(u.pathname!='/api/mvp')throw Error('Blocked non-fixture API '+u.pathname);
  const action=u.searchParams.get('action'),body=opt.body?JSON.parse(opt.body):null;f.log.push({action,body,auth:new Headers(opt.headers).get('Authorization')});
  if(f.hold===action)await new Promise(r=>f.release=r);
  if(f.fail===action){f.fail='';return new Response(JSON.stringify({message:'合成请求失败'}),{status:f.failStatus});}
  let result={ok:true};
  if(action==='bootstrap')result={classes:f.noClasses?[]:[{id:'c1',name:'测试班'}]};
  else if(action==='desk-list')result={assignments:f.empty?[]:[{id:'e1',name:d.exam.name,className:'测试班',examDate:'2026-11-12',status:d.batch.status,pagesPerStudent:d.batch.pagesPerStudent,capturedCount:d.pages.length,studentCount:3,doneCount:d.pages.filter(p=>p.status==='done').length}]};
  else if(action==='desk-detail')result=u.searchParams.get('examId')==='e2'?{...d,exam:{...d.exam,id:'e2',name:'另一份合成练习'}}:d;
  else if(action==='desk-create'){d.exam.name=body.name;result={examId:'e1'};}
  else if(action==='desk-image')result={image,boxes:{'1':[0.08,0.08,0.84,0.34]},regions:f.regions||null};
  else if(action==='desk-answer-image')result={image};
  else if(action==='desk-capture'){const pageNo=body.pageNo||1;d.pages=d.pages.filter(p=>!(p.studentId===body.studentId&&(p.pageNo||1)===pageNo));d.pages.push({id:'p'+body.studentId+'-'+pageNo,studentId:body.studentId,pageNo,status:'ready',captureOrder:body.captureOrder});}
  else if(action==='desk-questions')d.questions=body.questions;
  else if(action==='desk-confirm')d.batch.status='confirmed';
  else if(action==='desk-preflight')result={invalid:f.preflightInvalid?1:0,check:0,pages:[]};
  else if(action==='desk-regions')result={count:body.regions.length};
  else if(action==='desk-relocate')result={status:'ok',regions:[]};
  else if(action==='desk-sub-score')result={score:body.score,needsReview:false};
  else if(action==='desk-regrade')result={};
  else if(action==='desk-start'){
   d.batch.status='done';d.pages.forEach(p=>p.status='done');
   const seen=new Set(),unique=d.pages.filter(p=>{if(seen.has(p.studentId))return false;seen.add(p.studentId);return true;});
   d.results=unique.flatMap(p=>d.questions.map((q,i)=>{
    const subs=(q.subQuestions||[]).map((sub,s)=>({id:'sub-'+p.studentId+'-'+i+'-'+s,subQuestionId:sub.id,label:sub.label,score:4,maxScore:sub.maxScore,needsReview:true,studentAnswer:'合成作答',analysis:''}));
    return {...q,studentId:p.studentId,questionId:q.id||('q'+i),score:4,maxScore:q.maxScore,needsReview:true,analysis:'合成评语',suggestions:['合成建议'],knowledgePoints:['合成知识'],bbox:[0.05,0.06+i*0.3,0.9,0.24],subs};
   }));
  }
  else if(action==='desk-retry')d.batch.status='grading';
  else throw Error('Unhandled fixture '+action);
  return new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json'}});
 };
 window.syntheticUpload=async (id,openGallery=true)=>{if(id==='photoFile' && openGallery)document.querySelector('[data-action=gallery]').click();const blob=await (await original(image)).blob();const dt=new DataTransfer();dt.items.add(new File([blob],'synthetic.png',{type:'image/png'}));const el=document.getElementById(id);el.files=dt.files;el.dispatchEvent(new Event('change',{bubbles:true}));};
}
(async()=>{
 try {
 const endpoint=await new Promise((resolve,reject)=>{let text='';chrome.stderr.on('data',b=>{text+=b;const m=text.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m)resolve(m[1]);});chrome.on('error',reject);setTimeout(()=>reject(Error('Chrome launch timeout')),15000).unref();});
 const port=new URL(endpoint).port;const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else events.push(m);};
 await send('Page.enable');await send('Runtime.enable');await send('Log.enable');await send('Page.addScriptToEvaluateOnNewDocument',{source:`(${fixtures.toString()})()`});await send('Page.navigate',{url:'http://localhost:8081/desk.html#list'});await wait(`!!document.querySelector('.assignment')`);
 ok('Authenticated fixture list',await evaluate(`fixture.log[0].auth==='Bearer fixture-not-real'`));await shot('desktop-list');
 await route('#new');await shot('mobile390-new',390,844);await shot('mobile360-new',360,800);
 await evaluate(`document.querySelector('[name=name]').value='合成练习';syntheticUpload('answerFile')`);await wait(`!document.querySelector('#answerPreview').hidden && !document.querySelector('[type=submit]').disabled`);await evaluate(`fixture.hold='desk-create'`);await click('[type=submit]');await wait(`!document.querySelector('#busyOverlay').hidden`);ok('Answer upload shows centered progress overlay',await evaluate(`getComputedStyle(document.querySelector('#busyOverlay')).position==='fixed' && document.querySelector('.busy-percent').textContent.endsWith('%')`));await shot('mobile390-answer-progress',390,844);await evaluate(`fixture.hold='';fixture.release()`);await wait(`location.hash==='#capture/e1' && !!document.querySelector('.camera') && document.querySelector('#busyOverlay').hidden`);
 ok('Answer image submitted',await evaluate(`fixture.log.find(x=>x.action==='desk-create').body.answerImage.startsWith('data:image/jpeg')`));await shot('mobile390-camera',390,844);
 await click('[data-action=gallery]');await evaluate(`syntheticUpload('photoFile')`);await wait(`location.hash==='#capture/e1/s2' && document.querySelector('h1').textContent==='测试乙'`);
 await click('[data-action=skip]');await wait(`document.querySelector('h1').textContent==='测试丙'`);
 await evaluate(`fixture.fail='desk-capture';syntheticUpload('photoFile')`);await wait(`document.querySelector('#notice').textContent==='合成请求失败'`);ok('Failed upload stays on same student',await evaluate(`location.hash==='#capture/e1/s3' && fixture.d.pages.length===1 && !document.querySelector('[data-action=gallery]').disabled`));const error390=await shot('mobile390-upload-error',390,844);const error360=await shot('mobile360-upload-error',360,800);ok('Mobile upload error fits viewport at 390 and 360',error390.scrollHeight<=error390.height && error360.scrollHeight<=error360.height);
 await evaluate(`syntheticUpload('photoFile')`);await wait(`!!document.querySelector('.question-editor')`);ok('Skip preserves student association',await evaluate(`JSON.stringify(fixture.d.pages.map(p=>[p.studentId,p.captureOrder]))==='[["s1",0],["s3",2]]'`));
 await click('[data-action=capture-one][data-student=s1]');await wait(`!!document.querySelector('.camera')`);await evaluate(`syntheticUpload('photoFile')`);await wait(`!!document.querySelector('.question-editor')`);ok('Replacement overwrites only intended student',await evaluate(`fixture.d.pages.length===2 && fixture.log.filter(x=>x.action==='desk-capture').at(-1).body.replacement===true`));
 await click('.question-editor summary');await shot('desktop-review',1440,1000);await shot('mobile390-review',390,844);await shot('mobile360-review',360,800);
 await click('[data-action=delete-question]');await click('[data-action=start]');await wait(`document.querySelector('#notice').textContent.includes('请先保存')`);ok('Delete marks dirty and blocks start',await evaluate(`!fixture.log.some(x=>x.action==='desk-confirm')`));
 await evaluate(`document.querySelectorAll('.question-row [type=checkbox]').forEach(e=>e.click())`);await click('[data-action=merge]');ok('Merge retains numbers and summed score',await evaluate(`document.querySelectorAll('.question-row').length===1 && document.querySelector('[name=questionNo]').value==='2+3' && document.querySelector('[name=maxScore]').value==='10'`));await click('[data-action=start]');ok('Merge dirty blocks start',await evaluate(`!fixture.log.some(x=>x.action==='desk-start')`));
 await evaluate(`document.querySelector('#questionForm').requestSubmit()`);await wait(`document.querySelector('#notice').textContent.includes('题目调整已保存')`);await click('[data-action=start]');await wait(`location.hash==='#results/e1' && !!document.querySelector('.score')`);ok('Save then confirm then start',await evaluate(`fixture.log.filter(x=>['desk-questions','desk-confirm','desk-start'].includes(x.action)).map(x=>x.action).join(',')==='desk-questions,desk-confirm,desk-start'`));await shot('desktop-results',1440,1000);await shot('mobile360-results',360,800);
 await evaluate(`window.__results=fixture.d.results;fixture.d.results=[];fixture.d.batch.status='grading';fixture.d.pages.forEach((p,i)=>p.status=i?'running':'done')`);await route('#list');await route('#results/e1');
 const gradeStart=await evaluate(`(()=>{const bar=document.querySelector('.student.is-grading .student-progress');return bar?parseFloat(bar.querySelector('i').style.width):-1})()`);await delay(900);
 const gradeLater=await evaluate(`(()=>{const bar=document.querySelector('.student.is-grading .student-progress');return bar?parseFloat(bar.querySelector('i').style.width):-1})()`);
 ok('Active grading shows determinate progress bar instead of queue text',await evaluate(`document.querySelectorAll('.student.is-grading .student-progress').length===1 && !document.querySelector('#app').textContent.includes('排队中') && !document.querySelector('#app').textContent.includes('批改中')`));ok('Grading progress bar fills forward over time',gradeStart>0 && gradeStart<60 && gradeLater>gradeStart && gradeLater<=92);const grading360=await shot('mobile360-results-grading',360,800);ok('Grading progress bars fit mobile width',grading360.scroll<=360);
 await evaluate(`fixture.hold='desk-detail'`);await delay(6400);ok('Grading auto-refresh keeps roster visible instead of blanking',await evaluate(`!!document.querySelector('.roster.results') && !document.querySelector('#app').textContent.includes('正在加载')`));await evaluate(`fixture.hold='';fixture.release()`);await delay(100);await evaluate(`fixture.d.results=window.__results;fixture.d.batch.status='done'`);
 await route('#student/e1/s1');await wait(`!!document.querySelector('.result-question')`);ok('Student score, review, comments rendered',await evaluate(`document.querySelector('#app').textContent.includes('合成评语') && document.querySelector('.badge').textContent==='待复核'`));await wait(`!!document.querySelector('.paper-box')`);ok('Student paper annotations rendered',await evaluate(`document.querySelectorAll('.paper-box').length===1 && document.querySelector('.paper-stage img').src.startsWith('data:image/')`));const paper390=await shot('mobile390-student-annotations',390,844);const paper360=await shot('mobile360-student-annotations',360,800);ok('Student paper fits mobile widths',paper390.scroll<=390 && paper360.scroll<=360);await click('[data-action=paper][data-mode=answer]');await wait(`document.querySelector('.paper-stage img')?.alt.includes('标准答案')`);ok('Standard answer tab switches',await evaluate(`document.querySelector('[data-action=paper][data-mode=answer]').classList.contains('is-active') && document.querySelectorAll('.paper-box').length===0`));await shot('mobile390-student',390,844);await click('[data-action=photo]');await wait(`document.querySelector('dialog').open`);await shot('mobile360-photo',360,800);await click('#closePhoto');ok('Photo modal opens and closes',await evaluate(`!document.querySelector('dialog').open`));
 await route('#student/e1/s2');ok('Student empty results',await evaluate(`document.querySelector('#app').textContent.includes('还没有批改结果')`));
 await evaluate(`fixture.empty=true`);await route('#list');ok('Empty list',await evaluate(`document.querySelector('#app').textContent.includes('还没有作业')`));await shot('desktop-empty',1440,1000);
 await evaluate(`fixture.noClasses=true`);await route('#new');ok('No classes empty state',await evaluate(`document.querySelector('#app').textContent.includes('先准备一份班级名单')`));
 await evaluate(`fixture.fail='desk-detail'`);await route('#results/e1');ok('Load error recovery UI',await evaluate(`document.querySelector('#app').textContent.includes('加载失败')`));await shot('mobile390-load-error',390,844);await click('[data-action=refresh]');await wait(`!!document.querySelector('.roster')`);ok('Refresh recovers');
 // Reject a callback from the picker opened for A after navigating to B.
 await evaluate(`fixture.d.batch.status='draft'`);await route('#capture/e1/s1');await click('[data-action=gallery]');
 const beforeStale=await evaluate(`fixture.log.filter(x=>x.action==='desk-capture').length`);
 await route('#capture/e1/s2');await evaluate(`syntheticUpload('photoFile',false)`);await wait(`document.querySelector('#notice').textContent.includes('拍照位置已切换')`);await delay(150);
 ok('Stale picker callback makes no capture API call',await evaluate(`fixture.log.filter(x=>x.action==='desk-capture').length===${beforeStale} && location.hash==='#capture/e1/s2' && document.querySelector('h1').textContent==='测试乙'`));
 // Queue hash navigation while the synthetic upload request is held.
 await evaluate(`fixture.hold='desk-capture';syntheticUpload('photoFile')`);await wait(`!!fixture.release`);await evaluate(`location.hash='#review/e1'`);await delay(80);
 assert.equal(await evaluate(`document.querySelector('h1').textContent`),'测试乙');
 await evaluate(`fixture.hold='';fixture.release()`);await wait(`location.hash==='#review/e1' && !!document.querySelector('.question-editor')`);
 ok('Busy navigation honors queued review destination',await evaluate(`fixture.log.filter(x=>x.action==='desk-capture').at(-1).body.studentId==='s2'`));
 await click('.question-editor summary');await click('[data-action=merge]');
 assert.equal(await evaluate(`document.querySelector('#questionForm').dataset.dirty`),'false');
 await click('.question-row [type=checkbox]');assert.equal(await evaluate(`document.querySelector('#questionForm').dataset.dirty`),'false');await click('[data-action=merge]');
 ok('Selection and zero/one-row merge do not mark dirty',await evaluate(`document.querySelector('#questionForm').dataset.dirty==='false' && document.querySelectorAll('.question-row').length===1 && document.querySelector('[name=maxScore]').value==='10'`));
 await click('[data-action=start]');await wait(`location.hash==='#results/e1' && !!document.querySelector('.score')`);ok('No-op merge does not block start');
 await evaluate(`fixture.d.batch.status='draft'`);await route('#review/e1');await click('.question-editor summary');
 await evaluate(`document.querySelector('[name=maxScore]').value='99';document.querySelector('[name=maxScore]').dispatchEvent(new Event('input',{bubbles:true}))`);
 await route('#results/e1');await route('#review/e2');ok('Question drafts are isolated per exam',await evaluate(`document.querySelector('[name=maxScore]').value==='10' && document.querySelector('#questionForm').dataset.dirty==='false'`));await route('#list');await route('#capture/e1/s1');await route('#review/e1');
 ok('Dirty draft retained across routes until save',await evaluate(`document.querySelector('[name=maxScore]').value==='99' && document.querySelector('#questionForm').dataset.dirty==='true' && fixture.d.questions[0].maxScore===10`));
 const beforeDirty=await evaluate(`fixture.log.filter(x=>['desk-confirm','desk-start'].includes(x.action)).length`);await click('[data-action=start]');await wait(`document.querySelector('#notice').textContent.includes('请先保存')`);
 ok('Retained dirty draft still blocks grading',await evaluate(`fixture.log.filter(x=>['desk-confirm','desk-start'].includes(x.action)).length===${beforeDirty}`));
 // Save normally before logout; do not disable beforeunload guards.
 await evaluate(`document.querySelector('#questionForm').requestSubmit()`);await wait(`document.querySelector('#notice').textContent.includes('题目调整已保存')`);await route('#results/e1');await route('#review/e1');
 ok('Saving persists draft and clears dirty state',await evaluate(`fixture.d.questions[0].maxScore===99 && document.querySelector('[name=maxScore]').value==='99' && document.querySelector('#questionForm').dataset.dirty==='false'`));
 // Multi-page capture, sub-question structure, region editor and sub-score editing.
 await evaluate(`Object.assign(fixture.d,{batch:{status:'draft',pagesPerStudent:2},pages:[],results:[],questions:[{id:'q1',questionNo:'1',title:'合成题 1',maxScore:5,questionType:'解答',subQuestions:[{id:'sq1',label:'(1)',maxScore:2},{id:'sq2',label:'(2)',maxScore:3}]},{id:'q2',questionNo:'2',title:'合成题 2',maxScore:5,questionType:'解答',subQuestions:[]}]});fixture.preflightInvalid=false;fixture.regions=null`);
 await route('#capture/e1/s1');
 ok('Multi-page camera shows page position',await evaluate(`document.querySelector('.camera-top').textContent.includes('1 / 2 页') && document.querySelector('.camera-status').textContent.includes('第 1 页')`));
 await evaluate(`syntheticUpload('photoFile')`);await wait(`location.hash==='#capture/e1/s1/2' && document.querySelector('h1').textContent==='测试甲'`);
 ok('Saving page 1 advances to page 2 of the same student',await evaluate(`fixture.log.filter(x=>x.action==='desk-capture').at(-1).body.pageNo===1 && document.querySelector('.camera-top').textContent.includes('2 / 2 页')`));
 await evaluate(`syntheticUpload('photoFile')`);await wait(`location.hash==='#capture/e1/s2/1' && document.querySelector('h1').textContent==='测试乙'`);
 ok('Saving page 2 advances to the next student',await evaluate(`fixture.log.filter(x=>x.action==='desk-capture').at(-1).body.pageNo===2`));
 await evaluate(`syntheticUpload('photoFile')`);await wait(`location.hash==='#capture/e1/s2/2'`);
 await click('[data-action=skip]');await wait(`location.hash==='#capture/e1/s3/1'`);
 ok('Skipping page 2 moves on to the next student',await evaluate(`document.querySelector('h1').textContent==='测试丙'`));
 await evaluate(`syntheticUpload('photoFile')`);await wait(`location.hash==='#capture/e1/s3/2'`);
 await evaluate(`syntheticUpload('photoFile')`);await wait(`location.hash==='#review/e1' && !!document.querySelector('.question-editor')`);
 ok('Review counts pages and flags an incomplete student',await evaluate(`document.querySelector('#app').textContent.includes('已拍 5 / 6 页') && document.querySelector('#app').textContent.includes('已拍 1 / 2 页')`));
 await shot('mobile360-review-multipage',360,800);
 await click('[data-action=regions][data-student=s1]');await wait(`document.querySelector('#regionDialog').open`);
 await shot('desktop-region-editor',1440,1000);
 ok('Region editor seeds template boxes and splits sub rows',await evaluate(`document.querySelectorAll('.region-box.question').length===1 && document.querySelectorAll('.region-box.sub').length===2 && document.querySelector('#regionChips').textContent.includes('2 小题') && document.querySelector('#regionChips').textContent.includes('待画框')`));
 await wait(`document.querySelector('#regionImage').complete && document.querySelector('#regionCanvas').getBoundingClientRect().height>100`);
 const canvasRect=await evaluate(`(()=>{const r=document.querySelector('#regionCanvas').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}})()`);
 const at=(fx,fy)=>({x:Math.round(canvasRect.x+canvasRect.w*fx),y:Math.round(canvasRect.y+canvasRect.h*fy)});
 await send('Input.dispatchMouseEvent',{type:'mousePressed',...at(0.2,0.55),button:'left',clickCount:1});
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',...at(0.7,0.85),button:'left'});
 await send('Input.dispatchMouseEvent',{type:'mouseReleased',...at(0.7,0.85),button:'left',clickCount:1});
 ok('Unboxed question can be drawn on the photo',await evaluate(`document.querySelectorAll('.region-box.question').length===2 && !document.querySelector('#regionChips').textContent.includes('待画框')`));
 await click('[data-action=region-relocate]');await wait(`document.querySelector('#notice').textContent.includes('重定位')`);
 ok('Relocate keeps manual boxes for review',await evaluate(`fixture.log.at(-1).action==='desk-relocate' && fixture.log.at(-1).body.pageNo===1`));
 await delay(150);await click('[data-action=region-save]');await wait(`document.querySelector('#notice').textContent.includes('框位已保存')`);
 ok('Saving regions sends question and sub boxes',await evaluate(`(()=>{const call=fixture.log.filter(x=>x.action==='desk-regions').at(-1).body;return call.pageNo===1 && call.regions.length===2 && call.regions[0].subs.length===2 && call.regions[1].bbox[2]>=0.4})()`));
 await evaluate(`fixture.preflightInvalid=true;fixture.d.pages.forEach(p=>p.regionStatus='invalid')`);await route('#list');await route('#review/e1');
 ok('Preflight anomalies mark student rows red',await evaluate(`document.querySelectorAll('.student.is-invalid').length===3 && !!document.querySelector('.roster-note.warning')`));
 const beforeStart=await evaluate(`fixture.log.filter(x=>x.action==='desk-start').length`);
 await click('[data-action=start]');await wait(`document.querySelector('#notice').textContent.includes('自动定位异常')`);
 ok('Invalid preflight pages block grading',await evaluate(`fixture.log.filter(x=>x.action==='desk-start').length===${beforeStart}`));
 await evaluate(`fixture.preflightInvalid=false;fixture.d.pages.forEach(p=>p.regionStatus='')`);await route('#list');await route('#review/e1');
 await click('[data-action=start]');await wait(`location.hash==='#results/e1' && !!document.querySelector('.score')`);
 ok('Clean preflight starts grading',await evaluate(`fixture.d.results.length===6 && fixture.d.results.every(r=>r.subs.length===(r.questionNo==='1'?2:0))`));
 await evaluate(`fixture.regions=[{questionId:'q1',questionNo:'1',bbox:[0.08,0.08,0.84,0.34],subs:[{subId:'sq1',label:'(1)',bbox:[0.08,0.08,0.84,0.16]},{subId:'sq2',label:'(2)',bbox:[0.08,0.25,0.84,0.16]}]},{questionId:'q2',questionNo:'2',bbox:[0.08,0.52,0.84,0.34],subs:[]}]`);
 await route('#student/e1/s1');await wait(`!!document.querySelector('.sub-row') && document.querySelectorAll('.paper-box').length===3`);
 ok('Sub details and sub-level boxes render',await evaluate(`document.querySelectorAll('.sub-row').length===2 && document.querySelector('#app').textContent.includes('(1)') && document.querySelector('#app').textContent.includes('(2)')`));
 await shot('mobile360-student-subs',360,800);
 ok('Multi-page student exposes page tabs',await evaluate(`document.querySelectorAll('.paper-pages button').length===2`));
 await click('.paper-pages [data-page="2"]');await wait(`document.querySelector('.paper-pages button.is-active').textContent.includes('2')`);
 ok('Page tab switches the annotated page',await evaluate(`!!document.querySelector('#paperStage .paper-image')`));
 const subId=await evaluate(`(()=>{const f=document.querySelector('.sub-score-form');f.querySelector('[name=score]').value='1';f.requestSubmit();return f.dataset.sub})()`);
 await wait(`document.querySelector('#notice').textContent.includes('已改分')`);
 ok('Editing a sub score posts its sub result id',await evaluate(`(()=>{const call=fixture.log.filter(x=>x.action==='desk-sub-score').at(-1).body;return call.subResultId===${JSON.stringify(subId)} && call.score===1 && call.studentId==='s1'})()`));
 await click('[data-action=regrade][data-question=q1]');await wait(`location.hash==='#results/e1' && !!document.querySelector('.score')`);
 ok('Regrade submits only the affected question',await evaluate(`(()=>{const call=fixture.log.filter(x=>x.action==='desk-regrade').at(-1).body;return call.questionId==='q1' && call.studentId==='s1'})()`));
 await route('#list');await click('.teacher-menu summary');await click('[data-action=logout]');await wait(`location.pathname==='/index.html'`);ok('Logout clears session and redirects',await evaluate(`localStorage.getItem('aihw.auth.session.v1')===null`));await send('Page.navigate',{url:'http://localhost:8081/desk.html#student/e1/s1'});await wait(`location.pathname==='/index.html'`);ok('Unauthenticated desk redirects');
 ok('Auth redirect preserves and resolves desk deep link',await evaluate(`new URLSearchParams(location.search).get('next')==='desk.html#student/e1/s1' && AppAuth.resolveNextPage(new URLSearchParams(location.search).get('next'))==='./desk.html#student/e1/s1'`));
 const errors=events.filter(e=>e.method==='Runtime.exceptionThrown'||e.method==='Log.entryAdded'&&e.params.entry.level==='error'||e.method==='Runtime.consoleAPICalled'&&e.params.type==='error');console.log('CONSOLE_ERRORS',JSON.stringify(errors));console.log('SUMMARY',JSON.stringify({checks:checks.length,shots,temp},null,2));
 } finally {if(ws)ws.close();chrome.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
