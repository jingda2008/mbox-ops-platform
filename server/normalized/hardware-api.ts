import { createHash, randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
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
import type { ScopedPostgresTransactionRunner, ScopedTransaction } from './transaction-runner.js'

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
  const repository = (transaction: ScopedTransaction) => (
    options.createRepository?.(transaction) ?? new HardwareRepository(transaction)
  )

  app.get('/hardware/devices', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveContext(request)
    requireAny(context, ['hardware.view', 'hardware.view_all', 'printer.manage'])
    const printerManagerOnly = hasCapability(context, 'printer.manage') && !hasAnyCapability(context, ['hardware.view', 'hardware.view_all'])
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
    requireAny(context, ['print.view', 'print.view_all', 'printer.manage'])
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
      })
      return outcome(context, 'hardware.device.created.v1', 'device', result.id, body.reason, result)
    })
    return reply.code(execution.replayed ? 200 : 201).send({ data: execution.value, replayed: execution.replayed })
  }))

  app.put('/hardware/printer-routes/:routeCode', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveContext(request)
    requireAny(context, ['hardware.manage', 'printer.manage'])
    const body = readObject(request.body)
    const routeCode = readString(readObject(request.params).routeCode, 'routeCode', 64)
    const execution = await options.commands.execute(command(request, context, 'hardware.route.upsert', body, codec()), async (transaction) => {
      const result = await repository(transaction).upsertPrinterRoute({
        code: routeCode,
        name: readString(body.name, 'name', 120),
        stationCode: readEnum(body.stationCode, ['bar', 'kitchen', 'cashier']) as HardwareStation,
        productCategoryCode: optionalString(body.productCategoryCode, 'productCategoryCode', 64),
        printerDeviceId: readUuid(body.printerDeviceId, 'printerDeviceId'),
        copies: optionalInteger(body.copies, 1, 5),
        priority: optionalInteger(body.priority, 0, 1000),
        status: optionalEnum(body.status, ['active', 'paused', 'retired']) as never,
      })
      return outcome(context, 'hardware.route.configured.v1', 'printer_route', result.id, body.reason, result)
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
      const result = await repository(transaction).retryPrintJob(jobId, context.employeeId, reason)
      return outcome(context, 'print.job.manual_retry.v1', 'print_job', result.id, reason, result)
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
      afterData: { id: objectId },
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
  if (context.capabilities.includes('hardware.view_all')) return undefined
  const stations: DeviceStation[] = []
  if (context.capabilities.includes('work.bar')) stations.push('bar')
  if (context.capabilities.includes('work.kitchen')) stations.push('kitchen')
  if (context.capabilities.includes('work.cashier')) stations.push('cashier')
  if (context.capabilities.includes('work.delivery')) stations.push('service')
  return stations
}

function printStationsFor(context: NormalizedOperationsRequestContext): HardwareStation[] {
  if (context.capabilities.includes('print.view_all') || context.capabilities.includes('printer.manage')) return ['bar', 'kitchen', 'cashier']
  const stations: HardwareStation[] = []
  if (context.capabilities.includes('work.bar')) stations.push('bar')
  if (context.capabilities.includes('work.kitchen')) stations.push('kitchen')
  if (context.capabilities.includes('work.cashier')) stations.push('cashier')
  return stations
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
    if (error instanceof HardwareAccessDeniedError) {
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
