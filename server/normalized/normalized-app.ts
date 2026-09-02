import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import staticPlugin from '@fastify/static'
import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyRequest,
  LogController,
} from 'fastify'
import { Pool } from 'pg'
import { wechatApiPlugin } from '../wechat-api.js'
import {
  OfficialWechatCodeSessionProvider,
  PostgresWechatChallengeRepository,
  PostgresWechatIdentityRepository,
} from '../wechat-production-adapters.js'
import type { PostgresPool as WechatPostgresPool } from '../postgres-repository.js'
import { AiCapabilityCenter, createCoreAiCapabilities } from './ai-capability-center.js'
import { aiExecutionApiPlugin } from './ai-execution-api.js'
import { ActivityPaymentService } from './activity-payment-service.js'
import { activitySharePreviewApiPlugin } from './activity-share-preview-api.js'
import { activityOperationsApiPlugin } from './activity-operations-api.js'
import { ActivityOperationsService } from './activity-operations-service.js'
import { BenefitCommandService } from './benefit-repository.js'
import { AnnualDailySnackClaimService } from './annual-daily-snack-claim-service.js'
import { catalogApiPlugin } from './catalog-api.js'
import { appendAuditEvent, appendOutboxMessage, NormalizedCommandExecutor, type JsonObject } from './command-executor.js'
import { CommerceCommandService } from './commerce-command-service.js'
import { commerceKdsApiPlugin } from './commerce-kds-api.js'
import { commercialOpsApiPlugin } from './commercial-ops-api.js'
import { customerBenefitApiPlugin } from './customer-benefit-api.js'
import { customerExperienceAnalyticsApiPlugin } from './customer-experience-analytics-api.js'
import { customerExperienceApiPlugin } from './customer-experience-api.js'
import { CustomerExperienceService } from './customer-experience-service.js'
import { customerPreferenceApiPlugin } from './customer-preference-api.js'
import { CustomerPreferenceService } from './customer-preference-service.js'
import { recommendationStaffModificationApiPlugin } from './recommendation-staff-modification-api.js'
import { RecommendationStaffModificationService } from './recommendation-staff-modification-service.js'
import { CustomerCommandService, CustomerRepository } from './customer-repository.js'
import { FulfillmentQueryService } from './fulfillment-query-service.js'
import { guestCommerceServiceApiPlugin } from './guest-commerce-service-api.js'
import {
  GUEST_DEVICE_HEADER,
  GuestRequestContextResolver,
  HeaderGuestDeviceFingerprintResolver,
} from './guest-request-context.js'
import { guestSessionApiPlugin } from './guest-session-api.js'
import { GuestSessionService, GuestTableSessionEndedError } from './guest-session-repository.js'
import { hardwareApiPlugin } from './hardware-api.js'
import { printBridgeApiPlugin } from './print-bridge-api.js'
import { inventoryApiPlugin } from './inventory-api.js'
import { InventoryQueryService } from './inventory-query-service.js'
import { KdsRepository } from './kds-repository.js'
import { loyaltyTierBenefitManagementApiPlugin } from './loyalty-tier-benefit-management-api.js'
import { LoyaltyTierBenefitManagementService } from './loyalty-tier-benefit-management-service.js'
import { loyaltyAnnualBenefitApiPlugin } from './loyalty-annual-benefit-api.js'
import { LoyaltyAnnualBenefitService } from './loyalty-annual-benefit-service.js'
import { loyaltyOperationalControlApiPlugin } from './loyalty-operational-control-api.js'
import { LoyaltyOperationalControlService } from './loyalty-operational-control-service.js'
import { membershipConfigurationApiPlugin } from './membership-configuration-api.js'
import { MembershipEnrollmentService } from './membership-enrollment-service.js'
import {
  MembershipRecoveryService,
  createMembershipRecoveryPhoneProtector,
  type MembershipRecoveryPhoneAuthorizationPort,
} from './membership-recovery-service.js'
import {
  DEVICE_ACCESS_COOKIE,
  PostgresNormalizedBusinessClock,
  STAFF_SESSION_COOKIE,
  NormalizedRequestContextResolver,
  fixedStoreScopeResolver,
  readRequestToken,
} from './normalized-request-context.js'
import { normalizedNotificationApiPlugin } from './notification-api.js'
import { NotificationQueryService } from './notification-query-service.js'
import { NotificationRepository } from './notification-repository.js'
import { normalizedOperationsApiPlugin } from './normalized-operations-api.js'
import { OperationsQueryService } from './operations-query-service.js'
import { OrderRepository } from './order-repository.js'
import { PostgresOrderCancellationRepository } from './order-cancellation-repository.js'
import { PostgresOrderSettlementExceptionRepository } from './order-settlement-exception-repository.js'
import { paymentApiPlugin, PaymentProviderVerificationError, type PaymentProviderVerifier } from './payment-api.js'
import { PaymentCommandService } from './payment-command-service.js'
import { PaymentFulfillmentRepository } from './payment-fulfillment-repository.js'
import { OnlinePaymentService } from './online-payment-service.js'
import { NormalizedPaymentCapabilityAuthorization } from './payment-security-policy.js'
import { PostgresCashierWorkbenchQuery } from './cashier-workbench-query.js'
import { registerNormalizedObservability } from './normalized-observability.js'
import { PerformanceCommandService } from './performance-command-service.js'
import { PerformerRepository } from './performer-repository.js'
import { PostarRsaPaymentProviderVerifier } from './postar-provider-verifier.js'
import {
  NormalizedProviderObservationAuthority,
  VerifiedProviderObservationService,
} from './provider-verification-observation.js'
import { PostgresPricingAuthority } from './postgres-pricing-authority.js'
import { PostgresReconciliationQuery } from './postgres-reconciliation-query.js'
import { ProfitQueryService } from './profit-query-service.js'
import { promotionalLoyaltyApiPlugin } from './promotional-loyalty-api.js'
import {
  promotionalLoyaltyPublicApiPlugin,
  PromotionalLoyaltyPublicQuery,
} from './promotional-loyalty-public-api.js'
import { PromotionalLoyaltyService } from './promotional-loyalty-service.js'
import { publicReservationApiPlugin } from './public-reservation-api.js'
import { ReservationCommandService } from './reservation-command-service.js'
import {
  ReservationGuestSessionInvalidError,
  ReservationGuestSessionService,
  type ReservationIdentityPort,
} from './reservation-guest-session.js'
import { reservationPerformanceApiPlugin } from './reservation-performance-api.js'
import { reservationPerformanceNotificationApiPlugin } from './reservation-performance-notification-api.js'
import { reservationPerformanceRevisionApiPlugin } from './reservation-performance-revision-api.js'
import { ReservationPerformanceRevisionService } from './reservation-performance-revision-service.js'
import { ReservationRepository } from './reservation-repository.js'
import { ScheduleRepository } from './schedule-repository.js'
import { ServiceTaskRepository } from './service-task-repository.js'
import { SongRequestRepository } from './song-request-repository.js'
import { SopCommandService } from './sop-repository.js'
import { SopWorker, type SopActionPort } from './sop-worker.js'
import { StaffAuthCommandService } from './staff-auth-command-service.js'
import { staffAuthApiPlugin } from './staff-auth-api.js'
import { staffAccessManagementApiPlugin } from './staff-access-management-api.js'
import { StaffAccessManagementService } from './staff-access-management-service.js'
import { StaffBootstrapQuery } from './staff-bootstrap-query.js'
import { PostgresStaffLoginRateLimiter } from './staff-login-rate-limiter.js'
import { staffWorkspaceApiPlugin } from './staff-workspace-api.js'
import { resolveEffectiveOnlinePayment, storeCommercePolicyApiPlugin } from './store-commerce-policy.js'
import { tableManagementApiPlugin } from './table-management-api.js'
import { TableManagementCommandService, TableManagementRepository } from './table-management-repository.js'
import { TableSessionCommandService, TableSessionRepository } from './table-session-repository.js'
import { PostgresTableCustomerLeftTurnoverRepository } from './table-customer-left-turnover-repository.js'
import { WaitlistCommandService } from './waitlist-repository.js'
import { OfficialWechatPhoneAuthorizationProvider } from './wechat-phone-authorization.js'
import { wechatLoyaltyNotificationApiPlugin } from './wechat-loyalty-notification-api.js'
import { wechatMemberServiceNotificationApiPlugin } from './wechat-member-service-notification-api.js'
import { wechatNotificationPromptApiPlugin } from './wechat-notification-prompt-api.js'
import { MembershipTermsService } from './membership-terms-service.js'
import { memberContentCardApiPlugin } from './member-content-card-api.js'
import { MemberContentCardService } from './member-content-card-service.js'
import { mediaAssetApiPlugin } from './media-asset-api.js'
import { MediaAssetService } from './media-asset-service.js'
import { createActivityContactProtectionKeyring } from './personal-contact-protection.js'
import { personalContactGovernanceApiPlugin } from './personal-contact-governance-api.js'
import { PersonalContactGovernanceService } from './personal-contact-governance-service.js'
import {
  NORMALIZED_SCHEMA_FLAVOR,
  NormalizedRuntimeConfigurationError,
  type NormalizedRuntimeConfig,
} from './normalized-runtime-config.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type ScopedTransaction,
  type StoreScope,
} from './transaction-runner.js'

export const NORMALIZED_LOG_REDACTION_PATHS = Object.freeze([
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'body.pin',
  'body.credential',
  'body.tableQrToken',
  'body.deviceKey',
  'body.deviceFingerprint',
  'body.providerAssertion',
  'body.customerAuthCode',
  'body.openid',
  'body.payerId',
  'body.phone',
  'body.contact',
  'body.contactValue',
  'body.contactToken',
  'body.phoneAuthorizationCode',
  'databaseUrl',
  'secret',
  'payment.publicKey',
])

export const NORMALIZED_MIN_SCHEMA_VERSION = '114'
export const NORMALIZED_INJECTABLE_PLUGIN_PORTS = Object.freeze([
  'customer-table-side',
] as const)

const RESERVATION_GUEST_SESSION_COOKIE = 'mbox_reservation_session'

export interface NormalizedLifecycleController {
  start(): void | Promise<void>
  stop(): void | Promise<void>
}

export interface NormalizedInjectedPlugin {
  name: string
  plugin: FastifyPluginAsync<Record<string, unknown>>
  options?: Readonly<Record<string, unknown>>
  prefix?: string
}

export interface NormalizedAppOptions {
  config: Readonly<NormalizedRuntimeConfig>
  pool?: PostgresPool
  logger?: boolean
  paymentProviderVerifier?: PaymentProviderVerifier
  recoveryPhoneAuthorization?: MembershipRecoveryPhoneAuthorizationPort
  lifecycleControllers?: readonly NormalizedLifecycleController[]
  injectedPlugins?: readonly NormalizedInjectedPlugin[]
  workerHealth?: { snapshot(): Readonly<{
    status: 'starting' | 'healthy' | 'degraded'
    lastCompletedAt: string | null
    failures: readonly string[]
    integrationWorkersEnabled: boolean
    adapterCapabilities: readonly string[]
  }> }
}

export interface NormalizedAppRuntime {
  app: FastifyInstance
  pool: PostgresPool
  transactions: ScopedPostgresTransactionRunner
  commandExecutor: NormalizedCommandExecutor
  databaseTelemetry(): ReturnType<ScopedPostgresTransactionRunner['telemetrySnapshot']>
  services: Readonly<{
    staffAuth: StaffAuthCommandService
    guestSessions: GuestSessionService
    sop: SopCommandService
    ai: AiCapabilityCenter
    createSopWorker(actions: SopActionPort): SopWorker
  }>
}

interface ReadyRow extends Record<string, unknown> {
  schema_flavor: string
  schema_version: string
  store_active: boolean
}

interface PersonalContactKeyProbeRow extends Record<string,unknown> {
  personal_contact_key_ids: string[]
  personal_contact_key_probes: Array<{
    kind:'activity_registration_contact'|'verified_membership_phone'
    keyId:string; contactHash:string; encryptedBase64:string
  }>
}

export async function createNormalizedApp(options: Readonly<NormalizedAppOptions>): Promise<NormalizedAppRuntime> {
  assertRuntimeConfig(options.config)
  const scope = Object.freeze({
    tenantId: options.config.tenantId,
    storeId: options.config.storeId,
  })
  const app = Fastify({
    logger: options.logger ?? loggerConfiguration(options.config),
    logController: new LogController({ disableRequestLogging: true }),
    // Fastify 5.12.1 deliberately fails closed for numeric hop-count trust:
    // a hop count cannot prove that the immediate peer is our proxy. The app
    // is reachable only from the host's Caddy container on the private Docker
    // network (or loopback in local validation), so validate that peer network
    // explicitly and let proxy-addr stop at the first public client address.
    trustProxy: options.config.trustProxyHops === 0 ? false : ['loopback', 'uniquelocal'],
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  })
  // wx.request may send DELETE/PATCH with content-type application/json and no body.
  // Accept an empty body instead of failing the whole public reservation flow.
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    if (body === '' || body === undefined || body === null) {
      done(null, undefined)
      return
    }
    try {
      const text = typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : String(body)
      if (!text) {
        done(null, undefined)
        return
      }
      done(null, JSON.parse(text) as unknown)
    } catch (error) {
      done(error as Error)
    }
  })
  if (options.config.runtimeRole==='contract_candidate') {
    app.addHook('onRequest',async(request,reply)=>{
      if (request.method==='GET' || request.method==='HEAD' || request.method==='OPTIONS') return
      return reply.code(503).send({ error:{
        code:'CONTRACT_CANDIDATE_READ_ONLY',
        message:'系统正在完成安全升级，暂不接受写入操作。',
      } })
    })
  }
  const pool = options.pool ?? createPool(options.config)
  pool.on?.('error', (error) => {
    app.log.error({ errorCode: safeErrorCode(error) }, 'normalized database pool idle client failed')
  })
  const transactions = new ScopedPostgresTransactionRunner(pool)
  const activityContactProtection = createActivityContactProtectionKeyring(
    options.config.personalContactProtection ?? null,
    options.config.secret,
  )
  const wechatIdentity = options.config.wechatIdentity === null
    ? null
    : new PostgresWechatIdentityRepository({
        pool: pool as unknown as WechatPostgresPool,
        tenantId: scope.tenantId,
        storeId: scope.storeId,
        appId: options.config.wechatIdentity.appId,
        activeKeyVersion: options.config.wechatIdentity.encryptionKeyVersion,
        encryptionKeys: new Map([[
          options.config.wechatIdentity.encryptionKeyVersion,
          options.config.wechatIdentity.encryptionKey,
        ]]),
      })
  registerNormalizedObservability(app, options.config, transactions)
  const commandExecutor = new NormalizedCommandExecutor(transactions)
  const providerObservations = new VerifiedProviderObservationService(transactions)
  const onlinePayments = new OnlinePaymentService(
    transactions,
    options.config.secret,
    options.config.payment,
    undefined,
    undefined,
    wechatIdentity,
  )
  const businessClock = new PostgresNormalizedBusinessClock(transactions)
  const trustedScope = fixedStoreScopeResolver(scope)
  const staffRateLimiter = new PostgresStaffLoginRateLimiter(transactions, options.config.secret)
  const staffAuth = new StaffAuthCommandService(transactions, commandExecutor, staffRateLimiter)
  const staffContext = new NormalizedRequestContextResolver(trustedScope, staffAuth, businessClock)
  const guestDevices = new HeaderGuestDeviceFingerprintResolver()
  const guestSessions = new GuestSessionService(
    transactions,
    {
      resolveAnonymous: async ({ transaction, identityHash, publicId }) => {
        const result = await new CustomerRepository(transaction).createAnonymous({ publicId, identityHash })
        return { customerId: result.customer.id }
      },
    },
    options.config.secret,
  )
  const guestContext = new GuestRequestContextResolver(trustedScope, guestDevices, guestSessions)
  const reservationGuestSessions = new ReservationGuestSessionService(
    transactions,
    commandExecutor,
    createReservationIdentityPort(),
  )
  const tableManagement = new TableManagementCommandService(commandExecutor)
  const sop = new SopCommandService(commandExecutor)
  const ai = new AiCapabilityCenter(commandExecutor, createCoreAiCapabilities(coreAiPorts()))
  const lifecycleControllers = [...(options.lifecycleControllers ?? [])]
  if (options.config.startWorkers && lifecycleControllers.length === 0) {
    throw new NormalizedRuntimeConfigurationError(['MBOX_START_WORKERS'])
  }

  registerStaffAuthenticationErrorClassification(app, transactions, scope)

  let startedControllerCount = 0
  app.addHook('onReady', async () => {
    if (!options.config.startWorkers) return
    for (const controller of lifecycleControllers) {
      await controller.start()
      startedControllerCount += 1
    }
  })
  app.addHook('onClose', async () => {
    for (const controller of lifecycleControllers.slice(0, startedControllerCount).toReversed()) {
      await controller.stop()
    }
    await pool.end()
  })

  try {
    registerSystemRoutes(
      app,options.config,transactions,scope,activityContactProtection,options.workerHealth,
    )
    if (options.config.wechatIdentity !== null && wechatIdentity !== null) {
      const repositoryOptions = {
        pool: pool as unknown as WechatPostgresPool,
        tenantId: scope.tenantId,
        storeId: scope.storeId,
        appId: options.config.wechatIdentity.appId,
        activeKeyVersion: options.config.wechatIdentity.encryptionKeyVersion,
        encryptionKeys: new Map([[
          options.config.wechatIdentity.encryptionKeyVersion,
          options.config.wechatIdentity.encryptionKey,
        ]]),
      }
      await app.register(wechatApiPlugin, {
        runtimeMode: options.config.nodeEnv === 'development' ? 'local' : options.config.nodeEnv,
        stateSecret: options.config.wechatIdentity.stateSecret,
        provider: new OfficialWechatCodeSessionProvider({
          appSecrets: { [options.config.wechatIdentity.appId]: options.config.wechatIdentity.appSecret },
        }),
        challengeRepository: new PostgresWechatChallengeRepository(repositoryOptions),
        identityRepository: wechatIdentity,
        applications: [{
          tenantId: scope.tenantId,
          storeId: scope.storeId,
          appId: options.config.wechatIdentity.appId,
        }],
      })
    }
    registerDomainPlugins(app)
    await registerInjectedPlugins(app, options.injectedPlugins ?? [])
    if (options.config.staticDir !== null) {
      await app.register(staticPlugin, {
        root: resolve(options.config.staticDir),
        prefix: '/',
        wildcard: true,
        index: ['index.html'],
      })
      registerSinglePageApplicationFallback(app)
    }
    await app.ready()
  } catch (error) {
    await app.close().catch(() => undefined)
    throw error
  }
  return {
    app,
    pool,
    transactions,
    commandExecutor,
    databaseTelemetry: () => transactions.telemetrySnapshot(),
    services: Object.freeze({
      staffAuth,
      guestSessions,
      sop,
      ai,
      createSopWorker: (actions: SopActionPort) => new SopWorker(transactions, actions),
    }),
  }

  function registerDomainPlugins(instance: FastifyInstance): void {
    const operationsContext = (request: FastifyRequest) => staffContext.resolve(request)
    const commerceContext = async (request: FastifyRequest) => {
      const trusted = await staffContext.resolveTrustedScope(request)
      const token = readRequestToken(request, STAFF_SESSION_COOKIE)
      const [authenticated, day] = await Promise.all([
        staffAuth.authenticateSession(trusted, token),
        businessClock.current(trusted),
      ])
      return {
        scope: trusted,
        employeeId: authenticated.session.employeeId,
        staffSessionId: authenticated.session.id,
        deviceAccessLeaseId: authenticated.session.deviceAccessLeaseId,
        businessDate: day.businessDate,
      }
    }
    const guestReservationContext = async (request: FastifyRequest) => {
      const context = await guestContext.resolve(request)
      const businessDate = context.businessDate ?? (await businessClock.current(context.scope)).businessDate
      return {
        scope: context.scope,
        customerId: context.customerId,
        tableSessionId: context.tableSessionId,
        businessDate,
        actorRef: context.actorRef,
      }
    }
    const staffReservationContext = async (request: FastifyRequest) => {
      const context = await staffContext.resolve(request)
      return { scope: context.scope, employeeId: context.employeeId, businessDate: context.businessDate }
    }

    instance.register(staffAuthApiPlugin, {
      prefix: '/api/auth',
      auth: staffAuth,
      requestContext: staffContext,
      businessClock,
    })
    instance.register(staffWorkspaceApiPlugin, {
      prefix: '/api',
      query: new StaffBootstrapQuery(transactions),
      resolveContext: operationsContext,
    })
    instance.register(staffAccessManagementApiPlugin, {
      prefix: '/api',
      service: new StaffAccessManagementService(transactions, commandExecutor),
      resolveContext: operationsContext,
    })
    instance.register(guestSessionApiPlugin, {
      prefix: '/api/guest',
      sessions: guestSessions,
      requestContext: guestContext,
      businessClock,
      resolveWechatCustomer: resolveWechatTableScanCustomer,
      loadTableOverview: (currentScope, tableSessionId) => transactions.run(
        currentScope,
        async (transaction) => {
          const selected = await transaction.query<{
            guest_count: number
            primary_service_name: string | null
            guest_cart_protocol_version: number
          }>(`
            SELECT table_session.guest_count,table_session.guest_cart_protocol_version,
              CASE WHEN count(public_profile.id) = 1 THEN min(public_profile.public_display_name) ELSE NULL END
                AS primary_service_name
            FROM mbox.table_sessions AS table_session
            LEFT JOIN mbox.table_assignments AS assignment
              ON assignment.tenant_id = table_session.tenant_id
             AND assignment.store_id = table_session.store_id
             AND assignment.table_id = table_session.table_id
             AND assignment.assignment_type = 'primary'
             AND assignment.starts_at <= clock_timestamp()
             AND (assignment.ends_at IS NULL OR assignment.ends_at > clock_timestamp())
            LEFT JOIN mbox.employees AS employee
              ON employee.tenant_id = assignment.tenant_id
             AND employee.store_id = assignment.store_id
             AND employee.id = assignment.employee_id
             AND employee.status = 'active'
            LEFT JOIN mbox.employee_customer_public_profiles AS public_profile
              ON public_profile.tenant_id = employee.tenant_id
             AND public_profile.store_id = employee.store_id
             AND public_profile.employee_id = employee.id
             AND public_profile.status = 'published'
             AND public_profile.effective_at <= clock_timestamp()
            WHERE table_session.tenant_id = $1::uuid
              AND table_session.store_id = $2::uuid
              AND table_session.id = $3::uuid
              AND table_session.status = 'open'
            GROUP BY table_session.id, table_session.guest_count,table_session.guest_cart_protocol_version
          `, [transaction.scope.tenantId, transaction.scope.storeId, tableSessionId])
          const row = selected.rows[0]
          if (row === undefined) throw new GuestTableSessionEndedError()
          return {
            guestCount: Number(row.guest_count),
            primaryServiceName: row.primary_service_name,
            cartProtocolVersion: Number(row.guest_cart_protocol_version) as 1 | 2,
          }
        },
        { readOnly: true },
      ),
    })
    instance.register(normalizedOperationsApiPlugin, {
      prefix: '/api',
      operationsQuery: new OperationsQueryService(transactions),
      tableSessions: new TableSessionCommandService(commandExecutor),
      commandExecutor,
      resolveContext: operationsContext,
      createTableSessionRepository: (transaction) => new TableSessionRepository(transaction),
      createCustomerLeftTableTurnoverRepository: (transaction) => new PostgresTableCustomerLeftTurnoverRepository(transaction),
      createServiceTaskRepository: (transaction) => new ServiceTaskRepository(transaction),
    })
    instance.register(catalogApiPlugin, {
      prefix: '/api',
      transactions,
      commandExecutor,
      resolveContext: operationsContext,
      resolveGuestContext: () => ({ scope }),
    })
    const commerce = new CommerceCommandService(
      commandExecutor,
      new PostgresPricingAuthority(),
      {
        inventoryEnforcementMode: options.config.inventoryEnforcementMode,
        guestOrderSafetyPolicy: options.config.guestOrderSafetyPolicy,
      },
    )
    const benefitCommands = new BenefitCommandService(commandExecutor, {
      createGiftOrder: async (transaction, input) => {
        if (input.redeemedByEmployeeId === null || !/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
          throw new Error('Gift benefit fulfillment requires an authenticated employee and business date')
        }
        const products = await transaction.query<{
          product_id: string; original_product_id: string | null; configured_reason: string | null
        }>(`
          SELECT allowed.product_id,definition.product_id AS original_product_id,
            substitute.reason AS configured_reason
          FROM mbox.benefit_allowed_products allowed
          LEFT JOIN mbox.membership_annual_benefit_grants grant_row
            ON grant_row.tenant_id=allowed.tenant_id AND grant_row.store_id=allowed.store_id
           AND grant_row.benefit_id=allowed.benefit_id
          LEFT JOIN mbox.loyalty_annual_benefit_rules rule
            ON rule.tenant_id=grant_row.tenant_id AND rule.store_id=grant_row.store_id AND rule.id=grant_row.rule_id
          LEFT JOIN mbox.loyalty_benefit_definitions definition
            ON definition.tenant_id=rule.tenant_id AND definition.store_id=rule.store_id
           AND definition.id=rule.benefit_definition_id
          LEFT JOIN mbox.loyalty_annual_benefit_rule_substitutes substitute
            ON substitute.tenant_id=rule.tenant_id AND substitute.store_id=rule.store_id
           AND substitute.rule_id=rule.id AND substitute.product_id=allowed.product_id
          WHERE allowed.tenant_id=$1::uuid AND allowed.store_id=$2::uuid AND allowed.benefit_id=$3::uuid
          ORDER BY (allowed.product_id=definition.product_id) DESC,substitute.priority,allowed.product_id
          FOR KEY SHARE OF allowed
        `, [transaction.scope.tenantId, transaction.scope.storeId, input.benefitId])
        const selected = input.selectedProductId === null
          ? (products.rows.length === 1 ? products.rows[0] : undefined)
          : products.rows.find((row) => row.product_id === input.selectedProductId)
        if (!selected) {
          throw new Error(products.rows.length > 1
            ? 'Gift benefit fulfillment requires an explicit allowed product selection'
            : 'Gift benefit fulfillment has no authoritative allowed product')
        }
        const substituted = selected.original_product_id !== null && selected.product_id !== selected.original_product_id
        const substitutionReason = input.substitutionReason?.trim() || selected.configured_reason
        if (substituted && (!substitutionReason || substitutionReason.length < 2)) {
          throw new Error('Gift benefit substitute selection requires a reason')
        }
        // A daily-snack claim already owns a short recipe hold. Release that
        // hold inside this same transaction immediately before the zero-value
        // order reserves the identical recipe, so no competing request can
        // take the inventory between the two authoritative states.
        await transaction.query(
          'SELECT mbox.convert_annual_daily_snack_inventory_hold($1::uuid)',
          [input.benefitId],
        )
        const publicId = `benefit-gift-${createHash('sha256')
          .update(`${input.benefitId}:${input.benefitReservationId}`).digest('hex').slice(0, 40)}`
        const orderOutcome = await commerce.submitOrderInTransaction(transaction, {
          scope: transaction.scope,
          actor: { type: 'employee', employeeId: input.redeemedByEmployeeId },
          businessDate: input.businessDate,
          idempotencyKey: `benefit-gift-order:${input.benefitReservationId}`,
          tableSessionId: input.tableSessionId,
          publicId,
          channel: 'cashier',
          settlementMode: 'immediate_payment',
          lines: [{ productId: selected.product_id, quantity: input.quantity }],
          note: substituted
            ? `会员权益核销：${input.benefitId}；替代商品：${selected.original_product_id} → ${selected.product_id}；原因：${substitutionReason}`
            : `会员权益核销：${input.benefitId}`,
          createdByEmployeeId: input.redeemedByEmployeeId,
          pricingAuthorization: { sourceType: 'benefit', sourceId: input.benefitId },
        })
        await new PaymentFulfillmentRepository(transaction)
          .activateComplimentaryBenefitOrder(orderOutcome.result.order.id,input.benefitId)
        for (const audit of orderOutcome.auditEvents) await appendAuditEvent(transaction, audit)
        for (const outbox of orderOutcome.outboxMessages) await appendOutboxMessage(transaction, outbox)
        await appendAuditEvent(transaction, {
          actor:{ type:'employee',employeeId:input.redeemedByEmployeeId },
          action:substituted ? 'benefit.gift_substitute_selected' : 'benefit.gift_product_selected',
          objectType:'order',objectId:orderOutcome.result.order.id,businessDate:input.businessDate,
          afterData:{ benefitId:input.benefitId,originalProductId:selected.original_product_id,
            selectedProductId:selected.product_id,substituted,substitutionReason:substitutionReason ?? null,
            inventoryState:'reserved_until_production_start' },
          reason:substitutionReason ?? undefined,
        })
        await appendOutboxMessage(transaction, {
          businessEventKey:`benefit-gift-fulfillment-requested:${orderOutcome.result.order.id}`,
          aggregateType:'order',aggregateId:orderOutcome.result.order.id,aggregateVersion:1,
          eventType:'benefit.gift.fulfillment-requested.v1',
          payload:{ orderId:orderOutcome.result.order.id,benefitId:input.benefitId,
            status:'pending',source:'benefit_gift' },
        })
        return { reference: orderOutcome.result.order.publicId }
      },
    })
    const customerExperience = new CustomerExperienceService(
      transactions,
      commandExecutor,
      new CustomerCommandService(commandExecutor),
      options.config.payment !== null,
    )
    const mediaAssets = new MediaAssetService(transactions, commandExecutor)
    const personalContactGovernance = new PersonalContactGovernanceService(
      transactions,activityContactProtection,
    )
    const customerPreferences = new CustomerPreferenceService(transactions, commandExecutor)
    const tierBenefitManagement = new LoyaltyTierBenefitManagementService(transactions, commandExecutor)
    const annualBenefitManagement = new LoyaltyAnnualBenefitService(transactions, commandExecutor)
    const annualDailySnackClaims = new AnnualDailySnackClaimService(transactions, commandExecutor)
    const loyaltyOperationalControl = new LoyaltyOperationalControlService(transactions, commandExecutor)
    const promotionalLoyalty = new PromotionalLoyaltyService(transactions, commandExecutor)
    const membershipTerms = new MembershipTermsService(transactions, commandExecutor)
    const recoveryPhoneAuthorization = options.recoveryPhoneAuthorization
      ?? (options.config.wechatIdentity === null ? undefined : new OfficialWechatPhoneAuthorizationProvider({
          appId: options.config.wechatIdentity.appId,
          appSecret: options.config.wechatIdentity.appSecret,
        }))
    const membershipPhoneProtection = createMembershipRecoveryPhoneProtector(activityContactProtection)
    const membershipRecovery = new MembershipRecoveryService(
      transactions,
      membershipPhoneProtection,
    )
    const membershipEnrollment = recoveryPhoneAuthorization === undefined
      ? undefined
      : new MembershipEnrollmentService(
          commandExecutor, recoveryPhoneAuthorization, membershipPhoneProtection,
        )
    const onlinePaymentProvider = options.config.guestPaymentMode === 'simulation'
      ? 'simulation' as const
      : options.config.payment !== null ? 'postar' as const : null
    const paymentProviderConfigured = onlinePaymentProvider !== null
    const paymentPolicy = (currentScope: Readonly<StoreScope>) => resolveEffectiveOnlinePayment(
      transactions,
      currentScope,
      paymentProviderConfigured,
      onlinePaymentProvider,
    )
    instance.register(commerceKdsApiPlugin, {
      prefix: '/api',
      commerce,
      fulfillmentQuery: new FulfillmentQueryService(transactions),
      commandExecutor,
      staffAccessTransactions: transactions,
      resolveContext: commerceContext,
      createKdsRepository: (transaction) => new KdsRepository(transaction),
      createOrderRepository: (transaction) => new OrderRepository(transaction),
      resolveOpenTableSessionId: (currentScope, tableId) => resolveOpenSession(transactions, currentScope, tableId),
      onlinePaymentAvailable: paymentProviderConfigured,
      resolveOnlinePaymentAvailable: async (currentScope) => (await paymentPolicy(currentScope)).onlinePaymentEnabled,
      onlinePaymentProvider,
    })
    const paymentCommands = new PaymentCommandService(
      commandExecutor,
      new NormalizedPaymentCapabilityAuthorization(),
      new NormalizedProviderObservationAuthority(),
    )
    const activityPayments = new ActivityPaymentService(transactions, paymentCommands, onlinePayments)
    instance.register(paymentApiPlugin, {
      prefix: '/api',
      commands: paymentCommands,
      providerVerifier: options.paymentProviderVerifier ?? paymentVerifier(options.config, scope),
      providerObservations,
      reconciliationQuery: new PostgresReconciliationQuery(transactions),
      cashierWorkbenchQuery: new PostgresCashierWorkbenchQuery(transactions),
      orderCancellation: new PostgresOrderCancellationRepository(transactions),
      orderSettlementException: new PostgresOrderSettlementExceptionRepository(transactions),
      onlinePayments,
      onlinePaymentProvider,
      resolveOnlinePaymentAvailable: async (currentScope) => (await paymentPolicy(currentScope)).onlinePaymentEnabled,
      resolveActorContext: async (request) => {
        if (isGuestRequest(request)) {
          const context = await guestReservationContext(request)
          return {
            scope: context.scope,
            actor: { type: 'guest' as const, ref: context.actorRef },
            businessDate: context.businessDate,
            ...(context.tableSessionId === null ? {} : { tableSessionId: context.tableSessionId }),
            customerId: context.customerId,
          }
        }
        const context = await staffContext.resolve(request)
        return {
          scope: context.scope,
          actor: { type: 'employee' as const, employeeId: context.employeeId },
          employeeId: context.employeeId,
          businessDate: context.businessDate,
          capabilities: context.capabilities,
        }
      },
      resolveStaffContext: async (request) => {
        const context = await staffContext.resolve(request)
        return {
          scope: context.scope,
          actor: { type: 'employee' as const, employeeId: context.employeeId },
          employeeId: context.employeeId,
          businessDate: context.businessDate,
          capabilities: context.capabilities,
        }
      },
      resolveProviderBusinessDate: async (merchant) => (
        await businessClock.current(merchant.scope)
      ).businessDate,
    })
    instance.register(reservationPerformanceApiPlugin, {
      prefix: '/api',
      transactions,
      reservations: new ReservationCommandService(commandExecutor),
      performance: new PerformanceCommandService(commandExecutor),
      resolveGuestContext: guestReservationContext,
      resolveStaffContext: staffReservationContext,
      createReservationRepository: (transaction) => new ReservationRepository(transaction),
      createPerformerRepository: (transaction) => new PerformerRepository(transaction),
      createScheduleRepository: (transaction) => new ScheduleRepository(transaction),
      createSongRequestRepository: (transaction) => new SongRequestRepository(transaction),
    })
    instance.register(customerBenefitApiPlugin, {
      prefix: '/api',
      transactions,
      customers: new CustomerCommandService(commandExecutor),
      benefits: benefitCommands,
      dailySnackClaims: annualDailySnackClaims,
      resolveSelfContext: async (request) => {
        const session = await authenticateReservationGuest(request)
        const businessDate = (await businessClock.current(scope)).businessDate
        return {
          scope,
          customerId: session.customerId,
          tableSessionId: null,
          businessDate,
          actorRef: session.actorRef,
        }
      },
      resolveGuestContext: guestReservationContext,
      resolveStaffContext: staffReservationContext,
    })
    instance.register(inventoryApiPlugin, {
      prefix: '/api',
      commands: commandExecutor,
      query: new InventoryQueryService(transactions),
      resolveContext: operationsContext,
    })
    instance.register(commercialOpsApiPlugin, {
      prefix: '/api',
      transactions,
      commandExecutor,
      queryService: new ProfitQueryService(transactions),
      resolveContext: operationsContext,
    })
    instance.register(tableManagementApiPlugin, {
      prefix: '/api',
      transactions,
      commands: tableManagement,
      resolveContext: operationsContext,
    })
    instance.register(normalizedNotificationApiPlugin, {
      prefix: '/api',
      commandExecutor,
      notificationQuery: new NotificationQueryService(transactions),
      resolveContext: operationsContext,
      createNotificationRepository: (transaction) => new NotificationRepository(transaction),
    })
    instance.register(aiExecutionApiPlugin, {
      prefix: '/api/ai',
      center: ai,
      resolveContext: staffReservationContext,
    })
    instance.register(guestCommerceServiceApiPlugin, {
      prefix: '/api',
      transactions,
      commandExecutor,
      commerce,
      payments: paymentCommands,
      onlinePayments,
      resolveGuestContext: (request) => guestContext.resolve(request),
      resolvePublicContext: async (request) => {
        await authenticateReservationGuest(request)
        return { scope }
      },
      resolveDeviceFingerprint: (request) => guestDevices.resolve(request),
      paymentMode: options.config.guestPaymentMode,
      resolvePaymentMode: async (currentScope) => (await paymentPolicy(currentScope)).onlinePaymentEnabled
        ? options.config.guestPaymentMode
        : null,
      paymentActionSecret: options.config.secret,
    })
    instance.register(hardwareApiPlugin, {
      prefix: '/api',
      transactions,
      commands: commandExecutor,
      resolveContext: operationsContext,
    })
    instance.register(printBridgeApiPlugin, {
      prefix: '/api',
      scope,
      transactions,
      hashSecret: options.config.secret,
      requireHttps: options.config.deploymentTier === 'production',
      resolveStaffContext: operationsContext,
    })
    instance.register(storeCommercePolicyApiPlugin, {
      prefix: '/api',
      transactions,
      commands: commandExecutor,
      providerConfigured: paymentProviderConfigured,
      provider: onlinePaymentProvider,
      resolveContext: operationsContext,
    })
    instance.register(loyaltyTierBenefitManagementApiPlugin, {
      prefix: '/api',
      transactions,
      service: tierBenefitManagement,
      resolveStaffContext: staffReservationContext,
    })
    instance.register(loyaltyAnnualBenefitApiPlugin, {
      prefix: '/api',
      transactions,
      service: annualBenefitManagement,
      resolveStaffContext: staffReservationContext,
    })
    instance.register(loyaltyOperationalControlApiPlugin, {
      prefix: '/api',
      transactions,
      service: loyaltyOperationalControl,
      resolveStaffContext: staffReservationContext,
    })
    instance.register(membershipConfigurationApiPlugin, {
      prefix: '/api',
      transactions,
      resolveStaffContext: staffReservationContext,
    })
    instance.register(promotionalLoyaltyApiPlugin, {
      prefix: '/api',
      transactions,
      service: promotionalLoyalty,
      resolveStaffContext: staffReservationContext,
    })
    instance.register(async (reservationApp) => {
      reservationApp.addHook('onSend', async (_request, reply, payload) => {
        const setCookie = reply.getHeader('set-cookie')
        if (typeof setCookie === 'string') {
          reply.header('set-cookie', reservationApiCookiePath(setCookie))
        } else if (Array.isArray(setCookie)) {
          reply.header('set-cookie', setCookie.map(reservationApiCookiePath))
        }
        return payload
      })
      await reservationApp.register(publicReservationApiPlugin, {
        transactions,
        commands: commandExecutor,
        waitlists: new WaitlistCommandService(commandExecutor),
        reservationSessions: reservationGuestSessions,
        resolveTrustedScope: () => scope,
        resolveGuest: async (request) => {
          const session = await authenticateReservationGuest(request)
          const day = await businessClock.current(scope)
          return {
            scope,
            sessionId: session.id,
            customerId: session.customerId,
            actorRef: session.actorRef,
            businessDate: day.businessDate,
            capabilities: session.scopes,
          }
        },
        resolveStaff: async (request) => {
          const context = await staffContext.resolve(request)
          return {
            scope: context.scope,
            employeeId: context.employeeId,
            permissions: context.capabilities,
            visibleOwnerEmployeeIds: [context.employeeId],
          }
        },
        protectContact: (value) => activityContactProtection.protect(value),
        currentBusinessDate: async (currentScope) => (
          await businessClock.current(currentScope)
        ).businessDate,
      })
      await reservationApp.register(promotionalLoyaltyPublicApiPlugin, {
        query: new PromotionalLoyaltyPublicQuery(transactions),
        resolveScope: () => scope,
      })
      await reservationApp.register(activitySharePreviewApiPlugin, {
        service: customerExperience,
        // A share preview is public marketing content. It must not depend on
        // or create a reservation/WeChat guest session.
        resolveShareScope: () => scope,
      })
      await reservationApp.register(reservationPerformanceRevisionApiPlugin, {
        transactions,
        service: new ReservationPerformanceRevisionService(transactions, commandExecutor),
        resolveCustomerContext: async (request) => {
          const session = await authenticateReservationGuest(request)
          const day = await businessClock.current(scope)
          return {
            scope,
            customerId: session.customerId,
            actorRef: session.actorRef,
            businessDate: day.businessDate,
          }
        },
        resolveStaffContext: staffReservationContext,
      })
      await reservationApp.register(reservationPerformanceNotificationApiPlugin, {
        transactions,
        commands: commandExecutor,
        channelConfigured: options.config.wechatIdentity !== null,
        resolveCustomerContext: async (request) => {
          const session = await authenticateReservationGuest(request)
          const day = await businessClock.current(scope)
          return {
            scope,
            customerId: session.customerId,
            actorRef: session.actorRef,
            businessDate: day.businessDate,
          }
        },
      })
      await reservationApp.register(customerExperienceApiPlugin, {
        transactions,
        service: customerExperience,
        resolvePublicContext: async (request) => {
          const session = await authenticateReservationGuest(request)
          const day = await businessClock.current(scope)
          return {
            scope,
            customerId: session.customerId,
            actorRef: session.actorRef,
            businessDate: day.businessDate,
          }
        },
        resolveGuestContext: guestReservationContext,
        resolveStaffContext: staffReservationContext,
        protectContact: (value) => activityContactProtection.protect(value),
        activityPayments,
        resolveActivityPaymentReady: (currentScope, customerId) => (
          onlinePayments.isGuestJsapiReady(currentScope, customerId)
        ),
        notificationConsentPolicy: options.config.wechatNotification,
        membershipRecovery,
        membershipTerms,
        ...(membershipEnrollment === undefined ? {} : { membershipEnrollment }),
        ...(recoveryPhoneAuthorization === undefined
          ? {}
          : { recoveryPhoneAuthorization }),
      })
      await reservationApp.register(personalContactGovernanceApiPlugin, {
        transactions,
        service:personalContactGovernance,
        protection:activityContactProtection,
        resolvePublicContext:async (request) => {
          const session=await authenticateReservationGuest(request)
          const day=await businessClock.current(scope)
          return {
            scope,customerId:session.customerId,actorRef:session.actorRef,
            businessDate:day.businessDate,
          }
        },
        resolveStaffContext:staffReservationContext,
      })
      await reservationApp.register(customerExperienceAnalyticsApiPlugin, {
        transactions,
        resolveStaffContext: staffReservationContext,
      })
      await reservationApp.register(recommendationStaffModificationApiPlugin, {
        service: new RecommendationStaffModificationService(transactions,commandExecutor),
        resolveStaffContext: staffReservationContext,
      })
      await reservationApp.register(activityOperationsApiPlugin, {
        transactions,
        service: new ActivityOperationsService(transactions, commandExecutor),
        activityPublisher: customerExperience,
        activityPayments,
        resolveStaffContext: staffReservationContext,
      })
      await reservationApp.register(memberContentCardApiPlugin, {
        transactions,
        service: new MemberContentCardService(transactions, commandExecutor),
        resolveStaffContext: staffReservationContext,
      })
      await reservationApp.register(mediaAssetApiPlugin, {
        transactions,
        service: mediaAssets,
        resolveStaffContext: staffReservationContext,
        resolveScope: () => scope,
      })
      await reservationApp.register(customerPreferenceApiPlugin, {
        service: customerPreferences,
        resolvePublicContext: async (request) => {
          const session = await authenticateReservationGuest(request)
          const day = await businessClock.current(scope)
          return {
            scope,
            customerId: session.customerId,
            actorRef: session.actorRef,
            businessDate: day.businessDate,
          }
        },
      })
      await reservationApp.register(wechatLoyaltyNotificationApiPlugin, {
        transactions,
        commands: commandExecutor,
        channelConfigured: options.config.wechatIdentity !== null,
        resolvePublicContext: async (request) => {
          const session = await authenticateReservationGuest(request)
          const day = await businessClock.current(scope)
          return {
            scope,
            customerId: session.customerId,
            actorRef: session.actorRef,
            businessDate: day.businessDate,
          }
        },
      })
      await reservationApp.register(wechatMemberServiceNotificationApiPlugin, {
        transactions,
        commands: commandExecutor,
        channelConfigured: options.config.wechatIdentity !== null,
        resolvePublicContext: async (request) => {
          const session = await authenticateReservationGuest(request)
          const day = await businessClock.current(scope)
          return {
            scope,
            customerId: session.customerId,
            actorRef: session.actorRef,
            businessDate: day.businessDate,
          }
        },
      })
      await reservationApp.register(wechatNotificationPromptApiPlugin, {
        transactions,
        channelConfigured: options.config.wechatIdentity !== null,
        resolvePublicContext: async (request) => {
          const session = await authenticateReservationGuest(request)
          const day = await businessClock.current(scope)
          return {
            scope,
            customerId: session.customerId,
            actorRef: session.actorRef,
            businessDate: day.businessDate,
          }
        },
      })
    }, { prefix: '/api' })
  }

  function createReservationIdentityPort(): ReservationIdentityPort {
    return {
      resolve: async ({ transaction, provider, providerAssertion, identitySubjectHash }) => {
        const customers = new CustomerRepository(transaction)
        if (provider === 'wechat') {
          if (wechatIdentity === null) throw new ReservationGuestSessionInvalidError()
          const tokenHash = createHash('sha256').update(providerAssertion).digest('base64url')
          const session = await wechatIdentity.findSession(tokenHash)
          if (session === null || session.revokedAt !== null || session.expiresAt <= Date.now()) {
            throw new ReservationGuestSessionInvalidError()
          }
          const principal = session.principal
          if (principal.tenantId !== scope.tenantId || principal.storeId !== scope.storeId
            || principal.appId !== options.config.wechatIdentity?.appId) {
            throw new ReservationGuestSessionInvalidError()
          }
          const principalHash = createHash('sha256')
            .update(`wechat:${principal.principalId}`)
            .digest('hex')
          const existing = await customers.findByIdentity('wechat', principalHash)
          if (existing !== null) return { customerId: existing.id, actorRef: `customer:${existing.id}` }
          const created = await customers.createAnonymous({ publicId: `wechat-${principalHash.slice(0, 40)}` })
          const linked = await customers.linkIdentity(created.customer.id, 'wechat', principalHash)
          return { customerId: linked.id, actorRef: `customer:${linked.id}` }
        }
        const publicId = `reservation-${identitySubjectHash.slice(0, 40)}`
        const created = await customers.createAnonymous({
          publicId,
          identityHash: identitySubjectHash,
        })
        return { customerId: created.customer.id, actorRef: `customer:${created.customer.id}` }
      },
    }
  }

  /**
   * A table scan may optionally carry the mini-program identity bearer.  It is
   * parsed only by the scan route (never by ordinary guest-cookie endpoints),
   * verified against the configured WeChat app and then resolved to the same
   * canonical customer used by JSAPI.  A missing/expired bearer remains a
   * browse-only anonymous table session; it is not treated as a caller-supplied
   * customer id.
   */
  async function resolveWechatTableScanCustomer(
    request: FastifyRequest,
    currentScope: Readonly<StoreScope>,
  ): Promise<string | null> {
    if (wechatIdentity === null || options.config.wechatIdentity === null) return null
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string') return null
    const matched = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(authorization.trim())
    if (!matched?.[1]) return null
    const tokenHash = createHash('sha256').update(matched[1]).digest('base64url')
    const session = await wechatIdentity.findSession(tokenHash)
    if (session === null || session.revokedAt !== null || session.expiresAt <= Date.now()) return null
    const principal = session.principal
    if (principal.tenantId !== currentScope.tenantId || principal.storeId !== currentScope.storeId
      || principal.appId !== options.config.wechatIdentity.appId) return null
    const principalHash = createHash('sha256').update(`wechat:${principal.principalId}`).digest('hex')
    return transactions.run(currentScope, async (transaction) => {
      const customers = new CustomerRepository(transaction)
      const existing = await customers.findByIdentity('wechat', principalHash)
      if (existing !== null) return existing.id
      const created = await customers.createAnonymous({ publicId: `wechat-${principalHash.slice(0, 40)}` })
      return (await customers.linkIdentity(created.customer.id, 'wechat', principalHash)).id
    })
  }

  async function authenticateReservationGuest(request: FastifyRequest) {
    let token: string
    let deviceFingerprint: string
    try {
      token = readRequestToken(request, RESERVATION_GUEST_SESSION_COOKIE)
      deviceFingerprint = guestDevices.resolve(request)
    } catch {
      throw new ReservationGuestSessionInvalidError()
    }
    return reservationGuestSessions.authenticate({ scope, sessionToken: token, deviceFingerprint })
  }

  function coreAiPorts() {
    return {
      resolveTable: async (transaction: ScopedTransaction, tableCode: string) => {
        const result = await transaction.query<{ id: string; code: string }>(`
          SELECT id, code FROM mbox.tables
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND status = 'available' AND (upper(code) = upper($3) OR code ILIKE $4)
          ORDER BY CASE WHEN upper(code) = upper($3) THEN 0 ELSE 1 END, code
          LIMIT 6
        `, [transaction.scope.tenantId, transaction.scope.storeId, tableCode, `%${escapeLike(tableCode)}%`])
        const exact = result.rows.find((row) => row.code.toUpperCase() === tableCode.toUpperCase())
        if (exact) return { kind: 'exact' as const, tableId: exact.id, tableCode: exact.code }
        return { kind: result.rows.length === 0 ? 'not_found' as const : 'ambiguous' as const,
          candidates: result.rows.map((row) => row.code) }
      },
      resolveEmployee: async (transaction: ScopedTransaction, employeeName: string) => {
        const result = await transaction.query<{ id: string; display_name: string }>(`
          SELECT id, display_name FROM mbox.employees
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND status = 'active'
            AND (display_name = $3 OR display_name ILIKE $4 OR employee_code ILIKE $4)
          ORDER BY CASE WHEN display_name = $3 THEN 0 ELSE 1 END, display_name
          LIMIT 6
        `, [transaction.scope.tenantId, transaction.scope.storeId, employeeName, `%${escapeLike(employeeName)}%`])
        const exact = result.rows.find((row) => row.display_name === employeeName)
        if (exact) return { kind: 'exact' as const, employeeId: exact.id, displayName: exact.display_name }
        return { kind: result.rows.length === 0 ? 'not_found' as const : 'ambiguous' as const,
          candidates: result.rows.map((row) => row.display_name) }
      },
      openTable: async (input: {
        transaction: ScopedTransaction
        context: { employeeId: string; businessDate: string }
        tableId: string
        guestCount: number
      }) => {
        const opened = await new TableManagementRepository(input.transaction).open({
          tableId: input.tableId,
          publicId: `table-session-${randomUUID()}`,
          guestCount: input.guestCount,
          businessDate: input.context.businessDate,
          openedByEmployeeId: input.context.employeeId,
          guestProfileSnapshot: {},
        })
        return managedSessionJson(opened)
      },
      createWaterServiceTask: async (input: {
        transaction: ScopedTransaction
        context: { employeeId: string }
        tableId: string
        assignedEmployeeId: string
        assignedEmployeeName: string
        quantity: number
        idempotencyKey: string
      }) => {
        const session = await input.transaction.query<{ id: string }>(`
          SELECT id FROM mbox.table_sessions
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND table_id = $3::uuid
            AND status = 'open'
          FOR UPDATE
        `, [input.transaction.scope.tenantId, input.transaction.scope.storeId, input.tableId])
        const tableSessionId = session.rows[0]?.id
        if (!tableSessionId) throw new Error('当前桌台尚未开台')
        const task = await new ServiceTaskRepository(input.transaction).create({
          tableId: input.tableId,
          tableSessionId,
          publicId: `service-${randomUUID()}`,
          taskType: 'water',
          title: `送${input.quantity}杯水`,
          detail: `由${input.assignedEmployeeName}执行`,
          priority: 'normal',
          source: 'ai',
          assignedEmployeeId: input.assignedEmployeeId,
          createdByEmployeeId: input.context.employeeId,
          requestSnapshot: { quantity: input.quantity },
          actor: { type: 'employee', employeeId: input.context.employeeId },
          eventIdempotencyKey: input.idempotencyKey,
        })
        return { taskId: task.id, status: task.status, assignedEmployeeId: task.assignedEmployeeId }
      },
    }
  }
}

function registerSinglePageApplicationFallback(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?', 1)[0] ?? '/'
    const acceptsHtml = request.headers.accept?.includes('text/html') === true
    if (request.method === 'GET' && acceptsHtml && isApplicationRoute(path)) {
      return reply
        .header('cache-control', 'no-store')
        .type('text/html; charset=utf-8')
        .sendFile('index.html', { cacheControl: false })
    }
    return reply.code(404).send({
      error: { code: 'ROUTE_NOT_FOUND', message: '请求的页面或接口不存在' },
    })
  })
}

function isApplicationRoute(path: string): boolean {
  return path === '/'
    || /^\/mini-preview(?:\/[^.]*)?$/.test(path)
    || /^\/(?:guest|reserve|member|staff)(?:\/[^.]*)?$/.test(path)
}

function registerStaffAuthenticationErrorClassification(
  app: FastifyInstance,
  transactions: ScopedPostgresTransactionRunner,
  scope: Readonly<StoreScope>,
): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (!isStaffLoginRoute(request) || reply.statusCode !== 401 || !isAuthRequiredPayload(payload)) {
      return payload
    }
    if (await hasValidDeviceAccessLease(request, transactions, scope)) return payload
    reply.type('application/json; charset=utf-8')
    return JSON.stringify({
      error: {
        code: 'DEVICE_ACCESS_REQUIRED',
        message: '当前设备尚未完成门店验证，或验证已失效，请重新验证',
      },
    })
  })
}

function isStaffLoginRoute(request: FastifyRequest): boolean {
  if (request.method !== 'POST') return false
  const route = request.routeOptions.url ?? request.url.split('?')[0]
  return route === '/api/auth/login'
}

function isAuthRequiredPayload(payload: unknown): boolean {
  const serialized = typeof payload === 'string'
    ? payload
    : payload instanceof Uint8Array ? Buffer.from(payload).toString('utf8') : null
  if (serialized === null) return false
  try {
    const body = JSON.parse(serialized) as { error?: { code?: unknown } }
    return body.error?.code === 'AUTH_REQUIRED'
  } catch {
    return false
  }
}

async function hasValidDeviceAccessLease(
  request: FastifyRequest,
  transactions: ScopedPostgresTransactionRunner,
  scope: Readonly<StoreScope>,
): Promise<boolean> {
  let token: string
  try {
    token = readRequestToken(request, DEVICE_ACCESS_COOKIE)
  } catch {
    return false
  }
  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
  try {
    return transactions.run(scope, async (transaction) => {
      const result = await transaction.query<{ valid: boolean }>(`
        SELECT EXISTS (
          SELECT 1
          FROM mbox.store_device_access_leases AS lease
          JOIN mbox.store_daily_credentials AS credential
            ON credential.tenant_id = lease.tenant_id
           AND credential.store_id = lease.store_id
           AND credential.id = lease.daily_credential_id
          WHERE lease.tenant_id = $1::uuid
            AND lease.store_id = $2::uuid
            AND lease.lease_token_hash = $3
            AND lease.revoked_at IS NULL
            AND lease.expires_at > clock_timestamp()
            AND credential.revoked_at IS NULL
            AND credential.valid_from <= clock_timestamp()
            AND credential.valid_until > clock_timestamp()
        ) AS valid
      `, [scope.tenantId, scope.storeId, tokenHash])
      return result.rows[0]?.valid === true
    }, { readOnly: true })
  } catch {
    // Do not expose infrastructure or credential details from an authentication response.
    return true
  }
}

function registerSystemRoutes(
  app: FastifyInstance,
  config: Readonly<NormalizedRuntimeConfig>,
  transactions: ScopedPostgresTransactionRunner,
  scope: Readonly<StoreScope>,
  activityContactProtection: ReturnType<typeof createActivityContactProtectionKeyring>,
  workerHealth?: NormalizedAppOptions['workerHealth'],
): void {
  let personalContactKeyReadiness:
    | { status:'ready' }
    | { status:'unavailable'|'invalid' }={status:'unavailable'}
  const version = Object.freeze({
    commitSha: config.commitSha,
    releaseImageDigest: config.releaseImageDigest,
    schemaFlavor: config.schemaFlavor,
    deploymentTier: config.deploymentTier,
    inventoryEnforcementMode: config.inventoryEnforcementMode,
    runtimeRole:config.runtimeRole ?? 'normal',
    writeEnabled:config.runtimeRole!=='contract_candidate',
  })
  app.get('/api/live', async () => ({ status: 'live', ...version }))
  app.get('/api/version', async () => version)
  app.addHook('onReady',async()=>{
    try{
      const evidence=await queryPersonalContactKeyProbesOnce(transactions,scope)
      if (!(evidence?.personal_contact_key_ids ?? []).every((keyId)=>activityContactProtection.hasKey(keyId))){
        personalContactKeyReadiness={status:'unavailable'}
        return
      }
      personalContactKeyReadiness=(evidence?.personal_contact_key_probes ?? []).every((probe)=>
        activityContactProtection.validateProbe({
          kind:probe.kind,encryptionKeyId:probe.keyId,contactHash:probe.contactHash,
          encryptedValue:Buffer.from(probe.encryptedBase64,'base64'),
        })) ? {status:'ready'} : {status:'invalid'}
    }catch{
      personalContactKeyReadiness={status:'unavailable'}
    }
  })
  app.get('/api/ready', async (_request, reply) => {
    try {
      const row = await queryReadinessOnce(transactions, scope)
      if (!row || row.schema_flavor !== NORMALIZED_SCHEMA_FLAVOR || row.store_active !== true) {
        return reply.code(503).send({ status: 'not_ready', reason: 'normalized_schema_unavailable', ...version })
      }
      if (!schemaVersionAtLeast(row.schema_version, NORMALIZED_MIN_SCHEMA_VERSION)) {
        return reply.code(503).send({ status: 'not_ready', reason: 'normalized_schema_outdated', ...version })
      }
      if (personalContactKeyReadiness.status==='unavailable') {
        return reply.code(503).send({ status: 'not_ready', reason: 'personal_contact_key_unavailable', ...version })
      }
      if (personalContactKeyReadiness.status==='invalid') {
        return reply.code(503).send({ status:'not_ready',reason:'personal_contact_key_invalid',...version })
      }
      const workers = workerHealth?.snapshot()
      if (workers !== undefined && workers.status !== 'healthy') {
        return reply.code(503).send({ status: 'not_ready', reason: 'workers_unavailable', workers, ...version })
      }
      return reply.send({ status: 'ready', schemaVersion: row.schema_version, ...(workers === undefined ? {} : { workers }), ...version })
    } catch {
      return reply.code(503).send({ status: 'not_ready', reason: 'database_unavailable', ...version })
    }
  })
}

async function queryReadinessOnce(
  transactions: ScopedPostgresTransactionRunner,
  scope: Readonly<StoreScope>,
): Promise<ReadyRow | undefined> {
  const result = await transactions.singleScopedQuery<ReadyRow>(scope, `
    WITH request_scope AS MATERIALIZED (
      SELECT
        set_config('app.tenant_id', $1::text, true) AS tenant_id,
        set_config('app.store_id', $2::text, true) AS store_id
    )
    SELECT metadata.schema_flavor, metadata.schema_version,
      EXISTS (
        SELECT 1 FROM mbox.stores
        WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'active'
      ) AS store_active
    FROM mbox.normalized_schema_metadata AS metadata
    CROSS JOIN request_scope
    WHERE metadata.singleton = true
  `)
  return result.rows[0]
}

async function queryPersonalContactKeyProbesOnce(
  transactions:ScopedPostgresTransactionRunner,
  scope:Readonly<StoreScope>,
):Promise<PersonalContactKeyProbeRow|undefined>{
  const result=await transactions.singleScopedQuery<PersonalContactKeyProbeRow>(scope,`
    WITH request_scope AS MATERIALIZED (
      SELECT set_config('app.tenant_id',$1::text,true),set_config('app.store_id',$2::text,true)
    ), source AS (
      SELECT 'activity_registration_contact'::text AS kind,
        contact.encryption_key_id AS key_id,contact.contact_hash,
        contact.encrypted_contact AS encrypted_value,contact.captured_at AS recorded_at,contact.id
      FROM mbox.community_activity_registration_contact_versions contact
      CROSS JOIN request_scope
      WHERE contact.tenant_id=$1::uuid AND contact.store_id=$2::uuid
        AND contact.encrypted_contact IS NOT NULL
      UNION ALL
      SELECT 'verified_membership_phone',verified.contact_encryption_key_id,
        verified.contact_hash,verified.encrypted_value,verified.created_at,verified.id
      FROM mbox.customer_verified_contacts verified
      WHERE verified.tenant_id=$1::uuid AND verified.store_id=$2::uuid
        AND verified.encrypted_value IS NOT NULL
    ), ranked AS (
      SELECT source.*,
        row_number() OVER (PARTITION BY kind,key_id ORDER BY recorded_at,id) AS oldest_rank,
        row_number() OVER (PARTITION BY kind,key_id ORDER BY recorded_at DESC,id DESC) AS newest_rank
      FROM source
    )
    SELECT ARRAY(
        SELECT DISTINCT key_id FROM source WHERE key_id IS NOT NULL ORDER BY key_id
      ) AS personal_contact_key_ids,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'kind',probe.kind,'keyId',probe.key_id,'contactHash',probe.contact_hash,
        'encryptedBase64',encode(probe.encrypted_value,'base64')
      ) ORDER BY probe.kind,probe.key_id,probe.recorded_at,probe.id)
      FROM ranked probe WHERE probe.oldest_rank=1 OR probe.newest_rank=1),'[]'::jsonb)
      AS personal_contact_key_probes
  `)
  return result.rows[0]
}

function reservationApiCookiePath(value: string): string {
  return value.replace('Path=/public', 'Path=/api/public')
}

function schemaVersionAtLeast(actual: string, minimum: string): boolean {
  if (!/^\d+$/.test(actual) || !/^\d+$/.test(minimum)) return false
  return Number(actual) >= Number(minimum)
}

async function registerInjectedPlugins(
  app: FastifyInstance,
  plugins: readonly NormalizedInjectedPlugin[],
): Promise<void> {
  const names = new Set<string>()
  for (const registration of plugins) {
    const name = registration.name.trim()
    if (!name || names.has(name)) throw new TypeError('注入插件名称必须唯一且不能为空')
    names.add(name)
    await app.register(registration.plugin, {
      ...(registration.options ?? {}),
      ...(registration.prefix === undefined ? {} : { prefix: registration.prefix }),
    })
  }
}

function createPool(config: Readonly<NormalizedRuntimeConfig>): PostgresPool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: `mbox-normalized:${config.commitSha.slice(0, 16)}`,
  }) as unknown as PostgresPool
}

function paymentVerifier(
  config: Readonly<NormalizedRuntimeConfig>,
  scope: Readonly<StoreScope>,
): PaymentProviderVerifier {
  if (config.payment === null) return new RejectingPaymentProviderVerifier()
  return new PostarRsaPaymentProviderVerifier({
    bindings: [{
      agencyId: config.payment.agencyId,
      merchantId: config.payment.merchantId,
      publicKey: config.payment.publicKey,
      scope,
    }],
  })
}

class RejectingPaymentProviderVerifier implements PaymentProviderVerifier {
  async verifyPaymentCallback(): Promise<never> {
    throw new PaymentProviderVerificationError('支付机构尚未配置')
  }

  async verifyRefundCallback(): Promise<never> {
    throw new PaymentProviderVerificationError('支付机构尚未配置')
  }
}

function loggerConfiguration(config: Readonly<NormalizedRuntimeConfig>) {
  if (config.nodeEnv === 'test') return false
  return {
    level: config.nodeEnv === 'production' ? 'info' : 'debug',
    redact: { paths: [...NORMALIZED_LOG_REDACTION_PATHS], censor: '[REDACTED]' },
    serializers: {
      req: (request: { method?: string; url?: string; id?: string }) => ({
        id: request.id,
        method: request.method,
        path: request.url?.split('?')[0],
      }),
    },
  }
}

function safeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code.slice(0, 64)
  }
  return error instanceof Error ? error.name.slice(0, 64) : 'UNKNOWN_ERROR'
}

function isGuestRequest(request: FastifyRequest): boolean {
  const guestDevice = request.headers[GUEST_DEVICE_HEADER]
  if (typeof guestDevice === 'string' && guestDevice.trim()) return true
  return request.headers.cookie?.split(';').some((part) => part.trim().startsWith('__Host-mbox_guest_session=')) === true
}

async function resolveOpenSession(
  transactions: ScopedPostgresTransactionRunner,
  scope: Readonly<StoreScope>,
  tableId: string,
): Promise<string | null> {
  return transactions.run(scope, async (transaction) => {
    const result = await transaction.query<{ id: string }>(`
      SELECT id FROM mbox.table_sessions
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND table_id = $3::uuid
        AND status = 'open'
      LIMIT 1
    `, [scope.tenantId, scope.storeId, tableId])
    return result.rows[0]?.id ?? null
  }, { readOnly: true })
}

function managedSessionJson(session: {
  id: string
  tableId: string
  tableCode: string
  publicId: string
  guestCount: number
  status: string
}): JsonObject {
  return {
    tableSessionId: session.id,
    tableId: session.tableId,
    tableCode: session.tableCode,
    publicId: session.publicId,
    guestCount: session.guestCount,
    status: session.status,
  }
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function assertRuntimeConfig(config: Readonly<NormalizedRuntimeConfig>): void {
  const fields: string[] = []
  if (!config.databaseUrl.trim()) fields.push('DATABASE_URL')
  if (!config.tenantId.trim()) fields.push('MBOX_TENANT_ID')
  if (!config.storeId.trim()) fields.push('MBOX_STORE_ID')
  if (Buffer.byteLength(config.secret, 'utf8') < 32) fields.push('MBOX_NORMALIZED_SECRET')
  if (config.deploymentTier === 'production' && config.personalContactProtection == null) {
    fields.push('MBOX_CONTACT_ACTIVE_KEY_ID','MBOX_CONTACT_ACTIVE_KEY_BASE64',
      'MBOX_CONTACT_LOOKUP_KEY_BASE64','MBOX_CONTACT_LEGACY_PHONE_LOOKUP_KEY_BASE64')
  }
  if (config.schemaFlavor !== NORMALIZED_SCHEMA_FLAVOR) fields.push('schemaFlavor')
  if (config.deploymentTier === 'production' && config.payment === null) fields.push('payment')
  if (config.nodeEnv === 'production' && config.metricsToken === null) fields.push('MBOX_METRICS_TOKEN')
  if (fields.length > 0) throw new NormalizedRuntimeConfigurationError(fields)
}
