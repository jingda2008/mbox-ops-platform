import type { ScopedTransaction } from './transaction-runner.js'
import type { OrderProductionNotice } from '../../src/shared/print-alerts.js'

export async function readOrderProductionNotices(tx: ScopedTransaction, employeeId: string, audience: {
  cashier: boolean; service: boolean; manager: boolean; stations: readonly string[]
}): Promise<OrderProductionNotice[]> {
  if (!audience.cashier && !audience.service && !audience.manager && !audience.stations.length) return []
  const result = await tx.query<OrderProductionNotice & Record<string, unknown>>(`
    WITH originals AS MATERIALIZED (
      SELECT o.*, venue.code AS table_code, $4 OR ($5 AND s.primary_service_employee_id IS NOT DISTINCT FROM $3) AS collect
      FROM mbox.table_sessions s JOIN mbox.tables venue ON (venue.tenant_id,venue.store_id,venue.id)=(s.tenant_id,s.store_id,s.table_id)
      JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.table_session_id)=(s.tenant_id,s.store_id,s.id)
      WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.status IN ('open','closing')
        AND o.status NOT IN ('draft','cancelled') AND o.fulfillment_state<>'cancelled'
        AND ($4 OR $6 OR ($5 AND s.primary_service_employee_id IS NOT DISTINCT FROM $3) OR cardinality($7::text[])>0)
    ), evidence AS MATERIALIZED (
      SELECT o.*, needs.stations,needs.live,needs.missing,
        mbox.order_collection_due_amount(o.tenant_id,o.store_id,o.id) AS due,
        mbox.order_production_allowed(o.tenant_id,o.store_id,o.id) AS allowed,
        mbox.order_consumption_settled(o.tenant_id,o.store_id,o.id) AS settled
      FROM originals o CROSS JOIN LATERAL (
        SELECT array_agg(DISTINCT i.fulfillment_station) AS stations,
          array_agg(DISTINCT i.fulfillment_station) FILTER(WHERE k.status IN ('pending','accepted','preparing','ready','failed')) AS live,
          array_agg(DISTINCT i.fulfillment_station) FILTER(WHERE k.id IS NULL AND i.status='submitted') AS missing
        FROM mbox.order_items i LEFT JOIN mbox.kds_tasks k
          ON (k.tenant_id,k.store_id,k.order_item_id,k.station_code)=(i.tenant_id,i.store_id,i.id,i.fulfillment_station)
        WHERE (i.tenant_id,i.store_id,i.order_id)=(o.tenant_id,o.store_id,o.id)
          AND i.fulfillment_station IN ('kitchen','bar') AND i.status NOT IN ('cancelled','delivered')
      ) needs WHERE needs.stations IS NOT NULL OR o.collect
    ), issues AS (
      SELECT e.*, CASE
        WHEN NOT allowed AND live IS NOT NULL AND ($6 OR live && $7) THEN 'blocked'
        WHEN settled AND missing IS NOT NULL AND ($6 OR missing && $7)
          AND updated_at<=now()-interval '90 seconds' THEN 'missing'
        WHEN NOT allowed AND NOT settled AND total_amount_minor=0 AND stations IS NOT NULL AND (collect OR $6)
          AND updated_at<=now()-interval '90 seconds' THEN 'proof'
        WHEN NOT settled AND due>0 AND total_amount_minor>0 AND (collect OR allowed AND live && $7)
          THEN CASE WHEN stations IS NULL THEN 'balance' WHEN allowed THEN 'tab' ELSE 'collect' END
      END AS issue
      FROM evidence e
    )
    SELECT public_id AS "orderNumber",table_code AS "tableCode",issue,
      CASE WHEN collect AND issue IN ('tab','collect','balance') THEN
        due::float8 END AS "dueMinor",
      collect AND EXISTS (SELECT 1 FROM mbox.order_payment_facts p
        WHERE (p.tenant_id,p.store_id,p.order_id)=(issues.tenant_id,issues.store_id,issues.id)
          AND p.status IN ('created','pending') AND p.retry_released_at IS NULL) AS "checkPayment",
      ARRAY(SELECT st FROM unnest(CASE WHEN issue='missing' THEN missing ELSE live END) st
        WHERE $6 OR st=ANY($7) ORDER BY st) AS stations
    FROM issues WHERE issue IS NOT NULL
    ORDER BY CASE issue WHEN 'blocked' THEN 0 WHEN 'missing' THEN 1 ELSE 2 END, created_at, id
  `, [tx.scope.tenantId,tx.scope.storeId,employeeId,audience.cashier,audience.service,audience.manager,audience.stations])
  return result.rows
}
