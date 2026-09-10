import type {ScopedTransaction} from './transaction-runner.js'
import {assertEmployeeEffectivePermission} from './employee-table-access.js'

export class ManualBusinessDayEndConflict extends Error {}
export interface ManualBusinessDayEnd {
  id:string; businessDate:string; nextBusinessDate:string; endedAt:string
  ledgerSnapshot:Array<{provider:string;receivedMinor:string;refundedMinor:string;netMinor:string}>
  replayed:boolean
}

/** Records the accounting boundary without pretending old receivables settled. */
export async function recordManualBusinessDayEnd(tx:ScopedTransaction,input:{employeeId:string;expectedBusinessDate:string;reason:string}):Promise<ManualBusinessDayEnd> {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(input.expectedBusinessDate)
    ||!Number.isFinite(Date.parse(input.expectedBusinessDate))
    ||new Date(input.expectedBusinessDate).toISOString().slice(0,10)!==input.expectedBusinessDate
    ||input.reason.trim().length<2||input.reason.trim().length>500)throw new TypeError('日结日期或原因无效')
  await assertEmployeeEffectivePermission(tx,input.employeeId,'business_day.close')
  // Serialize manual boundary writers for this store; no provider or printer IO.
  const store=(await tx.query<{calendar_date:string}>(`
    SELECT ((clock_timestamp() AT TIME ZONE timezone)-business_day_cutoff)::date::text AS calendar_date
    FROM mbox.stores WHERE tenant_id=$1 AND id=$2 AND status='active' FOR UPDATE
  `,[tx.scope.tenantId,tx.scope.storeId])).rows[0]
  if(!store)throw new ManualBusinessDayEndConflict('门店不可用')
  const existing=(await tx.query<BoundaryRow>(`${SELECT_BOUNDARY} AND business_date=$3::date`,
    [tx.scope.tenantId,tx.scope.storeId,input.expectedBusinessDate])).rows[0]
  if(existing)return map(existing,true)
  if(store.calendar_date!==input.expectedBusinessDate)throw new ManualBusinessDayEndConflict('营业日已变化，请重新核对；不能连续提前结束未来营业日')
  const rows=await tx.query<BoundaryRow>(`
    INSERT INTO mbox.manual_business_day_ends(tenant_id,store_id,business_date,next_business_date,
      calendar_business_date,employee_id,reason,ledger_snapshot,operating_snapshot)
    SELECT $1,$2,$3::date,$3::date+1,$3::date,$4,$5,COALESCE(jsonb_agg(to_jsonb(receipt)),'[]'::jsonb),mbox.operating_day_summary($1,$2,$3::date)
    FROM (
      SELECT provider,
        COALESCE(sum(amount_minor) FILTER(WHERE entry_type='payment'),0)::text AS "receivedMinor",
        (-COALESCE(sum(amount_minor) FILTER(WHERE entry_type='refund'),0))::text AS "refundedMinor",
        COALESCE(sum(amount_minor),0)::text AS "netMinor"
      FROM mbox.reconciliation_entries WHERE tenant_id=$1 AND store_id=$2 AND business_date=$3::date
        AND entry_type IN ('payment','refund') GROUP BY provider ORDER BY provider
    ) receipt
    RETURNING id,business_date::text,next_business_date::text,ended_at::text,ledger_snapshot
  `,[tx.scope.tenantId,tx.scope.storeId,input.expectedBusinessDate,input.employeeId,input.reason.trim()])
  // The automatic worker may have been offline for several days. Release any
  // older open-day marker, not its tables or receivables, before opening next day.
  await tx.query(`UPDATE mbox.business_days SET status='awaiting_close',
    rollover_at=COALESCE(rollover_at,clock_timestamp())
    WHERE tenant_id=$1 AND store_id=$2 AND status='open' AND business_date<=$3::date`,
  [tx.scope.tenantId,tx.scope.storeId,input.expectedBusinessDate])
  await tx.query(`INSERT INTO mbox.business_days(tenant_id,store_id,business_date,status,rollover_at)
    VALUES($1,$2,$3::date,'awaiting_close',clock_timestamp())
    ON CONFLICT(tenant_id,store_id,business_date) DO UPDATE SET
      status=CASE WHEN business_days.status='open' THEN 'awaiting_close' ELSE business_days.status END,
      rollover_at=COALESCE(business_days.rollover_at,EXCLUDED.rollover_at)`,[tx.scope.tenantId,tx.scope.storeId,input.expectedBusinessDate])
  await tx.query(`INSERT INTO mbox.business_days(tenant_id,store_id,business_date,status)
    VALUES($1,$2,$3::date+1,'open') ON CONFLICT(tenant_id,store_id,business_date) DO NOTHING`,
  [tx.scope.tenantId,tx.scope.storeId,input.expectedBusinessDate])
  return map(rows.rows[0]!,false)
}
interface BoundaryRow extends Record<string,unknown>{id:string;business_date:string;next_business_date:string;ended_at:string;ledger_snapshot:ManualBusinessDayEnd['ledgerSnapshot']}
const SELECT_BOUNDARY='SELECT id,business_date::text,next_business_date::text,ended_at::text,ledger_snapshot FROM mbox.manual_business_day_ends WHERE tenant_id=$1 AND store_id=$2'
function map(row:BoundaryRow,replayed:boolean):ManualBusinessDayEnd{return{id:row.id,businessDate:row.business_date,nextBusinessDate:row.next_business_date,endedAt:row.ended_at,ledgerSnapshot:row.ledger_snapshot,replayed}}
