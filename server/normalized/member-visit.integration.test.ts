import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { ScopedPostgresTransactionRunner, type ScopedTransaction } from './transaction-runner.js'
import { MemberVisitRepository } from './member-visit-repository.js'
import { NormalizedCommandExecutor, type JsonCodec } from './command-executor.js'
import type { MemberVisit } from '../../src/shared/member-visit.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
const tenantId=randomUUID(),storeId=randomUUID(),otherStoreId=randomUUID(),employeeId=randomUUID()
const customerId=randomUUID(),secondCustomerId=randomUUID(),mergedId=randomUUID()
const scope={tenantId,storeId},day='2026-09-26',member='MBX-VISIT001',second='MBX-VISIT002'
const codec:JsonCodec<MemberVisit>={encode:value=>JSON.parse(JSON.stringify(value)),decode:value=>value as MemberVisit}

integration('member visit PostgreSQL attendance boundaries',()=>{
  let pool:Pool,runner:ScopedPostgresTransactionRunner
  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    pool=new Pool({connectionString:databaseUrl,max:8});runner=new ScopedPostgresTransactionRunner(pool)
    await pool.query('INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,$2)',[tenantId,`visit-${tenantId}`])
    for(const id of [storeId,otherStoreId])await pool.query('INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,$3)',[id,tenantId,`visit-${id}`])
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'VISIT','签到员工')",[employeeId,tenantId,storeId])
    for(const [id,no] of [[customerId,member],[secondCustomerId,second],[mergedId,'MBX-VISITOLD']]){
      await pool.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)',[id,tenantId,storeId,`visit-${id}`])
      await pool.query('INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no) VALUES($1,$2,$3,$4)',[tenantId,storeId,id,no])
    }
  },30000)
  afterAll(async()=>{await pool?.end()})
  function run<T>(operation:(repo:MemberVisitRepository,tx:ScopedTransaction)=>Promise<T>,readOnly=false){
    return runner.run(scope,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');return operation(new MemberVisitRepository(tx),tx)},{readOnly})
  }
  it('concurrent scans create only one attendance without activity, benefit or reward facts',async()=>{
    const results=await Promise.all(Array.from({length:6},()=>run(repo=>repo.checkIn(member,day,employeeId))))
    expect(new Set(results.map(result=>result.visit.id)).size).toBe(1)
    expect(results.filter(result=>result.changed)).toHaveLength(1)
    const current=await run(repo=>repo.current(member,day),true)
    expect(current).toMatchObject({businessDate:day,employeeName:'签到员工',status:'checked_in'})
    for(const table of ['community_activity_registrations','benefits','loyalty_promotion_trigger_facts']){
      const rows=await pool.query(`SELECT count(*)::int AS count FROM mbox.${table} WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId])
      expect(rows.rows[0].count).toBe(0)
    }
  })
  it('uses a separate business date and records only one entry per date',async()=>{
    const previous=await run(repo=>repo.current(member,day),true)
    const next=await run(repo=>repo.checkIn(member,'2026-09-27',employeeId))
    expect(next.visit.id).not.toBe(previous!.id)
    expect((await run(repo=>repo.current(member,day),true))!.id).toBe(previous!.id)
  })
  it('cancels only the original record, preserves history, and does not undo a later re-check-in',async()=>{
    const original=await run(repo=>repo.current(member,day),true)
    await expect(run(repo=>repo.cancel(second,day,original!.id,employeeId,'错会员'))).rejects.toMatchObject({code:'MEMBER_VISIT_NOT_FOUND'})
    await run(repo=>repo.cancel(member,day,original!.id,employeeId,'误签到撤回'))
    expect(await run(repo=>repo.current(member,day),true)).toBeNull()
    const newer=await run(repo=>repo.checkIn(member,day,employeeId))
    expect(newer.visit.id).not.toBe(original!.id)
    const repeatedCancel=await run(repo=>repo.cancel(member,day,original!.id,employeeId,'重试原撤回'))
    expect(repeatedCancel.changed).toBe(false)
    expect((await run(repo=>repo.current(member,day),true))!.id).toBe(newer.visit.id)
    const history=await pool.query('SELECT cancelled_at,cancel_reason FROM mbox.member_visit_checkins WHERE id=$1',[original!.id])
    expect(history.rows[0].cancel_reason).toBe('误签到撤回')
  })
  it('blocks cross-store membership lookup and row visibility for runtime role',async()=>{
    await expect(runner.run({tenantId,storeId:otherStoreId},async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime')
      expect((await tx.query('SELECT id FROM mbox.member_visit_checkins')).rows).toEqual([])
      return new MemberVisitRepository(tx).checkIn(member,day,employeeId)
    })).rejects.toThrow()
  })
  it('keeps an existing merged-customer visit instead of counting another attendance',async()=>{
    const old=await run(repo=>repo.checkIn('MBX-VISITOLD',day,employeeId))
    await pool.query("UPDATE mbox.customers SET status='merged',merged_into_customer_id=$1 WHERE id=$2",[secondCustomerId,mergedId])
    const result=await run(repo=>repo.checkIn(second,day,employeeId))
    expect(result.changed).toBe(false);expect(result.visit.id).toBe(old.visit.id)
  })
  it('retains command receipt and a single audit when the same successful request is retried',async()=>{
    const commands=new NormalizedCommandExecutor(runner),key=`visit-${randomUUID()}`
    const execute=()=>commands.execute({scope,operationScope:'member.visit.check-in',idempotencyKey:key,requestFingerprint:'visit-key-bound-to-original-member-and-day',resultCodec:codec},async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime')
      const result=await new MemberVisitRepository(tx).checkIn(member,'2026-09-28',employeeId)
      return {result:result.visit,auditEvents:[{actor:{type:'employee' as const,employeeId},businessDate:'2026-09-28',action:'member.visit.check-in',objectType:'member_visit_checkin',objectId:result.visit.id,reason:'测试现场确认到店'}],outboxMessages:[]}
    })
    const initial=await execute(),retry=await execute()
    expect(retry.replayed).toBe(true);expect(retry.value.id).toBe(initial.value.id)
    const audit=await pool.query('SELECT count(*)::int AS count FROM mbox.audit_events WHERE tenant_id=$1 AND store_id=$2 AND object_id=$3',[tenantId,storeId,initial.value.id])
    expect(audit.rows[0].count).toBe(1)
  })
  it('does not allow disabled memberships or mutation of original attendance identity',async()=>{
    await pool.query("UPDATE mbox.customer_memberships SET status='suspended' WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3",[tenantId,storeId,customerId])
    await expect(run(repo=>repo.checkIn(member,'2026-09-29',employeeId))).rejects.toThrow()
    await pool.query("UPDATE mbox.customer_memberships SET status='active' WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3",[tenantId,storeId,customerId])
    await expect(run(async(_repo,tx)=>tx.query('UPDATE mbox.member_visit_checkins SET customer_id=$1',[secondCustomerId]))).rejects.toMatchObject({code:'42501'})
    await expect(run(async(_repo,tx)=>tx.query("UPDATE mbox.member_visit_checkins SET cancel_reason='改写原因' WHERE cancelled_at IS NOT NULL"))).rejects.toMatchObject({code:'23514'})
  })
})
