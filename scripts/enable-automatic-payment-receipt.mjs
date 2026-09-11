import pg from 'pg'
if(process.argv.slice(2).some(arg=>arg!=='--apply'))throw new Error('Only --apply is supported; default rolls back')
if(!process.env.DATABASE_URL||!process.env.MBOX_TENANT_ID||!process.env.MBOX_STORE_ID)throw new Error('Scoped configuration required')
const client=new pg.Client({connectionString:process.env.DATABASE_URL,statement_timeout:10000})
const scope=[process.env.MBOX_TENANT_ID,process.env.MBOX_STORE_ID]
await client.connect()
try{
 await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='3s'")
 await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.store_id',$2,true)",scope)
 if(Number((await client.query('SELECT schema_version FROM mbox.normalized_schema_metadata')).rows[0]?.schema_version)<196)throw new Error('Deploy the final-development release first')
 const before=(await client.query('SELECT ticket_kind,enabled,copies FROM mbox.print_ticket_policies WHERE tenant_id=$1 AND store_id=$2 ORDER BY ticket_kind FOR UPDATE',scope)).rows
 const payment=before.find(row=>row.ticket_kind==='cashier_payment');if(!payment)throw new Error('Existing payment receipt policy missing')
 const changed=!payment.enabled||payment.copies!==1
 if(changed){
  const after=(await client.query("UPDATE mbox.print_ticket_policies SET enabled=true,copies=1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND ticket_kind='cashier_payment' RETURNING ticket_kind,enabled,copies,updated_at::text",scope)).rows[0]
  await client.query(`INSERT INTO mbox.audit_events(tenant_id,store_id,actor_type,actor_ref,action,object_type,object_id,before_snapshot,after_snapshot,reason,business_date)
   VALUES($1,$2,'system','final-development-20260911','print.payment_receipt.enabled','print_policy','cashier_payment',$3::jsonb,$4::jsonb,'按用户最终需求开启后续实际到账一张收据，历史事件不自动补打',(clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date)`,[...scope,JSON.stringify(payment),JSON.stringify(after)])
 }
 const after=(await client.query('SELECT ticket_kind,enabled,copies FROM mbox.print_ticket_policies WHERE tenant_id=$1 AND store_id=$2 ORDER BY ticket_kind',scope)).rows
 if(JSON.stringify(before.filter(row=>row.ticket_kind!=='cashier_payment'))!==JSON.stringify(after.filter(row=>row.ticket_kind!=='cashier_payment')))throw new Error('Unrelated print policy changed')
 await client.query(process.argv.includes('--apply')?'COMMIT':'ROLLBACK')
 console.log(JSON.stringify({mode:process.argv.includes('--apply')?'committed':'preview_rolled_back',changed,before,after}))
}catch(error){await client.query('ROLLBACK');throw error}finally{await client.end()}
