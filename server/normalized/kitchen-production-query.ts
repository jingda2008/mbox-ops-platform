import type {KitchenBoardData, KitchenPendingItem, KitchenProductionBatch, ProductionStation, KitchenHandoffPreview} from '../../src/shared/kitchen-production.js'
import type {ScopedTransaction} from './transaction-runner.js'
import type {CommerceKdsRequestContext} from './commerce-kds-api.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {hasActiveKdsSession, KdsAuthorizationError} from './kds-authorization-policy.js'
import {resolveFulfillmentAllowedStations} from './fulfillment-query-service.js'
import {readPhysicalPickupUnits} from './pickup-workflow-query.js'

export interface KitchenSource extends KitchenPendingItem {
  eligible: boolean
  legacy: boolean
}

/** Read and mutation use the same compatibility and current-location facts. */
export async function readKitchenSources(tx:ScopedTransaction, employeeId:string, businessDate:string, stationCode:ProductionStation='kitchen'):Promise<KitchenSource[]> {
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
    -- Keep scoped primary-key lookups dependent on each task. Under RLS, underestimated row counts mean
    -- flattening these joins can repeatedly scan every order/item/task combination.
    JOIN LATERAL (SELECT item.* FROM mbox.order_items item
      WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.id=task.order_item_id OFFSET 0) item ON true
    JOIN LATERAL (SELECT original.* FROM mbox.orders original
      WHERE original.tenant_id=$1 AND original.store_id=$2 AND original.id=item.order_id OFFSET 0) original ON true
    JOIN LATERAL (SELECT session.* FROM mbox.table_sessions session
      WHERE session.tenant_id=$1 AND session.store_id=$2 AND session.id=original.table_session_id OFFSET 0) session ON true
    JOIN LATERAL (SELECT venue.* FROM mbox.tables venue
      WHERE venue.tenant_id=$1 AND venue.store_id=$2 AND venue.id=session.table_id OFFSET 0) venue ON true
    JOIN LATERAL (SELECT product.* FROM mbox.products product
      WHERE product.tenant_id=$1 AND product.store_id=$2 AND product.id=item.product_id OFFSET 0) product ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS total,
        count(*) FILTER(WHERE unit.production_state='unmade' AND unit.held_by_case_id IS NULL AND NOT unit.operationally_stopped AND bound.unit_id IS NULL AND remake.unit_id IS NULL)::int AS unmade,
        count(*) FILTER(WHERE unit.production_state='started' AND bound.unit_id IS NULL AND remake.unit_id IS NULL)::int AS unbound_started,
        count(*) FILTER(WHERE unit.held_by_case_id IS NOT NULL OR unit.operationally_stopped)::int AS blocked
      FROM mbox.order_item_quantity_units unit
      LEFT JOIN mbox.kitchen_production_units bound ON (bound.tenant_id,bound.store_id,bound.unit_id)=(unit.tenant_id,unit.store_id,unit.id)
      LEFT JOIN LATERAL (SELECT replacement.unit_id FROM mbox.quantity_remake_units replacement
        WHERE (replacement.tenant_id,replacement.store_id,replacement.unit_id)=(unit.tenant_id,unit.store_id,unit.id) LIMIT 1) remake ON true
      WHERE (unit.tenant_id,unit.store_id,unit.order_item_id)=(item.tenant_id,item.store_id,item.id)
    ) portions ON true
    WHERE task.tenant_id=$1 AND task.store_id=$2 AND task.station_code=$5
      AND task.status IN ('pending','accepted','preparing','ready','failed')
      AND original.status IN ('submitted','confirmed','fulfilling','completed')
      AND session.status IN ('open','closing') AND item.status NOT IN ('cancelled','delivered')
    ORDER BY original.created_at,original.id,task.id
  `,[tx.scope.tenantId,tx.scope.storeId,employeeId,businessDate,stationCode])
  return rows.rows.map(row=>row.value)
}

export async function readKitchenBatches(tx:ScopedTransaction, batchId?:string, stationCode:ProductionStation='kitchen'):Promise<KitchenProductionBatch[]> {
  const rows=await tx.query<{value:KitchenProductionBatch}>(`
    SELECT jsonb_build_object('id',batch.id,'productId',batch.product_id,'productName',batch.product_name,
      'specification',batch.specification,'itemNote',batch.item_note,'orderNote',batch.order_note,
      'employeeId',COALESCE(handoff.to_employee_id,batch.created_by_employee_id),'employeeName',COALESCE(successor.display_name,employee.display_name),
      'stationCode',batch.station_code,'createdByEmployeeId',batch.created_by_employee_id,'createdByEmployeeName',employee.display_name,
      'ownershipVersion',COALESCE(handoff.ownership_version,0),
      'createdAt',batch.created_at,'startedAt',batch.started_at,'anchorAt',batch.anchor_at,
      'equipment',batch.equipment,'releasedAt',batch.released_at,'expectedSeconds',batch.expected_seconds,
      'originalQuantity',batch.original_quantity,'units',parts.units) AS value
    FROM mbox.kitchen_production_batches batch
    JOIN mbox.employees employee ON (employee.tenant_id,employee.store_id,employee.id)=(batch.tenant_id,batch.store_id,batch.created_by_employee_id)
    LEFT JOIN LATERAL (SELECT change.to_employee_id,change.ownership_version FROM mbox.kitchen_production_handoffs change
      WHERE (change.tenant_id,change.store_id,change.batch_id)=(batch.tenant_id,batch.store_id,batch.id)
      ORDER BY change.ownership_version DESC LIMIT 1) handoff ON true
    LEFT JOIN mbox.employees successor ON (successor.tenant_id,successor.store_id,successor.id)=(batch.tenant_id,batch.store_id,handoff.to_employee_id)
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
        AND task.status NOT IN ('failed','cancelled') AND session.status IN ('open','closing')
        AND NOT EXISTS(SELECT 1 FROM mbox.quantity_remake_units remake WHERE (remake.tenant_id,remake.store_id,remake.unit_id)=(unit.tenant_id,unit.store_id,unit.id))) AS unfinished
      FROM mbox.kitchen_production_units part
      -- Apply the same bounded lookups after batches accumulate during a burst.
      JOIN LATERAL (SELECT unit.* FROM mbox.order_item_quantity_units unit
        WHERE unit.tenant_id=$1 AND unit.store_id=$2 AND unit.id=part.unit_id OFFSET 0) unit ON true
      JOIN LATERAL (SELECT task.* FROM mbox.kds_tasks task
        WHERE task.tenant_id=$1 AND task.store_id=$2 AND task.id=part.kds_task_id OFFSET 0) task ON true
      JOIN LATERAL (SELECT item.* FROM mbox.order_items item
        WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.id=unit.order_item_id OFFSET 0) item ON true
      JOIN LATERAL (SELECT original.* FROM mbox.orders original
        WHERE original.tenant_id=$1 AND original.store_id=$2 AND original.id=item.order_id OFFSET 0) original ON true
      JOIN LATERAL (SELECT session.* FROM mbox.table_sessions session
        WHERE session.tenant_id=$1 AND session.store_id=$2 AND session.id=original.table_session_id OFFSET 0) session ON true
      JOIN LATERAL (SELECT venue.* FROM mbox.tables venue
        WHERE venue.tenant_id=$1 AND venue.store_id=$2 AND venue.id=session.table_id OFFSET 0) venue ON true
      WHERE (part.tenant_id,part.store_id,part.batch_id)=(batch.tenant_id,batch.store_id,batch.id)
    ) parts ON true
    WHERE batch.tenant_id=$1 AND batch.store_id=$2 AND batch.station_code=$4
      AND ($3::uuid IS NULL AND (parts.unfinished OR batch.equipment IS NOT NULL AND batch.released_at IS NULL) OR batch.id=$3)
    ORDER BY batch.anchor_at,batch.created_at,batch.id
  `,[tx.scope.tenantId,tx.scope.storeId,batchId??null,stationCode])
  return rows.rows.map(row=>row.value)
}

export async function readKitchenBoard(tx:ScopedTransaction,context:CommerceKdsRequestContext,enabled:boolean,stationCode:ProductionStation='kitchen'):Promise<KitchenBoardData> {
  const access=await new StaffAccessRepository(tx).resolve(context.employeeId)
  if(!access.permissions.includes('kds.prepare'))throw new KdsAuthorizationError('KDS_PREPARE_FORBIDDEN','start')
  if(!resolveFulfillmentAllowedStations(access.dataScopes).includes(stationCode))throw new KdsAuthorizationError('KDS_STATION_FORBIDDEN','start')
  const actionSessionValid=await hasActiveKdsSession({transaction:tx,...context})
  const sources=await readKitchenSources(tx,context.employeeId,context.businessDate,stationCode)
  const batches=await readKitchenBatches(tx,undefined,stationCode)
  const physical=await readPhysicalPickupUnits(tx,{includeTakenBusinessDate:context.businessDate,station:stationCode})
  const equipment=await tx.query<{equipment:string}>(`SELECT DISTINCT equipment FROM mbox.kitchen_production_batches WHERE tenant_id=$1 AND store_id=$2 AND station_code=$3 AND equipment IS NOT NULL ORDER BY equipment`,[tx.scope.tenantId,tx.scope.storeId,stationCode])
  return {employeeId:context.employeeId,stationCode,canHandoff:actionSessionValid&&access.permissions.includes('kds.exception.manage'),canStart:enabled&&actionSessionValid,canPrepare:actionSessionValid,actionSessionValid,generatedAt:new Date().toISOString(),
    pickupSummary:{awaitingPickup:physical.filter(row=>row.available&&row.state==='ready').length,pickedUpThisShift:physical.filter(row=>row.currentPhysical&&row.state==='delivered'&&row.pickupBusinessDate===context.businessDate).length},
    pending:sources.filter(item=>item.eligible&&item.unmade>0).map(({eligible:_eligible,legacy:_legacy,...item})=>({...item,canPrepare:actionSessionValid&&item.canPrepare})),
    batches,equipmentLabels:equipment.rows.map(row=>row.equipment),legacyTaskIds:sources.filter(item=>item.legacy).map(item=>item.taskId)}
}

/** A task can span several batches. Transfer their connected active scope together. */
export async function readKitchenHandoffPreview(tx:ScopedTransaction,batchId:string,stationCode:ProductionStation):Promise<KitchenHandoffPreview|null>{
  const batches=await readKitchenBatches(tx,undefined,stationCode),anchor=batches.find(batch=>batch.id===batchId)
  if(!anchor)return null
  const selected=new Set([batchId]),taskIds=new Set(anchor.units.map(unit=>unit.taskId))
  let changed=true
  while(changed){changed=false
    for(const batch of batches){
      if(selected.has(batch.id)||!batch.units.some(unit=>taskIds.has(unit.taskId)))continue
      selected.add(batch.id);batch.units.forEach(unit=>taskIds.add(unit.taskId));changed=true
    }
  }
  const affected=batches.filter(batch=>selected.has(batch.id)).sort((a,b)=>a.id.localeCompare(b.id))
  const tasks=(await tx.query<{taskId:string;expectedEmployeeId:string|null}>(`SELECT id AS "taskId",assigned_employee_id AS "expectedEmployeeId" FROM mbox.kds_tasks
    WHERE tenant_id=$1 AND store_id=$2 AND station_code=$3 AND id=ANY($4::uuid[]) ORDER BY id`,[tx.scope.tenantId,tx.scope.storeId,stationCode,[...taskIds]])).rows
  return {stationCode,anchorBatchId:batchId,batches:affected.map(batch=>({batchId:batch.id,expectedCurrentOwnerId:batch.employeeId,expectedOwnershipVersion:batch.ownershipVersion})),tasks,
    displayLines:affected.map(batch=>({batchId:batch.id,productName:batch.productName,specification:batch.specification,itemNote:batch.itemNote,orderNote:batch.orderNote,tableCodes:[...new Set(batch.units.map(unit=>unit.tableCode))],remaining:batch.units.filter(unit=>unit.state==='started'&&!unit.stopped).length,equipment:batch.equipment,released:batch.releasedAt!==null}))}
}
