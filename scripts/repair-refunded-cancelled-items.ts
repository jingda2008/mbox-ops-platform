import { Client } from 'pg'
import { synchronizeRefundedCancelledItem } from '../server/normalized/refunded-fulfillment-repair.js'
import type { ScopedTransaction } from '../server/normalized/transaction-runner.js'

// Explicit historical allowlist; never infer refund or cancellation from a name alone.
const ids = ['ca567ae5-6ff1-4aa9-9cd5-250c456b2828','2b293730-84c9-4fb3-91ca-963d75b19294',
  '8229a863-796a-46fa-976b-c89c81fd37ba','6a4ca2a9-db48-4142-8792-bf51c590a7d9']
const scope = { tenantId:'10000000-0000-4000-8000-000000000001',storeId:'20000000-0000-4000-8000-000000000001' }
const client = new Client({connectionString:process.env.DATABASE_URL,statement_timeout:10_000})
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Only --apply is supported; default is rollback preview')
await client.connect()
try {
  await client.query('BEGIN')
  await client.query("SET LOCAL lock_timeout='3s'")
  const schema = await client.query('SELECT schema_version FROM mbox.normalized_schema_metadata')
  if (!(Number(schema.rows[0]?.schema_version)>=189)) throw new Error('Deploy migration 189 through the release pipeline first')
  await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.store_id',$2,true)",[scope.tenantId,scope.storeId])
  const before=await client.query(`SELECT item.id,item.status,ordering.payment_status,session.status AS session_status
    FROM mbox.order_items item JOIN mbox.orders ordering ON ordering.id=item.order_id
    JOIN mbox.table_sessions session ON session.id=ordering.table_session_id
    WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.id=ANY($3::uuid[]) FOR UPDATE OF item`,[scope.tenantId,scope.storeId,ids])
  if (before.rowCount!==4 || before.rows.some(row=>row.payment_status!=='refunded'||row.session_status!=='closed'||!['submitted','cancelled'].includes(row.status))) {
    throw new Error('Historical preconditions changed; all changes rolled back')
  }
  const transaction={scope,query:client.query.bind(client)} as ScopedTransaction
  const changed: string[]=[]
  for(const id of ids) changed.push(...await synchronizeRefundedCancelledItem(transaction,id))
  const after=await client.query('SELECT id,status FROM mbox.order_items WHERE id=ANY($1::uuid[])',[ids])
  if(after.rows.some(row=>row.status!=='cancelled')) throw new Error('Cancellation evidence incomplete; all changes rolled back')
  await client.query(process.argv.includes('--apply')?'COMMIT':'ROLLBACK')
  console.log(JSON.stringify({mode:process.argv.includes('--apply')?'committed':'preview_rolled_back',changed,before:before.rows,after:after.rows}))
} catch(error) {
  await client.query('ROLLBACK')
  throw error
} finally {await client.end()}
