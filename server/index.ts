import cors from '@fastify/cors'
import compress from '@fastify/compress'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ZodError } from 'zod'
import {
  areaWriteSchema,
  configDraftSchema,
  employeeWriteSchema,
  productWriteSchema,
  shiftWriteSchema,
  tableWriteSchema,
} from '../src/shared/contracts.js'
import { authorityWriteSchema } from '../src/shared/commerce-api.js'
import { calculateMetrics, saveConfigDraft } from './domain.js'
import { createRuntimeDependencies } from './repository-factory.js'
import { CommerceRequestError, registerCommerceRoutes } from './commerce-api.js'
import { registerPaymentRoutes } from './payment-api.js'
import {
  createEnvironmentPaymentProviderResolver,
  PaymentProviderUnavailableError,
  validateEnvironmentPaymentRuntime,
} from './payment-provider.js'
import { registerProactiveServiceRoutes } from './proactive-service.js'
import { dispatchDueSopActions } from './sop-action-dispatch.js'
import { createSopActionAdapters } from './sop-action-runtime.js'
import { registerSopActionRoutes, SopActionBusinessError } from './sop-action-api.js'
import { registerBenefitRoutes } from './benefit-domain.js'
import { buildMemberPortal, registerMemberPortalRoutes } from './member-portal.js'
import { registerNotificationRoutes } from './notification-api.js'
import { dispatchDueNotifications } from './notification-dispatch.js'
import { BenefitRedemptionBusinessError, registerBenefitRedemptionRoutes } from './benefit-redemption.js'
import { AuthenticationError, registerAuthContext, requireRequestActor } from './auth-context.js'
import type { RuntimeMode } from '../src/shared/auth-contracts.js'
import { publishConfigVersion, rollbackConfigVersion } from './config-versioning.js'
import { publishConfigVersionSchema, rollbackConfigVersionSchema } from '../src/shared/config-versioning-contracts.js'
import { registerSongRoutes, SongConfigVersionConflictError } from './song-api.js'
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
import { registerPublicReservationRoutes } from './public-reservation-api.js'
import { TableAccessError } from './table-access.js'
import { registerStoreImportRoutes } from './store-import-api.js'
import { registerTableSessionRoutes } from './table-session-api.js'
import { registerBusinessDayRoutes } from './business-day-api.js'
import { reconcileAutomaticBusinessDay } from './business-day-rollover.js'
import { StoreImportValidationError } from './store-import.js'
import {
  PostgresRepositoryError,
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
import { registerWaitlistRoutes } from './waitlist-api.js'
import { registerWechatReservationRoutes } from './wechat-reservation-api.js'
import { registerPilotAuthRoutes } from './pilot-auth.js'
import { AuthorizationError, requireApprovalAmount, requireConfiguredOperation } from './authorization.js'
import { createCustomerNotificationAdapters } from './notification-runtime.js'
import { applyScheduledOperations, scheduledOperationsWouldChange } from './operational-scheduler.js'
import { projectRuntimeStateForActor } from './bootstrap-projection.js'
import { buildBootstrapViewEtag } from './bootstrap-etag.js'
import { RevisionScopedCache } from './revision-scoped-cache.js'
import {
  OperationalReadStoreError,
  resolveOperationalRuntimeState,
} from './operational-read-store.js'
import { effectivePermissionIdsForEmployee } from '../src/shared/staff-access.js'
import { preserveProtectedProductCost, productCostView } from './product-cost-policy.js'
import { MemoryRateLimitStore, PostgresRateLimitStore } from './rate-limit.js'
import { DEFAULT_PRESENCE_LEASE_TTL_MS, registerPresenceRoutes, resumePresenceLease } from './presence.js'
import { MemoryGuestInsightsStore, PostgresGuestInsightsStore } from './guest-insights.js'
import { GoogleCloudVoiceTranscriber, registerVoiceTranscriptionRoutes } from './voice-transcription.js'
import { clientValidationError } from './validation-error.js'
import { registerAssistantRoutes } from './assistant-api.js'
import { registerCommercialOpsRoutes } from './commercial-ops-api.js'
import { registerHardwareRoutes } from './hardware-api.js'
import { registerTaskRoutes } from './task-api.js'
import { effectiveHardwareDeviceStatus, HardwareBusinessError } from './hardware-domain.js'
import { GeminiAssistantPlanner, QwenAssistantPlanner } from './assistant-planner.js'
import {
  MemoryAssistantConversationStore,
  PostgresAssistantConversationStore,
} from './assistant-conversation-store.js'

const runtimeConfig = loadRuntimeConfig()

const app = Fastify({
  logger: { level: runtimeConfig.logLevel },
  bodyLimit: runtimeConfig.bodyLimitBytes,
  trustProxy: runtimeConfig.runtimeMode === 'staging' || runtimeConfig.runtimeMode === 'production',
})
const runtimeDependencies = createRuntimeDependencies(runtimeConfig)
const repository = runtimeDependencies.repository
const operationalStateCache = new RevisionScopedCache<Promise<{
  state: Awaited<ReturnType<typeof repository.read>>
  source: 'normalized_tables' | 'aggregate_compatibility'
}>>(8)
const bootstrapViewCache = new RevisionScopedCache<{
  projected: ReturnType<typeof projectRuntimeStateForActor>
  etag: string
  permissionIds: ReturnType<typeof effectivePermissionIdsForEmployee>
  metrics: ReturnType<typeof calculateMetrics>
  source: 'normalized_tables' | 'aggregate_compatibility'
}>(64)
const guestInsights = runtimeDependencies.postgresPool
  ? new PostgresGuestInsightsStore({
      pool: runtimeDependencies.postgresPool,
      tenantId: runtimeConfig.tenantId!,
      storeId: runtimeConfig.storeUuid!,
    })
  : new MemoryGuestInsightsStore()
const rateLimitStore = runtimeDependencies.postgresPool
  ? new PostgresRateLimitStore({
      pool: runtimeDependencies.postgresPool,
      tenantId: runtimeConfig.tenantId!,
      storeId: runtimeConfig.storeUuid!,
      hashSecret: runtimeConfig.sessionSecret ?? runtimeConfig.qrSecret,
    })
  : new MemoryRateLimitStore({
      usage: 'test',
      tenantId: '00000000-0000-4000-8000-000000000001',
      storeId: '00000000-0000-4000-8000-000000000002',
      hashSecret: runtimeConfig.qrSecret,
    })
const assistantConversationStore = runtimeDependencies.postgresPool
  ? new PostgresAssistantConversationStore({
      pool: runtimeDependencies.postgresPool,
      tenantId: runtimeConfig.tenantId!,
      storeId: runtimeConfig.storeUuid!,
    })
  : new MemoryAssistantConversationStore()

await repository.init()
const startupBusinessDayRollover = await repository.mutate((state) => reconcileAutomaticBusinessDay(state))
if (startupBusinessDayRollover.status === 'rolled_over') {
  app.log.info({
    previousBusinessDate: startupBusinessDayRollover.steps[0]?.businessDate,
    businessDate: startupBusinessDayRollover.businessDate,
    rolledBusinessDayCount: startupBusinessDayRollover.steps.length,
  }, 'business day automatically rolled over during startup')
}
await guestInsights.init()
await assistantConversationStore.init()
const paymentProviderResolver = createEnvironmentPaymentProviderResolver()
const paymentRuntime = validateEnvironmentPaymentRuntime((await repository.read()).paymentDomain)
await app.register(cors, {
  origin: runtimeConfig.corsOrigins,
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
})
await app.register(compress, {
  global: true,
  threshold: 1_024,
})
if (runtimeConfig.runtimeMode === 'staging' || runtimeConfig.runtimeMode === 'production') {
  const staticRoot = resolve(process.cwd(), 'dist')
  app.get('/install/ios', async (_request, reply) => reply.redirect('/install/ios.html'))
  app.get('/install/android', async (_request, reply) => reply.redirect('/install/android.html'))
  app.get('/downloads/MBOX-Ops-Validation-latest.apk', async (_request, reply) => reply
    .redirect('/downloads/MBOX-Ops-Validation-1.0.0-rc.14-validation.1.apk'))
  await app.register(fastifyStatic, {
    root: staticRoot,
    prefix: '/',
    wildcard: false,
    setHeaders: (reply, path) => {
      if (path.endsWith('.mobileconfig')) {
        reply
          .header('Content-Type', 'application/x-apple-aspen-config')
          .header('Content-Disposition', 'attachment; filename="MBOX-Ops-Validation.mobileconfig"')
          .header('Cache-Control', 'public, max-age=300')
      }
      if (path.endsWith('.apk')) {
        reply
          .header('Content-Type', 'application/vnd.android.package-archive')
          .header('Content-Disposition', 'attachment; filename="MBOX-Ops-Validation.apk"')
          .header('Cache-Control', 'public, max-age=300')
      }
    },
  })
  const assetLinks = JSON.parse(
    await readFile(resolve(staticRoot, '.well-known/assetlinks.json'), 'utf8'),
  ) as unknown
  app.get('/.well-known/assetlinks.json', async (_request, reply) => reply
    .header('Cache-Control', 'public, max-age=300')
    .type('application/json; charset=utf-8')
    .send(assetLinks))
}
await registerObservability(app, {
  runtimeMode: runtimeConfig.runtimeMode,
  metricsToken: runtimeConfig.metricsToken,
  readiness: async () => {
    const status = await repository.healthCheck()
    const state = status.ready ? await repository.read() : null
    const enabledDevices = state?.hardwareState?.devices.filter((device) => device.enabled) ?? []
    const realDevices = enabledDevices.filter((device) => device.adapter !== 'simulator')
    const realDevicesOnline = state?.hardwareState
      ? realDevices.filter((device) => effectiveHardwareDeviceStatus(device, state.hardwareState!.config) === 'online').length
      : 0
    const simulatedDevicesEnabled = enabledDevices.filter((device) => device.adapter === 'simulator').length
    const hardwareMode = realDevices.length > 0
      ? realDevicesOnline === realDevices.length ? 'real_ready' : 'real_degraded'
      : simulatedDevicesEnabled > 0 ? 'simulation_only' : 'unconfigured'
    return {
      ready: status.ready,
      details: {
        repository: status.repository,
        revision: status.revision ?? -1,
        projectionReady: status.projectionReady ?? status.repository !== 'postgres',
        projectionRevision: status.projectionRevision ?? -1,
        projectionCountsMatch: status.projectionCountsMatch ?? status.repository !== 'postgres',
        operationalReadPath: runtimeDependencies.operationalReadStore ? 'normalized_tables' : 'aggregate_compatibility',
        operationalReadEntityTypes: runtimeDependencies.operationalReadStore ? 8 : 0,
        paymentMode: runtimeConfig.pilotPaymentSimulationEnabled ? 'simulation' : paymentRuntime.mode,
        commercialOnlinePaymentReady: paymentRuntime.onlinePaymentReady && !runtimeConfig.pilotPaymentSimulationEnabled,
        voiceTranscription: runtimeConfig.voiceTranscriptionProvider,
        assistant: runtimeConfig.assistantProvider,
        assistantModel: runtimeConfig.assistantProvider === 'gemini_interactions'
          ? runtimeConfig.geminiModel
          : runtimeConfig.assistantProvider === 'qwen_openai'
            ? runtimeConfig.qwenModel
            : 'disabled',
        releaseSha: runtimeConfig.releaseSha,
        releaseImageDigest: runtimeConfig.releaseImageDigest,
        hardwareMode,
        realHardwareDevices: realDevices.length,
        realHardwareDevicesOnline: realDevicesOnline,
        simulatedDevicesEnabled,
      },
    }
  },
})

await registerAuthContext(app, {
  runtimeMode: runtimeConfig.runtimeMode as RuntimeMode,
  sessionSecret: runtimeConfig.sessionSecret,
  readState: () => repository.read(),
  resumeStaffSession: async (input) => repository.mutate((state) => Boolean(resumePresenceLease(state, {
    ...input,
    businessDate: state.store.businessDate,
    leaseTtlMs: DEFAULT_PRESENCE_LEASE_TTL_MS,
  }))),
})
await registerVoiceTranscriptionRoutes(app, {
  rateLimitStore,
  transcriber: runtimeConfig.voiceTranscriptionProvider === 'google_v1'
    ? new GoogleCloudVoiceTranscriber()
    : undefined,
})
await registerAssistantRoutes(app, {
  repository,
  conversationStore: assistantConversationStore,
  rateLimitStore,
  planner: runtimeConfig.assistantProvider === 'gemini_interactions'
    ? new GeminiAssistantPlanner({
        apiKey: runtimeConfig.geminiApiKey!,
        model: runtimeConfig.geminiModel,
        timeoutMs: runtimeConfig.assistantHttpTimeoutMs,
        endpoint: runtimeConfig.geminiEndpoint,
      })
    : runtimeConfig.assistantProvider === 'qwen_openai'
      ? new QwenAssistantPlanner({
          apiKey: runtimeConfig.qwenApiKey!,
          model: runtimeConfig.qwenModel,
          timeoutMs: runtimeConfig.assistantHttpTimeoutMs,
          endpoint: runtimeConfig.qwenEndpoint!,
        })
    : undefined,
})
if (runtimeConfig.runtimeMode === 'staging' || runtimeConfig.runtimeMode === 'production') {
  await registerPresenceRoutes(app, repository)
}

if (runtimeConfig.pilotAccessCode) {
  await registerPilotAuthRoutes(app, repository, {
    accessCode: runtimeConfig.pilotAccessCode,
    employeePins: runtimeConfig.pilotEmployeePins!,
    sessionSecret: runtimeConfig.sessionSecret!,
    sessionHours: runtimeConfig.pilotSessionHours,
    rateLimitStore,
  })
}

let wechatChallengeRepository: PostgresWechatChallengeRepository | undefined
let wechatIdentityRepository: PostgresWechatIdentityRepository | undefined
const customerNotificationsEnabled = runtimeConfig.serviceAccountNotificationsEnabled || runtimeConfig.wecomNotificationsEnabled
if (runtimeConfig.wechatEnabled || customerNotificationsEnabled) {
  const commonWechatOptions = {
    pool: runtimeDependencies.postgresPool!,
    tenantId: runtimeConfig.tenantId!,
    storeId: runtimeConfig.storeUuid!,
    appId: runtimeConfig.wechatAppId ?? runtimeConfig.serviceAccountNotificationAppId ?? runtimeConfig.wecomCorpId!,
    activeKeyVersion: runtimeConfig.wechatEncryptionKeyVersion,
    encryptionKeys: new Map([[runtimeConfig.wechatEncryptionKeyVersion, runtimeConfig.wechatEncryptionKey!]]),
    notificationAppIds: {
      service_account: runtimeConfig.serviceAccountNotificationAppId,
      wecom: runtimeConfig.wecomCorpId,
    },
  }
  wechatIdentityRepository = new PostgresWechatIdentityRepository(commonWechatOptions)
  if (runtimeConfig.wechatEnabled) {
    wechatChallengeRepository = new PostgresWechatChallengeRepository(commonWechatOptions)
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
      onIdentityAuthenticated: async ({ anonymousGuestId, principal, occurredAt }) => {
        await guestInsights.linkIdentity(anonymousGuestId, {
          wechatPrincipalId: principal.principalId,
          memberId: principal.memberId,
        }, occurredAt)
      },
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
}

const customerNotificationAdapters = createCustomerNotificationAdapters({
  timeoutMs: runtimeConfig.notificationHttpTimeoutMs,
  serviceAccount: {
    enabled: runtimeConfig.serviceAccountNotificationsEnabled,
    appId: runtimeConfig.serviceAccountNotificationAppId,
    appSecret: runtimeConfig.serviceAccountNotificationAppSecret,
    templates: runtimeConfig.serviceAccountNotificationTemplates,
  },
  wecom: {
    enabled: runtimeConfig.wecomNotificationsEnabled,
    corpId: runtimeConfig.wecomCorpId,
    corpSecret: runtimeConfig.wecomCorpSecret,
    agentId: runtimeConfig.wecomAgentId,
  },
}, {
  recipientResolver: wechatIdentityRepository,
  observe: (diagnostic) => app.log[diagnostic.level]({
    channel: diagnostic.channel,
    code: diagnostic.code,
    missing: diagnostic.missing,
  }, diagnostic.message),
})
const sopActionAdapters = createSopActionAdapters(runtimeConfig)

function isPersistenceFailure(error: unknown) {
  if (error instanceof PostgresRepositoryError || error instanceof OperationalReadStoreError) return true
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  const code = String((error as { code?: unknown }).code ?? '')
  return /^[0-9A-Z]{5}$/.test(code) || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(code)
}

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) {
    return reply.status(400).send(clientValidationError(error))
  }
  if (error instanceof BenefitRedemptionBusinessError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message })
  }
  if (error instanceof SopActionBusinessError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message })
  }
  if (error instanceof HardwareBusinessError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message })
  }
  if (error instanceof AuthenticationError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message })
  }
  if (error instanceof AuthorizationError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message, operation: error.operation })
  }
  if (error instanceof CommerceRequestError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message })
  }
  if (error instanceof SongConfigVersionConflictError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message, currentVersion: error.currentVersion })
  }
  if (error instanceof TableAccessError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message, details: error.details })
  }
  if (error instanceof PaymentProviderUnavailableError) {
    return reply.status(503).send({ code: 'PAYMENT_PROVIDER_UNAVAILABLE', message: error.message })
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
  if (isPersistenceFailure(error)) {
    app.log.error(error)
    return reply.status(503).send({
      code: 'PERSISTENCE_UNAVAILABLE',
      message: '经营数据服务暂时不可用，请稍后重试',
    })
  }
  app.log.error(error)
  return reply.status(400).send({
    code: 'BUSINESS_ERROR',
    message: error instanceof Error ? error.message : '未知业务错误',
  })
})

app.get('/api/health', async () => ({ status: 'ok', time: new Date().toISOString() }))

app.get('/api/bootstrap', async (request, reply) => {
  const aggregateState = request.mboxAuthState ?? await repository.read()
  const actor = requireRequestActor(request)
  const authoritativePromise = operationalStateCache.getOrCreate(actor.storeId, aggregateState.revision, async () => {
    if (!runtimeDependencies.operationalReadStore) {
      return { state: aggregateState, source: 'aggregate_compatibility' as const }
    }
    if (!repository.readFresh) {
      return { state: aggregateState, source: 'aggregate_compatibility' as const }
    }
    const resolved = await resolveOperationalRuntimeState({
      initialState: aggregateState,
      readFresh: () => repository.readFresh!(),
      readSnapshot: (revision, businessDate) => runtimeDependencies.operationalReadStore!.read(revision, businessDate),
    })
    if (resolved.source === 'aggregate_compatibility') {
      app.log.warn({
        revision: resolved.state.revision,
        revisionMismatches: resolved.revisionMismatches,
      }, 'operational read revision kept advancing; served fresh aggregate fallback')
    }
    return { state: resolved.state, source: resolved.source }
  })
  let authoritative: Awaited<typeof authoritativePromise>
  try {
    authoritative = await authoritativePromise
  } catch (error) {
    operationalStateCache.delete(actor.storeId, aggregateState.revision)
    throw error
  }
  const state = authoritative.state
  const view = bootstrapViewCache.getOrCreate(`${actor.storeId}:${actor.actorId}`, state.revision, () => {
    const projected = projectRuntimeStateForActor(state, actor)
    return {
      projected,
      etag: buildBootstrapViewEtag(projected),
      permissionIds: effectivePermissionIdsForEmployee(state, actor.actorId),
      metrics: calculateMetrics(projected),
      source: authoritative.source,
    }
  })
  const legacyRevisionEtag = `"${state.revision}"`
  reply
    .header('etag', view.etag)
    .header('cache-control', 'private, no-cache')
    .header('x-mbox-operational-source', view.source)
  if ([view.etag, legacyRevisionEtag].includes(request.headers['if-none-match'] ?? '')) {
    return reply.status(304).send()
  }
  return {
    ...view.projected,
    serverNow: new Date().toISOString(),
    metrics: view.metrics,
    runtimeCapabilities: {
      voiceTranscription: runtimeConfig.voiceTranscriptionProvider,
    },
    viewer: { actorId: actor.actorId, permissionIds: view.permissionIds },
  }
})

registerTaskRoutes(app, repository)

app.put('/api/config/draft', async (request) => {
  const input = configDraftSchema.parse(request.body)
  return repository.mutate((state) => {
    const actor = requireConfiguredOperation(request, state, 'config.write')
    return saveConfigDraft(state, input, actor.actorId)
  })
})

app.post('/api/config/publish', async (request) => {
  const input = publishConfigVersionSchema.omit({ actorId: true, occurredAt: true }).parse(request.body)
  return repository.mutate((state) => {
    const actor = requireConfiguredOperation(request, state, 'config.write')
    const result = publishConfigVersion(state, state.configVersions, {
      ...input,
      actorId: actor.actorId,
      occurredAt: new Date().toISOString(),
    })
    Object.assign(state, result.state, { configVersions: result.versions })
    return result.state.config
  })
})

app.get('/api/config/versions', async (request) => {
  const state = await repository.read()
  requireConfiguredOperation(request, state, 'config.write')
  return state.configVersions.toSorted((left, right) => right.version - left.version)
})

app.post<{ Params: { version: string } }>('/api/config/versions/:version/rollback', async (request) => {
  const input = rollbackConfigVersionSchema.omit({ actorId: true, occurredAt: true, targetVersion: true }).parse(request.body)
  const targetVersion = Number(request.params.version)
  return repository.mutate((state) => {
    const actor = requireConfiguredOperation(request, state, 'config.write')
    const result = rollbackConfigVersion(state, state.configVersions, {
      ...input,
      targetVersion,
      actorId: actor.actorId,
      occurredAt: new Date().toISOString(),
    })
    Object.assign(state, result.state, { configVersions: result.versions })
    return result.state.config
  })
})

app.post('/api/master-data/employees', async (request, reply) => {
  const input = employeeWriteSchema.parse(request.body)
  const employee = await repository.mutate((state) => {
    const actor = requireConfiguredOperation(request, state, 'identity.write')
    return createEmployee(state, input, actor.actorId)
  })
  return reply.status(201).send(employee)
})

app.put<{ Params: { employeeId: string } }>('/api/master-data/employees/:employeeId', async (request) => {
  const input = employeeWriteSchema.parse(request.body)
  return repository.mutate((state) => {
    const actor = requireConfiguredOperation(request, state, 'identity.write')
    return updateEmployee(state, request.params.employeeId, input, actor.actorId)
  })
})

app.put<{ Params: { tableId: string } }>('/api/master-data/tables/:tableId', async (request) => {
  const input = tableWriteSchema.parse(request.body)
  return repository.mutate((state) => {
    const actor = requireConfiguredOperation(request, state, 'table.write')
    return updateTable(state, request.params.tableId, input, actor.actorId)
  })
})

app.post('/api/master-data/shifts', async (request, reply) => {
  const input = shiftWriteSchema.parse(request.body)
  const shift = await repository.mutate((state) => {
    const actor = requireConfiguredOperation(request, state, 'shift.write')
    return createShift(state, input, actor.actorId)
  })
  return reply.status(201).send(shift)
})

app.put<{ Params: { shiftId: string } }>('/api/master-data/shifts/:shiftId', async (request) => {
  const input = shiftWriteSchema.parse(request.body)
  return repository.mutate((state) => {
    const actor = requireConfiguredOperation(request, state, 'shift.write')
    return updateShift(state, request.params.shiftId, input, actor.actorId)
  })
})

app.put<{ Params: { areaId: string } }>('/api/master-data/areas/:areaId', async (request) => {
  const input = areaWriteSchema.parse(request.body)
  return repository.mutate((state) => {
    const actor = requireConfiguredOperation(request, state, 'master-data.write')
    return updateArea(state, request.params.areaId, input, actor.actorId)
  })
})

app.post('/api/master-data/products', async (request, reply) => {
  const input = productWriteSchema.parse(request.body)
  const product = await repository.mutate((state) => {
    const actor = requireConfiguredOperation(request, state, 'master-data.write')
    const permissionIds = effectivePermissionIdsForEmployee(state, actor.actorId)
    const canManageFinance = permissionIds.includes('finance.manage')
    const canViewFinance = canManageFinance || permissionIds.includes('finance.view')
    const protectedInput = preserveProtectedProductCost(input, 0, canManageFinance)
    return productCostView(createProduct(state, protectedInput, actor.actorId), canViewFinance)
  })
  return reply.status(201).send(product)
})

app.put<{ Params: { productId: string } }>('/api/master-data/products/:productId', async (request) => {
  const input = productWriteSchema.parse(request.body)
  return repository.mutate((state) => {
    const actor = requireConfiguredOperation(request, state, 'master-data.write')
    const product = state.products.find((candidate) => candidate.id === request.params.productId)
    if (!product) throw new Error('商品不存在')
    const permissionIds = effectivePermissionIdsForEmployee(state, actor.actorId)
    const canManageFinance = permissionIds.includes('finance.manage')
    const canViewFinance = canManageFinance || permissionIds.includes('finance.view')
    const protectedInput = preserveProtectedProductCost(input, product.costAmount, canManageFinance)
    return productCostView(updateProduct(state, request.params.productId, protectedInput, actor.actorId), canViewFinance)
  })
})

app.post('/api/master-data/commerce-authorities', async (request, reply) => {
  const input = authorityWriteSchema.parse(request.body)
  const authority = await repository.mutate((state) => {
    const actor = requireConfiguredOperation(request, state, 'commerce-authority.write')
    input.kinds.forEach((kind) => requireApprovalAmount(request, state, kind, input.maxAmount, 'commerce-authority.write'))
    return createAuthority(state, input, actor.actorId)
  })
  return reply.status(201).send(authority)
})

app.put<{ Params: { authorityId: string } }>('/api/master-data/commerce-authorities/:authorityId', async (request) => {
  const input = authorityWriteSchema.parse(request.body)
  return repository.mutate((state) => {
    const actor = requireConfiguredOperation(request, state, 'commerce-authority.write')
    input.kinds.forEach((kind) => requireApprovalAmount(request, state, kind, input.maxAmount, 'commerce-authority.write'))
    return updateAuthority(state, request.params.authorityId, input, actor.actorId)
  })
})

app.post('/api/dev/reset', async (request) => {
  await repository.mutate((state) => requireConfiguredOperation(request, state, 'config.write'))
  return repository.reset()
})

registerCommerceRoutes(app, repository, { guestTokenSecret: runtimeConfig.qrSecret, guestInsights })
registerPaymentRoutes(app, repository, {
  allowPilotSimulation: runtimeConfig.pilotPaymentSimulationEnabled,
  providerResolver: paymentProviderResolver,
})
registerProactiveServiceRoutes(app, repository)
registerTableSessionRoutes(app, repository)
registerBusinessDayRoutes(app, repository)
registerBenefitRoutes(app, repository)
registerMemberPortalRoutes(app, repository)
registerNotificationRoutes(app, repository)
registerBenefitRedemptionRoutes(app, repository)
registerSongRoutes(app, repository)
registerGuestRoutes(app, repository, {
  secret: runtimeConfig.qrSecret,
  previousSecret: runtimeConfig.qrPreviousSecret,
  runtimeMode: runtimeConfig.runtimeMode,
  allowPaymentSimulation: runtimeConfig.pilotPaymentSimulationEnabled,
  providerResolver: paymentProviderResolver,
  guestInsights,
})
registerPublicReservationRoutes(app, repository, { secret: runtimeConfig.qrSecret, rateLimitStore })
registerStoreImportRoutes(app, repository)
registerInventoryRoutes(app, repository)
registerReservationRoutes(app, repository)
registerCommercialOpsRoutes(app, repository)
registerHardwareRoutes(app, repository)
registerWaitlistRoutes(app, repository)
registerSopActionRoutes(app, repository, {
  qrSecret: runtimeConfig.qrSecret,
  qrPreviousSecret: runtimeConfig.qrPreviousSecret,
})

if (runtimeConfig.runtimeMode === 'staging' || runtimeConfig.runtimeMode === 'production') {
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ code: 'ROUTE_NOT_FOUND', message: '接口不存在' })
    }
    const path = request.url.split('?')[0]?.replace(/\/$/, '') || '/'
    if (path === '/' || path === '/guest' || path === '/member' || path === '/reserve') return reply.sendFile('index.html')
    return reply.status(404).send({ code: 'PAGE_NOT_FOUND', message: '页面不存在' })
  })
}

let schedulerRunning = false
const notificationWorkerId = `notification-worker:${process.pid}:${randomUUID()}`
const sopActionWorkerId = `sop-action-worker:${process.pid}:${randomUUID()}`
const scheduler = setInterval(() => {
  if (schedulerRunning) return
  schedulerRunning = true
  const now = new Date()
  void repository.read()
    .then(async (snapshot) => {
      const scheduledWorkDue = scheduledOperationsWouldChange(snapshot, now)
      const businessDayRollover = scheduledWorkDue
        ? await repository.mutate((state) => applyScheduledOperations(state, now))
        : null
      const dispatchSnapshot = scheduledWorkDue ? await repository.read() : snapshot
      if (businessDayRollover?.status === 'rolled_over') {
        app.log.info({
          previousBusinessDate: businessDayRollover.steps[0]?.businessDate,
          businessDate: businessDayRollover.businessDate,
          rolledBusinessDayCount: businessDayRollover.steps.length,
        }, 'business day automatically rolled over')
      }
      await Promise.all([
        dispatchDueNotifications(repository, customerNotificationAdapters, notificationWorkerId, now, {}, dispatchSnapshot),
        dispatchDueSopActions(repository, sopActionAdapters, sopActionWorkerId, now, dispatchSnapshot),
      ])
    })
    .catch((error) => app.log.error(error))
    .finally(() => { schedulerRunning = false })
}, 2_000)
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

const rateLimitCleanupScheduler = runtimeDependencies.postgresPool
  ? setInterval(() => {
      void rateLimitStore.cleanupExpired(1_000).catch((error) => app.log.error(error))
    }, 15 * 60_000)
  : null
rateLimitCleanupScheduler?.unref()

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  app.log.info({ signal }, 'graceful shutdown started')
  clearInterval(scheduler)
  if (wechatCleanupScheduler) clearInterval(wechatCleanupScheduler)
  if (rateLimitCleanupScheduler) clearInterval(rateLimitCleanupScheduler)
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
