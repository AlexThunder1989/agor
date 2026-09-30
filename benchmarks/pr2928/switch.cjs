const fs=require('fs');const git=require('/usr/lib/node_modules/agor-live/node_modules/simple-git')();
const arms={A:'122fe057e90a745208331dac690109d64ffcfcfa',B:'e373b7069a483d2bb97ad91198d1ad6804f79047'};
(async()=>{const sha=arms[process.argv[2]];if(!sha)throw Error('A or B required; stop managed environment FIRST');await git.checkout(['--detach',sha]);fs.writeFileSync('benchmarks/pr2928/arm-sha.txt',sha+'\n');console.log(await git.revparse(['HEAD']));})();
