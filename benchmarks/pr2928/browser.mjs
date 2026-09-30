import { chromium } from '/usr/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs';
import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const base='http://127.0.0.1:10292';
const sha=readFileSync('benchmarks/pr2928/arm-sha.txt','utf8').trim();
const block=process.argv[2]||'pilot';const runs=Number(process.argv[3]||1);
const browser=await chromium.launch({headless:true,executablePath:'/home/agorpg/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',args:['--no-sandbox']});
// Synthetic login happens once per block, outside measured navigation. Tokens never persisted.
const login=await browser.newContext();const auth=await login.request.post(`${base}/authentication`,{data:{strategy:'local',email:'bench@example.invalid',password:'synthetic-benchmark-2928'}});
assert(auth.ok(),`Synthetic login HTTP ${auth.status()}`);const {accessToken}=await auth.json();await login.close();
const routes={board:'/ui/b/bench-engineering/',conversation:'/ui/s/29280001-0005-7000-8000-000000000001/'};
for(let run=-2;run<runs;run++)for(const [route,path] of Object.entries(routes)){
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'no-preference'});
 await context.addInitScript(({token,route})=>{
  localStorage.setItem('agor-access-token',token);
  window.__bench={route,requests:[],errors:[],longTasks:[],observerMs:0,observerChecks:0,ready:null};
  try{new PerformanceObserver(list=>{for(const x of list.getEntries())window.__bench.longTasks.push({start:x.startTime,duration:x.duration});}).observe({entryTypes:['longtask']});}catch{}
  const Native=WebSocket;
  window.WebSocket=class extends Native{
   constructor(...args){super(...args);this.pending=new Map();this.addEventListener('message',e=>{
    if(typeof e.data!=='string')return;const m=/^43(\d+)(\[.*)$/s.exec(e.data);if(!m)return;
    const req=this.pending.get(m[1]);if(!req)return;this.pending.delete(m[1]);
    const v=JSON.parse(m[2]);const res=v[1];const rows=Array.isArray(res)?res:res?.data;
    Object.assign(req,{ack:performance.now(),ms:performance.now()-req.start,bytes:new TextEncoder().encode(e.data).length,error:!!v[0],count:Array.isArray(rows)?rows.length:null,total:res?.total});
    if(['branches','sessions'].includes(req.service)&&Array.isArray(rows))req.content=rows.map(x=>({id:x.branch_id||x.session_id,name:x.name,title:x.title,status:x.status,zone_id:x.zone_id,zone_label:x.zone_label,board_id:x.board_id,branch_board_id:x.branch_board_id,last_message:x.last_message}));
   });}
   send(data){if(typeof data==='string'){const m=/^42(\d+)(\[.*)$/s.exec(data);if(m){const v=JSON.parse(m[2]);const [method,service]=v;if(service!=='authentication'){const req={method,service,start:performance.now()};if(method==='find')req.query=v[2];this.pending.set(m[1],req);window.__bench.requests.push(req);}}}return super.send(data);}
  };
  const visible=(el,clip)=>{if(!el?.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return false;const r=el.getBoundingClientRect(),c=clip.getBoundingClientRect();const l=Math.max(0,r.left,c.left),t=Math.max(0,r.top,c.top),right=Math.min(innerWidth,r.right,c.right),bottom=Math.min(innerHeight,r.bottom,c.bottom);if(right-l<2||bottom-t<2)return false;const hit=document.elementFromPoint((l+right)/2,(t+bottom)/2);return el.contains(hit);};
  let stableSince=0,lastGeometry='';
  function check(){
   const checkStart=performance.now();
   let receipt=null;
   if(route==='board'){
    const pane=document.querySelector('.react-flow');
    const branches=document.querySelectorAll('.react-flow__node-branchNode');
    const rows=[...document.querySelectorAll('[data-session-id]')];
    const target=document.querySelector('.react-flow__node[data-id="29280001-0004-7000-8000-000000000001"]');
    const session=target?.querySelector('[data-session-id="29280001-0005-7000-8000-000000000001"]');
    if(pane&&branches.length===120&&rows.length>=240&&target?.textContent.includes('bench-001-checkout-validation')&&session?.textContent.includes('Implement checkout validation 001')&&visible(target,pane)&&visible(session,pane)&&target.getBoundingClientRect().width<450){const r=target.getBoundingClientRect();const geom=[r.x,r.y,r.width,r.height].map(n=>Math.round(n*10)/10).join(',');if(geom!==lastGeometry){lastGeometry=geom;stableSince=performance.now();}if(performance.now()-stableSince>=100)receipt={branchNodes:branches.length,sessionRows:rows.length,target:target.getAttribute('data-id'),targetText:target.textContent,geometry:geom,viewport:document.querySelector('.react-flow__viewport')?.getAttribute('style')};}
   }else{
    const scroll=document.querySelector('[data-testid="conversation-scroll-container"]');
    const end=scroll&&[...scroll.querySelectorAll('p')].find(x=>x.textContent.includes('BENCHMARK TRANSCRIPT READY'));
    if(end&&visible(end,scroll))receipt={transcript:scroll.textContent,final:end.textContent};
   }
   window.__bench.observerMs+=performance.now()-checkStart;window.__bench.observerChecks++;
   if(receipt){window.__bench.ready={at:performance.now(),...receipt};return;}requestAnimationFrame(check);
  }
  requestAnimationFrame(check);
 },{token:accessToken,route});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));let failure=null;
 try{await page.goto(base+path,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForFunction(()=>window.__bench?.ready,{timeout:30000});}catch(e){failure=e.message;}
 const result=await page.evaluate(()=>({...window.__bench,resources:performance.getEntriesByType('resource').map(x=>({name:new URL(x.name).pathname,start:x.startTime,duration:x.duration,transferSize:x.transferSize})),debugEnabled:!!window.__AGOR_INITIAL_LOAD_TIMINGS__}));
 const health=await context.request.get(base+'/health');const h=await health.json();
 assert.equal(h.buildSha,sha,'Served backend revision');
 const row={sha,block,run,warmup:run<0,route,chromium:browser.version(),failure,pageErrors:errors,healthBuild:{sha:h.buildSha,builtAt:h.builtAt},...result};
 for(const req of row.requests){if(req.content){req.contentHash=createHash('sha256').update(JSON.stringify(req.content)).digest('hex');delete req.content;}}
 if(row.ready?.transcript){row.ready.transcriptHash=createHash('sha256').update(row.ready.transcript).digest('hex');}
 appendFileSync(`benchmarks/pr2928/results/${block}.jsonl`,JSON.stringify(row)+'\n');
 console.log(JSON.stringify({block,run,route,ms:row.ready?.at,failure,branch:row.requests.filter(x=>x.service==='branches').map(x=>({ms:x.ms,count:x.count})),session:row.requests.filter(x=>x.service==='sessions').map(x=>({ms:x.ms,count:x.count})),observerMs:row.observerMs,errors}));
 if(block==='pilot'||failure){await page.screenshot({path:`benchmarks/pr2928/results/${block}-${route}.png`});writeFileSync(`benchmarks/pr2928/results/${block}-${route}.txt`,await page.locator('body').innerText());}
 await context.close();if(failure) {await browser.close();process.exit(1);}
}
await browser.close();
