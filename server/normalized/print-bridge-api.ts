import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { appendAuditEvent, type JsonObject } from './command-executor.js'
import type { NormalizedOperationsRequestContext } from './normalized-operations-api.js'
import {
  PrintBridgeAuthenticationError,
  PrintBridgeRepository,
  PrintBridgeRequestError,
} from './print-bridge-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

export interface PrintBridgeApiOptions {
  scope: Readonly<StoreScope>
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>
  hashSecret: string
  requireHttps: boolean
  resolveStaffContext(request: FastifyRequest): Promise<NormalizedOperationsRequestContext> | NormalizedOperationsRequestContext
  createRepository?(transaction: ScopedTransaction): PrintBridgeRepository
}

class PrintBridgeAccessDeniedError extends Error {
  constructor() {
    super('当前员工没有设备与打印管理权限')
    this.name = 'PrintBridgeAccessDeniedError'
  }
}

export const printBridgeApiPlugin: FastifyPluginAsync<PrintBridgeApiOptions> = async (app, options) => {
  const repository = (transaction: ScopedTransaction) => (
    options.createRepository?.(transaction) ?? new PrintBridgeRepository(transaction, options.hashSecret)
  )

  app.get('/hardware/print-bridges', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveStaffContext(request)
    requirePrinterManager(context)
    const data = await options.transactions.run(context.scope, (transaction) => repository(transaction).list(), { readOnly: true })
    return reply.send({ data })
  }))

  app.post('/hardware/print-bridges/pairing-code', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveStaffContext(request)
    requirePrinterManager(context)
    const body = readObject(request.body)
    const reason = readString(body.reason, 'reason', 1000, 3)
    const ttlSeconds = optionalInteger(body.ttlSeconds, 60, 1800) ?? 600
    const data = await options.transactions.run(context.scope, async (transaction) => {
      const created = await repository(transaction).createPairingCode(context.employeeId, reason, ttlSeconds)
      await appendAuditEvent(transaction, {
        actor: { type: 'employee', employeeId: context.employeeId },
        action: 'print.bridge.pairing_code.created', objectType: 'print_bridge_pairing_code',
        objectId: created.id, businessDate: context.businessDate, reason,
        afterData: { expiresAt: created.expiresAt },
      })
      return created
    })
    return reply.code(201).send({ data })
  }))

  app.post<{ Params: { bridgeId: string } }>('/hardware/print-bridges/:bridgeId/revoke', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveStaffContext(request)
    requirePrinterManager(context)
    const body = readObject(request.body)
    const reason = readString(body.reason, 'reason', 1000, 3)
    const bridgeId = readUuid(request.params.bridgeId, 'bridgeId')
    const data = await options.transactions.run(context.scope, async (transaction) => {
      const changed = await repository(transaction).revoke(bridgeId)
      await appendAuditEvent(transaction, {
        actor: { type: 'employee', employeeId: context.employeeId },
        action: 'print.bridge.revoked', objectType: 'print_bridge', objectId: bridgeId,
        businessDate: context.businessDate, reason,
        beforeData: changed.before,
        afterData: changed.bridge,
      })
      return changed.bridge
    })
    return reply.send({ data })
  }))

  app.post('/print-bridge/pair', async (request, reply) => handle(reply, async () => {
    assertSecureTransport(request, options.requireHttps)
    const body = readObject(request.body)
    const data = await options.transactions.run(options.scope, (transaction) => repository(transaction).pair({
      pairingCode: readString(body.pairingCode, 'pairingCode', 32, 20),
      name: readString(body.name, 'name', 120),
      hostname: readString(body.hostname, 'hostname', 160),
      softwareVersion: readString(body.softwareVersion, 'softwareVersion', 64),
    }))
    return reply.code(201).send({ data })
  }))

  app.post('/print-bridge/heartbeat', async (request, reply) => bridgeRoute(request, reply, options, repository, async (store, bridge) => {
    const body = readObject(request.body)
    const queues = readStringArray(body.queues, 'queues', 64, 180)
    const data = await store.heartbeat(bridge.id, {
      hostname: readString(body.hostname, 'hostname', 160),
      softwareVersion: readString(body.softwareVersion, 'softwareVersion', 64),
      queues,
    })
    return reply.send({ data })
  }))

  app.post('/print-bridge/work/claim', async (request, reply) => bridgeRoute(request, reply, options, repository, async (store, bridge) => {
    const body = readObject(request.body)
    const data = await store.claim(bridge, optionalInteger(body.limit, 1, 25) ?? 10)
    return reply.send({ data })
  }))

  app.post<{ Params: { jobId: string } }>('/print-bridge/jobs/:jobId/result', async (request, reply) => bridgeRoute(request, reply, options, repository, async (store, bridge) => {
    const body = readObject(request.body)
    const outcome = readEnum(body.outcome, ['printed', 'failed']) as 'printed' | 'failed'
    const data = await store.recordPrintResult(bridge, {
      jobId: readUuid(request.params.jobId, 'jobId'), outcome,
      failureCode: optionalString(body.failureCode, 'failureCode', 96),
    })
    return reply.send({ data })
  }))

  app.post<{ Params: { commandId: string } }>('/print-bridge/commands/:commandId/result', async (request, reply) => bridgeRoute(request, reply, options, repository, async (store, bridge) => {
    const body = readObject(request.body)
    const outcome = readEnum(body.outcome, ['succeeded', 'failed']) as 'succeeded' | 'failed'
    const data = await store.recordCommandResult(bridge, {
      commandId: readUuid(request.params.commandId, 'commandId'), outcome,
      failureCode: optionalString(body.failureCode, 'failureCode', 96),
      resultSnapshot: optionalObject(body.resultSnapshot),
    })
    return reply.send({ data })
  }))
}

async function bridgeRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  options: PrintBridgeApiOptions,
  createRepository: (transaction: ScopedTransaction) => PrintBridgeRepository,
  operation: (repository: PrintBridgeRepository, bridge: { id: string; publicId: string }) => Promise<FastifyReply>,
) {
  return handle(reply, async () => {
    assertSecureTransport(request, options.requireHttps)
    const credentials = readBridgeCredentials(request)
    return options.transactions.run(options.scope, async (transaction) => {
      const store = createRepository(transaction)
      const bridge = await store.authenticate(credentials.publicId, credentials.credential)
      return operation(store, bridge)
    })
  })
}

function readBridgeCredentials(request: FastifyRequest) {
  const publicId = request.headers['x-mbox-print-bridge-id']
  const authorization = request.headers.authorization
  if (typeof publicId !== 'string' || typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    throw new PrintBridgeAuthenticationError()
  }
  return { publicId, credential: authorization.slice('Bearer '.length) }
}

function assertSecureTransport(request: FastifyRequest, required: boolean) {
  if (required && request.protocol !== 'https') throw new PrintBridgeAuthenticationError()
}

function requirePrinterManager(context: NormalizedOperationsRequestContext) {
  if (!context.capabilities.includes('printer.manage') && !context.capabilities.includes('hardware.manage')) {
    throw new PrintBridgeAccessDeniedError()
  }
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PrintBridgeRequestError('请求数据格式无效')
  return value as Record<string, unknown>
}

function optionalObject(value: unknown): JsonObject | undefined {
  return value === undefined ? undefined : readObject(value) as JsonObject
}

function readString(value: unknown, field: string, maximum: number, minimum = 1) {
  if (typeof value !== 'string' || value.trim().length < minimum || value.trim().length > maximum) {
    throw new PrintBridgeRequestError(`${field}格式无效`)
  }
  return value.trim()
}

function optionalString(value: unknown, field: string, maximum: number) {
  if (value === undefined || value === null || value === '') return undefined
  return readString(value, field, maximum)
}

function readStringArray(value: unknown, field: string, maxItems: number, maxLength: number) {
  if (!Array.isArray(value) || value.length > maxItems) throw new PrintBridgeRequestError(`${field}格式无效`)
  return value.map((item) => readString(item, field, maxLength))
}

function optionalInteger(value: unknown, minimum: number, maximum: number) {
  if (value === undefined || value === null) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new PrintBridgeRequestError('整数参数无效')
  return parsed
}

function readEnum(value: unknown, choices: readonly string[]) {
  const normalized = readString(value, '枚举值', 64)
  if (!choices.includes(normalized)) throw new PrintBridgeRequestError('枚举值无效')
  return normalized
}

function readUuid(value: unknown, field: string) {
  const normalized = readString(value, field, 36, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new PrintBridgeRequestError(`${field}格式无效`)
  }
  return normalized
}

async function handle(reply: FastifyReply, operation: () => Promise<FastifyReply>) {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof PrintBridgeAuthenticationError) {
      return reply.code(401).send({ error: { code: 'PRINT_BRIDGE_UNAUTHORIZED', message: error.message } })
    }
    if (error instanceof PrintBridgeAccessDeniedError) {
      return reply.code(403).send({ error: { code: 'PRINT_BRIDGE_ACCESS_DENIED', message: error.message } })
    }
    if (error instanceof PrintBridgeRequestError) {
      return reply.code(400).send({ error: { code: 'PRINT_BRIDGE_REQUEST_INVALID', message: error.message } })
    }
    throw error
  }
}
