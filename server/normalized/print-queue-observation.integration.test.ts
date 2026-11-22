import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'
import { recordQueueObservations } from './print-queue-observation.js'

const url=process.env.TEST_NORMALIZED_DATABASE_URL
describe.skipIf(!url)('scoped Windows queue observations',()=>{
  const scope={tenantId:randomUUID(),storeId:randomUUID()}
  const bridge=randomUUID()
  let pool:Pool,runner:ScopedPostgresTransactionRunner
  beforeAll(async()=>{
    await runNormalizedMigrations(url!)
    pool=new Pool({connectionString:url})
    runner=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'queue fixture')",[scope.tenantId,'probe-'+scope.tenantId])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'fixture','queue fixture')",[scope.storeId,scope.tenantId])
    await pool.query("INSERT INTO mbox.print_bridges(id,tenant_id,store_id,public_id,name,secret_hash,hostname,software_version) VALUES($1,$2,$3,$4,'fixture',repeat('a',64),'fixture','1.0.14')",[bridge,scope.tenantId,scope.storeId,'print-bridge-'+bridge])
    await pool.query("INSERT INTO mbox.devices(tenant_id,store_id,code,name,device_type,print_bridge_id,windows_queue_name,print_profile) VALUES($1,$2,'bar','test','printer',$3,'bar','escpos_80')",[scope.tenantId,scope.storeId,bridge])
  })
  afterAll(async()=>pool?.end())
  it('stores only the bound queue, ignores invalid, stale and out-of-order reports, and preserves a read failure',async()=>{
    const report={queue:'bar',checkedAt:new Date(Date.now()-5000).toISOString(),readable:true,error:null,printerStatus:'Paused',driver:'test',port:'test',count:1,truncated:false,
      jobs:[{documentHash:'f'.repeat(64),id:9,status:'Paused',submittedAt:null}]}
    const send=(input:unknown)=>runner.run(scope,async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime')
      return recordQueueObservations(tx,bridge,input)
    })
    const read=async()=> (await pool.query('SELECT observation FROM mbox.print_queue_observations WHERE bridge_id=$1',[bridge])).rows.map(r=>r.observation)
    expect(await send([report,{...report,queue:'unbound'}])).toEqual(['bar'])
    expect(await read()).toEqual([report])
    await send([{...report,checkedAt:new Date(Date.now()-60000).toISOString(),count:0,jobs:[]}])
    await send([{...report,checkedAt:new Date(Date.now()+3600000).toISOString()}])
    await send([{...report,unexpected:'invalid field'}])
    expect(await read()).toEqual([report])
    const failed={...report,checkedAt:new Date().toISOString(),readable:false,error:'queue_read_failed',count:null,jobs:[]}
    await send([failed])
    expect(await read()).toEqual([failed])
  })
})
