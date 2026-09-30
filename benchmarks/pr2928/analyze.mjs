import {readFileSync,writeFileSync} from 'node:fs';
const blocks=['A1','B1','B2','A2'];
const rows=blocks.flatMap(b=>readFileSync(`benchmarks/pr2928/results/${b}.jsonl`,'utf8').trim().split('\n').map(JSON.parse));
const quant=(a,q)=>{const v=[...a].sort((x,y)=>x-y),i=(v.length-1)*q;return v[Math.floor(i)]+(v[Math.ceil(i)]-v[Math.floor(i)])*(i%1);};
const stats=a=>({n:a.length,median:quant(a,.5),p25:quant(a,.25),p75:quant(a,.75),min:Math.min(...a),max:Math.max(...a)});
const measures={ready:r=>r.ready?.at,branch120:r=>r.requests.find(q=>q.service==='branches'&&q.method==='find'&&q.count===120)?.ms,session240:r=>r.requests.find(q=>q.service==='sessions'&&q.method==='find'&&q.count===240)?.ms,session50:r=>r.requests.find(q=>q.service==='sessions'&&q.method==='find'&&q.count===50)?.ms,branch150:r=>r.requests.find(q=>q.service==='branches'&&q.method==='find'&&q.count===150)?.ms,session300:r=>r.requests.find(q=>q.service==='sessions'&&q.method==='find'&&q.count===300)?.ms,firstRequest:r=>r.requests[0]?.start,lastScopedAck:r=>Math.max(...r.requests.filter(q=>['branches','sessions','board-objects','boards','cards','board-comments'].includes(q.service)&&(q.count===120||q.count===240||q.method==='get')).map(q=>q.ack||0).filter(x=>x<r.ready.at)),longTaskTotal:r=>r.longTasks.filter(x=>x.start<r.ready.at).reduce((n,x)=>n+x.duration,0),observerMs:r=>r.observerMs};
const output={failures:rows.filter(r=>r.failure||r.pageErrors.length),feathersErrors:rows.flatMap(r=>r.requests.filter(q=>typeof q.service==='string'&&q.error).map(q=>({block:r.block,run:r.run,route:r.route,service:q.service}))),warmups:rows.filter(r=>r.warmup).length,measured:rows.filter(r=>!r.warmup).length,byRoute:{},byBlock:{},content:{}};
for(const route of ['board','conversation']){
 const selected=rows.filter(r=>!r.warmup&&r.route===route);output.byRoute[route]={};
 for(const [metric,get] of Object.entries(measures)){
  const vals=arm=>selected.filter(r=>r.block.startsWith(arm)).map(get).filter(x=>Number.isFinite(x));const A=stats(vals('A')),B=stats(vals('B'));
  output.byRoute[route][metric]={A,B,deltaMs:B.median-A.median,percent:100*(B.median/A.median-1)};
 }
 output.content[route]={transcriptHashes:[...new Set(selected.map(r=>r.ready?.transcriptHash).filter(Boolean))],targetTexts:[...new Set(selected.map(r=>r.ready?.targetText).filter(Boolean))],branch120Hashes:[...new Set(selected.flatMap(r=>r.requests.filter(q=>q.service==='branches'&&q.count===120).map(q=>q.contentHash)))],session240Hashes:[...new Set(selected.flatMap(r=>r.requests.filter(q=>q.service==='sessions'&&q.count===240).map(q=>q.contentHash)))],requestCounts:stats(selected.map(r=>r.requests.filter(q=>typeof q.service==='string').length)),debugEnabled:selected.some(r=>r.debugEnabled)};
}
for(const b of blocks)output.byBlock[b]=Object.fromEntries(['board','conversation'].map(route=>[route,stats(rows.filter(r=>r.block===b&&r.route===route&&!r.warmup).map(r=>r.ready?.at).filter(x=>x!==undefined))]));
writeFileSync('benchmarks/pr2928/results/summary.json',JSON.stringify(output,null,2)+'\n');
for(const route of ['board','conversation'])for(const metric of ['ready','branch120','session240']){const x=output.byRoute[route][metric];const f=y=>`${y.median.toFixed(1)} [${y.p25.toFixed(1)}, ${y.p75.toFixed(1)}]`;console.log(`${route} ${metric}: ${f(x.A)} -> ${f(x.B)} (${x.deltaMs.toFixed(1)}ms, ${x.percent.toFixed(1)}%)`);}
console.log(JSON.stringify({failures:output.failures.length,blocks:output.byBlock,content:output.content},null,2));
