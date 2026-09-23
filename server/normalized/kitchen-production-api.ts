import {createHash,randomUUID} from 'node:crypto'
import type {FastifyPluginAsync} from 'fastify'
import {kitchenCompatibilityKey,type KitchenCommand,type KitchenCommandResult,type KitchenDestination,type ProductionStation} from '../../src/shared/kitchen-production.js'
import {CommerceKdsRequestError,handleCommerceRoute,performKdsAction,type CommerceKdsApiOptions,type CommerceKdsRequestContext} from './commerce-kds-api.js'
import {type CommandOutcome,type JsonCodec,type JsonValue,IdempotencyConflictError} from './command-executor.js'
import {NormalizedKdsAuthorization} from './kds-authorization-policy.js'
import {lockQuantityTaskOrders} from './quantity-task-lock.js'
import {readKitchenBatches,readKitchenBoard,readKitchenSources,readKitchenHandoffPreview} from './kitchen-production-query.js'
import type {ScopedTransaction} from './transaction-runner.js'
import {executeKitchenHandoff} from './kitchen-production-handoff.js'
import {ItemQuantityRepository} from './item-quantity-repository.js'

type Options=Pick<CommerceKdsApiOptions,'resolveContext'|'staffAccessTransactions'|'commandExecutor'|'createKdsRepository'|'createOrderRepository'>&{enabled?:boolean;barEnabled?:boolean}
const codec:JsonCodec<KitchenCommandResult>={encode:value=>({...value}),decode:value=>value as KitchenCommandResult}
const conflict=(message:string,code='KITCHEN_CHANGED'):never=>{throw new CommerceKdsRequestError(code,message,409)}

export const kitchenProductionApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
  app.get('/commerce/kitchen-board',async(request,reply)=>handleCommerceRoute(reply,async()=>{
    const context=await options.resolveContext(request),stationCode=parseStation((request.query as Record<string,unknown>).station)
    const data=await options.staffAccessTransactions.run(context.scope,tx=>readKitchenBoard(tx,context,(stationCode==='bar'?options.barEnabled:options.enabled)===true,stationCode),{isolation:'repeatable-read',readOnly:true})
    return reply.send({data})
  }))
  app.get('/commerce/kitchen-board/handoff-preview',async(request,reply)=>handleCommerceRoute(reply,async()=>{
    const context=await options.resolveContext(request),query=object(request.query),stationCode=parseStation(query.station),batchId=uuid(query.batchId)
    const data=await options.staffAccessTransactions.run(context.scope,async tx=>{await authorize(tx,context,stationCode,true);return readKitchenHandoffPreview(tx,batchId,stationCode)},{isolation:'repeatable-read'})
    if(!data)throw new CommerceKdsRequestError('KITCHEN_BATCH_NOT_FOUND','原批次已结束，请读取最新制作队列',404)
    return reply.send({data})
  }))
  app.post('/commerce/kitchen-board/commands',async(request,reply)=>handleCommerceRoute(reply,async()=>{
    const context=await options.resolveContext(request),body=object(request.body)
    if(body.employeeId!==context.employeeId)throw new CommerceKdsRequestError('ACTOR_BINDING_FORBIDDEN','登录员工已改变，请切回原员工核对操作',403)
    const command=parseKitchenCommand(body.command),stationCode=parseStation(body.stationCode)
    const key=request.headers['idempotency-key']
    if(typeof key!=='string'||! /^[A-Za-z0-9_.:-]{1,100}$/.test(key))throw new TypeError('操作凭据无效，请保留原操作并重新读取')
    // Authorize even when the generic executor returns a cached result.
    await options.staffAccessTransactions.run(context.scope,tx=>authorize(tx,context,stationCode,command.action==='handoff'))
    const operationKey=createHash('sha256').update(`${context.employeeId}:${stationCode==='bar'?'bar/':''}${key}`).digest('hex')
    const execution=await options.commandExecutor.execute({scope:context.scope,operationScope:'commerce.kitchen.batch',
      idempotencyKey:operationKey,requestFingerprint:JSON.stringify(stationCode==='bar'?{employeeId:context.employeeId,command,stationCode}:{employeeId:context.employeeId,command}),resultCodec:codec},
    tx=>executeKitchenCommand(tx,options,context,command,key,request.id,stationCode))
    return reply.send({data:execution.value,replayed:execution.replayed})
  }))
}

async function authorize(tx:ScopedTransaction,context:CommerceKdsRequestContext,stationCode:ProductionStation='kitchen',handoff=false){
  // Production authorization is scoped by station; table assignment is checked only for manager exceptions.
  await new NormalizedKdsAuthorization().assertCanActOnTask({transaction:tx,...context,action:'start',stationCode,tableId:''})
  if(handoff)await new NormalizedKdsAuthorization().assertCanActOnTask({transaction:tx,...context,action:'production_handoff',stationCode,tableId:''})
}

export async function executeKitchenCommand(tx:ScopedTransaction,options:Options,context:CommerceKdsRequestContext,command:KitchenCommand,key:string,requestId:string,stationCode:ProductionStation='kitchen'):Promise<CommandOutcome<KitchenCommandResult>> {
  await authorize(tx,context,stationCode,command.action==='handoff')
  const receiptKey=stationCode==='bar'?`bar/${key}`:key
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const receipt=(await tx.query<{same:boolean;result:KitchenCommandResult}>(`SELECT request_body=$5::jsonb AS same,result FROM mbox.kitchen_production_receipts WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3 AND operation_key=$4`,[...scope,context.employeeId,receiptKey,JSON.stringify(command)])).rows[0]
  if(receipt){if(!receipt.same)throw new IdempotencyConflictError('commerce.kitchen.batch',key);return {result:receipt.result,auditEvents:[],outboxMessages:[]}}
  const outcomes:Array<Awaited<ReturnType<typeof performKdsAction>>>=[]
  let batchId:string,quantity=0,released=false,handoffResult:KitchenCommandResult|undefined
  const eventKey=createHash('sha256').update(`${context.employeeId}:${stationCode==='bar'?'bar/':''}${key}`).digest('hex')
  const transition=async(taskId:string,action:'start'|'complete',count:number,unitIds?:string[])=>{
    const outcome=await performKdsAction(tx,{...options,quantityActionsEnabled:true},context,taskId,action,`${stationCode}:${eventKey}`,requestId,null,count,unitIds)
    outcomes.push(outcome)
    return outcome.result.affectedUnitIds!
  }
  if(command.action==='handoff'){
    handoffResult=await executeKitchenHandoff(tx,context,command,eventKey,stationCode)
    batchId=handoffResult.batchId;released=handoffResult.released
  }else if(command.action==='start'||command.action==='quick-ready'){
    if((stationCode==='bar'?options.barEnabled:options.enabled)!==true)conflict('新增制作批次已暂停，已有批次仍可出锅、分盘或恢复原结果','KITCHEN_ADMISSION_PAUSED')
    await lockQuantityTaskOrders(tx,command.items.map(item=>item.taskId))
    const sources=await readKitchenSources(tx,context.employeeId,context.businessDate,stationCode)
    const chosen=command.items.map(selection=>{
      const source=sources.find(item=>item.taskId===selection.taskId)
      if(!source||!source.eligible||!source.canPrepare||source.unmade<selection.quantity||source.unmade!==selection.expectedUnmade)conflict('待制作份数或接单员工已改变，请重新核对原订单')
      assertLocation(source!,selection)
      if(kitchenCompatibilityKey(source!)!==command.compatibilityKey)conflict('菜品、规格或备注已改变，不能合入本批')
      return {...source!,quantity:selection.quantity}
    })
    const first=chosen[0]!
    quantity=chosen.reduce((sum,item)=>sum+item.quantity,0)
    batchId=randomUUID()
    released=command.action==='quick-ready'||command.equipment===null
    // The unique index arbitrates two cooks choosing the same physical device concurrently.
    const inserted=await tx.query<{id:string}>(`INSERT INTO mbox.kitchen_production_batches
      (id,tenant_id,store_id,product_id,product_name,specification,item_note,order_note,created_by_employee_id,started_at,anchor_at,equipment,released_at,expected_seconds,original_quantity,station_code)
      VALUES($3,$1,$2,$4,$5,$6,$7,$8,$9,CASE WHEN $10 THEN clock_timestamp() END,$11,$12,CASE WHEN $13 THEN clock_timestamp() END,$14,$15,$16)
      ON CONFLICT(tenant_id,store_id,station_code,equipment_key) WHERE equipment_key IS NOT NULL AND released_at IS NULL DO NOTHING RETURNING id`,
    [...scope,batchId,first.productId,first.productName,first.specification,first.itemNote,first.orderNote,context.employeeId,command.action==='start',chosen.map(item=>item.orderCreatedAt).sort()[0],command.equipment,released,command.expectedSeconds,quantity,stationCode])
    if(inserted.rowCount!==1)conflict('该设备仍有在制批次，实际出锅后释放，或选择另一台设备','KITCHEN_EQUIPMENT_BUSY')
    for(const item of [...chosen].sort((a,b)=>a.taskId.localeCompare(b.taskId))){
      // Direct readiness acts on the selected unmade portions, never legacy work
      // already started outside this board. Parent locks keep this selection stable.
      const exact=command.action==='quick-ready'?await unmadeSelection(tx,item.itemId,item.quantity):undefined
      const unitIds=await transition(item.taskId,command.action==='start'?'start':'complete',item.quantity,exact)
      await tx.query(`INSERT INTO mbox.kitchen_production_units(tenant_id,store_id,batch_id,unit_id,kds_task_id,original_table_code)
        SELECT $1,$2,$3,id,$4,$5 FROM unnest($6::uuid[]) AS id`,[...scope,batchId,item.taskId,item.tableCode,unitIds])
    }
  }else{
    batchId='batchId' in command?command.batchId:conflict('请核对原制作操作')
    const before=(await readKitchenBatches(tx,batchId,stationCode))[0]
    if(!before)throw new CommerceKdsRequestError('KITCHEN_BATCH_NOT_FOUND','未找到原制作批次',404)
    await lockQuantityTaskOrders(tx,[...new Set(before.units.map(unit=>unit.taskId))])
    await tx.query('SELECT id FROM mbox.kitchen_production_batches WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...scope,batchId])
    const batch=(await readKitchenBatches(tx,batchId,stationCode))[0]!
    if(batch.employeeId!==context.employeeId||(('expectedOwnershipVersion' in command?command.expectedOwnershipVersion:0)??0)!==batch.ownershipVersion)conflict('该批负责人已改变，请重新核对接班后的批次','KITCHEN_OWNER_CHANGED')
    released=batch.releasedAt!==null
    if(command.action==='ready'){
      for(const item of [...command.items].sort((a,b)=>a.taskId.localeCompare(b.taskId))){
        const selected=batch.units.filter(unit=>item.unitIds.includes(unit.unitId)&&unit.taskId===item.taskId)
        if(selected.length!==item.unitIds.length||selected.some(unit=>unit.held||unit.stopped||unit.state!=='started'))conflict('原批次已有暂停、停止或完成的份数，请核对后重新选择')
        for(const unit of selected)assertLocation(unit,item)
        await transition(item.taskId,'complete',selected.length,item.unitIds)
        quantity+=selected.length
      }
      const after=(await readKitchenBatches(tx,batchId,stationCode))[0]!
      released=released||after.units.every(unit=>!unit.held&&!unit.stopped&&['ready','delivered'].includes(unit.state))
    }else{
      // Timers, cancellations and session closure never assert that a device was physically emptied.
      released=true
    }
    if(released&&!batch.releasedAt)await tx.query('UPDATE mbox.kitchen_production_batches SET released_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope,batchId])
  }
  const result:KitchenCommandResult=handoffResult??{batchId,action:command.action,quantity,released}
  await tx.query(`INSERT INTO mbox.kitchen_production_receipts(tenant_id,store_id,employee_id,operation_key,request_body,result) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,[...scope,context.employeeId,receiptKey,JSON.stringify(command),JSON.stringify(result)])
  return {result,auditEvents:[...outcomes.flatMap(outcome=>outcome.auditEvents),{actor:{type:'employee',employeeId:context.employeeId},action:`${stationCode}.${command.action}`,objectType:'kitchen_production_batch',objectId:batchId,businessDate:context.businessDate,requestId,afterData:{...result,stationCode,command:command as unknown as JsonValue}}],outboxMessages:outcomes.flatMap(outcome=>outcome.outboxMessages)}
}

async function unmadeSelection(tx:ScopedTransaction,itemId:string,quantity:number){
  await new ItemQuantityRepository(tx).initialize(itemId)
  const result=await tx.query<{id:string}>(`SELECT unit.id FROM mbox.order_item_quantity_units unit
    WHERE unit.tenant_id=$1 AND unit.store_id=$2 AND unit.order_item_id=$3
      AND unit.production_state='unmade' AND unit.held_by_case_id IS NULL AND NOT unit.operationally_stopped
      AND NOT EXISTS(SELECT 1 FROM mbox.kitchen_production_units bound
        WHERE (bound.tenant_id,bound.store_id,bound.unit_id)=(unit.tenant_id,unit.store_id,unit.id))
      AND NOT EXISTS(SELECT 1 FROM mbox.quantity_remake_units remake
        WHERE (remake.tenant_id,remake.store_id,remake.unit_id)=(unit.tenant_id,unit.store_id,unit.id))
    ORDER BY unit.unit_index LIMIT $4`,[tx.scope.tenantId,tx.scope.storeId,itemId,quantity])
  if(result.rows.length!==quantity)conflict('待制作份数已改变，请重新核对原订单')
  return result.rows.map(unit=>unit.id)
}

function assertLocation(current:KitchenDestination,expected:Pick<KitchenDestination,'tableId'|'tableSessionId'|'locationVersion'>){
  if(current.tableId!==expected.tableId||current.tableSessionId!==expected.tableSessionId||current.locationVersion!==expected.locationVersion)conflict(`订单已移动到${current.tableCode}，请核对新桌号再操作`,'KITCHEN_TABLE_MOVED')
}
function parseStation(value:unknown):ProductionStation{if(value===undefined)return 'kitchen';if(value==='kitchen'||value==='bar')return value;throw new TypeError('请选择酒水或后厨制作岗位')}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('请提交完整的制作操作');return value as Record<string,unknown>}
function uuid(value:unknown):string{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw new TypeError('原订单标识无效');return value}
function integer(value:unknown,min:number,max:number):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new TypeError('请选择有效的实际份数或时间');return value}
function selections(value:unknown,exact:boolean){
  if(!Array.isArray(value)||value.length<1||value.length>50)throw new TypeError('每批请选择1至50个原订单品项')
  const taskIds=new Set<string>(),allUnits=new Set<string>()
  const rows=value.map(raw=>{const item=object(raw),taskId=uuid(item.taskId)
    if(taskIds.has(taskId))throw new TypeError('同一原订单品项不能重复选择');taskIds.add(taskId)
    const base={taskId,tableId:uuid(item.tableId),tableSessionId:uuid(item.tableSessionId),locationVersion:integer(item.locationVersion,0,Number.MAX_SAFE_INTEGER)}
    if(exact){if(!Array.isArray(item.unitIds)||item.unitIds.length<1||item.unitIds.length>999)throw new TypeError('请选择原批次待分盘的份数')
      const unitIds=item.unitIds.map(value=>{const id=uuid(value);if(allUnits.has(id))throw new TypeError('同一份菜不能重复选择');allUnits.add(id);return id})
      return {...base,unitIds,quantity:unitIds.length,expectedUnmade:0}}
    return {...base,quantity:integer(item.quantity,1,999),expectedUnmade:integer(item.expectedUnmade,1,999),unitIds:[]}
  })
  if(rows.reduce((sum,item)=>sum+item.quantity,0)>999)throw new TypeError('单批份数不能超过999，请按实际设备容量分批')
  return rows
}
export function parseKitchenCommand(value:unknown):KitchenCommand {
  const body=object(value)
  const version=body.expectedOwnershipVersion===undefined?{}:{expectedOwnershipVersion:integer(body.expectedOwnershipVersion,0,Number.MAX_SAFE_INTEGER-1)}
  if(body.action==='handoff'){
    if(body.physicalChecked!==true||typeof body.reason!=='string'||body.reason.trim().length<2||body.reason.trim().length>1000)throw new TypeError('请核对实物并填写接班原因')
    if(!Array.isArray(body.expectedBatches)||!Array.isArray(body.expectedTasks)||body.expectedBatches.length<1||body.expectedTasks.length<1||body.expectedBatches.length>500||body.expectedTasks.length>500)throw new TypeError('接班范围无效，请重新读取')
    const expectedBatches=body.expectedBatches.map(raw=>{const row=object(raw);return {batchId:uuid(row.batchId),expectedCurrentOwnerId:uuid(row.expectedCurrentOwnerId),expectedOwnershipVersion:integer(row.expectedOwnershipVersion,0,Number.MAX_SAFE_INTEGER-1)}})
    const expectedTasks=body.expectedTasks.map(raw=>{const row=object(raw);return {taskId:uuid(row.taskId),expectedEmployeeId:row.expectedEmployeeId===null?null:uuid(row.expectedEmployeeId)}})
    if(new Set(expectedBatches.map(row=>row.batchId)).size!==expectedBatches.length||new Set(expectedTasks.map(row=>row.taskId)).size!==expectedTasks.length)throw new TypeError('接班范围不能重复')
    return {action:'handoff',batchId:uuid(body.batchId),expectedBatches,expectedTasks,physicalChecked:true,reason:body.reason.trim()}
  }
  if(body.action==='release')return {action:'release',batchId:uuid(body.batchId),...version}
  if(body.action==='ready')return {action:'ready',batchId:uuid(body.batchId),...version,items:selections(body.items,true).map(({quantity:_quantity,expectedUnmade:_expectedUnmade,...item})=>item)}
  if(body.action!=='start'&&body.action!=='quick-ready')throw new TypeError('请选择开始制作、实际出锅或备齐')
  if(typeof body.compatibilityKey!=='string'||body.compatibilityKey.length>10000)throw new TypeError('菜品分组信息无效')
  const equipment=body.equipment===null?null:typeof body.equipment==='string'?body.equipment.trim():undefined
  if(equipment===undefined||equipment!==null&&(!equipment.length||equipment.length>40))throw new TypeError('请填写实际设备编号，或选择无需设备')
  const expectedSeconds=body.expectedSeconds===null?null:integer(body.expectedSeconds,1,36000)
  if(body.action==='quick-ready'&&(equipment!==null||expectedSeconds!==null))throw new TypeError('直接备齐不登记加热设备或预计时长')
  return {action:body.action,compatibilityKey:body.compatibilityKey,items:selections(body.items,false).map(({unitIds:_unitIds,...item})=>item),equipment,expectedSeconds}
}
