import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { appendOutboxMessage } from './command-executor.js'
import { HardwareRepository } from './hardware-repository.js'
import { lockPrintTicketPolicy, readPrintTicketPolicies, writePrintTicketPolicy } from './print-ticket-policy-repository.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import type { PrintTicketPolicy } from '../../src/shared/print-ticket-policy.js'

const url=process.env.TEST_NORMALIZED_DATABASE_URL
;(url?describe:describe.skip)('print policy inheritance and legacy compatibility',()=>{
  const scope={tenantId:randomUUID(),storeId:randomUUID()}
  let pool:Pool,runner:ScopedPostgresTransactionRunner,printerId:string
  beforeAll(async()=>{
    await runNormalizedMigrations(url!)
    pool=new Pool({connectionString:url});runner=new ScopedPostgresTransactionRunner(pool)
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Print inheritance')",[scope.tenantId,scope.tenantId])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Print inheritance')",[scope.storeId,scope.tenantId,scope.storeId])
    printerId=await runner.run(scope,async tx=>{
      const repo=new HardwareRepository(tx)
      const device=await repo.createDevice({code:'inherit-printer',name:'继承测试打印机',deviceType:'printer',stationCode:'bar'})
      await repo.upsertPrinterRoute({code:'inherit-route',name:'继承测试路由',stationCode:'bar',printerDeviceId:device.id,copies:3})
      return device.id
    })
  })
  afterAll(async()=>pool?.end())
  const save=(policy:PrintTicketPolicy)=>runner.run(scope,async tx=>{
    await tx.query('SET LOCAL ROLE mbox_runtime')
    await lockPrintTicketPolicy(tx,policy.ticketKind);await writePrintTicketPolicy(tx,policy)
    return (await readPrintTicketPolicies(tx)).find(p=>p.ticketKind===policy.ticketKind)
  })
  const source=()=>runner.run(scope,tx=>appendOutboxMessage(tx,{aggregateType:'store',aggregateId:scope.storeId,
    aggregateVersion:1,eventType:`audit.print.${randomUUID()}`,payload:{}}))
  const materialize=(id:string,kind='bar_production')=>runner.run(scope,async tx=>{
    await tx.query('SET LOCAL ROLE mbox_runtime')
    const repo=new HardwareRepository(tx)
    const jobs=await repo.materializeFromOutbox({sourceOutboxMessageId:id,stationCode:'bar',sourceType:'kds',
      sourceReference:randomUUID(),printSnapshot:{kind,tableCode:'T1',productName:'隔离票据',quantity:1},containsPriorityNote:false})
    return {jobs,skip:repo.lastSkipReason}
  })
  it('keeps route copies on disable/re-enable and can restore inheritance after an explicit override',async()=>{
    expect(await save({ticketKind:'bar_production',enabled:false,copies:null})).toMatchObject({enabled:false,copies:null})
    expect((await pool.query('SELECT enabled,copies FROM mbox.print_ticket_policies WHERE tenant_id=$1',[scope.tenantId])).rows)
      .toEqual([{enabled:false,copies:1}])
    expect((await materialize(await source())).jobs).toHaveLength(0)
    expect(await save({ticketKind:'bar_production',enabled:true,copies:null})).toMatchObject({enabled:true,copies:null})
    expect((await pool.query('SELECT copies FROM mbox.print_ticket_policies WHERE tenant_id=$1',[scope.tenantId])).rows).toEqual([])
    expect((await materialize(await source())).jobs[0].copies).toBe(3)
    await save({ticketKind:'bar_production',enabled:true,copies:2})
    expect((await materialize(await source())).jobs[0].copies).toBe(2)
    await save({ticketKind:'bar_production',enabled:true,copies:null})
    await runner.run(scope,tx=>new HardwareRepository(tx).upsertPrinterRoute({code:'inherit-route',name:'继承测试路由',stationCode:'bar',printerDeviceId:printerId,copies:4}))
    expect((await materialize(await source())).jobs[0].copies).toBe(4)
  })
  it('clears inherited state on legacy integer writes, preserves bounds and isolates stores',async()=>{
    await save({ticketKind:'bar_production',enabled:false,copies:null})
    await runner.run(scope,async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime')
      await tx.query("UPDATE mbox.print_ticket_policies SET enabled=true,copies=2 WHERE tenant_id=$1 AND store_id=$2 AND ticket_kind='bar_production'",[scope.tenantId,scope.storeId])
      expect((await readPrintTicketPolicies(tx)).find(p=>p.ticketKind==='bar_production')).toMatchObject({enabled:true,copies:2})
      expect((await tx.query('SELECT * FROM mbox.print_ticket_policy_inheritance')).rows).toEqual([])
    })
    await expect(pool.query('UPDATE mbox.print_ticket_policies SET copies=0 WHERE tenant_id=$1',[scope.tenantId])).rejects.toThrow()
    await expect(pool.query('UPDATE mbox.print_ticket_policies SET copies=NULL WHERE tenant_id=$1',[scope.tenantId])).rejects.toThrow()
    await save({ticketKind:'bar_production',enabled:false,copies:null})
    await runner.run({tenantId:randomUUID(),storeId:randomUUID()},async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime')
      expect((await tx.query('SELECT * FROM mbox.print_ticket_policy_inheritance')).rows).toEqual([])
    })
  })
  it('retains the old-payment cutoff when returning to route inheritance',async()=>{
    await save({ticketKind:'cashier_payment',enabled:false,copies:null})
    const old=await source()
    // Outbox identity is immutable; move the policy-change time forward instead.
    await new Promise(resolve=>setTimeout(resolve,10))
    await save({ticketKind:'cashier_payment',enabled:true,copies:null})
    expect((await materialize(old,'cashier_payment')).jobs).toEqual([])
    expect((await materialize(await source(),'cashier_payment')).jobs[0].copies).toBe(4)
  })
})
