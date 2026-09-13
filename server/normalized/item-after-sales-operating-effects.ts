import {synchronizeQuantityItem} from './item-quantity-projection.js'
import {randomUUID,createHash} from 'node:crypto'
import {appendOutboxMessage} from './command-executor.js'
import type {ScopedTransaction} from './transaction-runner.js'
import type {QuantityOperatingEffects} from './item-after-sales-command-service.js'
import {lockQuantityOrder} from './item-quantity-lock.js'

/** Persists original-quantity notices through the existing print worker. No
 * printer setting changes and no device/network work in the sales transaction.
 * Partial KDS/delivery commands still require the quantity-aware API adapter. */
export class ItemAfterSalesOperatingEffects implements QuantityOperatingEffects {
  async apply(tx:ScopedTransaction,input:Parameters<QuantityOperatingEffects['apply']>[1]){
    const scope=[tx.scope.tenantId,tx.scope.storeId]
    await lockQuantityOrder(tx,{kind:'case',id:input.caseId})
    const actionKey=input.action==='physical'?`physical:${createHash('sha256').update(input.eventKey).digest('hex').slice(0,32)}`:input.action
    const inserted=await tx.query(`INSERT INTO mbox.item_after_sales_events(tenant_id,store_id,case_id,employee_id,event_type,metadata)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING RETURNING id`,[...scope,input.caseId,input.employeeId,`operating.${actionKey}`,JSON.stringify({commandKey:input.eventKey})])
    if(!inserted.rowCount)return
    const context=(await tx.query<{table_code:string;guest_count:number;order_public_id:string;business_date:string;issued_at:string;operator_name:string;reason:string;session_status:string}>(`SELECT venue.code AS table_code,session.guest_count,original.public_id AS order_public_id,
      mbox.current_operating_business_date($1,$2)::text AS business_date,clock_timestamp()::text AS issued_at,employee.display_name AS operator_name,target.reason,session.status AS session_status
      FROM mbox.item_after_sales_cases target JOIN mbox.orders original ON original.tenant_id=target.tenant_id AND original.store_id=target.store_id AND original.id=target.order_id
      JOIN mbox.table_sessions session ON session.tenant_id=original.tenant_id AND session.store_id=original.store_id AND session.id=original.table_session_id
      JOIN mbox.tables venue ON venue.tenant_id=session.tenant_id AND venue.store_id=session.store_id AND venue.id=session.table_id
      JOIN mbox.employees employee ON employee.tenant_id=target.tenant_id AND employee.store_id=target.store_id AND employee.id=$4
      WHERE target.tenant_id=$1 AND target.store_id=$2 AND target.id=$3`,[...scope,input.caseId,input.employeeId])).rows[0]!
    const groups=(await tx.query<{item_id:string;station:string;category_code:string|null;name:string;production_state:string;remake_batch_id:string|null;stopped:boolean;quantity:number}>(`SELECT item.id AS item_id,item.fulfillment_station AS station,
      COALESCE(item.product_snapshot->>'categoryCode',item.product_snapshot->>'category_code') AS category_code,COALESCE(item.product_snapshot->>'name','原商品') AS name,
      COALESCE(latest.production_state,unit.production_state) AS production_state,latest.batch_id AS remake_batch_id,unit.stopped_by_case_id=selected.case_id AS stopped,count(*)::int AS quantity
      FROM mbox.item_after_sales_case_units selected JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id
      JOIN mbox.order_items item ON item.tenant_id=unit.tenant_id AND item.store_id=unit.store_id AND item.id=unit.order_item_id
      LEFT JOIN LATERAL(SELECT part.production_state,part.batch_id FROM mbox.quantity_remake_units part WHERE part.tenant_id=unit.tenant_id AND part.store_id=unit.store_id AND part.unit_id=unit.id ORDER BY part.generation DESC LIMIT 1) latest ON true
      WHERE selected.tenant_id=$1 AND selected.store_id=$2 AND selected.case_id=$3 AND ($4::uuid[] IS NULL OR unit.id=ANY($4::uuid[]))
      GROUP BY item.id,COALESCE(latest.production_state,unit.production_state),latest.batch_id,unit.stopped_by_case_id=selected.case_id ORDER BY item.id,latest.batch_id,COALESCE(latest.production_state,unit.production_state)`,[...scope,input.caseId,input.unitIds??null])).rows
    for(const itemId of new Set(groups.map(group=>group.item_id))){
      const tasks=(await tx.query<{id:string}>(`SELECT id FROM mbox.kds_tasks WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=$3 ORDER BY id FOR UPDATE`,[...scope,itemId])).rows
      for(const task of tasks)await tx.query(`INSERT INTO mbox.kds_task_events(tenant_id,store_id,kds_task_id,event_type,actor_employee_id,idempotency_key,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[...scope,task.id,`quantity.${input.action}`,input.employeeId,`case:${input.caseId}:${actionKey}`,JSON.stringify({caseId:input.caseId,source:'item_after_sales',quantities:groups.filter(group=>group.item_id===itemId).map(group=>({quantity:group.quantity,productionState:group.production_state,stopped:group.stopped===true}))})])
      if(['open','closing'].includes(context.session_status))await synchronizeQuantityItem(tx,itemId)
    }
    for(const group of groups){
      if(!['bar','kitchen'].includes(group.station))continue
      const instruction=input.action==='resume'?(group.production_state==='ready'?'恢复取送，勿重做':group.production_state==='delivered'?'保留已送达，勿重做':group.remake_batch_id?'继续本批重做':'继续原制作')
        :group.stopped?'已停止，勿制作/取送':['rejected','withdrawn'].includes(input.action)?'保持暂停，等明确继续':'暂停后续制作和取送'
      const eventId=randomUUID()
      const source=await appendOutboxMessage(tx,{eventId,aggregateType:'item_after_sales_notice',aggregateId:eventId,aggregateVersion:1,eventType:'item.after_sales.production_notice.v1',occurredAt:context.issued_at,
        payload:{caseId:input.caseId,stationCode:group.station,categoryCode:group.category_code,ticket:{schemaVersion:1,kind:'production_notice',title:'商品处理通知',subtitle:instruction,test:false,
          issuedAt:context.issued_at,businessDate:context.business_date,ticketReference:context.order_public_id,tableCode:context.table_code,guestCount:context.guest_count,operatorLabel:context.operator_name,
          lines:[{name:`${instruction}：${group.remake_batch_id?'重做批次 · ':''}${group.name}`.slice(0,120),quantity:group.quantity,unitAmountMinor:null,totalAmountMinor:null,note:group.remake_batch_id?`仅处理重做批次 ${group.remake_batch_id} 的本票数量；不要另开重做。`:group.production_state==='unmade'?'仅处理本票所选数量，其余商品继续。':'已有制作或送达记录，勿重新制作或重复配送。'}],
          payment:null,totalAmountMinor:null,currency:'CNY',note:`${['open','closing'].includes(context.session_status)?'':'原桌次已结束，此为历史商品通知，不属于当前桌上客人。'}申请：${input.caseId}。${input.reason??context.reason}`.slice(0,300)}}})
      await tx.query(`INSERT INTO mbox.print_source_jobs(tenant_id,store_id,source_outbox_message_id,aggregate_id,ticket_kind) VALUES($1,$2,$3,$4,'production_notice')`,[...scope,source,eventId])
      await tx.query(`INSERT INTO mbox.item_after_sales_notices(tenant_id,store_id,case_id,source_outbox_message_id,station_code,instruction) VALUES($1,$2,$3,$4,$5,$6)`,[...scope,input.caseId,source,group.station,instruction])
    }
  }
}
