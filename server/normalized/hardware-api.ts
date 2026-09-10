import { createHash, randomUUID } from 'node:crypto'
import { PRINT_TICKET_KINDS } from '../../src/shared/print-ticket-policy.js'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
  appendOutboxMessage,
  type JsonCodec,
  type JsonObject,
  type NormalizedCommandExecutor,
} from './command-executor.js'
import {
  HardwareConflictError,
  HardwareNotFoundError,
  HardwarePolicyError,
  HardwareRepository,
  type DeviceStation,
  type HardwareStation,
  type PrintJobStatus,
} from './hardware-repository.js'
import type { NormalizedOperationsRequestContext } from './normalized-operations-api.js'
import { NormalizedAuthenticationRequiredError } from './normalized-request-context.js'
import { StaffSessionNotFoundError } from './staff-session-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction } from './transaction-runner.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {orderHistoryAccess} from './order-history-access.js'
import {PrintTicketSourceRepository} from './print-ticket-source.js'
import {DeliveryBatchRepository} from './delivery-batch-repository.js'
import {OrderStockReturnRepository} from './order-stock-return-repository.js'
import {InventoryConflictError} from './inventory-repository.js'
import {assertEmployeeTableSessionAccess, EmployeeTableAccessDeniedError} from './employee-table-access.js'

type TransactionPort = Pick<ScopedPostgresTransactionRunner, 'run'>
type CommandPort = Pick<NormalizedCommandExecutor, 'execute'>

export interface HardwareApiOptions {
  transactions: TransactionPort
  commands: CommandPort
  resolveContext(request: FastifyRequest): Promise<NormalizedOperationsRequestContext> | NormalizedOperationsRequestContext
  createRepository?(transaction: ScopedTransaction): HardwareRepository
}

class HardwareRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HardwareRequestError'
  }
}

class HardwareAccessDeniedError extends Error {
  constructor() {
    super('当前岗位无权执行此操作')
    this.name = 'HardwareAccessDeniedError'
  }
}

export const hardwareApiPlugin: FastifyPluginAsync<HardwareApiOptions> = async (app, options) => {
  app.post('/operations/delivery-batches',async(request,reply)=>handle(reply,async()=>{
    const context=await options.resolveContext(request),body=readObject(request.body)
    requireAny(context,['kds.deliver'])
    if(!Array.isArray(body.items))throw new HardwareRequestError('请选择配送菜品')
    const items=body.items.map(value=>{const item=readObject(value);return {taskId:readUuid(item.taskId,'taskId'),quantity:optionalInteger(item.quantity,1,9999)??0}})
    const result=await options.commands.execute(command(request,context,'delivery.batch.create',body,codec()),async tx=>{
      const access=await new StaffAccessRepository(tx).resolve(context.employeeId)
      if(!access.permissions.includes('kds.deliver'))throw new HardwareAccessDeniedError()
      const batch=await new DeliveryBatchRepository(tx).create(context.employeeId,items)
      await assertEmployeeTableSessionAccess(tx,{employeeId:context.employeeId,tableSessionId:batch.tableSessionId,allTablePermissionCodes:['kds.deliver'],requiredPermissionCodes:['kds.deliver']})
      return outcome(context,'delivery.batch.ready.v1','delivery_batch',batch.id,'确认本批备齐',batch)
    })
    return reply.code(result.replayed?200:202).send({data:result.value,replayed:result.replayed})
  }))
  app.post('/operations/order-items/:itemId/stock-return',async(request,reply)=>handle(reply,async()=>{
    const context=await options.resolveContext(request),body=readObject(request.body)
    requireAny(context,['inventory.receive'])
    const itemId=readUuid(readObject(request.params).itemId,'itemId')
    const result=await options.commands.execute(command(request,context,'order.stock-return',body,codec()),async tx=>{
      const access=await new StaffAccessRepository(tx).resolve(context.employeeId)
      if(!access.permissions.includes('inventory.receive'))throw new HardwareAccessDeniedError()
      if(!access.permissions.some(p=>['order.history.view','order.history.all','reconciliation.view'].includes(p)))throw new HardwareAccessDeniedError()
      const date=(await tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text AS date',[context.scope.tenantId,context.scope.storeId])).rows[0]!.date
      const earliest=orderHistoryAccess(access.permissions,date).earliestBusinessDate
      const visible=(await tx.query<{id:string}>(`SELECT item.id FROM mbox.order_items item JOIN mbox.orders o ON o.tenant_id=item.tenant_id AND o.store_id=item.store_id AND o.id=item.order_id
        WHERE item.tenant_id=$1 AND item.store_id=$2 AND item.id=$3 AND ($4::date IS NULL OR o.business_date>=$4::date
        OR (o.status<>'cancelled' AND o.total_amount_minor>0 AND o.payment_status IN ('unpaid','pending','partially_paid'))
        OR EXISTS(SELECT 1 FROM mbox.refunds r JOIN mbox.payments p ON p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=r.payment_id
          WHERE p.tenant_id=o.tenant_id AND p.store_id=o.store_id AND p.order_id=o.id AND r.status IN ('requested','approved','processing','failed')))`,
      [context.scope.tenantId,context.scope.storeId,itemId,earliest])).rows[0]
      if(!visible)throw new HardwareAccessDeniedError()
      try{
        const value=await new OrderStockReturnRepository(tx).record({orderItemId:itemId,employeeId:context.employeeId,
          quantity:optionalInteger(body.quantity,1,9999)??0,disposition:readEnum(body.disposition,['unmade','returned_unopened']) as 'unmade'|'returned_unopened',
          reason:readString(body.reason,'reason',1000,3),unopenedConfirmed:body.unopenedConfirmed===true})
        return outcome(context,'order.stock-return.recorded.v1','order_stock_return',value.id,body.reason,value)
      }catch(error){if(error instanceof InventoryConflictError)throw new HardwareConflictError(error.message);throw error}
    })
    return reply.code(result.replayed?200:201).send({data:result.value,replayed:result.replayed})
  }))
  app.post('/hardware/orders/:orderId/bill',async(request,reply)=>handle(reply,async()=>{
    const context=await options.resolveContext(request)
    requireAny(context,['order.bill.print'])
    const orderId=readUuid(readObject(request.params).orderId,'orderId'),body=readObject(request.body??{})
    const execution=await options.commands.execute(command(request,context,'order.bill.print',body,codec()),async tx=>{
      const access=await new StaffAccessRepository(tx).resolve(context.employeeId)
      if(!access.permissions.includes('order.bill.print')||!access.permissions.some(p=>['order.history.view','order.history.all','reconciliation.view'].includes(p)))throw new HardwareAccessDeniedError()
      const current=(await tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text AS date',[context.scope.tenantId,context.scope.storeId])).rows[0]!.date
      const policy=orderHistoryAccess(access.permissions,current)
      const visible=(await tx.query<{id:string}>(`
        SELECT o.id FROM mbox.orders o WHERE o.tenant_id=$1 AND o.store_id=$2 AND o.id=$3 AND o.status<>'draft'
          AND ($4::date IS NULL OR o.business_date>=$4::date
            OR (o.status<>'cancelled' AND o.total_amount_minor>0 AND o.payment_status IN ('unpaid','pending','partially_paid'))
            OR EXISTS(SELECT 1 FROM mbox.refunds r JOIN mbox.payments p ON p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=r.payment_id
              WHERE p.tenant_id=o.tenant_id AND p.store_id=o.store_id AND p.order_id=o.id AND r.status IN ('requested','approved','processing','failed')))`,
      [context.scope.tenantId,context.scope.storeId,orderId,policy.earliestBusinessDate])).rows[0]
      if(!visible)throw new HardwareAccessDeniedError()
      const requestId=randomUUID()
      const sourceId=await appendOutboxMessage(tx,{aggregateType:'manual_print_request',aggregateId:requestId,aggregateVersion:1,
        eventType:'manual.order-bill.requested.v1',payload:{orderId,employeeId:context.employeeId}})
      const jobs=await new PrintTicketSourceRepository(tx,true).materializeManualOrderBill(sourceId,orderId,access.displayName)
      if(!jobs.length)throw new HardwarePolicyError('当前没有可用的账单打印路由；订单和收款未受影响')
      return outcome(context,'manual.order-bill.queued.v1','manual_print_request',requestId,'订单中心手动打印',
        {requestId,orderId,jobIds:jobs.map(job=>job.id),status:'queued'})
    })
    return reply.code(execution.replayed?200:202).send({data:execution.value,replayed:execution.replayed})
  }))
  app.get('/hardware/print-ticket-policies', async (request,reply) => handle(reply,async()=>{
    const context=await options.resolveContext(request)
    requireAny(context,['hardware.manage','printer.manage'])
    const rows=await options.transactions.run(context.scope,async tx=>(await tx.query<{ticketKind:string;enabled:boolean;copies:number}>(`
      SELECT ticket_kind AS "ticketKind",enabled,copies FROM mbox.print_ticket_policies WHERE tenant_id=$1 AND store_id=$2`,
    [context.scope.tenantId,context.scope.storeId])).rows,{readOnly:true})
    return reply.send({data:PRINT_TICKET_KINDS.map(ticketKind=>rows.find(row=>row.ticketKind===ticketKind)??{ticketKind,enabled:true,copies:null})})
  }))

  app.post('/hardware/print-ticket-policies', async (request,reply) => handle(reply,async()=>{
    const context=await options.resolveContext(request)
    requireAny(context,['hardware.manage','printer.manage'])
    const body=readObject(request.body)
    const ticketKind=readEnum(body.ticketKind,[...PRINT_TICKET_KINDS])
    if(typeof body.enabled!=='boolean')throw new HardwareRequestError('enabled必须为布尔值')
    const enabled=body.enabled,copies=optionalInteger(body.copies,1,5)
    if(copies===undefined)throw new HardwareRequestError('请指定1至5份')
    const reason=readString(body.reason,'reason',1000,3)
    const execution=await options.commands.execute(command(request,context,'print.ticket-policy.update',body,codec()),async tx=>{
      const before=(await tx.query(`SELECT enabled,copies FROM mbox.print_ticket_policies WHERE tenant_id=$1 AND store_id=$2 AND ticket_kind=$3 FOR UPDATE`,
        [context.scope.tenantId,context.scope.storeId,ticketKind])).rows[0]
      await tx.query(`INSERT INTO mbox.print_ticket_policies(tenant_id,store_id,ticket_kind,enabled,copies)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,store_id,ticket_kind) DO UPDATE
        SET enabled=EXCLUDED.enabled,copies=EXCLUDED.copies,updated_at=clock_timestamp()`,
      [context.scope.tenantId,context.scope.storeId,ticketKind,enabled,copies])
      return outcome(context,'print.ticket-policy.updated.v1','store',context.scope.storeId,reason,{ticketKind,enabled,copies},before)
    })
    return reply.send({data:execution.value,replayed:execution.replayed})
  }))

  const repository = (transaction: ScopedTransaction) => (
    options.createRepository?.(transaction) ?? new HardwareRepository(transaction)
  )

  app.get('/hardware/devices', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveContext(request)
    requireAny(context, ['hardware.view', 'hardware.view_all', 'hardware.command', 'hardware.manage', 'printer.manage'])
    const printerManagerOnly = hasCapability(context, 'printer.manage')
      && !hasAnyCapability(context, ['hardware.view', 'hardware.view_all', 'hardware.command', 'hardware.manage'])
    const stations = printerManagerOnly ? undefined : deviceStationsFor(context)
    const data = await options.transactions.run(
      context.scope,
      (transaction) => repository(transaction).listDevices(stations),
      { readOnly: true },
    )
    return reply.send({ data: printerManagerOnly ? data.filter((device) => device.deviceType === 'printer') : data })
  }))

  app.get('/hardware/print-jobs', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveContext(request)
    requireAny(context, ['print.view', 'print.view_all', 'print.reprint', 'hardware.manage', 'printer.manage'])
    const stations = printStationsFor(context)
    const query = readObject(request.query ?? {})
    const requestedStation = optionalEnum(query.station, ['bar', 'kitchen', 'cashier']) as HardwareStation | undefined
    if (requestedStation && !stations.includes(requestedStation)) throw new HardwareAccessDeniedError()
    const statuses = optionalCsv(query.status, ['pending', 'printing', 'printed', 'failed', 'dead', 'cancelled']) as PrintJobStatus[] | undefined
    const data = await options.transactions.run(
      context.scope,
      (transaction) => repository(transaction).listPrintJobs({
        stations: requestedStation ? [requestedStation] : stations,
        statuses,
        limit: optionalInteger(query.limit, 1, 200),
      }),
      { readOnly: true },
    )
    return reply.send({ data })
  }))

  app.get('/hardware/print-sources', async (request, reply) => handle(reply, async () => {
    const context=await options.resolveContext(request)
    requireAny(context,['hardware.manage','printer.manage'])
    const data=await options.transactions.run(context.scope,async tx=>(await tx.query(`
      SELECT id,ticket_kind AS "ticketKind",status,attempts,last_error_code AS "lastErrorCode",
        created_at::text AS "createdAt",next_attempt_at::text AS "nextAttemptAt",job_count AS "jobCount"
      FROM mbox.print_source_jobs WHERE tenant_id=$1 AND store_id=$2
        AND status IN ('pending','retry','dead','skipped')
      ORDER BY CASE status WHEN 'dead' THEN 0 WHEN 'retry' THEN 1 ELSE 2 END,created_at DESC,id LIMIT 50`,
      [context.scope.tenantId,context.scope.storeId])).rows,{readOnly:true})
    return reply.send({data})
  }))

  app.post('/hardware/print-sources/:sourceId/retry', async (request, reply) => handle(reply, async () => {
    const context=await options.resolveContext(request)
    requireAny(context,['hardware.manage','printer.manage'])
    const body=readObject(request.body),sourceId=readUuid(readObject(request.params).sourceId,'sourceId')
    const reason=readString(body.reason,'reason',1000,3)
    const execution=await options.commands.execute(command(request,context,'print.source.retry',body,codec()),async tx=>{
      const updated=await tx.query<{id:string}>(`UPDATE mbox.print_source_jobs SET status='pending',attempts=0,
        next_attempt_at=clock_timestamp(),last_error_code=NULL
        WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status IN ('retry','dead') RETURNING id`,
        [context.scope.tenantId,context.scope.storeId,sourceId])
      if(!updated.rows[0])throw new HardwareConflictError('仅失败的票据生成任务可重试；已完成或已跳过的任务不可重复生成')
      return outcome(context,'print.source.retried.v1','print_source',sourceId,reason,{id:sourceId,status:'pending'})
    })
    return reply.send({data:execution.value,replayed:execution.replayed})
  }))

  app.get('/hardware/printer-routes', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveContext(request)
    requireAny(context, ['hardware.view_all', 'hardware.manage', 'printer.manage'])
    const data = await options.transactions.run(
      context.scope,
      (transaction) => repository(transaction).listPrinterRoutes(),
      { readOnly: true },
    )
    return reply.send({ data })
  }))

  app.get('/hardware/work', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveContext(request)
    const stations = printStationsFor(context)
    const includeDelivery = context.capabilities.includes('work.delivery')
    if (stations.length === 0 && !includeDelivery) throw new HardwareAccessDeniedError()
    const data = await options.transactions.run(context.scope, async (transaction) => {
      const store = repository(transaction)
      return {
        production: stations.length > 0
          ? await store.listPrintJobs({ stations, statuses: ['pending', 'printing', 'failed', 'dead'], limit: 100 })
          : [],
        delivery: includeDelivery ? await store.listDeliveryWork(100) : [],
      }
    }, { readOnly: true })
    return reply.send({ data })
  }))

  app.post('/hardware/devices', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveContext(request)
    const body = readObject(request.body)
    const reason = readString(body.reason, 'reason', 1000, 3)
    const deviceType = readEnum(body.deviceType, ['printer', 'kds_display', 'cash_drawer', 'headset', 'controller'])
    requireAny(context, ['hardware.manage', 'printer.manage'])
    if (!hasCapability(context, 'hardware.manage') && deviceType !== 'printer') throw new HardwareAccessDeniedError()
    const execution = await options.commands.execute(command(request, context, 'hardware.device.create', body, codec()), async (transaction) => {
      const result = await repository(transaction).createDevice({
        code: readString(body.code, 'code', 64),
        name: readString(body.name, 'name', 120),
        deviceType: deviceType as never,
        stationCode: optionalEnum(body.stationCode, ['bar', 'kitchen', 'cashier', 'service']) as DeviceStation | undefined,
        capabilities: optionalStringArray(body.capabilities),
        configSnapshot: optionalObject(body.configSnapshot),
        printBridgeId: optionalUuid(body.printBridgeId, 'printBridgeId'),
        windowsQueueName: optionalString(body.windowsQueueName, 'windowsQueueName', 180),
        printProfile: optionalEnum(body.printProfile, ['escpos_58', 'escpos_80', 'windows_text']) as never,
      })
      return outcome(context, 'hardware.device.created.v1', 'device', result.id, reason, result)
    })
    return reply.code(execution.replayed ? 200 : 201).send({ data: execution.value, replayed: execution.replayed })
  }))

  app.patch('/hardware/devices/:deviceId', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveContext(request)
    const body = readObject(request.body)
    const reason = readString(body.reason, 'reason', 1000, 3)
    requireAny(context, ['hardware.manage', 'printer.manage'])
    const printerManagerOnly = hasCapability(context, 'printer.manage') && !hasCapability(context, 'hardware.manage')
    const execution = await options.commands.execute(command(request, context, 'hardware.device.update', body, codec()), async (transaction) => {
      const changed = await repository(transaction).updateDevice({
        id: readUuid(readObject(request.params).deviceId, 'deviceId'),
        name: optionalString(body.name, 'name', 120),
        stationCode: optionalEnum(body.stationCode, ['bar', 'kitchen', 'cashier', 'service']) as DeviceStation | undefined,
        status: optionalEnum(body.status, ['active', 'paused', 'retired']) as never,
        printBridgeId: optionalUuid(body.printBridgeId, 'printBridgeId'),
        windowsQueueName: optionalString(body.windowsQueueName, 'windowsQueueName', 180),
        printProfile: optionalEnum(body.printProfile, ['escpos_58', 'escpos_80', 'windows_text']) as never,
        printerOnly: printerManagerOnly,
      })
      return outcome(
        context,
        'hardware.device.updated.v1',
        'device',
        changed.device.id,
        reason,
        changed.device,
        changed.before,
      )
    })
    return reply.send({ data: execution.value, replayed: execution.replayed })
  }))

  app.put('/hardware/printer-routes/:routeCode', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveContext(request)
    requireAny(context, ['hardware.manage', 'printer.manage'])
    const body = readObject(request.body)
    const reason = readString(body.reason, 'reason', 1000, 3)
    const routeCode = readString(readObject(request.params).routeCode, 'routeCode', 64)
    const execution = await options.commands.execute(command(request, context, 'hardware.route.upsert', body, codec()), async (transaction) => {
      const store = repository(transaction)
      const before = await store.getPrinterRouteByCode(routeCode, true)
      const result = await store.upsertPrinterRoute({
        code: routeCode,
        name: readString(body.name, 'name', 120),
        stationCode: readEnum(body.stationCode, ['bar', 'kitchen', 'cashier']) as HardwareStation,
        productCategoryCode: optionalString(body.productCategoryCode, 'productCategoryCode', 64),
        printerDeviceId: readUuid(body.printerDeviceId, 'printerDeviceId'),
        copies: optionalInteger(body.copies, 1, 5),
        priority: optionalInteger(body.priority, 0, 1000),
        status: optionalEnum(body.status, ['active', 'paused', 'retired']) as never,
      })
      return outcome(context, 'hardware.route.configured.v1', 'printer_route', result.id, reason, result, before ?? undefined)
    })
    return reply.send({ data: execution.value, replayed: execution.replayed })
  }))

  app.post('/hardware/print-jobs/:jobId/retry', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveContext(request)
    requireAny(context, ['print.retry', 'printer.manage'])
    const body = readObject(request.body)
    const reason = readString(body.reason, 'reason', 1000, 3)
    const jobId = readUuid(readObject(request.params).jobId, 'jobId')
    const execution = await options.commands.execute(command(request, context, 'print.job.retry', body, codec()), async (transaction) => {
      const original=await repository(transaction).getById(jobId)
      if(!original)throw new HardwareNotFoundError('打印任务不存在')
      if(!printStationsFor(context).includes(original.stationCode))throw new HardwareAccessDeniedError()
      const result = await repository(transaction).retryPrintJob(jobId, context.employeeId, reason)
      return outcome(context, 'print.job.manual_retry.v1', 'print_job', result.id, reason, result)
    })
    return reply.send({ data: execution.value, replayed: execution.replayed })
  }))

  app.post('/hardware/print-jobs/:jobId/reprint', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveContext(request)
    requireAny(context, ['print.reprint', 'printer.manage'])
    const body = readObject(request.body)
    const reason = readString(body.reason, 'reason', 1000, 3)
    const jobId = readUuid(readObject(request.params).jobId, 'jobId')
    const execution = await options.commands.execute(command(request, context, 'print.job.reprint', body, codec()), async (transaction) => {
      const store = repository(transaction)
      const original = await store.getById(jobId)
      if (!original) throw new HardwareNotFoundError('打印任务不存在')
      if (!printStationsFor(context).includes(original.stationCode)) throw new HardwareAccessDeniedError()
      const result = await store.reprintPrintJob(
        jobId,
        context.employeeId,
        reason,
        commandIdempotencyKey(request),
      )
      return outcome(context, 'print.job.reprinted.v1', 'print_job', result.id, reason, result)
    })
    return reply.send({ data: execution.value, replayed: execution.replayed })
  }))

  app.post('/hardware/devices/:deviceId/commands', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveContext(request)
    const body = readObject(request.body)
    const commandType = readEnum(body.commandType, ['test_print', 'reconnect', 'ping', 'open_cash_drawer', 'restart'])
    const printerManagerOnly = hasCapability(context, 'printer.manage') && !hasCapability(context, 'hardware.command')
    requireAny(context, ['hardware.command', 'printer.manage'])
    if (printerManagerOnly && !['test_print', 'reconnect', 'ping'].includes(commandType)) throw new HardwareAccessDeniedError()
    const reason = readString(body.reason, 'reason', 1000, 3)
    const execution = await options.commands.execute(command(request, context, 'hardware.command.request', body, codec()), async (transaction) => {
      const result = await repository(transaction).requestHardwareCommand({
        publicId: `hardware-command-${randomUUID()}`,
        deviceId: readUuid(readObject(request.params).deviceId, 'deviceId'),
        commandType: commandType as never,
        requestedByEmployeeId: context.employeeId,
        reason,
        payloadSnapshot: optionalObject(body.payloadSnapshot),
        printerOnly: printerManagerOnly,
      })
      return outcome(context, 'hardware.command.requested.v1', 'hardware_command', result.id, reason, result)
    })
    return reply.code(execution.replayed ? 200 : 202).send({ data: execution.value, replayed: execution.replayed })
  }))
}

function command<Result>(
  request: FastifyRequest,
  context: NormalizedOperationsRequestContext,
  operationScope: string,
  body: Record<string, unknown>,
  resultCodec: JsonCodec<Result>,
) {
  const value = request.headers['idempotency-key'] ?? request.headers['x-idempotency-key']
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(value)) {
    throw new HardwareRequestError('缺少有效的幂等键')
  }
  return {
    scope: context.scope,
    operationScope,
    idempotencyKey: value,
    requestFingerprint: createHash('sha256').update(JSON.stringify({
      employeeId: context.employeeId,
      method: request.method,
      url: request.url,
      body,
    })).digest('hex'),
    resultCodec,
  }
}

function outcome(
  context: NormalizedOperationsRequestContext,
  eventType: string,
  objectType: string,
  objectId: string,
  reasonValue: unknown,
  result: object,
  before?: object,
) {
  const reason = typeof reasonValue === 'string' && reasonValue.trim() ? reasonValue.trim() : '现场设备配置'
  return {
    result: result as Record<string, unknown>,
    auditEvents: [{
      actor: { type: 'employee' as const, employeeId: context.employeeId },
      action: eventType,
      objectType,
      objectId,
      businessDate: context.businessDate,
      reason,
      ...(before === undefined ? {} : { beforeData: before as JsonObject }),
      afterData: result as JsonObject,
    }],
    outboxMessages: [{
      aggregateType: objectType,
      aggregateId: objectId,
      aggregateVersion: 1,
      eventType,
      payload: { id: objectId },
    }],
  }
}

function deviceStationsFor(context: NormalizedOperationsRequestContext): DeviceStation[] | undefined {
  if (context.capabilities.includes('hardware.view_all') || context.capabilities.includes('hardware.manage')) return undefined
  const stations: DeviceStation[] = []
  if (context.capabilities.includes('work.bar')) stations.push('bar')
  if (context.capabilities.includes('work.kitchen')) stations.push('kitchen')
  if (context.capabilities.includes('work.cashier')) stations.push('cashier')
  if (context.capabilities.includes('work.delivery')) stations.push('service')
  return stations
}

function printStationsFor(context: NormalizedOperationsRequestContext): HardwareStation[] {
  if (context.capabilities.includes('print.view_all') || context.capabilities.includes('printer.manage')
    || context.capabilities.includes('hardware.manage')) return ['bar', 'kitchen', 'cashier']
  const stations: HardwareStation[] = []
  if (context.capabilities.includes('work.bar')) stations.push('bar')
  if (context.capabilities.includes('work.kitchen')) stations.push('kitchen')
  if (context.capabilities.includes('work.cashier')) stations.push('cashier')
  if (context.capabilities.includes('print.reprint')) stations.push('cashier')
  return stations
}

function commandIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'] ?? request.headers['x-idempotency-key']
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(value)) {
    throw new HardwareRequestError('缺少有效的幂等键')
  }
  return value
}

function requireAny(context: NormalizedOperationsRequestContext, capabilities: readonly string[]) {
  if (!hasAnyCapability(context, capabilities)) throw new HardwareAccessDeniedError()
}

function hasCapability(context: NormalizedOperationsRequestContext, capability: string) {
  return context.capabilities.includes(capability)
}

function hasAnyCapability(context: NormalizedOperationsRequestContext, capabilities: readonly string[]) {
  return capabilities.some((capability) => hasCapability(context, capability))
}

function codec<Result extends Record<string, unknown>>(): JsonCodec<Result> {
  return {
    encode: (value) => value as JsonObject,
    decode: (value) => readObject(value) as Result,
  }
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HardwareRequestError('请求数据格式无效')
  return value as Record<string, unknown>
}

function optionalObject(value: unknown): JsonObject | undefined {
  if (value === undefined || value === null) return undefined
  return readObject(value) as JsonObject
}

function readString(value: unknown, field: string, maximum: number, minimum = 1) {
  if (typeof value !== 'string') throw new HardwareRequestError(`${field}格式无效`)
  const normalized = value.trim()
  if (normalized.length < minimum || normalized.length > maximum) throw new HardwareRequestError(`${field}格式无效`)
  return normalized
}

function optionalString(value: unknown, field: string, maximum: number) {
  if (value === undefined || value === null || value === '') return undefined
  return readString(value, field, maximum)
}

function readUuid(value: unknown, field: string) {
  const normalized = readString(value, field, 36, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new HardwareRequestError(`${field}格式无效`)
  }
  return normalized
}

function optionalUuid(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return undefined
  return readUuid(value, field)
}

function readEnum(value: unknown, choices: readonly string[]) {
  const normalized = readString(value, '枚举值', 64)
  if (!choices.includes(normalized)) throw new HardwareRequestError('枚举值无效')
  return normalized
}

function optionalEnum(value: unknown, choices: readonly string[]) {
  if (value === undefined || value === null || value === '') return undefined
  return readEnum(value, choices)
}

function optionalInteger(value: unknown, minimum: number, maximum: number) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new HardwareRequestError('整数参数无效')
  return parsed
}

function optionalCsv(value: unknown, choices: readonly string[]) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new HardwareRequestError('筛选参数无效')
  return value.split(',').map((item) => readEnum(item.trim(), choices))
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new HardwareRequestError('capabilities格式无效')
  return value.map((item) => readString(item, 'capability', 64))
}

async function handle(reply: FastifyReply, operation: () => Promise<FastifyReply>) {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof NormalizedAuthenticationRequiredError || error instanceof StaffSessionNotFoundError) {
      return reply.code(401).send({ error: { code: 'AUTH_REQUIRED', message: '登录信息无效或已过期，请重新登录' } })
    }
    if (error instanceof HardwareAccessDeniedError || error instanceof EmployeeTableAccessDeniedError) {
      return reply.code(403).send({ error: { code: 'HARDWARE_FORBIDDEN', message: error.message } })
    }
    if (error instanceof HardwareNotFoundError) {
      return reply.code(404).send({ error: { code: 'HARDWARE_NOT_FOUND', message: error.message } })
    }
    if (error instanceof HardwareConflictError || error instanceof IdempotencyConflictError || error instanceof IdempotencyInProgressError) {
      return reply.code(409).send({ error: { code: 'HARDWARE_CONFLICT', message: error.message } })
    }
    if (error instanceof HardwareRequestError || error instanceof HardwarePolicyError) {
      return reply.code(400).send({ error: { code: 'HARDWARE_REQUEST_INVALID', message: error.message } })
    }
    if (error instanceof IdempotencyRecordError) {
      return reply.code(503).send({ error: { code: 'HARDWARE_TEMPORARILY_UNAVAILABLE', message: '设备服务暂时不可用' } })
    }
    return reply.code(500).send({ error: { code: 'HARDWARE_INTERNAL_ERROR', message: '设备服务暂时不可用' } })
  }
}
