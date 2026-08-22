import { createHash } from 'node:crypto'
import type {
  AuditEvent,
  CommandExecution,
  JsonCodec,
  JsonValue,
} from './command-executor.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import {
  ActivityOperationsRepository,
  type ActivityDraftInput,
  type ActivityOperationsActivity,
  type ActivityOperationsRegistration,
  type ActivityRegistrationOperation,
  type ActivityWaitlistRetry,
} from './activity-operations-repository.js'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

export interface ActivityOperationsStaffContext {
  scope: Readonly<StoreScope>
  employeeId: string
  businessDate: string
}

export class ActivityOperationsService {
  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner, 'run'>,
    private readonly commands: NormalizedCommandExecutor,
  ) {}

  list(context: ActivityOperationsStaffContext) {
    return this.transactions.run(
      context.scope,
      (transaction) => new ActivityOperationsRepository(transaction).list(),
      { readOnly: true },
    )
  }

  detail(context: ActivityOperationsStaffContext, publicId: string) {
    return this.transactions.run(
      context.scope,
      (transaction) => new ActivityOperationsRepository(transaction).detail(publicId),
      { readOnly: true },
    )
  }

  createDraft(
    context: ActivityOperationsStaffContext,
    input: Readonly<{ draft: ActivityDraftInput; reason: string; idempotencyKey: string }>,
  ): Promise<CommandExecution<ActivityOperationsActivity>> {
    const publicId = `community-activity-${createHash('sha256')
      .update(`${context.scope.storeId}:${input.idempotencyKey}`)
      .digest('hex').slice(0, 24)}`
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'community.activity.draft.create',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<ActivityOperationsActivity>(),
    }, async (transaction) => {
      const result = await new ActivityOperationsRepository(transaction)
        .createDraft(publicId, input.draft, context.employeeId)
      return {
        result,
        auditEvents: [audit(context, {
          action: 'community.activity.draft_created',
          objectType: 'community_activity',
          objectId: publicId,
          reason: input.reason,
          afterData: {
            status: result.status,
            startsAt: result.startsAt,
            endsAt: result.endsAt,
            capacity: result.capacity,
            paymentMode: result.paymentMode,
            feeAmountMinor: result.feeAmountMinor,
          },
        })],
        outboxMessages: [],
      }
    })
  }

  updateDraft(
    context: ActivityOperationsStaffContext,
    input: Readonly<{ publicId: string; draft: ActivityDraftInput; reason: string; idempotencyKey: string }>,
  ): Promise<CommandExecution<ActivityOperationsActivity>> {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'community.activity.draft.update',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<ActivityOperationsActivity>(),
    }, async (transaction) => {
      const result = await new ActivityOperationsRepository(transaction).updateDraft(input.publicId, input.draft)
      return {
        result,
        auditEvents: [audit(context, {
          action: 'community.activity.draft_updated',
          objectType: 'community_activity',
          objectId: input.publicId,
          reason: input.reason,
          afterData: {
            status: result.status,
            startsAt: result.startsAt,
            endsAt: result.endsAt,
            capacity: result.capacity,
            paymentMode: result.paymentMode,
            feeAmountMinor: result.feeAmountMinor,
            refundPolicyVersion: result.refundPolicyVersion,
            safetyPolicyVersion: result.safetyPolicyVersion,
          },
        })],
        outboxMessages: [],
      }
    })
  }

  transitionRegistration(
    context: ActivityOperationsStaffContext,
    input: Readonly<{
      publicId: string
      operation: ActivityRegistrationOperation
      reason: string
      idempotencyKey: string
    }>,
  ): Promise<CommandExecution<ActivityOperationsRegistration>> {
    const operationCode = input.operation === 'check_in'
      ? 'check-in'
      : input.operation === 'no_show' ? 'no-show' : 'cancel'
    return this.commands.execute({
      scope: context.scope,
      operationScope: `community.activity.registration.${operationCode}`,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<ActivityOperationsRegistration>(),
    }, async (transaction) => {
      const result = await new ActivityOperationsRepository(transaction)
        .transitionRegistration(input.publicId, input.operation, input.reason)
      return {
        result,
        auditEvents: [audit(context, {
          action: `community.activity.registration.${operationCode}`,
          objectType: 'community_activity_registration',
          objectId: input.publicId,
          reason: input.reason,
          afterData: {
            status: result.status,
            paymentStatus: result.paymentStatus,
            partySize: result.partySize,
          },
        })],
        outboxMessages: [],
      }
    })
  }

  retryWaitlistPromotion(
    context: ActivityOperationsStaffContext,
    input: Readonly<{ publicId: string; reason: string; idempotencyKey: string }>,
  ): Promise<CommandExecution<ActivityWaitlistRetry>> {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'community.activity.waitlist.retry',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<ActivityWaitlistRetry>(),
    }, async (transaction) => {
      const result = await new ActivityOperationsRepository(transaction)
        .retryWaitlistPromotion(input.publicId)
      return {
        result,
        auditEvents: [audit(context, {
          action: 'community.activity.waitlist_retry_requested',
          objectType: 'community_activity',
          objectId: input.publicId,
          reason: input.reason,
          afterData: { state: result.state, nextAttemptAt: result.nextAttemptAt },
        })],
        outboxMessages: [],
      }
    })
  }
}

function audit(
  context: ActivityOperationsStaffContext,
  input: Omit<AuditEvent, 'actor' | 'businessDate'>,
): AuditEvent {
  return {
    ...input,
    actor: { type: 'employee', employeeId: context.employeeId },
    businessDate: context.businessDate,
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function objectCodec<Value>(): JsonCodec<Value> {
  return {
    encode: (value) => value as unknown as JsonValue,
    decode: (value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError('activity operation replay payload is invalid')
      }
      return value as Value
    },
  }
}
