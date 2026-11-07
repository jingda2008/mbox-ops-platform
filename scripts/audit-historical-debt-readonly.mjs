// Execute with the application's environment inside its container. No mutation,
// payment-channel calls or customer contact fields. Save stdout locally.
import pg from 'pg'
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,
  options:'-c default_transaction_read_only=on -c statement_timeout=20000 -c lock_timeout=1000'})
const c=await pool.connect()
try {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  await c.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.store_id',$2,true)",[process.env.MBOX_TENANT_ID,process.env.MBOX_STORE_ID])
  const scope=[process.env.MBOX_TENANT_ID,process.env.MBOX_STORE_ID]
  const environment=(await c.query("SELECT current_setting('transaction_read_only') AS read_only,current_database() AS database,schema_version FROM mbox.normalized_schema_metadata WHERE singleton=true")).rows[0]
  if(environment?.read_only!=='on')throw new Error('Read-only transaction required')
  const rows=(await c.query(`WITH receipts AS (
    SELECT order_id,COALESCE(sum(amount_minor) FILTER(WHERE status IN('succeeded','partially_refunded','refunded')),0)::bigint AS gross,
      count(*) FILTER(WHERE status IN('created','pending'))::int AS unknown_count
    FROM mbox.order_payment_facts WHERE tenant_id=$1 AND store_id=$2 GROUP BY order_id
  ), refunds AS (
    SELECT order_id,COALESCE(sum(amount_minor) FILTER(WHERE status='succeeded'),0)::bigint AS refunded
    FROM mbox.order_refund_facts WHERE tenant_id=$1 AND store_id=$2 GROUP BY order_id
  ), delivered AS (
    SELECT i.order_id,COALESCE(sum(i.total_amount_minor) FILTER(WHERE i.status='delivered'),0)::bigint AS delivered,
      COALESCE(sum(CASE WHEN i.status='delivered' OR EXISTS(SELECT 1 FROM mbox.order_item_quantity_units u
        WHERE (u.tenant_id,u.store_id,u.order_item_id)=(i.tenant_id,i.store_id,i.id)
          AND mbox.quantity_unit_has_delivery(u.tenant_id,u.store_id,u.id))
        THEN mbox.quantity_delivered_item_amount(i.tenant_id,i.store_id,i.id) ELSE 0 END),0)::bigint AS delivery_evidence
    FROM mbox.order_items i WHERE i.tenant_id=$1 AND i.store_id=$2 GROUP BY i.order_id
  ), exceptions AS (
    SELECT DISTINCT ON(order_id) order_id,reason_code,settled_amount_minor,occurred_at
    FROM mbox.order_settlement_exception_events WHERE tenant_id=$1 AND store_id=$2 ORDER BY order_id,occurred_at DESC
  ) SELECT count(*) OVER()::text AS total_candidates,o.id AS order_id,o.public_id,o.business_date::text,
    t.code AS table_code,s.id AS table_session_id,s.closed_at,o.status,o.payment_status,
    o.total_amount_minor::text,mbox.order_receivable_amount(o.tenant_id,o.store_id,o.id)::text AS effective_receivable_minor,
    COALESCE(p.gross,0)::text AS captured_minor,COALESCE(r.refunded,0)::text AS refunded_minor,
    COALESCE(d.delivered,0)::text AS whole_item_delivered_minor,COALESCE(d.delivery_evidence,0)::text AS delivery_evidence_minor,COALESCE(p.unknown_count,0) AS unknown_count,
    e.reason_code AS exception_reason,e.settled_amount_minor::text AS exception_amount_minor,e.occurred_at AS exception_at,
    mbox.order_collection_due_amount(o.tenant_id,o.store_id,o.id)::text AS current_collectible_minor
  FROM mbox.orders o JOIN mbox.table_sessions s ON (s.tenant_id,s.store_id,s.id)=(o.tenant_id,o.store_id,o.table_session_id)
  JOIN mbox.tables t ON (t.tenant_id,t.store_id,t.id)=(s.tenant_id,s.store_id,s.table_id)
  LEFT JOIN receipts p ON p.order_id=o.id LEFT JOIN refunds r ON r.order_id=o.id
  LEFT JOIN delivered d ON d.order_id=o.id LEFT JOIN exceptions e ON e.order_id=o.id
  WHERE o.tenant_id=$1 AND o.store_id=$2 AND s.status='closed' AND o.status<>'draft' AND o.total_amount_minor>0
    AND (COALESCE(p.gross,0)<o.total_amount_minor OR e.order_id IS NOT NULL)
  ORDER BY o.business_date DESC,o.id LIMIT 5000`,scope)).rows
  const groups={}
  for(const row of rows){
    row.classification=row.exception_reason&&!['automatic_cutoff','customer_left'].includes(row.exception_reason)?'approved_exception_do_not_restore'
      :row.unknown_count>0?'payment_unknown_review'
      :BigInt(row.current_collectible_minor)>0n?'existing_collectible_review_receipts'
      :BigInt(row.delivery_evidence_minor)>0n||BigInt(row.exception_amount_minor??'0')>0n?'consumption_evidence_review_offline_receipts'
      :'no_delivery_evidence_review_only'
    groups[row.classification]=(groups[row.classification]??0)+1
  }
  await c.query('ROLLBACK')
  console.log(JSON.stringify({checkedAt:new Date().toISOString(),releaseSha:process.env.APP_COMMIT_SHA,
    readOnly:true,environment,scannedCount:rows.length,totalCandidates:Number(rows[0]?.total_candidates??0),
    truncated:Number(rows[0]?.total_candidates??0)>rows.length,groups,
    limitations:['分类是核对线索，不是客户实际欠款认定；未核对线下实收。','已核对整行与按份送达证据；仍不能排除未录入的现金、POS、外部转账或减免，不据此自动恢复应收。','没有调用任何支付、恢复、减免或写库接口。'],orders:rows},null,2))
} finally {c.release();await pool.end()}
