import type {ScopedTransaction} from './transaction-runner.js'
import type {ParticipantMovementHistory} from '../../src/shared/participant-movement-history.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {TABLE_PARTICIPATION_MANAGE_PERMISSION,TableManagementConflictError} from './table-management-repository.js'

/** Read committed permanent evidence; never replay a command or return its body/key. */
export async function participantMovementHistory(tx:ScopedTransaction,employeeId:string,cursor:string|null):Promise<ParticipantMovementHistory>{
  await new StaffAccessRepository(tx).assertPermission(employeeId,TABLE_PARTICIPATION_MANAGE_PERMISSION)
  // Wait for already-running movement transactions before claiming a fresh view.
  // A not-yet-arrived network request still cannot be ruled out by an empty list.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('table-customer-movement:'||$1::text||':'||$2::text,0))",[tx.scope.tenantId,tx.scope.storeId])
  // Permission may have changed while this read waited behind a write.
  await new StaffAccessRepository(tx).assertPermission(employeeId,TABLE_PARTICIPATION_MANAGE_PERMISSION)
  const args=[tx.scope.tenantId,tx.scope.storeId,employeeId,cursor]
  if(cursor){
    const found=await tx.query('SELECT id FROM mbox.table_customer_movement_events WHERE tenant_id=$1 AND store_id=$2 AND moved_by_employee_id=$3 AND id=$4',args)
    if(!found.rows.length)throw new TableManagementConflictError('历史记录分页位置已变化，请从最新记录重新核对')
  }
  const result=await tx.query<ParticipantMovementHistory['items'][number]>(`
    SELECT e.id,e.movement_kind AS kind,e.source_table_code_snapshot AS "sourceTableCode",
      e.target_table_code_snapshot AS "targetTableCode",e.moved_guest_count AS "movedGuestCount",
      employee.display_name AS "employeeName",e.occurred_at::text AS "occurredAt",
      t.code AS "targetCurrentTableCode",s.status AS "targetSessionStatus"
    FROM mbox.table_customer_movement_events e
    JOIN mbox.employees employee ON (employee.tenant_id,employee.store_id,employee.id)=(e.tenant_id,e.store_id,e.moved_by_employee_id)
    JOIN mbox.table_sessions s ON (s.tenant_id,s.store_id,s.id)=(e.tenant_id,e.store_id,e.target_table_session_id)
    JOIN mbox.tables t ON (t.tenant_id,t.store_id,t.id)=(s.tenant_id,s.store_id,s.table_id)
    WHERE e.tenant_id=$1 AND e.store_id=$2 AND e.moved_by_employee_id=$3
      AND ($4::uuid IS NULL OR (e.occurred_at,e.id)<(SELECT occurred_at,id FROM mbox.table_customer_movement_events WHERE tenant_id=$1 AND store_id=$2 AND moved_by_employee_id=$3 AND id=$4))
    ORDER BY e.occurred_at DESC,e.id DESC LIMIT 21`,args)
  const items=result.rows.slice(0,20)
  return{items,nextCursor:result.rows.length>20?items.at(-1)!.id:null}
}
