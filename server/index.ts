import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { ZodError } from 'zod'
import {
  areaWriteSchema,
  configDraftSchema,
  createTaskSchema,
  employeeWriteSchema,
  productWriteSchema,
  shiftWriteSchema,
  tableWriteSchema,
  taskActionSchema,
} from '../src/shared/contracts.js'
import { authorityWriteSchema } from '../src/shared/commerce-api.js'
import {
  applyTaskAction,
  calculateMetrics,
  createServiceTask,
  escalateDueTasks,
  saveConfigDraft,
} from './domain.js'
import { createRuntimeDependencies } from './repository-factory.js'
import { registerCommerceRoutes } from './commerce-api.js'
import { registerPaymentRoutes } from './payment-api.js'
import { processAwaitingOrderReminders, registerProactiveServiceRoutes } from './proactive-service.js'
import { registerBenefitRoutes } from './benefit-domain.js'
import { buildMemberPortal, registerMemberPortalRoutes } from './member-portal.js'
import { registerNotificationRoutes } from './notification-api.js'
import { processDueNotifications } from './notification-dispatch.js'
import { BenefitRedemptionBusinessError, registerBenefitRedemptionRoutes } from './benefit-redemption.js'
import { AuthenticationError, registerAuthContext, requireRequestActor } from './auth-context.js'
import type { RuntimeMode } from '../src/shared/auth-contracts.js'
import { publishConfigVersion, rollbackConfigVersion } from './config-versioning.js'
import { publishConfigVersionSchema, rollbackConfigVersionSchema } from '../src/shared/config-versioning-contracts.js'
import { registerSongRoutes } from './song-api.js'
import {
  createEmployee,
  createAuthority,
  createShift,
  createProduct,
  updateArea,
  updateEmployee,
  updateAuthority,
  updateShift,
  updateProduct,
  updateTable,
} from './master-data.js'
import { loadRuntimeConfig } from './runtime-config.js'
import { registerObservability } from './observability.js'
import { registerGuestRoutes } from './guest-api.js'
import { TableAccessError } from './table-access.js'
import { registerStoreImportRoutes } from './store-import-api.js'
import { StoreImportValidationError } from './store-import.js'
import {
  PostgresIdempotencyConflictError,
  PostgresIdempotencyInProgressError,
  PostgresOptimisticConcurrencyError,
} from './postgres-repository.js'
import { wechatApiPlugin } from './wechat-api.js'
import {
  OfficialWechatCodeSessionProvider,
  PostgresWechatChallengeRepository,
  PostgresWechatIdentityRepository,
} from './wechat-production-adapters.js'
import { registerInventoryRoutes } from './inventory-api.js'
import { registerReservationRoutes } from './reservation-api.js'
import { registerWechatReservationRoutes } from './wechat-reservation-api.js'

const runtimeConfig = loadRuntimeConfig()

const app = Fastify({
  logger: { level: runtimeConfig.logLevel },
  bodyLimit: runtimeConfig.bodyLimitBytes,
  trustProxy: runtimeConfig.runtimeMode === 'staging' || runtimeConfig.runtimeMode === 'production',
})
const runtimeDependencies = createRuntimeDependencies(runtimeConfig)
const repository = runtimeDependencies.repository

await repository.init()
await app.register(cors, {
  origin: runtimeConfig.corsOrigins,
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
})
if (runtimeConfig.runtimeMode === 'staging' || runtimeConfig.runtimeMode === 'production') {
  await app.register(fastifyStatic, {
    root: resolve(process.cwd(), 'dist'),
    prefix: '/',
    wildcard: false,
  })
}
await registerObservability(app, {
  runtimeMode: runtimeConfig.runtimeMode,
  metricsToken: runtimeConfig.metricsToken,
  readiness: async () => {
    const status = await repository.healthCheck()
    return {
      ready: status.ready,
      details: { repository: status.repository, revision: status.revision ?? -1 },
    }
  },
})

await registerAuthContext(app, {
  runtimeMode: runtimeConfig.runtimeMode as RuntimeMode,
  sessionSecret: runtimeConfig.sessionSecret,
  readState: () => repository.read(),
})

let wechatChallengeRepository: PostgresWechatChallengeRepository | undefined
let wechatIdentityRepository: PostgresWechatIdentityRepository | undefined
if (runtimeConfig.wechatEnabled) {
  const commonWechatOptions = {
    pool: runtimeDependencies.postgresPool!,
    tenantId: runtimeConfig.tenantId!,
    storeId: runtimeConfig.storeUuid!,
    appId: runtimeConfig.wechatAppId!,
    activeKeyVersion: runtimeConfig.wechatEncryptionKeyVersion,
    encryptionKeys: new Map([[runtimeConfig.wechatEncryptionKeyVersion, runtimeConfig.wechatEncryptionKey!]]),
  }
  wechatChallengeRepository = new PostgresWechatChallengeRepository(commonWechatOptions)
  wechatIdentityRepository = new PostgresWechatIdentityRepository(commonWechatOptions)
  await app.register(wechatApiPlugin, {
    runtimeMode: runtimeConfig.runtimeMode,
    stateSecret: runtimeConfig.wechatStateSecret,
    provider: new OfficialWechatCodeSessionProvider({
      appSecrets: { [runtimeConfig.wechatAppId!]: runtimeConfig.wechatAppSecret! },
    }),
    challengeRepository: wechatChallengeRepository,
    identityRepository: wechatIdentityRepository,
    applications: [{
      tenantId: runtimeConfig.tenantId!,
      storeId: runtimeConfig.storeUuid!,
      appId: runtimeConfig.wechatAppId!,
    }],
  })
  app.get('/api/wechat/member-portal', async (request, reply) => {
    const authorization = request.headers.authorization
    if (!authorization?.startsWith('Bearer ')) {
      return reply.status(401).send({ code: 'WECHAT_SESSION_REQUIRED', message: '缺少微信身份会话' })
    }
    const accessToken = authorization.slice(7).trim()
    const accessTokenHash = createHash('sha256').update(accessToken).digest('base64url')
    const session = await wechatIdentityRepository!.findSession(accessTokenHash)
    if (!session || session.revokedAt !== null || session.expiresAt <= Date.now()) {
      return reply.status(401).send({ code: 'WECHAT_SESSION_INVALID', message: '微信身份会话无效或已过期' })
    }
    if (!session.principal.memberId) {
      return reply.status(403).send({ code: 'MEMBER_NOT_BOUND', message: '当前微信身份尚未绑定会员账户' })
    }
    return buildMemberPortal(await repository.read(), session.principal.memberId)
  })
  registerWechatReservationRoutes(app, repository, {
    identityRepository: wechatIdentityRepository,
    tenantId: runtimeConfig.tenantId!,
    storeId: runtimeConfig.storeUuid!,
    appId: runtimeConfig.wechatAppId!,
  })
}

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) {
    return reply.status(400).send({ code: 'VALIDATION_ERROR', message: error.issues[0]?.message ?? '输入无效' })
  }
  if (error instanceof BenefitRedemptionBusinessError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message })
  }
  if (error instanceof AuthenticationError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message })
  }
  if (error instanceof TableAccessError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message })
  }
  if (error instanceof StoreImportValidationError) {
    return reply.status(422).send({ code: 'STORE_IMPORT_INVALID', message: error.message, issues: error.issues })
  }
  if (
    error instanceof PostgresOptimisticConcurrencyError ||
    error instanceof PostgresIdempotencyConflictError ||
    error instanceof PostgresIdempotencyInProgressError
  ) {
    return reply.status(409).send({ code: 'CONCURRENT_WRITE_CONFLICT', message: '数据已发生变化，请刷新后重试' })
  }
  app.log.error(error)
  return reply.status(400).send({
    code: 'BUSINESS_ERROR',
    message: error instanceof Error ? error.message : '未知业务错误',
  })
})

app.get('/api/health', async () => ({ status: 'ok', time: new Date().toISOString() }))

app.get('/api/bootstrap', async () => {
  await repository.mutate((state) => {
    processAwaitingOrderReminders(state)
    return escalateDueTasks(state)
  })
  const state = await repository.read()
  return { ...state, serverNow: new Date().toISOString(), metrics: calculateMetrics(state) }
})

app.post('/api/tasks', async (request, reply) => {
  const input = createTaskSchema.parse(request.body)
  const task = await repository.mutate((state) => createServiceTask(state, input))
  return reply.status(201).send(task)
})

app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/actions', async (request) => {
  const input = taskActionSchema.parse(request.body)
  return repository.mutate((state) => applyTaskAction(state, request.params.taskId, input))
})

app.put('/api/config/draft', async (request) => {
  const input = configDraftSchema.parse(request.body)
  return repository.mutate((state) => saveConfigDraft(state, input, requireRequestActor(request).actorId))
})

app.post('/api/config/publish', async (request) => {
  const input = publishConfigVersionSchema.omit({ actorId: true, occurredAt: true }).parse(request.body)
  return repository.mutate((state) => {
    const result = publishConfigVersion(state, state.configVersions, {
      ...input,
      actorId: requireRequestActor(request).actorId,
      occurredAt: new Date().toISOString(),
    })
    Object.assign(state, result.state, { configVersions: result.versions })
    return result.state.config
  })
})

app.get('/api/config/versions', async () => (await repository.read()).configVersions.toSorted((left, right) => right.version - left.version))

app.post<{ Params: { version: string } }>('/api/config/versions/:version/rollback', async (request) => {
  const input = rollbackConfigVersionSchema.omit({ actorId: true, occurredAt: true, targetVersion: true }).parse(request.body)
  const targetVersion = Number(request.params.version)
  return repository.mutate((state) => {
    const result = rollbackConfigVersion(state, state.configVersions, {
      ...input,
      targetVersion,
      actorId: requireRequestActor(request).actorId,
      occurredAt: new Date().toISOString(),
    })
    Object.assign(state, result.state, { configVersions: result.versions })
    return result.state.config
  })
})

app.post('/api/master-data/employees', async (request, reply) => {
  const input = employeeWriteSchema.parse(request.body)
  const employee = await repository.mutate((state) => createEmployee(state, input, requireRequestActor(request).actorId))
  return reply.status(201).send(employee)
})

app.put<{ Params: { employeeId: string } }>('/api/master-data/employees/:employeeId', async (request) => {
  const input = employeeWriteSchema.parse(request.body)
  return repository.mutate((state) => updateEmployee(state, request.params.employeeId, input, requireRequestActor(request).actorId))
})

app.put<{ Params: { tableId: string } }>('/api/master-data/tables/:tableId', async (request) => {
  const input = tableWriteSchema.parse(request.body)
  return repository.mutate((state) => updateTable(state, request.params.tableId, input, requireRequestActor(request).actorId))
})

app.post('/api/master-data/shifts', async (request, reply) => {
  const input = shiftWriteSchema.parse(request.body)
  const shift = await repository.mutate((state) => createShift(state, input, requireRequestActor(request).actorId))
  return reply.status(201).send(shift)
})

app.put<{ Params: { shiftId: string } }>('/api/master-data/shifts/:shiftId', async (request) => {
  const input = shiftWriteSchema.parse(request.body)
  return repository.mutate((state) => updateShift(state, request.params.shiftId, input, requireRequestActor(request).actorId))
})

app.put<{ Params: { areaId: string } }>('/api/master-data/areas/:areaId', async (request) => {
  const input = areaWriteSchema.parse(request.body)
  return repository.mutate((state) => updateArea(state, request.params.areaId, input, requireRequestActor(request).actorId))
})

app.post('/api/master-data/products', async (request, reply) => {
  const input = productWriteSchema.parse(request.body)
  const product = await repository.mutate((state) => createProduct(state, input, requireRequestActor(request).actorId))
  return reply.status(201).send(product)
})

app.put<{ Params: { productId: string } }>('/api/master-data/products/:productId', async (request) => {
  const input = productWriteSchema.parse(request.body)
  return repository.mutate((state) => updateProduct(state, request.params.productId, input, requireRequestActor(request).actorId))
})

app.post('/api/master-data/commerce-authorities', async (request, reply) => {
  const input = authorityWriteSchema.parse(request.body)
  const authority = await repository.mutate((state) => createAuthority(state, input, requireRequestActor(request).actorId))
  return reply.status(201).send(authority)
})

app.put<{ Params: { authorityId: string } }>('/api/master-data/commerce-authorities/:authorityId', async (request) => {
  const input = authorityWriteSchema.parse(request.body)
  return repository.mutate((state) => updateAuthority(state, request.params.authorityId, input, requireRequestActor(request).actorId))
})

app.post('/api/dev/reset', async () => repository.reset())

registerCommerceRoutes(app, repository)
registerPaymentRoutes(app, repository)
registerProactiveServiceRoutes(app, repository)
registerBenefitRoutes(app, repository)
registerMemberPortalRoutes(app, repository)
registerNotificationRoutes(app, repository)
registerBenefitRedemptionRoutes(app, repository)
registerSongRoutes(app, repository)
registerGuestRoutes(app, repository, { secret: runtimeConfig.qrSecret, runtimeMode: runtimeConfig.runtimeMode })
registerStoreImportRoutes(app, repository)
registerInventoryRoutes(app, repository)
registerReservationRoutes(app, repository)

if (runtimeConfig.runtimeMode === 'staging' || runtimeConfig.runtimeMode === 'production') {
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ code: 'ROUTE_NOT_FOUND', message: '接口不存在' })
    }
    return reply.sendFile('index.html')
  })
}

const scheduler = setInterval(() => {
  void repository.mutate(async (state) => {
    processAwaitingOrderReminders(state)
    escalateDueTasks(state)
    return processDueNotifications(state, [])
  }).catch((error) => app.log.error(error))
}, 1000)
scheduler.unref()

const wechatCleanupScheduler = runtimeConfig.wechatEnabled
  ? setInterval(() => {
      void Promise.all([
        wechatChallengeRepository!.cleanupExpired(),
        wechatIdentityRepository!.cleanupExpired(),
      ]).catch((error) => app.log.error(error))
    }, 15 * 60_000)
  : null
wechatCleanupScheduler?.unref()

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  app.log.info({ signal }, 'graceful shutdown started')
  clearInterval(scheduler)
  if (wechatCleanupScheduler) clearInterval(wechatCleanupScheduler)
  const forceTimer = setTimeout(() => {
    app.log.fatal({ signal }, 'graceful shutdown timed out')
    process.exit(1)
  }, runtimeConfig.shutdownGraceMs)
  forceTimer.unref()
  try {
    await app.close()
    await repository.close()
    clearTimeout(forceTimer)
  } catch (error) {
    app.log.error(error)
    process.exitCode = 1
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))

await app.listen({ host: runtimeConfig.host, port: runtimeConfig.apiPort })
