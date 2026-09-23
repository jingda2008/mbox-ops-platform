import type {KitchenBoardData, KitchenPendingItem, KitchenProductionBatch} from '../../src/shared/kitchen-production.js'
import type {ScopedTransaction} from './transaction-runner.js'
import type {CommerceKdsRequestContext} from './commerce-kds-api.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {hasActiveKdsSession, KdsAuthorizationError} from './kds-authorization-policy.js'
import {resolveFulfillmentAllowedStations} from './fulfillment-query-service.js'

export interface KitchenSource extends KitchenPendingItem {
  eligible: boolean
  legacy: boolean
}

/** Read and mutation use the same compatibility and current-location facts. */
export async function readKitchenSources(tx:ScopedTransaction, employeeId:string, businessDate:string):Promise<KitchenSource[]> {
  const rows=await tx.query<{value:KitchenSource}>(`
    SELECT jsonb_build_object(
      'taskId',task.id,'itemId',item.id,'productId',item.product_id,
      'productName',COALESCE(item.product_snapshot->>'name',product.name),
      'specification',COALESCE(NULLIF(item.product_snapshot->>'specification',''),NULLIF(item.product_snapshot->'source'->>'specification',''),''),
      'itemNote',COALESCE(item.note,''),'orderNote',COALESCE(original.note,''),
      'tableSessionId',session.id,'tableId',venue.id,'tableCode',venue.code,
      'locationVersion',session.location_version,'orderPublicId',original.public_id,'orderCreatedAt',original.created_at,
      'unmade',CASE WHEN portions.total>0 THEN portions.unmade WHEN task.status IN ('pending','accepted') THEN item.quantity ELSE 0 END,
      'canPrepare',task.assigned_employee_id IS NULL OR task.assigned_employee_id=$3::uuid,
      'eligible',task.remake_of_task_id IS NULL AND task.status IN ('pending','accepted','preparing')
        AND original.business_date=$4::date AND session.status IN ('open','closing')
        AND NOT EXISTS(SELECT 1 FROM mbox.order_items child WHERE child.tenant_id=item.tenant_id AND child.store_id=item.store_id AND child.parent_order_item_id=item.id),
      'legacy',task.remake_of_task_id IS NOT NULL OR task.status='failed' OR original.business_date<>$4::date
        OR portions.unbound_started>0 OR portions.blocked>0 OR (portions.total=0 AND task.status='preparing')
        OR EXISTS(SELECT 1 FROM mbox.order_items child WHERE child.tenant_id=item.tenant_id AND child.store_id=item.store_id AND child.parent_order_item_id=item.id)
    ) AS value
    FROM mbox.kds_tasks task
    JOIN mbox.order_items item ON (item.tenant_id,item.store_id,item.id)=(task.tenant_id,task.store_id,task.order_item_id)
    JOIN mbox.orders original ON (original.tenant_id,original.store_id,original.id)=(item.tenant_id,item.store_id,item.order_id)
    JOIN mbox.table_sessions session ON (session.tenant_id,session.store_id,session.id)=(original.tenant_id,original.store_id,original.table_session_id)
    JOIN mbox.tables venue ON (venue.tenant_id,venue.store_id,venue.id)=(session.tenant_id,session.store_id,session.table_id)
    JOIN mbox.products product ON (product.tenant_id,product.store_id,product.id)=(item.tenant_id,item.store_id,item.product_id)
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS total,
        count(*) FILTER(WHERE unit.production_state='unmade' AND unit.held_by_case_id IS NULL AND NOT unit.operationally_stopped AND bound.unit_id IS NULL AND remake.unit_id IS NULL)::int AS unmade,
        count(*) FILTER(WHERE unit.production_state='started' AND bound.unit_id IS NULL AND remake.unit_id IS NULL)::int AS unbound_started,
        count(*) FILTER(WHERE unit.held_by_case_id IS NOT NULL OR unit.operationally_stopped)::int AS blocked
      FROM mbox.order_item_quantity_units unit
      LEFT JOIN mbox.kitchen_production_units bound ON (bound.tenant_id,bound.store_id,bound.unit_id)=(unit.tenant_id,unit.store_id,unit.id)
      LEFT JOIN mbox.quantity_remake_units remake ON (remake.tenant_id,remake.store_id,remake.unit_id)=(unit.tenant_id,unit.store_id,unit.id)
      WHERE (unit.tenant_id,unit.store_id,unit.order_item_id)=(item.tenant_id,item.store_id,item.id)
    ) portions ON true
    WHERE task.tenant_id=$1 AND task.store_id=$2 AND task.station_code='kitchen'
      AND task.status IN ('pending','accepted','preparing','ready','failed')
      AND original.status IN ('submitted','confirmed','fulfilling','completed')
      AND session.status IN ('open','closing') AND item.status NOT IN ('cancelled','delivered')
    ORDER BY original.created_at,original.id,task.id
  `,[tx.scope.tenantId,tx.scope.storeId,employeeId,businessDate])
  return rows.rows.map(row=>row.value)
}

export async function readKitchenBatches(tx:ScopedTransaction, batchId?:string):Promise<KitchenProductionBatch[]> {
  const rows=await tx.query<{value:KitchenProductionBatch}>(`
    SELECT jsonb_build_object('id',batch.id,'productId',batch.product_id,'productName',batch.product_name,
      'specification',batch.specification,'itemNote',batch.item_note,'orderNote',batch.order_note,
      'employeeId',batch.created_by_employee_id,'employeeName',employee.display_name,
      'createdAt',batch.created_at,'startedAt',batch.started_at,'anchorAt',batch.anchor_at,
      'equipment',batch.equipment,'releasedAt',batch.released_at,'expectedSeconds',batch.expected_seconds,
      'originalQuantity',batch.original_quantity,'units',parts.units) AS value
    FROM mbox.kitchen_production_batches batch
    JOIN mbox.employees employee ON (employee.tenant_id,employee.store_id,employee.id)=(batch.tenant_id,batch.store_id,batch.created_by_employee_id)
    JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('unitId',unit.id,'itemId',item.id,'taskId',task.id,
        'state',unit.production_state,'held',unit.held_by_case_id IS NOT NULL,
        'stopped',unit.operationally_stopped OR task.status IN ('failed','cancelled') OR session.status NOT IN ('open','closing')
          OR EXISTS(SELECT 1 FROM mbox.quantity_remake_units remake WHERE (remake.tenant_id,remake.store_id,remake.unit_id)=(unit.tenant_id,unit.store_id,unit.id)),
        'originalTableCode',part.original_table_code,'tableSessionId',session.id,'tableId',venue.id,
        'tableCode',venue.code,'locationVersion',session.location_version,
        'orderPublicId',original.public_id,'orderCreatedAt',original.created_at
      ) ORDER BY original.created_at,original.id,task.id,unit.unit_index) AS units,
      bool_or(unit.production_state IN ('unmade','started') AND NOT unit.operationally_stopped
        AND task.status NOT IN ('failed','cancelled') AND session.status IN ('open','closing')) AS unfinished
      FROM mbox.kitchen_production_units part
      JOIN mbox.order_item_quantity_units unit ON (unit.tenant_id,unit.store_id,unit.id)=(part.tenant_id,part.store_id,part.unit_id)
      JOIN mbox.kds_tasks task ON (task.tenant_id,task.store_id,task.id)=(part.tenant_id,part.store_id,part.kds_task_id)
      JOIN mbox.order_items item ON (item.tenant_id,item.store_id,item.id)=(unit.tenant_id,unit.store_id,unit.order_item_id)
      JOIN mbox.orders original ON (original.tenant_id,original.store_id,original.id)=(item.tenant_id,item.store_id,item.order_id)
      JOIN mbox.table_sessions session ON (session.tenant_id,session.store_id,session.id)=(original.tenant_id,original.store_id,original.table_session_id)
      JOIN mbox.tables venue ON (venue.tenant_id,venue.store_id,venue.id)=(session.tenant_id,session.store_id,session.table_id)
      WHERE (part.tenant_id,part.store_id,part.batch_id)=(batch.tenant_id,batch.store_id,batch.id)
    ) parts ON true
    WHERE batch.tenant_id=$1 AND batch.store_id=$2
      AND ($3::uuid IS NULL AND (parts.unfinished OR batch.equipment IS NOT NULL AND batch.released_at IS NULL) OR batch.id=$3)
    ORDER BY batch.anchor_at,batch.created_at,batch.id
  `,[tx.scope.tenantId,tx.scope.storeId,batchId??null])
  return rows.rows.map(row=>row.value)
}

export async function readKitchenBoard(tx:ScopedTransaction,context:CommerceKdsRequestContext,enabled:boolean):Promise<KitchenBoardData> {
  const access=await new StaffAccessRepository(tx).resolve(context.employeeId)
  if(!access.permissions.includes('kds.prepare'))throw new KdsAuthorizationError('KDS_PREPARE_FORBIDDEN','start')
  if(!resolveFulfillmentAllowedStations(access.dataScopes).includes('kitchen'))throw new KdsAuthorizationError('KDS_STATION_FORBIDDEN','start')
  const actionSessionValid=await hasActiveKdsSession({transaction:tx,...context})
  const sources=await readKitchenSources(tx,context.employeeId,context.businessDate)
  const batches=await readKitchenBatches(tx)
  const equipment=await tx.query<{equipment:string}>(`SELECT DISTINCT equipment FROM mbox.kitchen_production_batches WHERE tenant_id=$1 AND store_id=$2 AND equipment IS NOT NULL ORDER BY equipment`,[tx.scope.tenantId,tx.scope.storeId])
  return {employeeId:context.employeeId,canStart:enabled&&actionSessionValid,canPrepare:actionSessionValid,actionSessionValid,generatedAt:new Date().toISOString(),
    pending:sources.filter(item=>item.eligible&&item.unmade>0).map(({eligible:_eligible,legacy:_legacy,...item})=>({...item,canPrepare:actionSessionValid&&item.canPrepare})),
    batches,equipmentLabels:equipment.rows.map(row=>row.equipment),legacyTaskIds:sources.filter(item=>item.legacy).map(item=>item.taskId)}
}
