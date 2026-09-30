import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import postgres from 'postgres';
if(process.env.DATABASE_URL!=='postgresql://agor_app:agor_dev_secret@postgres:5432/agor')throw Error('Own benchmark DB only');
const sql=postgres(process.env.DATABASE_URL);
const result=await sql.begin(async tx=>{
 await tx`SELECT set_config('agor.tenant_id','default',true)`;
 const tables={};
 for(const [table,key] of [['boards','board_id'],['branches','branch_id'],['board_objects','object_id'],['sessions','session_id'],['tasks','task_id'],['messages','message_id']]){
  const rows=await tx`SELECT * FROM ${tx(table)} ORDER BY ${tx(key)}`;
  tables[table]={count:rows.length,bytes:Buffer.byteLength(JSON.stringify(rows)),sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
 }
 const boards=await tx`SELECT b.board_id,b.name,octet_length(b.data::text) as json_bytes,(select count(*)::int from branches x where x.board_id=b.board_id) as branches,(select count(*)::int from sessions s join branches x on s.branch_id=x.branch_id where x.board_id=b.board_id) as sessions FROM boards b order by b.board_id`;
 const roles=await tx`SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
 const states=await tx`SELECT status,count(*)::int FROM tasks GROUP BY status`;
 const version=await tx`select version()`;
 return {tables,boards,roles,states,version};
});
writeFileSync(`benchmarks/pr2928/results/fixture-${process.argv[2]||'initial'}.json`,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));await sql.end();
