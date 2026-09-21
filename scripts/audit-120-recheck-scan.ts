import {randomUUID} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {Pool} from 'pg'
import {CustomerRepository} from '../server/normalized/customer-repository.js'
import {GuestSessionService,hashTableQrCredential} from '../server/normalized/guest-session-repository.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from '../server/normalized/transaction-runner.js'

const url=process.env.TEST_NORMALIZED_DATABASE_URL
if(!url||new URL(url).hostname!=='127.0.0.1'||new URL(url).pathname!=='/mbox120_recheck_guest')throw new Error('Requires dedicated local mbox120_recheck_guest audit database')
const pool=new Pool({connectionString:url,max:12})
const wrapped:PostgresPool={connect:async()=>{const client=await pool.connect();return{query:(sql,values)=>client.query(sql,values?[...values]:undefined),release:error=>client.release(error)}},end:()=>pool.end()}
const runner=new ScopedPostgresTransactionRunner(wrapped)
const secret='a120-local-scan-contention-secret-more-than-32-characters'
const results:any[]=[]
try{
  for(const scenario of [
    {name:'12_same_table_anonymous_parallel',tables:1,parallel:true,known:false},
    {name:'12_distinct_tables_anonymous_parallel',tables:12,parallel:true,known:false},
    {name:'12_distinct_tables_known_parallel',tables:12,parallel:true,known:true},
    {name:'12_distinct_tables_anonymous_sequential',tables:12,parallel:false,known:false},
  ]){
    const tenantId=randomUUID(),storeId=randomUUID(),areaId=randomUUID(),scope={tenantId,storeId},tokens:string[]=[],customers:string[]=[]
    await pool.query(`INSERT INTO mbox.tenants(id,code,name)VALUES($1,$2,'scan contention audit')`,[tenantId,`scan-${tenantId}`])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff)VALUES($1,$2,$3,'scan contention audit','Asia/Shanghai','06:00')`,[storeId,tenantId,`scan-${storeId}`])
    await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)VALUES($1,$2,$3,'SC','Scan','indoor')`,[areaId,tenantId,storeId])
    for(let i=0;i<scenario.tables;i++){
      const tableId=randomUUID(),sessionId=randomUUID(),token=`audit-scan-${randomUUID()}`
      tokens.push(token)
      await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity,qr_version)VALUES($1,$2,$3,$4,$5,$5,12,1)`,[tableId,tenantId,storeId,areaId,`SC${i+1}`])
      await pool.query(`INSERT INTO mbox.table_qr_credentials(tenant_id,store_id,table_id,qr_version,credential_hash)VALUES($1,$2,$3,1,$4)`,[tenantId,storeId,tableId,hashTableQrCredential(secret,scope,token)])
      await pool.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status)VALUES($1,$2,$3,$4,$5,'2026-09-21',12,'open')`,[sessionId,tenantId,storeId,tableId,`scan-${sessionId}`])
    }
    if(scenario.known)for(let i=0;i<12;i++){
      const customerId=randomUUID();customers.push(customerId)
      await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id)VALUES($1,$2,$3,$4)`,[customerId,tenantId,storeId,`scan-${customerId}`])
    }
    const scan=async(i:number)=>{
      let attempts=0
      const trackingRunner={run:(scope:any,operation:any,options:any)=>runner.run(scope,transaction=>{attempts++;return operation(transaction)},options)}
      const service=new GuestSessionService(trackingRunner,{resolveAnonymous:async({transaction,identityHash,publicId})=>{
        const result=await new CustomerRepository(transaction).createAnonymous({publicId,identityHash});return {customerId:result.customer.id}
      }},secret)
      const start=performance.now()
      try{
        const result=await service.scanTable({scope,tableQrToken:tokens[i%scenario.tables]!,deviceFingerprint:`scan-audit-${scenario.name}-${i}`,businessDate:'2026-09-21',...(scenario.known?{customerId:customers[i]}:{})})
        return {guest:i,table:i%scenario.tables,status:result.status,attempts,ms:Math.round(performance.now()-start)}
      }catch(error:any){return {guest:i,table:i%scenario.tables,status:'error',code:error.code,message:error.message,attempts,ms:Math.round(performance.now()-start)}}
    }
    const rows:any[]=[]
    if(scenario.parallel)rows.push(...await Promise.all(Array.from({length:12},(_,i)=>scan(i))))
    else for(let i=0;i<12;i++)rows.push(await scan(i))
    const data={scenario:scenario.name,success:rows.filter(row=>row.status==='active'||row.status==='already_active').length,errors:rows.filter(row=>row.status==='error').length,attempts:rows.reduce((sum,row)=>sum+row.attempts,0),rows}
    results.push(data);console.log(JSON.stringify(data))
  }
  await writeFile('/Users/jingda/mbox/outputs/120-guests-recheck-20260921/guest/scan-contention.json',JSON.stringify({source:'f8306c7718e011f451af5f0eb29f0e8e16dbd532',mode:'real-service-postgres-synthetic-tables',pool:12,results},null,2))
}finally{await pool.end()}
