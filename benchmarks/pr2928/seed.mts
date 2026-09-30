/** Synthetic-only metadata fixture, adapted from packages/core/src/seed/demo-fixtures.ts.
 * Run ONLY inside the dedicated managed benchmark container, after migration. */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createDatabase } from '../../packages/core/src/db/client';
import { insert } from '../../packages/core/src/db/database-wrapper';
import { hashLocalPassword } from '../../packages/core/src/db/password-credentials';
import { runWithTenantDatabaseScope } from '../../packages/core/src/db/tenant-scope';
import { users } from '../../packages/core/src/db/schema';
import { BoardRepository, BoardObjectRepository, BranchRepository, RepoRepository, SessionRepository, TaskRepository, MessagesRepository, UsersRepository } from '../../packages/core/src/db/repositories';
import { SessionStatus, TaskStatus, MessageRole } from '../../packages/core/src/types';
import type { UUID, BoardID, BoardObject, BranchID } from '../../packages/core/src/types';
if (process.env.HOSTNAME === undefined || process.env.DATABASE_URL !== 'postgresql://agor_app:agor_dev_secret@postgres:5432/agor') throw Error('Dedicated synthetic Compose DB required');
const db = createDatabase({ dialect:'postgresql', url:process.env.DATABASE_URL });
const id = (kind:number,n:number) => `${(0x29280000+n).toString(16)}-${kind.toString(16).padStart(4,'0')}-7000-8000-${n.toString(16).padStart(12,'0')}` as UUID;
const at = '2026-09-01T10:00:00.000Z';
const owner=id(1,1), repoId=id(2,1);
const plan={boards:[{id:id(3,1),name:'Benchmark Engineering',slug:'bench-engineering',branches:120,sessions:240},{id:id(3,2),name:'Benchmark Operations',slug:'bench-operations',branches:30,sessions:60}],branches:150,sessions:300,tasks:300,messages:1200,zones:8,owner,repoId,session:id(5,1),transcript:['Please summarize the synthetic checkout validation.','I will inspect the fixture and report the validation outcome.','Validation completed: 12 synthetic checks passed.','BENCHMARK TRANSCRIPT READY — Checkout validation passed. No external services were contacted.']};
await runWithTenantDatabaseScope(db,'default',async t=>{
 if(await new UsersRepository(t).findByEmail('bench@example.invalid')) return;
 await insert(t,users).values({user_id:owner,email:'bench@example.invalid',name:'Benchmark Engineer',role:'admin',password:await hashLocalPassword('synthetic-benchmark-2928'),created_at:new Date(at),updated_at:new Date(at),onboarding_completed:true,must_change_password:false,data:{preferences:{}}}).run();
 await new RepoRepository(t).create({repo_id:repoId,name:'Synthetic Checkout',slug:'bench-checkout',repo_type:'local',local_path:'/tmp/benchmark-metadata-only',default_branch:'main'});
 for(let b=0;b<2;b++){
  const spec=plan.boards[b];const objects:Record<string,BoardObject>={};
  ['Planned','Implementation','Review','Complete'].forEach((label,z)=>{objects[`bench-zone-${z}`]={type:'zone',x:(z%2)*2400,y:Math.floor(z/2)*2600,width:2300,height:2500,label,borderColor:'#1677ff',backgroundColor:'#1677ff1a'};});
  objects['bench-note']={type:'markdown',x:4900,y:0,width:480,height:360,content:'# Synthetic engineering workspace\n\nCheckout validation, accessibility, API compatibility and release documentation.\n\nAll conversations are completed. This fixture performs no network requests or agent work.\n\nReview checklist:\n- Validate input\n- Preserve permissions\n- Exercise rollback\n- Document test coverage'};
  await new BoardRepository(t).create({board_id:spec.id as BoardID,name:spec.name,slug:spec.slug,description:'Deterministic synthetic engineering workspace for startup comparison.',created_by:owner,objects,icon:'🧪',color:'#1677ff'});
 }
 for(let i=0;i<150;i++){
  const board=plan.boards[i<120?0:1];const j=i<120?i:i-120;const branch=id(4,i+1) as BranchID;
  const name=`bench-${String(i+1).padStart(3,'0')}-checkout-validation`;
  await new BranchRepository(t).create({branch_id:branch,repo_id:repoId,name,ref:name,path:`/tmp/benchmark-metadata-only/${name}`,base_ref:'main',branch_unique_id:20000+i,created_by:owner,created_at:at,board_id:board.id as BoardID,permission_binding:'inherit',needs_attention:false,filesystem_status:'ready',notes:'Synthetic checkout change: validation, regression coverage and review notes. No filesystem or executor exists.',last_used:at});
  await new BoardObjectRepository(t).create({object_id:id(7,i+1),board_id:board.id as BoardID,branch_id:branch,zone_id:`bench-zone-${j%4}`,position:{x:30+(Math.floor(j/4)%5)*440,y:80+Math.floor(j/20)*390}});
  for(let k=0;k<2;k++){
   const n=i*2+k+1;const session=id(5,n),task=id(6,n);
   await new SessionRepository(t).create({session_id:session,branch_id:branch,created_by:owner,created_at:at,last_updated:at,status:SessionStatus.COMPLETED,agentic_tool:'claude-code',title:`${k?'Review':'Implement'} checkout validation ${String(i+1).padStart(3,'0')}`,description:'Synthetic completed conversation with validation and review metadata.',tasks:[task],genealogy:{children:[]},ready_for_prompt:false,model_config:{model:'claude-sonnet-4-6',effort:'high'},sdk_home_scope:'branch'});
   await new TaskRepository(t).create({task_id:task,session_id:session,created_by:owner,status:TaskStatus.COMPLETED,full_prompt:plan.transcript[0],message_range:{start_index:0,end_index:3,start_timestamp:at},completed_at:'2026-09-01T10:01:00.000Z',git_state:{ref_at_start:name,sha_at_start:'a'.repeat(40)}});
   for(let m=0;m<4;m++)await new MessagesRepository(t).create({message_id:id(8,n*10+m),session_id:session,task_id:task,type:m%2?'assistant':'user',role:m%2?MessageRole.ASSISTANT:MessageRole.USER,index:m,timestamp:new Date(Date.parse(at)+m*1000).toISOString(),content_preview:plan.transcript[m],content:plan.transcript[m],metadata:m%2?{model:'claude-sonnet-4-6',tokens:{input:120,output:45}}:{source:'agor'}});
 }
 }
});
writeFileSync('benchmarks/pr2928/results/fixture-plan.json',JSON.stringify({...plan,planHash:createHash('sha256').update(JSON.stringify(plan)).digest('hex')},null,2)+'\n');
await (db as any).$client.end();
console.log('Synthetic fixture ready: 2 boards / 8 zones / 150 branches / 300 sessions / 300 completed tasks / 1200 messages');
