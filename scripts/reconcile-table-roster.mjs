// Operates only on table configuration; it never transfers or closes a visit.
// Default invocation rolls the entire transaction back. Keep the private output
// for before/after evidence; no QR credentials are read or rotated.
import pg from 'pg'
import {readFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'

export function normalizedTableCode(code){return code.toUpperCase().replace(/^([A-Z]+)0+(\d+)$/,'$1$2')}
export async function reconcileTableRoster(client,scope,roster){
 if(!Array.isArray(roster)||!roster.length||new Set(roster.map(t=>t.code)).size!==roster.length)throw Error('Unique desired table roster required')
 for(const t of roster)if(!/^[A-Z]+[1-9][0-9]*$/.test(t.code)||!Number.isInteger(t.capacity)||t.capacity<1||t.capacity>200||!t.areaCode)throw Error('Invalid desired table')
 const args=[scope.tenantId,scope.storeId]
 const businessDate=(await client.query('SELECT mbox.current_operating_business_date($1,$2)::text AS date',args)).rows[0].date
 const areas=(await client.query("SELECT id,code FROM mbox.areas WHERE tenant_id=$1 AND store_id=$2 AND status='active'",args)).rows
 for(const t of roster)if(!areas.some(a=>a.code===t.areaCode))throw Error(`Unknown active area ${t.areaCode}`)
 const tables=(await client.query('SELECT * FROM mbox.tables WHERE tenant_id=$1 AND store_id=$2 ORDER BY id FOR UPDATE',args)).rows
 const byCode=new Map()
 for(const t of tables){const key=normalizedTableCode(t.code);if(byCode.has(key))throw Error(`Ambiguous existing table ${key}`);byCode.set(key,t)}
 const changes=[],deferred=[],desiredCodes=new Set(roster.map(t=>t.code))
 const audit=async(before,after,action)=>{
  await client.query(`INSERT INTO mbox.audit_events(tenant_id,store_id,actor_type,actor_ref,action,object_type,object_id,before_snapshot,after_snapshot,reason,business_date,metadata)
   VALUES($1,$2,'support','codex-user-table-roster-20260925',$3,'table',$4,$5::jsonb,$6::jsonb,'用户指定68张桌台名单；保留原桌ID、桌次与二维码；不改账、不移单',$7::date,$8::jsonb)`,[...args,action,after.id,before===null?null:JSON.stringify(before),JSON.stringify(after),businessDate,JSON.stringify({rosterDate:'2026-09-25',existingIdentityPreserved:before!==null})])
  changes.push({id:after.id,action,beforeCode:before?.code??null,code:after.code,beforeStatus:before?.status??null,status:after.status})
 }
 for(const desired of roster){
  const existing=byCode.get(desired.code)
  if(existing){
   // Existing capacity, area, map, QR version and every FK identity stay intact.
   if(existing.code===desired.code&&existing.display_name===desired.code&&existing.status==='available')continue
   if(existing.status!=='available')throw Error(`Existing desired table ${existing.code} is not available; review before reactivation`)
   const after=(await client.query('UPDATE mbox.tables SET code=$4,display_name=$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3 RETURNING *',[...args,existing.id,desired.code])).rows[0]
   await audit(existing,after,'table.roster.renamed')
  }else{
   const area=areas.find(a=>a.code===desired.areaCode)
   const after=(await client.query(`INSERT INTO mbox.tables(tenant_id,store_id,area_id,code,display_name,capacity,minimum_spend_minor,currency,layout_snapshot,status)
    VALUES($1,$2,$3,$4,$4,$5,0,'CNY','{}','available') RETURNING *`,[...args,area.id,desired.code,desired.capacity])).rows[0]
   await audit(null,after,'table.roster.created')
  }
 }
 for(const existing of tables){
  if(desiredCodes.has(normalizedTableCode(existing.code))||existing.status==='retired')continue
  const blockers=(await client.query(`SELECT
   (SELECT count(*)::int FROM mbox.table_sessions WHERE tenant_id=$1 AND store_id=$2 AND table_id=$3 AND status IN ('open','closing')) AS visits,
   (SELECT count(*)::int FROM mbox.reservation_table_locks WHERE tenant_id=$1 AND store_id=$2 AND table_id=$3 AND upper(reserved_during)>clock_timestamp()
     AND (status='confirmed' OR (status='held' AND hold_expires_at>clock_timestamp()))) AS reservations`,[...args,existing.id])).rows[0]
  if(blockers.visits||blockers.reservations){deferred.push({code:existing.code,...blockers});continue}
  const after=(await client.query("UPDATE mbox.tables SET status='retired' WHERE tenant_id=$1 AND store_id=$2 AND id=$3 RETURNING *",[...args,existing.id])).rows[0]
  await audit(existing,after,'table.roster.retired')
 }
 const desired=(await client.query("SELECT id,code,display_name,capacity,status FROM mbox.tables WHERE tenant_id=$1 AND store_id=$2 AND code=ANY($3::text[]) ORDER BY code",[...args,[...desiredCodes]])).rows
 if(desired.length!==roster.length||desired.some(t=>t.status!=='available'))throw Error('Desired roster readback mismatch')
 return {desiredCount:desired.length,changes,deferred,desired}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const argv=process.argv.slice(2),apply=argv.includes('--apply'),file=argv.find(x=>!x.startsWith('--'))
 if(!file||argv.some(x=>x.startsWith('--')&&x!=='--apply'))throw Error('Usage: node reconcile-table-roster.mjs roster.json [--apply]')
 const roster=JSON.parse(await readFile(file,'utf8'))
 const scope={tenantId:process.env.MBOX_TENANT_ID,storeId:process.env.MBOX_STORE_ID}
 if(!scope.tenantId||!scope.storeId||!process.env.DATABASE_URL)throw Error('Scoped runtime database configuration required')
 const client=new pg.Client({connectionString:process.env.DATABASE_URL,statement_timeout:8000,application_name:'mbox-table-roster-20260925'})
 await client.connect()
 try{
  await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='1s'")
  await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.store_id',$2,true)",[scope.tenantId,scope.storeId])
  const result=await reconcileTableRoster(client,scope,roster)
  const again=await reconcileTableRoster(client,scope,roster)
  if(again.changes.length)throw Error('Roster operation is not idempotent')
  await client.query(apply?'COMMIT':'ROLLBACK')
  console.log(JSON.stringify({mode:apply?'committed':'preview_rolled_back',...result,repeatedChanges:again.changes.length}))
 }catch(error){await client.query('ROLLBACK');throw error}finally{await client.end()}
}
