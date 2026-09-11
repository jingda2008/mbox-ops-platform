import pg from 'pg'
import {pathToFileURL} from 'node:url'

// Exact records matched against the retained historical audit and live readback.
// This list intentionally excludes the already handled historical refund.
export const historicalPaymentDisplayAllowlist = [
 ['055a604d-7252-409c-8149-767c545e02a7','2c997dc6-51f7-48ba-bfb1-121df3f537a2',2000],
 ['36d43286-9ff2-4be4-bfef-1c85afe63b50','d1e0e17c-b51d-4ba3-ba83-ba4580ae9872',35600],
 ['b1fb1e9b-4403-42dc-9d94-2a6348a8d7c2','1693b6c5-1df0-472b-ac48-8403a86d2734',35600],
 ['e29ec9b7-ce4d-45a1-8d65-a2204f2a57a9','06c1f2c7-531b-492e-b03e-333449ea378e',2000],
 ['eb7009d3-4878-4f15-beb7-7e9616218da5','c754853a-209b-4abd-9c78-13d40b10a0e9',12800],
]
const action='payment.historical_display_reconciled'
export async function repairHistoricalPaymentDisplays(client,scope) {
 const ids=historicalPaymentDisplayAllowlist.map(row=>row[0])
 // Same order-before-payment lock order as the payment command path.
 await client.query('SELECT id FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE',[scope.tenantId,scope.storeId,historicalPaymentDisplayAllowlist.map(row=>row[1])])
 const before=(await client.query(`SELECT p.id,p.order_id,p.amount_minor::text,p.status,p.retry_released_at,
  o.status AS order_status,o.payment_status,o.business_date::text,t.status AS session_status,s.phase,s.stop_reason
  FROM mbox.payments p JOIN mbox.orders o ON o.tenant_id=p.tenant_id AND o.store_id=p.store_id AND o.id=p.order_id
  JOIN mbox.table_sessions t ON t.tenant_id=o.tenant_id AND t.store_id=o.store_id AND t.id=o.table_session_id
  LEFT JOIN mbox.payment_reconciliation_states s ON s.tenant_id=p.tenant_id AND s.store_id=p.store_id AND s.payment_id=p.id
  WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.id=ANY($3::uuid[]) ORDER BY p.id FOR UPDATE OF p`,[scope.tenantId,scope.storeId,ids])).rows
 if(before.length!==5)throw new Error('Exact five-record scope was not found')
 for(const row of before){
  const expected=historicalPaymentDisplayAllowlist.find(item=>item[0]===row.id)
  if(row.order_id!==expected[1]||Number(row.amount_minor)!==expected[2]||row.status!=='pending'||row.retry_released_at!==null||row.order_status!=='cancelled'||!['pending','unpaid'].includes(row.payment_status)||row.session_status!=='closed'||row.phase!=='stopped'||row.stop_reason!=='finance_review_required')throw new Error('Historical preconditions changed; rollback required')
 }
 const changed=[]
 for(const row of before){
  const facts=(await client.query(`SELECT COALESCE(sum(amount_minor),0)::text amount FROM mbox.order_payment_facts WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3 AND status IN ('succeeded','partially_refunded','refunded')`,[scope.tenantId,scope.storeId,row.order_id])).rows[0]
  if(Number(facts.amount)!==0)throw new Error('Historical order has confirmed funds; separate financial review required')
  if(row.payment_status==='unpaid')continue
  await client.query("UPDATE mbox.orders SET payment_status='unpaid' WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[scope.tenantId,scope.storeId,row.order_id])
  await client.query(`INSERT INTO mbox.audit_events(tenant_id,store_id,actor_type,actor_ref,action,object_type,object_id,before_snapshot,after_snapshot,reason,business_date,metadata)
   VALUES($1,$2,'system','historical-display-repair-20260911',$3,'order',$4,$5::jsonb,$6::jsonb,'已取消订单和已关闭桌次退出营业待办，原未知支付保留财务核对',$7::date,$8::jsonb)`,[scope.tenantId,scope.storeId,action,row.order_id,JSON.stringify({payment_status:row.payment_status}),JSON.stringify({payment_status:'unpaid'}),row.business_date,JSON.stringify({paymentId:row.id,financialFactsUnchanged:true})])
  changed.push(row.order_id)
 }
 return {before,changed}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.slice(2).some(arg=>arg!=='--apply'))throw new Error('Only --apply is supported; default rolls back')
 if(!process.env.DATABASE_URL||!process.env.MBOX_TENANT_ID||!process.env.MBOX_STORE_ID)throw new Error('Scoped database configuration required')
 const scope={tenantId:process.env.MBOX_TENANT_ID,storeId:process.env.MBOX_STORE_ID}
 const client=new pg.Client({connectionString:process.env.DATABASE_URL,statement_timeout:10000});await client.connect()
 try{
  await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='3s'")
  await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.store_id',$2,true)",[scope.tenantId,scope.storeId])
  const schema=(await client.query('SELECT schema_version FROM mbox.normalized_schema_metadata')).rows[0]
  if(Number(schema.schema_version)<196)throw new Error('Deploy schema 196 before repair')
  const result=await repairHistoricalPaymentDisplays(client,scope)
  const again=await repairHistoricalPaymentDisplays(client,scope)
  if(again.changed.length)throw new Error('Repair is not idempotent')
  await client.query(process.argv.includes('--apply')?'COMMIT':'ROLLBACK')
  console.log(JSON.stringify({mode:process.argv.includes('--apply')?'committed':'preview_rolled_back',...result,repeatedChanges:again.changed.length}))
 }catch(error){await client.query('ROLLBACK');throw error}finally{await client.end()}
}
