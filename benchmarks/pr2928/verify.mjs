import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const dir='benchmarks/pr2928/results/';
const json=p=>JSON.parse(readFileSync(dir+p,'utf8'));
const blocks=['A1','B1','B2','A2'];
const rows=blocks.flatMap(b=>readFileSync(dir+b+'.jsonl','utf8').trim().split('\n').map(JSON.parse));
assert.equal(rows.length,56);assert.equal(rows.filter(r=>!r.warmup).length,40);
for(const b of blocks)for(const route of ['board','conversation'])assert.equal(rows.filter(r=>r.block===b&&r.route===route&&!r.warmup).length,5);
for(const r of rows){assert.equal(r.failure,null);assert.deepEqual(r.pageErrors,[]);assert.equal(r.debugEnabled,false);assert.equal(r.healthBuild.sha,r.sha);assert(r.ready.at>0);assert.equal(r.requests.filter(q=>typeof q.service==='string'&&q.error).length,0);if(r.route==='board'){assert.equal(r.ready.branchNodes,120);assert(r.ready.sessionRows>=240);assert(r.ready.targetText.includes('Implement checkout validation 001'));}else assert(r.ready.final.includes('BENCHMARK TRANSCRIPT READY'));}
const fixtures=readdirSync(dir).filter(p=>p.startsWith('fixture-')&&p.endsWith('.json')&&!p.includes('plan'));
for(const f of fixtures)assert.deepEqual(json(f),json('fixture-pilot.json'));
const summary=json('summary.json');
for(const route of ['board','conversation']){const c=summary.content[route];assert.equal(c.branch120Hashes.length,1);assert.equal(c.session240Hashes.length,1);}
assert.equal(summary.content.conversation.transcriptHashes.length,1);
const a1=json('attestation-A1.json'),a2=json('attestation-A2.json'),b=json('attestation-B1.json');
assert.equal(a1.sourceHash,a2.sourceHash);assert.equal(a1.indexHash,a2.indexHash);assert.deepEqual(a1.assets,a2.assets);assert.equal(a1.lockHash,b.lockHash);
const receipt={verified:true,measured:40,warmups:16,routeFailures:0,pageErrors:0,feathersErrors:0,fixtureSnapshots:fixtures.length,fixtureTables:Object.keys(json('fixture-pilot.json').tables),sourceAndServedAssetsVerified:true,branchAndSessionEnrichmentEquivalent:true,transcriptEquivalent:true,driverSha256:createHash('sha256').update(readFileSync('benchmarks/pr2928/browser.mjs')).digest('hex')};
writeFileSync(dir+'verification.json',JSON.stringify(receipt,null,2)+'\n');console.log(receipt);
