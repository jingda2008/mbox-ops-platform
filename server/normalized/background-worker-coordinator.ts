import type { IdempotencyCleanupResult } from './idempotency-cleanup-worker.js'
import type { BusinessDayRolloverResult } from './business-day-worker.js'
import type { AutomaticTableTurnoverBatch } from './automatic-table-turnover-worker.js'
import type { NotificationBatchResult, NotificationDelivery } from './notification-worker.js'
import type { OutboxBatchResult, OutboxDelivery } from './outbox-dispatcher.js'
import type { PrintAdapter, PrintBatchResult } from './print-worker.js'
import type { ReservationHoldExpiryBatch } from './reservation-hold-expiry-worker.js'
import type { PaymentReservationExpiryBatch } from './payment-reservation-expiry-worker.js'
import type { ActivityRegistrationExpiryBatch } from './activity-registration-expiry-worker.js'
import type { ActivityWaitlistPromotionBatch } from './activity-waitlist-promotion-worker.js'
import type { ExperienceCueDispatchBatch } from './experience-cue-dispatch-worker.js'
import type { ServiceTaskSlaBatch } from './service-task-sla-worker.js'
import type { SopWorkerBatchResult } from './sop-worker.js'
import type { LoyaltyPointsExpiryBatch } from './loyalty-points-expiry-worker.js'
import type { LoyaltyAccrualDeferredBatch } from './loyalty-accrual-deferred-worker.js'
import type { LoyaltyRedemptionRecoveryBatch } from './loyalty-redemption-recovery-worker.js'
import type { LoyaltyTierBenefitExpiryBatch } from './loyalty-tier-benefit-expiry-worker.js'
import type { LoyaltyAnnualBenefitGrantBatch } from './loyalty-annual-benefit-grant-worker.js'
import type { AnnualDailySnackExpiryBatch } from './annual-daily-snack-expiry-worker.js'
import type { LoyaltyTierReviewBatch } from './loyalty-tier-review-worker.js'
import type { WechatLoyaltyNotificationBatch } from './wechat-loyalty-notification-worker.js'
import type { WechatMemberServiceNotificationBatch } from './wechat-member-service-notification-worker.js'
import type { ReservationPerformanceNotificationBatch } from './reservation-performance-notification-worker.js'
import type {
  PromotionalLoyaltyBatchResult,
  PromotionalLoyaltyRefundBatchResult,
} from './promotional-loyalty-worker.js'
import type { StoreScope } from './transaction-runner.js'
import type { PersonalContactDispositionBatch } from './personal-contact-disposition-worker.js'
import type { ComplimentaryBenefitFulfillmentBatch } from './complimentary-benefit-fulfillment-worker.js'

type ServiceSlaPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<ServiceTaskSlaBatch>
}
type ReservationExpiryPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<ReservationHoldExpiryBatch>
}
type PaymentReservationExpiryPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<PaymentReservationExpiryBatch>
}
type ActivityRegistrationExpiryPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<ActivityRegistrationExpiryBatch>
}
type ActivityWaitlistPromotionPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<ActivityWaitlistPromotionBatch>
}
type ExperienceCueDispatchPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<ExperienceCueDispatchBatch>
}
type LoyaltyPointsExpiryPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<LoyaltyPointsExpiryBatch>
}
type LoyaltyAccrualDeferredPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<LoyaltyAccrualDeferredBatch>
}
type LoyaltyRedemptionRecoveryPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<LoyaltyRedemptionRecoveryBatch>
}
type LoyaltyTierReviewPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<LoyaltyTierReviewBatch>
}
type LoyaltyTierBenefitExpiryPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<LoyaltyTierBenefitExpiryBatch>
}
type LoyaltyAnnualBenefitGrantPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<LoyaltyAnnualBenefitGrantBatch>
}
type AnnualDailySnackExpiryPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<AnnualDailySnackExpiryBatch>
}
type WechatLoyaltyNotificationPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<WechatLoyaltyNotificationBatch>
}
type WechatMemberServiceNotificationPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<WechatMemberServiceNotificationBatch>
}
type ReservationPerformanceNotificationPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<ReservationPerformanceNotificationBatch>
}
type PromotionalLoyaltyPort = {
  runTriggerBatch(scope: Readonly<StoreScope>, workerId: string): Promise<PromotionalLoyaltyBatchResult>
  runRefundBatch(scope: Readonly<StoreScope>, workerId: string): Promise<PromotionalLoyaltyRefundBatchResult>
}
type PersonalContactDispositionPort = {
  runBatch(scope:Readonly<StoreScope>,workerId:string):Promise<PersonalContactDispositionBatch>
}
type ComplimentaryBenefitFulfillmentPort = {
  runBatch(scope:Readonly<StoreScope>,workerId:string):Promise<ComplimentaryBenefitFulfillmentBatch>
}
type IdempotencyCleanupPort = {
  runBatch(scope: Readonly<StoreScope>): Promise<IdempotencyCleanupResult>
}
type StaffLoginRateLimitCleanupPort = {
  cleanupExpired(scope: Readonly<StoreScope>, limit?: number): Promise<number>
}
type OutboxPort = {
  runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    deliver: OutboxDelivery,
  ): Promise<OutboxBatchResult>
}
type NotificationPort = {
  runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    deliver: NotificationDelivery,
  ): Promise<NotificationBatchResult>
}
type BusinessDayPort = {
  run(scope: Readonly<StoreScope>, workerId: string): Promise<BusinessDayRolloverResult>
}
type AutomaticTableTurnoverPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<AutomaticTableTurnoverBatch>
}
type SopPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<SopWorkerBatchResult>
}
type AiScheduledPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<{
    workerId: string
    claimed: number
    statuses: readonly string[]
  }>
}
type PrintPort = {
  runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    adapter: PrintAdapter,
  ): Promise<PrintBatchResult>
}

export interface NormalizedWorkerCoordinatorOptions {
  workerId: string
  intervalMs?: number
  cadenceMs?: Partial<Record<NormalizedWorkerName, number>>
  now?: () => number
  onError?: (worker: NormalizedWorkerName, error: unknown) => void
  onCycle?: (result: Readonly<NormalizedWorkerCycleResult>) => void
}

export type NormalizedWorkerName =
  | 'service-sla'
  | 'reservation-expiry'
  | 'payment-reservation-expiry'
  | 'activity-registration-expiry'
  | 'activity-waitlist-promotion'
  | 'experience-cue-dispatch'
  | 'loyalty-points-expiry'
  | 'loyalty-accrual-deferred'
  | 'loyalty-redemption-recovery'
  | 'loyalty-promotion'
  | 'loyalty-annual-benefit-grant'
  | 'annual-daily-snack-expiry'
  | 'loyalty-tier-benefit-expiry'
  | 'loyalty-tier-review'
  | 'wechat-loyalty-notification'
  | 'wechat-member-service-notification'
  | 'reservation-performance-notification'
  | 'idempotency-cleanup'
  | 'staff-login-rate-limit-cleanup'
  | 'business-day'
  | 'automatic-table-turnover'
  | 'sop'
  | 'ai-scheduled'
  | 'print'
  | 'outbox'
  | 'notification'
  | 'personal-contact-disposition'
  | 'complimentary-benefit-fulfillment'

export interface NormalizedWorkerCycleResult {
  startedAt: string
  completedAt: string
  workers: {
    serviceSla: ServiceTaskSlaBatch | null
    reservationExpiry: ReservationHoldExpiryBatch | null
    paymentReservationExpiry: PaymentReservationExpiryBatch | null
    activityRegistrationExpiry: ActivityRegistrationExpiryBatch | null
    activityWaitlistPromotion: ActivityWaitlistPromotionBatch | null
    experienceCueDispatch: ExperienceCueDispatchBatch | null
    loyaltyPointsExpiry: LoyaltyPointsExpiryBatch | null
    loyaltyAccrualDeferred: LoyaltyAccrualDeferredBatch | null
    loyaltyRedemptionRecovery: LoyaltyRedemptionRecoveryBatch | null
    loyaltyPromotion: {
      triggers: PromotionalLoyaltyBatchResult
      refunds: PromotionalLoyaltyRefundBatchResult
    } | null
    loyaltyAnnualBenefitGrant: LoyaltyAnnualBenefitGrantBatch | null
    annualDailySnackExpiry: AnnualDailySnackExpiryBatch | null
    loyaltyTierBenefitExpiry: LoyaltyTierBenefitExpiryBatch | null
    loyaltyTierReview: LoyaltyTierReviewBatch | null
    wechatLoyaltyNotification: WechatLoyaltyNotificationBatch | null
    wechatMemberServiceNotification: WechatMemberServiceNotificationBatch | null
    reservationPerformanceNotification: ReservationPerformanceNotificationBatch | null
    idempotencyCleanup: IdempotencyCleanupResult | null
    staffLoginRateLimitCleanup: number | null
    businessDay: BusinessDayRolloverResult | null
    automaticTableTurnover: AutomaticTableTurnoverBatch | null
    sop: SopWorkerBatchResult | null
    aiScheduled: { workerId: string; claimed: number; statuses: readonly string[] } | null
    print: PrintBatchResult | null
    outbox: OutboxBatchResult | null
    notification: NotificationBatchResult | null
    personalContactDisposition: PersonalContactDispositionBatch | null
    complimentaryBenefitFulfillment: ComplimentaryBenefitFulfillmentBatch | null
  }
  failures: NormalizedWorkerName[]
}

export class NormalizedBackgroundWorkerCoordinator {
  private timer: NodeJS.Timeout | null = null
  private cycle: Promise<NormalizedWorkerCycleResult> | null = null
  private readonly intervalMs: number
  private readonly cadenceMs: Readonly<Record<NormalizedWorkerName, number>>
  private readonly lastStartedAt = new Map<NormalizedWorkerName, number>()
  private readonly now: () => number

  constructor(
    private readonly scope: Readonly<StoreScope>,
    private readonly workers: Readonly<{
      serviceSla: ServiceSlaPort
      reservationExpiry: ReservationExpiryPort
      paymentReservationExpiry: PaymentReservationExpiryPort
      activityRegistrationExpiry: ActivityRegistrationExpiryPort
      activityWaitlistPromotion?: ActivityWaitlistPromotionPort
      experienceCueDispatch: ExperienceCueDispatchPort
      loyaltyPointsExpiry: LoyaltyPointsExpiryPort
      loyaltyAccrualDeferred?: LoyaltyAccrualDeferredPort
      loyaltyRedemptionRecovery?: LoyaltyRedemptionRecoveryPort
      promotionalLoyalty?: PromotionalLoyaltyPort
      loyaltyAnnualBenefitGrant?: LoyaltyAnnualBenefitGrantPort
      annualDailySnackExpiry?: AnnualDailySnackExpiryPort
      loyaltyTierBenefitExpiry?: LoyaltyTierBenefitExpiryPort
      loyaltyTierReview: LoyaltyTierReviewPort
      wechatLoyaltyNotification?: WechatLoyaltyNotificationPort
      wechatMemberServiceNotification?: WechatMemberServiceNotificationPort
      reservationPerformanceNotification?: ReservationPerformanceNotificationPort
      idempotencyCleanup: IdempotencyCleanupPort
      staffLoginRateLimitCleanup: StaffLoginRateLimitCleanupPort
      businessDay: BusinessDayPort
      automaticTableTurnover?: AutomaticTableTurnoverPort
      sop?: SopPort
      aiScheduled: AiScheduledPort
      print?: PrintPort
      outbox?: OutboxPort
      notification?: NotificationPort
      personalContactDisposition: PersonalContactDispositionPort
      complimentaryBenefitFulfillment?: ComplimentaryBenefitFulfillmentPort
    }>,
    private readonly delivery: Readonly<{
      outbox?: OutboxDelivery
      notification?: NotificationDelivery
      print?: PrintAdapter
    }>,
    private readonly options: Readonly<NormalizedWorkerCoordinatorOptions>,
  ) {
    validateWorkerId(options.workerId)
    this.intervalMs = validateInterval(options.intervalMs ?? 2_000)
    this.cadenceMs = workerCadences(options.cadenceMs)
    this.now = options.now ?? Date.now
  }

  runOnce(): Promise<NormalizedWorkerCycleResult> {
    if (this.cycle !== null) return this.cycle
    this.cycle = this.executeCycle().finally(() => {
      this.cycle = null
    })
    return this.cycle
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.intervalMs)
    this.timer.unref()
    void this.runOnce()
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.cycle
  }

  private async executeCycle(): Promise<NormalizedWorkerCycleResult> {
    const startedAt = new Date().toISOString()
    const names: readonly NormalizedWorkerName[] = [
      'service-sla',
      'reservation-expiry',
      'payment-reservation-expiry',
      'activity-registration-expiry',
      'activity-waitlist-promotion',
      'experience-cue-dispatch',
      'loyalty-points-expiry',
      'loyalty-accrual-deferred',
      'loyalty-redemption-recovery',
      'loyalty-promotion',
      'loyalty-annual-benefit-grant',
      'annual-daily-snack-expiry',
      'loyalty-tier-benefit-expiry',
      'loyalty-tier-review',
      'wechat-loyalty-notification',
      'reservation-performance-notification',
      'idempotency-cleanup',
      'staff-login-rate-limit-cleanup',
      'business-day',
      'automatic-table-turnover',
      'sop',
      'ai-scheduled',
      'print',
      'outbox',
      'notification',
      'personal-contact-disposition',
      'complimentary-benefit-fulfillment',
      'wechat-member-service-notification',
    ]
    const executions = await Promise.allSettled([
      this.runWhenDue('service-sla', () => this.workers.serviceSla.runBatch(this.scope, `${this.options.workerId}:service-sla`)),
      this.runWhenDue('reservation-expiry', () => this.workers.reservationExpiry.runBatch(this.scope, `${this.options.workerId}:reservation-expiry`)),
      this.runWhenDue('payment-reservation-expiry', () => this.workers.paymentReservationExpiry.runBatch(
        this.scope,
        `${this.options.workerId}:payment-reservation-expiry`,
      )),
      this.runWhenDue('activity-registration-expiry', () => this.workers.activityRegistrationExpiry.runBatch(
        this.scope,
        `${this.options.workerId}:activity-registration-expiry`,
      )),
      this.workers.activityWaitlistPromotion===undefined
        ? Promise.resolve(null)
        : this.runWhenDue('activity-waitlist-promotion', () => this.workers.activityWaitlistPromotion!.runBatch(
          this.scope,
          `${this.options.workerId}:activity-waitlist-promotion`,
        )),
      this.runWhenDue('experience-cue-dispatch', () => this.workers.experienceCueDispatch.runBatch(
        this.scope,
        `${this.options.workerId}:experience-cue-dispatch`,
      )),
      this.runWhenDue('loyalty-points-expiry', () => this.workers.loyaltyPointsExpiry.runBatch(
        this.scope,
        `${this.options.workerId}:loyalty-points-expiry`,
      )),
      this.workers.loyaltyAccrualDeferred===undefined
        ? Promise.resolve(null)
        : this.runWhenDue('loyalty-accrual-deferred', () => this.workers.loyaltyAccrualDeferred!.runBatch(
          this.scope,
          `${this.options.workerId}:loyalty-accrual-deferred`,
        )),
      this.workers.loyaltyRedemptionRecovery===undefined
        ? Promise.resolve(null)
        : this.runWhenDue('loyalty-redemption-recovery', () => this.workers.loyaltyRedemptionRecovery!.runBatch(
          this.scope,
          `${this.options.workerId}:loyalty-redemption-recovery`,
        )),
      this.workers.promotionalLoyalty===undefined
        ? Promise.resolve(null)
        : this.runWhenDue('loyalty-promotion', async () => {
          const [triggers, refunds] = await Promise.all([
            this.workers.promotionalLoyalty!.runTriggerBatch(
              this.scope, `${this.options.workerId}:loyalty-promotion-trigger`,
            ),
            this.workers.promotionalLoyalty!.runRefundBatch(
              this.scope, `${this.options.workerId}:loyalty-promotion-refund`,
            ),
          ])
          return { triggers, refunds }
        }),
      this.workers.loyaltyAnnualBenefitGrant===undefined
        ? Promise.resolve(null)
        : this.runWhenDue('loyalty-annual-benefit-grant', () => this.workers.loyaltyAnnualBenefitGrant!.runBatch(
          this.scope, `${this.options.workerId}:loyalty-annual-benefit-grant`,
        )),
      this.workers.annualDailySnackExpiry===undefined
        ? Promise.resolve(null)
        : this.runWhenDue('annual-daily-snack-expiry', () => this.workers.annualDailySnackExpiry!.runBatch(
          this.scope, `${this.options.workerId}:annual-daily-snack-expiry`,
        )),
      this.workers.loyaltyTierBenefitExpiry===undefined
        ? Promise.resolve(null)
        : this.runWhenDue('loyalty-tier-benefit-expiry', () => this.workers.loyaltyTierBenefitExpiry!.runBatch(
          this.scope,
          `${this.options.workerId}:loyalty-tier-benefit-expiry`,
        )),
      this.runWhenDue('loyalty-tier-review', () => this.workers.loyaltyTierReview.runBatch(
        this.scope,
        `${this.options.workerId}:loyalty-tier-review`,
      )),
      this.workers.wechatLoyaltyNotification===undefined
        ? Promise.resolve(null)
        : this.runWhenDue('wechat-loyalty-notification', () => this.workers.wechatLoyaltyNotification!.runBatch(
          this.scope,
          `${this.options.workerId}:wechat-loyalty-notification`,
        )),
      this.workers.reservationPerformanceNotification===undefined
        ? Promise.resolve(null)
        : this.runWhenDue('reservation-performance-notification', () => (
          this.workers.reservationPerformanceNotification!.runBatch(
            this.scope,
            `${this.options.workerId}:reservation-performance-notification`,
          )
        )),
      this.runWhenDue('idempotency-cleanup', () => this.workers.idempotencyCleanup.runBatch(this.scope)),
      this.runWhenDue('staff-login-rate-limit-cleanup', () => this.workers.staffLoginRateLimitCleanup.cleanupExpired(this.scope)),
      this.runWhenDue('business-day', () => this.workers.businessDay.run(this.scope, `${this.options.workerId}:business-day`)),
      this.workers.automaticTableTurnover === undefined
        ? Promise.resolve(null)
        : this.runWhenDue('automatic-table-turnover', () => this.workers.automaticTableTurnover!.runBatch(
          this.scope, `${this.options.workerId}:automatic-table-turnover`,
        )),
      this.workers.sop === undefined
        ? Promise.resolve(null)
        : this.runWhenDue('sop', () => this.workers.sop!.runBatch(this.scope, `${this.options.workerId}:sop`)),
      this.runWhenDue('ai-scheduled', () => this.workers.aiScheduled.runBatch(this.scope, `${this.options.workerId}:ai-scheduled`)),
      this.workers.print === undefined || this.delivery.print === undefined
        ? Promise.resolve(null)
        : this.runWhenDue('print', () => this.workers.print!.runBatch(this.scope, `${this.options.workerId}:print`, this.delivery.print!)),
      this.workers.outbox === undefined || this.delivery.outbox === undefined
        ? Promise.resolve(null)
        : this.runWhenDue('outbox', () => this.workers.outbox!.runBatch(this.scope, `${this.options.workerId}:outbox`, this.delivery.outbox!)),
      this.workers.notification === undefined || this.delivery.notification === undefined
        ? Promise.resolve(null)
        : this.runWhenDue('notification', () => this.workers.notification!.runBatch(
            this.scope,
            `${this.options.workerId}:notification`,
            this.delivery.notification!,
          )),
      this.runWhenDue('personal-contact-disposition', () => this.workers.personalContactDisposition.runBatch(
        this.scope,`${this.options.workerId}:personal-contact-disposition`,
      )),
      this.workers.complimentaryBenefitFulfillment===undefined
        ? Promise.resolve(null)
        : this.runWhenDue('complimentary-benefit-fulfillment', () => (
          this.workers.complimentaryBenefitFulfillment!.runBatch(
            this.scope,`${this.options.workerId}:complimentary-benefit-fulfillment`,
          )
        )),
      this.workers.wechatMemberServiceNotification===undefined
        ? Promise.resolve(null)
        : this.runWhenDue('wechat-member-service-notification', () => (
          this.workers.wechatMemberServiceNotification!.runBatch(
            this.scope,`${this.options.workerId}:wechat-member-service-notification`,
          )
        )),
    ] as const)

    const failures: NormalizedWorkerName[] = []
    executions.forEach((execution, index) => {
      if (execution.status === 'fulfilled') return
      const worker = names[index]
      if (worker === undefined) return
      failures.push(worker)
      this.options.onError?.(worker, execution.reason)
    })
    const automaticTableTurnover = fulfilledValue(executions[19])
    if (automaticTableTurnover !== null && automaticTableTurnover.failedSessionIds.length > 0) {
      failures.push('automatic-table-turnover')
      this.options.onError?.(
        'automatic-table-turnover',
        new Error('automatic_table_turnover_items_failed'),
      )
    }
    const personalContactDisposition = fulfilledValue(executions[25])
    if (personalContactDisposition !== null && personalContactDisposition.failed>0) {
      failures.push('personal-contact-disposition')
      this.options.onError?.(
        'personal-contact-disposition',
        new Error('personal_contact_disposition_items_failed'),
      )
    }

    const result: NormalizedWorkerCycleResult = {
      startedAt,
      completedAt: new Date().toISOString(),
      workers: {
        serviceSla: fulfilledValue(executions[0]),
        reservationExpiry: fulfilledValue(executions[1]),
        paymentReservationExpiry: fulfilledValue(executions[2]),
        activityRegistrationExpiry: fulfilledValue(executions[3]),
        activityWaitlistPromotion: fulfilledValue(executions[4]),
        experienceCueDispatch: fulfilledValue(executions[5]),
        loyaltyPointsExpiry: fulfilledValue(executions[6]),
        loyaltyAccrualDeferred: fulfilledValue(executions[7]),
        loyaltyRedemptionRecovery: fulfilledValue(executions[8]),
        loyaltyPromotion: fulfilledValue(executions[9]),
        loyaltyAnnualBenefitGrant: fulfilledValue(executions[10]),
        annualDailySnackExpiry: fulfilledValue(executions[11]),
        loyaltyTierBenefitExpiry: fulfilledValue(executions[12]),
        loyaltyTierReview: fulfilledValue(executions[13]),
        wechatLoyaltyNotification: fulfilledValue(executions[14]),
        reservationPerformanceNotification: fulfilledValue(executions[15]),
        idempotencyCleanup: fulfilledValue(executions[16]),
        staffLoginRateLimitCleanup: fulfilledValue(executions[17]),
        businessDay: fulfilledValue(executions[18]),
        automaticTableTurnover,
        sop: fulfilledValue(executions[20]),
        aiScheduled: fulfilledValue(executions[21]),
        print: fulfilledValue(executions[22]),
        outbox: fulfilledValue(executions[23]),
        notification: fulfilledValue(executions[24]),
        personalContactDisposition: fulfilledValue(executions[25]),
        complimentaryBenefitFulfillment: fulfilledValue(executions[26]),
        wechatMemberServiceNotification: fulfilledValue(executions[27]),
      },
      failures,
    }
    this.options.onCycle?.(result)
    return result
  }

  private runWhenDue<Value>(name: NormalizedWorkerName, execute: () => Promise<Value>): Promise<Value | null> {
    const now = this.now()
    const lastStartedAt = this.lastStartedAt.get(name)
    if (lastStartedAt !== undefined && now - lastStartedAt < this.cadenceMs[name]) {
      return Promise.resolve(null)
    }
    this.lastStartedAt.set(name, now)
    return execute()
  }
}

function fulfilledValue<Value>(result: PromiseSettledResult<Value>): Value | null {
  return result.status === 'fulfilled' ? result.value : null
}

function validateWorkerId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(value)) {
    throw new TypeError('workerId must be a stable internal identifier between 3 and 96 characters')
  }
}

function validateInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 250 || value > 60_000) {
    throw new TypeError('intervalMs must be an integer between 250 and 60000')
  }
  return value
}

const DEFAULT_WORKER_CADENCES: Readonly<Record<NormalizedWorkerName, number>> = Object.freeze({
  'service-sla': 2_000,
  'reservation-expiry': 5_000,
  'payment-reservation-expiry': 5_000,
  'activity-registration-expiry': 5_000,
  'activity-waitlist-promotion': 2_000,
  'experience-cue-dispatch': 2_000,
  'loyalty-points-expiry': 60_000,
  'loyalty-accrual-deferred': 30_000,
  'loyalty-redemption-recovery': 30_000,
  'loyalty-promotion': 5_000,
  'loyalty-annual-benefit-grant': 60_000,
  'annual-daily-snack-expiry': 2_000,
  'loyalty-tier-benefit-expiry': 60_000,
  'loyalty-tier-review': 60_000,
  'wechat-loyalty-notification': 30_000,
  'wechat-member-service-notification': 30_000,
  'reservation-performance-notification': 30_000,
  'idempotency-cleanup': 60_000,
  'staff-login-rate-limit-cleanup': 60_000,
  'business-day': 30_000,
  'automatic-table-turnover': 30_000,
  sop: 2_000,
  'ai-scheduled': 2_000,
  print: 500,
  outbox: 500,
  notification: 500,
  'personal-contact-disposition': 60_000,
  'complimentary-benefit-fulfillment': 500,
})

function workerCadences(
  overrides: Partial<Record<NormalizedWorkerName, number>> | undefined,
): Readonly<Record<NormalizedWorkerName, number>> {
  const result = { ...DEFAULT_WORKER_CADENCES, ...overrides }
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 250 || value > 3_600_000) {
      throw new TypeError(`cadence for ${name} must be an integer between 250 and 3600000`)
    }
  }
  return Object.freeze(result)
}
