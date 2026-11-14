import { PrintSourceWorker } from './print-source-worker.js'
import { describe,it,expect,vi } from 'vitest'
import { readFileSync } from 'node:fs'
import Fastify from 'fastify'
import { readDiagnosticEvents,PrintDiagnosticsRepository } from './print-diagnostics.js'
import { printBridgeApiPlugin } from './print-bridge-api.js'
import type { PrintBridgeRepository } from './print-bridge-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'
const id='11111111-1111-4111-8111-111111111111'
const other='22222222-2222-4222-8222-222222222222'
const scope={tenantId:id,storeId:other}
const event={eventId:id,occurredAt:'2026-11-14T01:00:00.000Z',kind:'print_ambiguous'}
const valid=()=>readDiagnosticEvents([event],Date.parse('2026-11-14T02:00:00Z'))
describe('print diagnostic privacy contract',()=>{
 it('accepts bounded structured event',()=>expect(valid()).toEqual([event]))
 it.each([{ticket:'secret'},{message:'password'},{path:'C:/secret'},{authorization:'Bearer secret'},{jobId:'bad'},{kind:'physical_paper_confirmed'},{failureCode:'full command line'},{durationMs:-1},{durationMs:86400001},{occurredAt:'not a date'}])('rejects forbidden content %j',patch=>expect(()=>readDiagnosticEvents([{...event,...patch}])).toThrow())
 it('accepts future clock without blocking queue',()=>expect(readDiagnosticEvents([{...event,occurredAt:'2099-01-01T00:00:00Z'}])).toHaveLength(1))
 it('rejects empty and oversized batches',()=>{expect(()=>readDiagnosticEvents([])).toThrow();expect(()=>readDiagnosticEvents(Array(51).fill(event))).toThrow()})
})
function tx(query=vi.fn()){return {scope,query} as unknown as ScopedTransaction}
describe('print diagnostic storage',()=>{
 it('checks bridge ownership before accepting job event',async()=>{const q=vi.fn().mockResolvedValue({rows:[],rowCount:0});await expect(new PrintDiagnosticsRepository(tx(q)).ingest(id,[{...valid()[0],jobId:other}])).rejects.toThrow('不属于');expect(q).toHaveBeenCalledTimes(1)})
 it('deduplicates exact events without adding occurrences',async()=>{const q=vi.fn().mockResolvedValueOnce({rows:[],rowCount:0}).mockResolvedValueOnce({rows:[{same:true}],rowCount:1});expect(await new PrintDiagnosticsRepository(tx(q)).ingest(id,valid())).toEqual({acceptedEventIds:[id]});expect(q).toHaveBeenCalledTimes(2)})
 it('rejects reused id with changed content',async()=>{const q=vi.fn().mockResolvedValueOnce({rows:[],rowCount:0}).mockResolvedValueOnce({rows:[{same:false}],rowCount:1});await expect(new PrintDiagnosticsRepository(tx(q)).ingest(id,valid())).rejects.toThrow('其他内容')})
 it('accepted spool event does not resolve incidents',async()=>{const q=vi.fn().mockResolvedValue({rows:[],rowCount:1});await new PrintDiagnosticsRepository(tx(q)).ingest(id,[{...valid()[0],kind:'spool_accepted'}]);expect(q).toHaveBeenCalledTimes(1);expect(q.mock.calls[0][0]).not.toContain('print_incidents')})
 it('old events cannot reopen resolved job incidents',async()=>{const q=vi.fn().mockResolvedValue({rows:[],rowCount:1});await new PrintDiagnosticsRepository(tx(q)).ingest(id,valid());expect(q.mock.calls[1][0]).toContain('mbox.print_incidents.job_id IS NULL AND EXCLUDED.last_seen_at>mbox.print_incidents.resolved_at')})
 it('cannot claim another employees incident',async()=>{const q=vi.fn().mockResolvedValue({rows:[{status:'claimed',claimed_by:other,episode_started_at:event.occurredAt}],rowCount:1});await expect(new PrintDiagnosticsRepository(tx(q)).act(id,id,'2026-11-14','claim',event.occurredAt)).rejects.toThrow('其他员工');expect(q).toHaveBeenCalledTimes(1)})
 it('cannot close job uncertainty by restoring a device',async()=>{const q=vi.fn().mockResolvedValue({rows:[{status:'claimed',claimed_by:id,job_id:other,episode_started_at:event.occurredAt}],rowCount:1});await expect(new PrintDiagnosticsRepository(tx(q)).act(id,id,'2026-11-14','resolve',event.occurredAt,'device_restored')).rejects.toThrow('实体纸票')})
 it('rejects prior episode even for the same actor and repeated action',async()=>{const q=vi.fn().mockResolvedValue({rows:[{status:'claimed',claimed_by:id,episode_started_at:'2026-11-14T03:00:00.000Z'}],rowCount:1});await expect(new PrintDiagnosticsRepository(tx(q)).act(id,id,'2026-11-14','claim',event.occurredAt)).rejects.toThrow('新一轮');expect(q).toHaveBeenCalledTimes(1)})
 it('same resolution retry is harmless',async()=>{const q=vi.fn().mockResolvedValue({rows:[{status:'resolved',claimed_by:id,resolution:'not_printed',episode_started_at:event.occurredAt}],rowCount:1});expect(await new PrintDiagnosticsRepository(tx(q)).act(id,id,'2026-11-14','resolve',event.occurredAt,'not_printed')).toMatchObject({replayed:true});expect(q).toHaveBeenCalledTimes(1)})
 it('forces store RLS on diagnostic tables',()=>{const sql=readFileSync('database/normalized-migrations/315_print_diagnostics.sql','utf8');expect(sql).toContain('FORCE ROW LEVEL SECURITY');expect(sql).toContain('store_id=mbox.current_store_id()');expect(sql).toContain('GRANT DELETE ON mbox.print_diagnostic_events');expect(sql).not.toContain('GRANT DELETE ON mbox.print_incidents')})
})
async function appFor(capabilities:string[],repository:Record<string,unknown>){const app=Fastify();await app.register(printBridgeApiPlugin,{prefix:'/api',scope,hashSecret:'test-only',requireHttps:false,resolveStaffContext:()=>({scope,employeeId:id,actor:{type:'employee',employeeId:id},businessDate:'2026-11-14',capabilities}),transactions:{run:async(_scope,fn)=>fn(tx())},createRepository:()=>repository as unknown as PrintBridgeRepository});return app}
describe('diagnostics HTTP boundaries',()=>{
 it('requires bridge credentials',async()=>{const ingestDiagnostics=vi.fn();const app=await appFor([],{ingestDiagnostics});const r=await app.inject({method:'POST',url:'/api/print-bridge/diagnostics',payload:{events:[event]}});expect(r.statusCode).toBe(401);expect(ingestDiagnostics).not.toHaveBeenCalled();await app.close()})
 it('requires staff role to read',async()=>{const listPrintIncidents=vi.fn();const app=await appFor([],{listPrintIncidents});expect((await app.inject('/api/hardware/print-incidents')).statusCode).toBe(403);expect(listPrintIncidents).not.toHaveBeenCalled();await app.close()})
 it('retry-only staff can view but cannot claim',async()=>{const listPrintIncidents=vi.fn().mockResolvedValue([]);const actOnPrintIncident=vi.fn();const app=await appFor(['print.retry'],{listPrintIncidents,actOnPrintIncident});expect((await app.inject('/api/hardware/print-incidents')).statusCode).toBe(200);expect((await app.inject({method:'POST',url:`/api/hardware/print-incidents/${id}/claim`,payload:{expectedEpisodeAt:event.occurredAt}})).statusCode).toBe(403);expect(actOnPrintIncident).not.toHaveBeenCalled();await app.close()})
 it('retry-only staff cannot resolve',async()=>{const app=await appFor(['print.retry'],{});expect((await app.inject({method:'POST',url:`/api/hardware/print-incidents/${id}/resolve`,payload:{resolution:'not_printed'}})).statusCode).toBe(403);await app.close()})
 it('returns acknowledged IDs only after authenticated ingest',async()=>{const ingestDiagnostics=vi.fn().mockResolvedValue({acceptedEventIds:[id]});const app=await appFor([],{authenticate:vi.fn().mockResolvedValue({id,publicId:'bridge'}),ingestDiagnostics});const r=await app.inject({method:'POST',url:'/api/print-bridge/diagnostics',headers:{authorization:'Bearer test','x-mbox-print-bridge-id':'bridge'},payload:{events:[event]}});expect(r.statusCode).toBe(200);expect(r.json()).toEqual({data:{acceptedEventIds:[id]}});await app.close()})
})

describe('bounded diagnostic maintenance',()=>{
 it('reports a fixed code without preventing the following source batch',async()=>{
  let fail=true
  const q=vi.fn(async(sql:string)=>{if(fail&&sql.includes('INSERT INTO mbox.print_incidents'))throw new Error('sensitive database detail');return {rows:[],rowCount:0}})
  const worker=new PrintSourceWorker({run:async(_scope,fn)=>fn(tx(q))})
  await expect(worker.runBatch(scope,'test-worker')).rejects.toThrow(/^print_diagnostics_maintenance_failed$/)
  fail=false
  expect(await worker.runBatch(scope,'test-worker')).toMatchObject({examined:0})
  expect(q.mock.calls.filter(([s])=>s.includes('SELECT id FROM mbox.print_source_jobs'))).toHaveLength(2)
  expect(q.mock.calls.some(([s])=>s==="SET LOCAL lock_timeout='100ms'")).toBe(true)
  expect(q.mock.calls.some(([s])=>s==="SET LOCAL statement_timeout='2s'")).toBe(true)
 })
 it('bounds migration waits and indexes retention scans',()=>{
  const sql=readFileSync('database/normalized-migrations/315_print_diagnostics.sql','utf8')
  expect(sql).toContain("SET LOCAL lock_timeout='3s'")
  expect(sql).toContain("SET LOCAL statement_timeout='30s'")
  expect(sql).toContain('print_diagnostic_events(tenant_id,store_id,received_at)')
 })
})
