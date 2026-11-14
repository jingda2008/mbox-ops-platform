import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,it,expect} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'
import {PrintDiagnosticsRepository,type DiagnosticEvent} from './print-diagnostics.js'
const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const suite=databaseUrl?describe:describe.skip
suite('persisted print diagnostics lifecycle',()=>{
 const scope={tenantId:randomUUID(),storeId:randomUUID()}, otherScope={tenantId:randomUUID(),storeId:randomUUID()}
 const bridgeId=randomUUID(),employeeId=randomUUID()
 let pool:Pool,transactions:ScopedPostgresTransactionRunner
 const run=<T>(fn:(r:PrintDiagnosticsRepository)=>Promise<T>)=>transactions.run(scope,tx=>fn(new PrintDiagnosticsRepository(tx)))
 const event=(kind:DiagnosticEvent['kind']='queue_unavailable',at=new Date().toISOString()):DiagnosticEvent=>({eventId:randomUUID(),occurredAt:at,kind})
 beforeAll(async()=>{
  await runNormalizedMigrations(databaseUrl!);pool=new Pool({connectionString:databaseUrl,max:3});transactions=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
  for(const s of [scope,otherScope]){await pool.query('INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,\'diagnostics test\')',[s.tenantId,`diag-${s.tenantId}`]);await pool.query('INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,\'diag\',\'diagnostics test\')',[s.storeId,s.tenantId])}
  await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'diag','Test operator')",[employeeId,scope.tenantId,scope.storeId])
  await pool.query("INSERT INTO mbox.print_bridges(id,tenant_id,store_id,public_id,name,secret_hash,hostname,platform,software_version) VALUES($1,$2,$3,$4,'Diagnostic test',repeat('a',64),'local-test','windows','test')",[bridgeId,scope.tenantId,scope.storeId,`print-bridge-${randomUUID()}`])
 })
 afterAll(async()=>pool?.end())
 it('deduplicates and rejects changed payloads; commits audit and preserves unresolved followup',async()=>{
  const e=event();await run(r=>r.ingest(bridgeId,[e]));await run(r=>r.ingest(bridgeId,[e]));let rows=await run(r=>r.list());const incident=rows.find(r=>r.kind==='queue_unavailable')!;expect(incident.occurrences).toBe(1)
  await expect(run(r=>r.ingest(bridgeId,[{...e,kind:'recovery_exhausted'}]))).rejects.toThrow('其他内容')
  await run(r=>r.act(String(incident.id),employeeId,'2026-11-14','claim',new Date(incident.episodeStartedAt as string).toISOString()));await run(r=>r.act(String(incident.id),employeeId,'2026-11-14','resolve',new Date(incident.episodeStartedAt as string).toISOString(),'not_printed'))
  rows=await run(r=>r.list());expect(rows.find(r=>r.id===incident.id)).toMatchObject({status:'claimed',resolution:'not_printed'})
  expect(await run(r=>r.act(String(incident.id),employeeId,'2026-11-14','resolve',new Date(incident.episodeStartedAt as string).toISOString(),'not_printed'))).toMatchObject({replayed:true})
  await run(r=>r.act(String(incident.id),employeeId,'2026-11-14','resolve',new Date(incident.episodeStartedAt as string).toISOString(),'device_restored'))
  await run(r=>r.ingest(bridgeId,[event('queue_unavailable',e.occurredAt)]));expect((await run(r=>r.list())).find(r=>r.id===incident.id)).toBeUndefined()
  await run(r=>r.ingest(bridgeId,[event('queue_unavailable',new Date(Date.now()+1000).toISOString())]));expect((await run(r=>r.list())).find(r=>r.id===incident.id)).toMatchObject({status:'open',claimedBy:null})
  await expect(run(r=>r.act(String(incident.id),employeeId,'2026-11-14','claim',new Date(incident.episodeStartedAt as string).toISOString()))).rejects.toThrow('新一轮')
  await expect(run(r=>r.act(String(incident.id),employeeId,'2026-11-14','resolve',new Date(incident.episodeStartedAt as string).toISOString(),'device_restored'))).rejects.toThrow('新一轮')
  expect((await run(r=>r.list())).find(r=>r.id===incident.id)).toMatchObject({status:'open',claimedBy:null})
  expect((await pool.query("SELECT count(*)::int n FROM mbox.audit_events WHERE tenant_id=$1 AND object_id=$2",[scope.tenantId,incident.id])).rows[0].n).toBe(3)
 })
 it('cannot close offline incident until a recent active heartbeat is present',async()=>{
  const offlineId=randomUUID()
  await pool.query("INSERT INTO mbox.print_incidents(id,tenant_id,store_id,bridge_id,incident_key,kind,first_seen_at,last_seen_at) VALUES($1,$2,$3,$4,'bridge:bridge_offline','bridge_offline',clock_timestamp(),clock_timestamp())",[offlineId,scope.tenantId,scope.storeId,bridgeId])
  const incident=(await run(r=>r.list())).find(r=>r.id===offlineId)!
  const episode=new Date(incident.episodeStartedAt as string).toISOString()
  await run(r=>r.act(offlineId,employeeId,'2026-11-14','claim',episode))
  await expect(run(r=>r.act(offlineId,employeeId,'2026-11-14','resolve',episode,'paper_confirmed'))).rejects.toThrow('不可用纸票')
  await expect(run(r=>r.act(offlineId,employeeId,'2026-11-14','resolve',episode,'device_restored'))).rejects.toThrow('有效心跳')
  expect((await run(r=>r.list())).find(r=>r.id===offlineId)).toMatchObject({status:'claimed'})
  await pool.query('UPDATE mbox.print_bridges SET last_seen_at=clock_timestamp() WHERE id=$1',[bridgeId])
  expect(await run(r=>r.act(offlineId,employeeId,'2026-11-14','resolve',episode,'device_restored'))).toMatchObject({status:'resolved'})
 })
 it('does not expose incidents across scopes',async()=>{expect(await transactions.run(otherScope,tx=>new PrintDiagnosticsRepository(tx).list())).toEqual([])})
 it('records skew and lost diagnostic counts without claiming physical paper',async()=>{
  const e={...event('diagnostic_gap','2099-01-01T00:00:00.000Z'),gapCount:5};await run(r=>r.ingest(bridgeId,[e]));const stored=(await pool.query('SELECT clock_skew,gap_count FROM mbox.print_diagnostic_events WHERE event_id=$1',[e.eventId])).rows[0];expect(stored).toEqual({clock_skew:true,gap_count:5})
  const rows=await run(r=>r.list());expect(new Date(String(rows.find(r=>r.kind==='diagnostic_gap')!.firstSeenAt)).getTime()).toBeLessThan(Date.now()+1000)
 })
 it('runs offline reconciliation without an open browser and keeps incident state when pruning old events',async()=>{
  await run(r=>r.reconcileHealth());const e=event('submission_failed','2000-01-01T00:00:00.000Z');await run(r=>r.ingest(bridgeId,[e]));await pool.query("UPDATE mbox.print_diagnostic_events SET received_at=clock_timestamp()-interval '31 days' WHERE event_id=$1",[e.eventId]);await run(r=>r.pruneEvents());expect((await pool.query('SELECT event_id FROM mbox.print_diagnostic_events WHERE event_id=$1',[e.eventId])).rowCount).toBe(0);expect((await run(r=>r.list())).some(r=>r.kind==='submission_failed')).toBe(true)
 })
})
