import { NativePushWorker } from './native-push-worker.js'
import { OfficialGetuiAdapter } from './native-push-getui.js'
import { OfficialApnsAdapter } from './native-push-apns.js'
import type { NativePushConfig, GetuiPushConfig } from './native-push-config.js'
import { pathToFileURL } from 'node:url'
import type { AiScheduledExecutionPort } from './ai-capability-center.js'
import {
  NormalizedBackgroundWorkerCoordinator,
  type NormalizedWorkerCycleResult,
  type NormalizedWorkerName,
} from './background-worker-coordinator.js'
import { BusinessDayRolloverWorker } from './business-day-worker.js'
import { AutomaticTableTurnoverWorker } from './automatic-table-turnover-worker.js'
import { IdempotencyCleanupWorker } from './idempotency-cleanup-worker.js'
import { NotificationWorker, type NotificationDelivery } from './notification-worker.js'
import { OutboxDispatcher, type OutboxDelivery } from './outbox-dispatcher.js'
import { PrintWorker, type PrintAdapter } from './print-worker.js'
import { PrintSourceWorker } from './print-source-worker.js'
import { ReservationHoldExpiryWorker } from './reservation-hold-expiry-worker.js'
import { PaymentReservationExpiryWorker } from './payment-reservation-expiry-worker.js'
import { ActivityRegistrationExpiryWorker } from './activity-registration-expiry-worker.js'
import { ActivityWaitlistPromotionWorker } from './activity-waitlist-promotion-worker.js'
import { ExperienceCueDispatchWorker } from './experience-cue-dispatch-worker.js'
import { ServiceTaskSlaWorker } from './service-task-sla-worker.js'
import { AiScheduledExecutionWorker, SopWorker, assertSopActionResult, type SopActionPort } from './sop-worker.js'
import { PostgresStaffLoginRateLimiter } from './staff-login-rate-limiter.js'
import { LoyaltyPointsExpiryWorker } from './loyalty-points-expiry-worker.js'
import { LoyaltyAccrualDeferredWorker } from './loyalty-accrual-deferred-worker.js'
import { LoyaltyRedemptionRecoveryWorker } from './loyalty-redemption-recovery-worker.js'
import { LoyaltyTierBenefitExpiryWorker } from './loyalty-tier-benefit-expiry-worker.js'
import { LoyaltyAnnualBenefitGrantWorker } from './loyalty-annual-benefit-grant-worker.js'
import { MemberGiftDeliveryWorker } from './member-gift-delivery-worker.js'
import {CheckoutCouponRecoveryWorker} from './checkout-coupon-recovery-worker.js'
import { MarketingDeliveryWorker,type MarketingDeliveryAdapter } from './marketing-delivery-worker.js'
import { AnnualDailySnackExpiryWorker } from './annual-daily-snack-expiry-worker.js'
import { LoyaltyTierReviewWorker } from './loyalty-tier-review-worker.js'
import {
  WechatLoyaltyNotificationWorker,
  type WechatMiniProgramNotificationRecipientResolver,
  type WechatSubscriptionMessageDelivery,
} from './wechat-loyalty-notification-worker.js'
import { ReservationPerformanceNotificationWorker } from './reservation-performance-notification-worker.js'
import { WechatMemberServiceNotificationWorker } from './wechat-member-service-notification-worker.js'
import { PromotionalLoyaltyWorker } from './promotional-loyalty-worker.js'
import { PersonalContactDispositionWorker } from './personal-contact-disposition-worker.js'
import { ComplimentaryBenefitFulfillmentWorker } from './complimentary-benefit-fulfillment-worker.js'
import {
  StaleGuestImmediatePaymentWorker,
  type StaleGuestImmediatePaymentWorkerDeps,
} from './stale-guest-immediate-payment-worker.js'
import type { WechatTemplateMessageDelivery } from './wechat-subscription-message-adapter.js'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

export interface NormalizedWorkerAdapters {
  capabilities: readonly NormalizedWorkerAdapterCapability[]
  preflight(): Promise<void>
  outbox: OutboxDelivery
  notification: NotificationDelivery
  print: PrintAdapter
  sop: SopActionPort
}

export const NORMALIZED_EXTERNAL_ADAPTER_CAPABILITIES = Object.freeze([
  'outbox.deliver',
  'notification.deliver',
  'print.deliver',
  'sop.execute',
] as const)

export type NormalizedWorkerAdapterCapability =
  (typeof NORMALIZED_EXTERNAL_ADAPTER_CAPABILITIES)[number]

export interface NormalizedWorkerAdapterFactoryContext {
  scope: Readonly<StoreScope>
  commitSha: string
  schemaFlavor: string
}

export interface NormalizedWorkerRuntimeOptions {
  scope: Readonly<StoreScope>
  workerId: string
  intervalMs: number
  hashSecret: string
  transactions: ScopedPostgresTransactionRunner
  aiExecutions: AiScheduledExecutionPort
  nativePush?: NativePushConfig | null
  getuiPush?: GetuiPushConfig | null
  adapters?: Readonly<NormalizedWorkerAdapters> | null
  wechatLoyaltyNotification?: Readonly<{
    recipients: WechatMiniProgramNotificationRecipientResolver
    delivery: WechatSubscriptionMessageDelivery
  }> | null
  reservationPerformanceNotification?: Readonly<{
    recipients: WechatMiniProgramNotificationRecipientResolver
    delivery: WechatTemplateMessageDelivery
  }> | null
  wechatMemberServiceNotification?: Readonly<{
    recipients: WechatMiniProgramNotificationRecipientResolver
    delivery: WechatTemplateMessageDelivery
  }> | null
  staleGuestImmediatePaymentReconciliation?: Readonly<StaleGuestImmediatePaymentWorkerDeps> | null
  marketingDelivery?: MarketingDeliveryAdapter | null
  paymentProviderConfigured?: boolean
  onError?: (worker: NormalizedWorkerName, error: unknown) => void
  onCycle?: (result: Readonly<NormalizedWorkerCycleResult>) => void
}

export class NormalizedWorkerAdapterConfigurationError extends Error {
  constructor(code: string) {
    super(`Normalized worker adapter configuration failed: ${code}`)
    this.name = 'NormalizedWorkerAdapterConfigurationError'
  }
}

export class NormalizedWorkerRuntime {
  private started = false

  constructor(private readonly coordinator: NormalizedBackgroundWorkerCoordinator) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.coordinator.start()
  }

  runOnce(): Promise<NormalizedWorkerCycleResult> {
    return this.coordinator.runOnce()
  }

  async stop(): Promise<void> {
    this.started = false
    await this.coordinator.stop()
  }
}

export function createNormalizedWorkerRuntime(
  options: Readonly<NormalizedWorkerRuntimeOptions>,
): NormalizedWorkerRuntime {
  const adapters = options.adapters ?? null
  if (adapters !== null) assertAdapters(adapters)
  const transactions = options.transactions
  const coordinator = new NormalizedBackgroundWorkerCoordinator(options.scope, {
    ...((options.nativePush||options.getuiPush) ? {nativePush:new NativePushWorker(transactions,options.nativePush??null,options.hashSecret,options.nativePush?new OfficialApnsAdapter(options.nativePush):null,options.getuiPush??null,options.getuiPush?new OfficialGetuiAdapter(options.getuiPush):null)} : {}),
    serviceSla: new ServiceTaskSlaWorker(transactions),
    reservationExpiry: new ReservationHoldExpiryWorker(transactions),
    paymentReservationExpiry: new PaymentReservationExpiryWorker(transactions),
    activityRegistrationExpiry: new ActivityRegistrationExpiryWorker(transactions),
    activityWaitlistPromotion: new ActivityWaitlistPromotionWorker(
      transactions,
      options.paymentProviderConfigured === true,
    ),
    experienceCueDispatch: new ExperienceCueDispatchWorker(transactions),
    loyaltyPointsExpiry: new LoyaltyPointsExpiryWorker(transactions),
    loyaltyAccrualDeferred: new LoyaltyAccrualDeferredWorker(transactions),
    loyaltyRedemptionRecovery: new LoyaltyRedemptionRecoveryWorker(transactions),
    promotionalLoyalty: new PromotionalLoyaltyWorker(transactions),
    loyaltyAnnualBenefitGrant: new LoyaltyAnnualBenefitGrantWorker(transactions),
    memberGiftDelivery: new MemberGiftDeliveryWorker(transactions),
    checkoutCouponRecovery:new CheckoutCouponRecoveryWorker(transactions),
    marketingDelivery: new MarketingDeliveryWorker(transactions,options.marketingDelivery??null),
    printSource: new PrintSourceWorker(transactions),
    annualDailySnackExpiry: new AnnualDailySnackExpiryWorker(transactions),
    loyaltyTierBenefitExpiry: new LoyaltyTierBenefitExpiryWorker(transactions),
    loyaltyTierReview: new LoyaltyTierReviewWorker(transactions),
    ...(options.wechatLoyaltyNotification == null ? {} : {
      wechatLoyaltyNotification: new WechatLoyaltyNotificationWorker(
        transactions,
        options.wechatLoyaltyNotification.recipients,
        options.wechatLoyaltyNotification.delivery,
      ),
    }),
    ...(options.reservationPerformanceNotification == null ? {} : {
      reservationPerformanceNotification: new ReservationPerformanceNotificationWorker(
        transactions,
        options.reservationPerformanceNotification.recipients,
        options.reservationPerformanceNotification.delivery,
      ),
    }),
    ...(options.wechatMemberServiceNotification == null ? {} : {
      wechatMemberServiceNotification: new WechatMemberServiceNotificationWorker(
        transactions,
        options.wechatMemberServiceNotification.recipients,
        options.wechatMemberServiceNotification.delivery,
      ),
    }),
    idempotencyCleanup: new IdempotencyCleanupWorker(transactions),
    staffLoginRateLimitCleanup: new PostgresStaffLoginRateLimiter(transactions, options.hashSecret),
    businessDay: new BusinessDayRolloverWorker(transactions),
    automaticTableTurnover: new AutomaticTableTurnoverWorker(transactions),
    ...(options.staleGuestImmediatePaymentReconciliation == null ? {} : {
      staleGuestImmediatePaymentReconciliation: new StaleGuestImmediatePaymentWorker(
        options.staleGuestImmediatePaymentReconciliation,
        transactions,
      ),
    }),
    ...(adapters?.capabilities.includes('sop.execute') ? { sop: new SopWorker(transactions, adapters.sop) } : {}),
    aiScheduled: new AiScheduledExecutionWorker(transactions, options.aiExecutions),
    personalContactDisposition:new PersonalContactDispositionWorker(transactions),
    complimentaryBenefitFulfillment:new ComplimentaryBenefitFulfillmentWorker(transactions),
    ...(adapters?.capabilities.includes('print.deliver') ? {print:new PrintWorker(transactions)} : {}),
    ...(adapters?.capabilities.includes('outbox.deliver') ? {outbox:new OutboxDispatcher(transactions)} : {}),
    ...(adapters?.capabilities.includes('notification.deliver') ? {notification:new NotificationWorker(transactions)} : {}),
  }, {
    ...(adapters === null ? {} : {
      outbox: adapters.outbox,
      notification: adapters.notification,
      print: adapters.print,
    }),
  }, {
    workerId: options.workerId,
    intervalMs: options.intervalMs,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.onCycle === undefined ? {} : { onCycle: options.onCycle }),
  })
  return new NormalizedWorkerRuntime(coordinator)
}

export interface NormalizedWorkerHealthSnapshot {
  status: 'starting' | 'healthy' | 'degraded'
  lastCompletedAt: string | null
  failures: readonly NormalizedWorkerName[]
  integrationWorkersEnabled: boolean
  adapterCapabilities: readonly NormalizedWorkerAdapterCapability[]
  unavailableAdapterCapabilities: readonly NormalizedWorkerAdapterCapability[]
  nativePush?: {status:'idle'|'healthy'|'degraded';lastConfigurationFailureAt:string|null;lastProviderAcceptedAt:string|null;lastErrorCode:string|null}
}

export class NormalizedWorkerHealthTracker {
  private lastCycle: Readonly<NormalizedWorkerCycleResult> | null = null
  private pushConfigurationFailureAt:string|null=null
  private pushAcceptedAt:string|null=null

  constructor(
    private readonly intervalMs: number,
    private readonly integrationWorkersEnabled: boolean,
    private readonly adapterCapabilities: readonly NormalizedWorkerAdapterCapability[] = [],
    private readonly nativePushEnabled=false,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000) {
      throw new TypeError('intervalMs must be an integer between 250 and 60000')
    }
  }

  report(result: Readonly<NormalizedWorkerCycleResult>): void {
    this.lastCycle = result
    const push=result.workers.nativePush
    if(push?.configurationRejected) this.pushConfigurationFailureAt=result.completedAt
    else if(push && push.accepted>0) this.pushConfigurationFailureAt=null
    if(push && push.accepted>0) this.pushAcceptedAt=result.completedAt
  }

  snapshot(nowMs = Date.now()): NormalizedWorkerHealthSnapshot {
    if (this.lastCycle === null) {
      return {
        status: 'starting', lastCompletedAt: null, failures: [],
        integrationWorkersEnabled: this.integrationWorkersEnabled,
        adapterCapabilities: [...this.adapterCapabilities],
        unavailableAdapterCapabilities: NORMALIZED_EXTERNAL_ADAPTER_CAPABILITIES.filter(capability=>!this.adapterCapabilities.includes(capability)),
        ...this.pushSnapshot(),
      }
    }
    const completedAtMs = Date.parse(this.lastCycle.completedAt)
    const staleAfterMs = Math.max(10_000, this.intervalMs * 3)
    const stale = !Number.isFinite(completedAtMs) || nowMs - completedAtMs > staleAfterMs
    const failures = [...this.lastCycle.failures]
    return {
      status: stale || failures.length > 0 ? 'degraded' : 'healthy',
      lastCompletedAt: this.lastCycle.completedAt,
      failures,
      integrationWorkersEnabled: this.integrationWorkersEnabled,
      adapterCapabilities: [...this.adapterCapabilities],
        unavailableAdapterCapabilities: NORMALIZED_EXTERNAL_ADAPTER_CAPABILITIES.filter(capability=>!this.adapterCapabilities.includes(capability)),
      ...this.pushSnapshot(),
    }
  }
  private pushSnapshot():Pick<NormalizedWorkerHealthSnapshot,'nativePush'> {
    if(!this.nativePushEnabled)return {}
    const failed=this.lastCycle?.failures.includes('native-push')
    return {nativePush:{status:failed||this.pushConfigurationFailureAt?'degraded':this.pushAcceptedAt?'healthy':'idle',lastConfigurationFailureAt:this.pushConfigurationFailureAt,lastProviderAcceptedAt:this.pushAcceptedAt,lastErrorCode:failed?'NATIVE_PUSH_WORKER_FAILED':this.pushConfigurationFailureAt?'NATIVE_PUSH_CONFIGURATION_REJECTED':null}}
  }

}

export async function loadNormalizedWorkerAdapters(
  modulePath: string,
  context: Readonly<NormalizedWorkerAdapterFactoryContext>,
): Promise<Readonly<NormalizedWorkerAdapters>> {
  let imported: Record<string, unknown>
  try {
    imported = await import(pathToFileURL(modulePath).href) as Record<string, unknown>
  } catch {
    throw new NormalizedWorkerAdapterConfigurationError('module_load_failed')
  }
  const factory = imported.createNormalizedWorkerAdapters
  if (typeof factory !== 'function') {
    throw new NormalizedWorkerAdapterConfigurationError('factory_missing')
  }
  let candidate: unknown
  try {
    candidate = await factory(Object.freeze({ ...context }))
  } catch {
    throw new NormalizedWorkerAdapterConfigurationError('factory_failed')
  }
  assertAdapters(candidate)
  // Mounted JavaScript does not receive TypeScript's contract checking.
  if (!('protocolVersion' in candidate) || candidate.protocolVersion !== 2) {
    throw new NormalizedWorkerAdapterConfigurationError('protocol_version_required')
  }
  async function preflight() {
    let receipt:unknown
    try { receipt=await (candidate as NormalizedWorkerAdapters).preflight() }
    catch { throw new NormalizedWorkerAdapterConfigurationError('preflight_failed') }
    if(!isRecord(receipt)||receipt.protocolVersion!==2||!Array.isArray(receipt.capabilities)
      ||JSON.stringify([...receipt.capabilities].sort())!==JSON.stringify([...(candidate as NormalizedWorkerAdapters).capabilities].sort())) {
      throw new NormalizedWorkerAdapterConfigurationError('preflight_receipt_invalid')
    }
  }
  await preflight()
  const verified=candidate
  async function deliver(capability:NormalizedWorkerAdapterCapability,send:()=>Promise<unknown>) {
    if(!verified.capabilities.includes(capability))throw new NormalizedWorkerAdapterConfigurationError('channel_not_configured')
    const result=await send()
    const expectedStatus=capability==='print.deliver'?'printed':'accepted'
    if(!isRecord(result)||result.status!==expectedStatus||typeof result.providerReference!=='string'
      ||result.providerReference.trim().length<1||result.providerReference.length>256) {
      throw new NormalizedWorkerAdapterConfigurationError('delivery_receipt_invalid')
    }
  }
  return Object.freeze({
    capabilities:Object.freeze([...verified.capabilities]),preflight,
    outbox:(message)=>deliver('outbox.deliver',()=>verified.outbox(message)),
    notification:(request)=>deliver('notification.deliver',()=>verified.notification(request)),
    print:Object.freeze({print:(request:Parameters<PrintAdapter['print']>[0])=>deliver('print.deliver',()=>verified.print.print(request))}),
    sop:Object.freeze({execute:async(request:Parameters<SopActionPort['execute']>[0])=>{
      if(!verified.capabilities.includes('sop.execute'))throw new NormalizedWorkerAdapterConfigurationError('channel_not_configured')
      const result=await verified.sop.execute(request)
      assertSopActionResult(result)
      return result
    }}),
  } satisfies NormalizedWorkerAdapters)
}

function assertAdapters(value: unknown): asserts value is NormalizedWorkerAdapters {
  if (!isRecord(value) || !validCapabilities(value.capabilities)
    || typeof value.preflight !== 'function' || typeof value.outbox !== 'function'
    || typeof value.notification !== 'function' || !isRecord(value.print) || typeof value.print.print !== 'function'
    || !isRecord(value.sop) || typeof value.sop.execute !== 'function') {
    throw new NormalizedWorkerAdapterConfigurationError('invalid_contract')
  }
}
function validCapabilities(value:unknown):value is readonly NormalizedWorkerAdapterCapability[]{
  return Array.isArray(value)&&new Set(value).size===value.length
    &&value.every(capability=>NORMALIZED_EXTERNAL_ADAPTER_CAPABILITIES.includes(capability))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
