const fs=require('fs'),path=require('path'),crypto=require('crypto');
const git=require('/usr/lib/node_modules/agor-live/node_modules/simple-git')();
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
(async()=>{
const sha=fs.readFileSync('benchmarks/pr2928/arm-sha.txt','utf8').trim();
if((await git.revparse(['HEAD'])).trim()!==sha)throw Error('Wrong checked-out arm');
const delta=await git.diff([sha,'--','apps','packages','pnpm-lock.yaml']);if(delta)throw Error('Production source differs from frozen arm');
const files=(await git.raw(['ls-files','apps/agor-daemon/src','apps/agor-ui/src','packages'])).split('\n').filter(Boolean);
const sourceHash=hash(files.map(p=>p+'\0'+hash(fs.readFileSync(p))).join('\n'));
const assets={};for(const name of fs.readdirSync('apps/agor-ui/dist/assets'))if(!name.endsWith('.gz'))assets[name]=hash(fs.readFileSync('apps/agor-ui/dist/assets/'+name));
const health=await (await fetch('http://127.0.0.1:10292/health')).json();
const index=await(await fetch('http://127.0.0.1:10292/ui/')).text();if(hash(index)!==hash(fs.readFileSync('apps/agor-ui/dist/index.html')))throw Error('Served HTML does not match build');
for(const [name,digest] of Object.entries(assets)){const got=await(await fetch('http://127.0.0.1:10292/ui/assets/'+name)).arrayBuffer();if(hash(Buffer.from(got))!==digest)throw Error('Served asset mismatch '+name);}
const result={sha,tree:(await git.revparse([sha+'^{tree}'])).trim(),sourceHash,lockHash:hash(fs.readFileSync('pnpm-lock.yaml')),indexHash:hash(index),assets,healthBuild:{sha:health.buildSha,builtAt:health.builtAt},healthKeys:Object.keys(health),sourceFiles:files.length,verifiedServedAssets:Object.keys(assets).length,at:new Date().toISOString()};
fs.writeFileSync('benchmarks/pr2928/results/attestation-'+process.argv[2]+'.json',JSON.stringify(result,null,2)+'\n');console.log({...result,assets:undefined});
})();
