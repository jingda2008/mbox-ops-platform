import type {ScopedTransaction} from './transaction-runner.js'
/** Counts are separate cohorts. A claim and a visit are not interchangeable,
 * and an unknown item/production cost never becomes a zero-cost profit. */
export async function readChannelReport(tx:ScopedTransaction){
 const scope=[tx.scope.tenantId,tx.scope.storeId]
 // Compute identity and paid-history facts once per scoped report, not once
 // for every batch and every pair of table participants.
 return(await tx.query(`WITH identities AS MATERIALIZED(
  SELECT tenant_id,store_id,table_session_id,mbox.canonical_customer_id(tenant_id,store_id,customer_id) AS customer_id
  FROM mbox.table_session_customer_participations WHERE tenant_id=$1 AND store_id=$2
 ), paid_history AS MATERIALIZED(
  SELECT o.table_session_id,o.created_at,min(p.succeeded_at) AS paid_at FROM mbox.orders o
  JOIN mbox.order_payment_facts p ON (p.tenant_id,p.store_id,p.order_id)=(o.tenant_id,o.store_id,o.id)
  WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.status NOT IN('draft','cancelled')
   AND p.status IN('succeeded','partially_refunded') AND p.provider<>'simulation'
  GROUP BY o.id,o.table_session_id,o.created_at
 ), returning_visits AS MATERIALIZED(
  SELECT DISTINCT v.id FROM mbox.channel_visits v
  JOIN mbox.channel_visit_tables t ON (t.tenant_id,t.store_id,t.visit_id)=(v.tenant_id,v.store_id,COALESCE(v.reporting_root_id,v.id))
  JOIN identities current_customer ON (current_customer.tenant_id,current_customer.store_id,current_customer.table_session_id)=(t.tenant_id,t.store_id,t.table_session_id)
  JOIN identities prior_customer ON (prior_customer.tenant_id,prior_customer.store_id,prior_customer.customer_id)=(current_customer.tenant_id,current_customer.store_id,current_customer.customer_id)
  JOIN paid_history old_order ON old_order.table_session_id=prior_customer.table_session_id
  WHERE v.tenant_id=$1 AND v.store_id=$2 AND prior_customer.table_session_id<>current_customer.table_session_id
   AND old_order.created_at<v.opened_at AND old_order.paid_at<v.opened_at
 ) SELECT b.id,b.offer_code AS "offerCode",b.rule_snapshot->>'title' AS title,r.name AS "promoterName",
  (SELECT count(*)::integer FROM mbox.channel_claims q WHERE (q.tenant_id,q.store_id,q.batch_id)=(b.tenant_id,b.store_id,b.id) AND NOT q.voided AND q.entry='staff') AS "staffClaims",
  (SELECT count(*)::integer FROM mbox.channel_claims q WHERE (q.tenant_id,q.store_id,q.batch_id)=(b.tenant_id,b.store_id,b.id) AND NOT q.voided AND q.entry='self') AS "selfClaims",
  (SELECT count(DISTINCT COALESCE(v.reporting_root_id,v.id))::integer FROM mbox.channel_visits v WHERE (v.tenant_id,v.store_id,v.source_batch_id)=(b.tenant_id,b.store_id,b.id) AND v.arrival_confirmed_at IS NOT NULL) AS "arrivedVisits",
  (SELECT count(DISTINCT COALESCE(v.reporting_root_id,v.id))::integer FROM mbox.channel_visits v WHERE (v.tenant_id,v.store_id,v.source_batch_id)=(b.tenant_id,b.store_id,b.id) AND (v.source_review_required OR EXISTS(SELECT 1 FROM mbox.channel_visit_tables t JOIN mbox.reservation_seating_sessions seating ON (seating.tenant_id,seating.store_id,seating.table_session_id)=(t.tenant_id,t.store_id,t.table_session_id) WHERE (t.tenant_id,t.store_id,t.visit_id)=(v.tenant_id,v.store_id,COALESCE(v.reporting_root_id,v.id))))) AS "priorReservationVisits",
  (SELECT count(DISTINCT COALESCE(v.reporting_root_id,v.id))::integer FROM mbox.channel_visits v WHERE (v.tenant_id,v.store_id,v.source_batch_id)=(b.tenant_id,b.store_id,b.id) AND EXISTS(SELECT 1 FROM returning_visits prior_visit WHERE prior_visit.id=v.id)) AS "knownReturningVisits",
  COALESCE((SELECT sum(p.net_basis_minor) FROM mbox.channel_financial_positions p WHERE (p.tenant_id,p.store_id,p.batch_id)=(b.tenant_id,b.store_id,b.id)),0)::text AS "qualifiedMinor",
  COALESCE((SELECT sum(p.commission_minor) FROM mbox.channel_financial_positions p WHERE (p.tenant_id,p.store_id,p.batch_id)=(b.tenant_id,b.store_id,b.id)),0)::text AS "commissionMinor",
  COALESCE((SELECT sum((o->>'netReceipt')::bigint) FROM mbox.channel_financial_positions p CROSS JOIN LATERAL jsonb_array_elements(p.evidence) o WHERE (p.tenant_id,p.store_id,p.batch_id)=(b.tenant_id,b.store_id,b.id)),0)::text AS "netReceiptsMinor",
  (SELECT min(p.checked_at)::text FROM mbox.channel_financial_positions p WHERE (p.tenant_id,p.store_id,p.batch_id)=(b.tenant_id,b.store_id,b.id)) AS "checkedAt",
  EXISTS(SELECT 1 FROM mbox.channel_visits v LEFT JOIN mbox.channel_financial_positions p ON (p.tenant_id,p.store_id,p.visit_id)=(v.tenant_id,v.store_id,v.id) WHERE (v.tenant_id,v.store_id,v.source_batch_id)=(b.tenant_id,b.store_id,b.id) AND (p.visit_id IS NULL OR p.frozen OR clock_timestamp()-p.checked_at>interval '60 seconds')) AS pending,
  costs.amount AS "costMinor",costs.missing AS "missingCostItems"
 FROM mbox.channel_batches b JOIN mbox.channel_promoters r ON (r.tenant_id,r.store_id,r.id)=(b.tenant_id,b.store_id,b.promoter_id)
 LEFT JOIN LATERAL(SELECT CASE WHEN count(*) FILTER(WHERE value IS NULL)>0 THEN NULL ELSE COALESCE(sum(value),0)::text END AS amount,count(*) FILTER(WHERE value IS NULL)::integer AS missing FROM(
  SELECT CASE
   WHEN EXISTS(SELECT 1 FROM mbox.inventory_movements m WHERE (m.tenant_id,m.store_id,m.order_item_id)=(i.tenant_id,i.store_id,i.id)) THEN
    (SELECT CASE WHEN count(*) FILTER(WHERE m.unit_cost_minor IS NULL)>0 THEN NULL ELSE round(-sum(m.quantity_delta*m.unit_cost_minor)) END FROM mbox.inventory_movements m WHERE (m.tenant_id,m.store_id,m.order_item_id)=(i.tenant_id,i.store_id,i.id))
   WHEN i.status='delivered' AND i.product_snapshot->>'inventoryControlMode'='not_managed' AND i.cost_source<>'included_in_parent' THEN i.total_cost_minor_at_submission
   WHEN i.status='cancelled' AND NOT EXISTS(SELECT 1 FROM mbox.kds_tasks k JOIN mbox.kds_task_events e ON (e.tenant_id,e.store_id,e.kds_task_id)=(k.tenant_id,k.store_id,k.id) WHERE (k.tenant_id,k.store_id,k.order_item_id)=(i.tenant_id,i.store_id,i.id) AND e.to_status IN('preparing','ready')) THEN 0
   ELSE NULL END AS value
  FROM mbox.channel_effective_attributions a JOIN mbox.order_items i ON (i.tenant_id,i.store_id,i.order_id)=(a.tenant_id,a.store_id,a.order_id)
  WHERE (a.tenant_id,a.store_id,a.batch_id)=(b.tenant_id,b.store_id,b.id)
   AND NOT EXISTS(SELECT 1 FROM mbox.order_items child WHERE (child.tenant_id,child.store_id,child.parent_order_item_id)=(i.tenant_id,i.store_id,i.id))
   AND NOT EXISTS(SELECT 1 FROM mbox.order_payment_facts p WHERE (p.tenant_id,p.store_id,p.order_id)=(a.tenant_id,a.store_id,a.order_id) AND p.provider='simulation')
 ) item_costs) costs ON true
 WHERE b.tenant_id=$1 AND b.store_id=$2 ORDER BY b.created_at DESC,b.id LIMIT 500`,scope)).rows.map(r=>({...r,contributionMinor:r.pending||r.costMinor==null?null:String(BigInt(String(r.netReceiptsMinor))-BigInt(String(r.costMinor))-BigInt(String(r.commissionMinor)))}))
}
export function channelReportCsv(rows:Record<string,unknown>[]){
 const fields=['offerCode','title','promoterName','staffClaims','selfClaims','arrivedVisits','priorReservationVisits','knownReturningVisits','qualifiedMinor','commissionMinor','netReceiptsMinor','costMinor','missingCostItems','contributionMinor','pending','checkedAt']
 const cell=(value:unknown)=>{const s=value==null?'待核算':String(value);return '"'+(/^[=+\-@\t\r]/.test(s)?"'"+s:s).replaceAll('"','""')+'"'}
 return '\uFEFF'+[fields.map(cell).join(','),...rows.map(row=>fields.map(f=>cell(row[f])).join(','))].join('\r\n')
}
