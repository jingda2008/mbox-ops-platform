import type { ScopedTransaction } from './transaction-runner.js'
import { appendAuditEvent } from './command-executor.js'

export class PrintDiagnosticInputError extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const diagnosticKinds = ['bridge_started','bridge_recovery','submission_started','spool_accepted','submission_failed','print_ambiguous','queue_unavailable','recovery_exhausted','bridge_connection_failed','diagnostic_gap'] as const
const failures = ['powershell_not_found','printer_queue_not_found','printer_unavailable','bridge_print_timeout','printer_spooler_failed','printer_access_denied','invalid_ticket_snapshot','bridge_print_failed','ambiguous_print_result','ambiguous_previous_attempt','bridge_connection_failed','recovery_exhausted']
export interface DiagnosticEvent { eventId:string; occurredAt:string; kind:typeof diagnosticKinds[number]; jobId?:string; durationMs?:number; failureCode?:string; gapCount?:number }
export function readDiagnosticEvents(input:unknown, _now=Date.now()):DiagnosticEvent[] {
 if(!Array.isArray(input)||input.length<1||input.length>50)throw new PrintDiagnosticInputError('诊断批次必须为1至50条')
 return input.map(raw=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new PrintDiagnosticInputError('诊断格式无效')
  const e=raw as Record<string,unknown>
  if(Object.keys(e).some(k=>!['eventId','occurredAt','kind','jobId','durationMs','failureCode','gapCount'].includes(k)))throw new PrintDiagnosticInputError('诊断含不允许的字段')
  if(typeof e.eventId!=='string'||!uuid.test(e.eventId)||typeof e.occurredAt!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(e.occurredAt)||!Number.isFinite(Date.parse(e.occurredAt)))throw new PrintDiagnosticInputError('诊断编号或时间无效')
  if(!diagnosticKinds.includes(e.kind as DiagnosticEvent['kind']))throw new PrintDiagnosticInputError('诊断类型无效')
  if(e.jobId!==undefined&&(typeof e.jobId!=='string'||!uuid.test(e.jobId)))throw new PrintDiagnosticInputError('任务编号无效')
  if(e.durationMs!==undefined&&(!Number.isInteger(e.durationMs)||Number(e.durationMs)<0||Number(e.durationMs)>86400000))throw new PrintDiagnosticInputError('诊断耗时无效')
  if(e.gapCount!==undefined&&(!Number.isInteger(e.gapCount)||Number(e.gapCount)<1||Number(e.gapCount)>1000000))throw new PrintDiagnosticInputError('诊断丢失数量无效')
  if(e.kind==='diagnostic_gap'&&e.gapCount===undefined)throw new PrintDiagnosticInputError('诊断缺失必须记录数量')
  if(e.failureCode!==undefined&&!failures.includes(e.failureCode as string))throw new PrintDiagnosticInputError('诊断错误码无效')
  return {...e,occurredAt:new Date(e.occurredAt).toISOString()} as unknown as DiagnosticEvent
 })
}
const incidentKinds = new Set(['submission_failed','print_ambiguous','queue_unavailable','recovery_exhausted','bridge_connection_failed','diagnostic_gap'])
export class PrintDiagnosticsRepository {
 constructor(private readonly tx:ScopedTransaction){}
 private scope(){return [this.tx.scope.tenantId,this.tx.scope.storeId]}
 async ingest(bridgeId:string,events:DiagnosticEvent[]){
  const acceptedEventIds:string[]=[]
  for(const e of events){
   if(e.jobId){const owns=await this.tx.query(`SELECT id FROM mbox.print_jobs WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND print_bridge_id=$4::uuid`,[...this.scope(),e.jobId,bridgeId]);if(!owns.rowCount)throw new PrintDiagnosticInputError('诊断任务不属于此打印桥')}
   const inserted=await this.tx.query(`INSERT INTO mbox.print_diagnostic_events(tenant_id,store_id,bridge_id,event_id,occurred_at,kind,job_id,duration_ms,failure_code,gap_count,clock_skew) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::timestamptz,$6,$7::uuid,$8,$9,$10,abs(extract(epoch from clock_timestamp()-$5::timestamptz))>300) ON CONFLICT DO NOTHING RETURNING event_id`,[...this.scope(),bridgeId,e.eventId,e.occurredAt,e.kind,e.jobId??null,e.durationMs??null,e.failureCode??null,e.gapCount??null])
   if(!inserted.rowCount){
    const prior=await this.tx.query<{same:boolean}>(`SELECT occurred_at=$5::timestamptz AND kind=$6 AND job_id IS NOT DISTINCT FROM $7::uuid AND duration_ms IS NOT DISTINCT FROM $8::integer AND failure_code IS NOT DISTINCT FROM $9::text AND gap_count IS NOT DISTINCT FROM $10::integer AS same FROM mbox.print_diagnostic_events WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND bridge_id=$3::uuid AND event_id=$4::uuid`,[...this.scope(),bridgeId,e.eventId,e.occurredAt,e.kind,e.jobId??null,e.durationMs??null,e.failureCode??null,e.gapCount??null])
    if(prior.rows[0]?.same!==true)throw new PrintDiagnosticInputError('诊断编号已用于其他内容')
   }
   if(inserted.rowCount&&incidentKinds.has(e.kind)){
    // Delayed telemetry cannot reopen resolved incidents. A fresh device-only fault after resolution may reopen; resolved job incidents never do.
    const key=`${e.jobId??'bridge'}:${e.kind}`
    await this.tx.query(`INSERT INTO mbox.print_incidents(tenant_id,store_id,bridge_id,incident_key,job_id,kind,failure_code,first_seen_at,last_seen_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7,LEAST($8::timestamptz,clock_timestamp()),LEAST($8::timestamptz,clock_timestamp())) ON CONFLICT(tenant_id,store_id,bridge_id,incident_key) DO UPDATE SET first_seen_at=CASE WHEN mbox.print_incidents.status='resolved' THEN EXCLUDED.first_seen_at ELSE LEAST(mbox.print_incidents.first_seen_at,EXCLUDED.first_seen_at) END,episode_started_at=CASE WHEN mbox.print_incidents.status='resolved' THEN GREATEST(clock_timestamp(),mbox.print_incidents.episode_started_at+interval '1 millisecond') ELSE mbox.print_incidents.episode_started_at END,last_seen_at=GREATEST(mbox.print_incidents.last_seen_at,EXCLUDED.last_seen_at),occurrences=mbox.print_incidents.occurrences+1,status=CASE WHEN mbox.print_incidents.status='resolved' THEN 'open' ELSE mbox.print_incidents.status END,claimed_by=CASE WHEN mbox.print_incidents.status='resolved' THEN NULL ELSE mbox.print_incidents.claimed_by END,resolution=CASE WHEN mbox.print_incidents.status='resolved' THEN NULL ELSE mbox.print_incidents.resolution END,resolved_at=CASE WHEN mbox.print_incidents.status='resolved' THEN NULL ELSE mbox.print_incidents.resolved_at END WHERE mbox.print_incidents.status<>'resolved' OR (mbox.print_incidents.job_id IS NULL AND EXCLUDED.last_seen_at>mbox.print_incidents.resolved_at)`,[...this.scope(),bridgeId,key,e.jobId??null,e.kind,e.failureCode??null,e.occurredAt])
   }
   acceptedEventIds.push(e.eventId)
  }
  return {acceptedEventIds}
 }
 async reconcileHealth(){
  // Worker reconciliation persists a stable offline incident even when the bridge cannot report.
  // Only active paired bridges with outstanding work alert; no assumption of opening hours.
  await this.tx.query(`INSERT INTO mbox.print_incidents(tenant_id,store_id,bridge_id,incident_key,kind,first_seen_at,last_seen_at)
   SELECT b.tenant_id,b.store_id,b.id,'bridge:bridge_offline','bridge_offline',COALESCE(b.last_seen_at,b.installed_at)+interval '120 seconds',COALESCE(b.last_seen_at,b.installed_at)+interval '120 seconds'
   FROM mbox.print_bridges b WHERE b.tenant_id=$1::uuid AND b.store_id=$2::uuid AND b.status='active'
   AND COALESCE(b.last_seen_at,b.installed_at)<clock_timestamp()-interval '120 seconds'
   AND EXISTS(SELECT 1 FROM mbox.print_jobs j WHERE j.tenant_id=b.tenant_id AND j.store_id=b.store_id AND j.print_bridge_id=b.id AND j.status IN ('pending','printing','failed'))
   ON CONFLICT(tenant_id,store_id,bridge_id,incident_key) DO UPDATE SET episode_started_at=GREATEST(clock_timestamp(),mbox.print_incidents.episode_started_at+interval '1 millisecond'),status='open',claimed_by=NULL,resolution=NULL,resolved_at=NULL,last_seen_at=EXCLUDED.last_seen_at,first_seen_at=EXCLUDED.first_seen_at
   WHERE mbox.print_incidents.status='resolved' AND EXCLUDED.last_seen_at>mbox.print_incidents.resolved_at`,this.scope())
 }
 async pruneEvents(){
  await this.tx.query(`DELETE FROM mbox.print_diagnostic_events WHERE (tenant_id,store_id,bridge_id,event_id) IN (SELECT tenant_id,store_id,bridge_id,event_id FROM mbox.print_diagnostic_events WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND received_at<clock_timestamp()-interval '30 days' ORDER BY received_at LIMIT 1000)`,this.scope())
 }
 async list(){
  const result=await this.tx.query(`SELECT id,bridge_id AS "bridgeId",job_id AS "jobId",kind,failure_code AS "failureCode",status,first_seen_at AS "firstSeenAt",last_seen_at AS "lastSeenAt",occurrences,claimed_by AS "claimedBy",resolution,episode_started_at AS "episodeStartedAt",CASE WHEN episode_started_at<clock_timestamp()-interval '3 minutes' THEN 'administrator' WHEN claimed_by IS NULL AND episode_started_at<clock_timestamp()-interval '1 minute' THEN 'supervisor' ELSE 'staff' END AS escalation FROM mbox.print_incidents WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status<>'resolved' ORDER BY first_seen_at ASC,id LIMIT 100`,this.scope())
  return result.rows
 }
 async act(id:string,employeeId:string,businessDate:string,action:'claim'|'resolve',expectedEpisodeAt:string,resolution?:string){
  if(typeof expectedEpisodeAt!=='string'||!Number.isFinite(Date.parse(expectedEpisodeAt)))throw new PrintDiagnosticInputError('故障轮次无效，请刷新')
  if(!uuid.test(id))throw new PrintDiagnosticInputError('故障编号无效')
  const found=await this.tx.query<{status:string;claimed_by:string|null;resolution:string|null;job_id:string|null;bridge_id:string;kind:string;episode_started_at:Date|string}>(`SELECT status,claimed_by,resolution,job_id,bridge_id,kind,episode_started_at FROM mbox.print_incidents WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE`,[...this.scope(),id])
  const row=found.rows[0];if(!row)throw new PrintDiagnosticInputError('故障不存在')
  if(new Date(row.episode_started_at).getTime()!==Date.parse(expectedEpisodeAt))throw new PrintDiagnosticInputError('故障已进入新一轮，请刷新后重新确认')
  if(row.claimed_by&&row.claimed_by!==employeeId)throw new PrintDiagnosticInputError('已由其他员工认领')
  if(action==='claim'&&row.status==='claimed')return {id,status:'claimed',replayed:true}
  if(action==='resolve'&&(row.status==='resolved'||row.status==='claimed'&&resolution==='not_printed')&&row.resolution===resolution)return {id,status:row.status,replayed:true}
  if(action==='claim'&&row.status!=='open'||action==='resolve'&&row.status!=='claimed')throw new PrintDiagnosticInputError('故障状态已变化，请刷新')
  if(action==='resolve'&&(!['paper_confirmed','not_printed','device_restored'].includes(resolution??'')||row.job_id&&resolution==='device_restored'))throw new PrintDiagnosticInputError('请核对实体纸票，不可仅按设备恢复关闭订单故障')
  if(action==='resolve'&&row.kind==='bridge_offline'&&resolution!=='device_restored')throw new PrintDiagnosticInputError('失联故障须核验设备恢复，不可用纸票核验代替')
  if(action==='resolve'&&resolution==='device_restored'&&row.kind==='bridge_offline'){
    const live=await this.tx.query(`SELECT id FROM mbox.print_bridges WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='active' AND last_seen_at>=clock_timestamp()-interval '120 seconds'`,[...this.scope(),row.bridge_id])
    if(!live.rowCount)throw new PrintDiagnosticInputError('打印桥仍未恢复有效心跳，不能关闭失联故障')
  }
  const status=action==='claim'||resolution==='not_printed'?'claimed':'resolved'
  await this.tx.query(`UPDATE mbox.print_incidents SET status=$4,claimed_by=$5::uuid,resolution=$6,resolved_at=CASE WHEN $4='resolved' THEN clock_timestamp() ELSE NULL END WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,[...this.scope(),id,status,employeeId,resolution??null])
  await appendAuditEvent(this.tx,{actor:{type:'employee',employeeId},action:`print.incident.${action}`,objectType:'print_incident',objectId:id,businessDate,reason:resolution??'claim',beforeData:{status:row.status},afterData:{status,resolution:resolution??null}})
  return {id,status,replayed:false}
 }
}
