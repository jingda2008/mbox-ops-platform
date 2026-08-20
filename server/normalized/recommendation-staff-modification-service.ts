import { createHash } from 'node:crypto'
import type { CommandExecution, JsonCodec, JsonValue, NormalizedCommandExecutor } from './command-executor.js'
import {
  RecommendationStaffModificationRepository,
  type RecommendationStaffModificationReason,
  type RecommendationStaffModificationView,
} from './recommendation-staff-modification-repository.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

export interface RecommendationStaffContext {
  scope: Readonly<StoreScope>
  employeeId: string
  businessDate: string
}

type AccessRepository = Pick<StaffAccessRepository, 'resolve'>
type ModificationRepository = Pick<
  RecommendationStaffModificationRepository,
  'latestForTable' | 'record'
>

export class RecommendationStaffModificationService {
  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner, 'run'>,
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
    private readonly createAccess: (transaction: ScopedTransaction) => AccessRepository = (
      transaction,
    ) => new StaffAccessRepository(transaction),
    private readonly createRepository: (transaction: ScopedTransaction) => ModificationRepository = (
      transaction,
    ) => new RecommendationStaffModificationRepository(transaction),
  ) {}

  latestForTable(context: RecommendationStaffContext, tableSessionId: string) {
    return this.transactions.run(context.scope, async (transaction) => {
      const access = await this.createAccess(transaction).resolve(context.employeeId)
      if (!access.permissions.includes('recommendation.staff.modify')) throw new StaffAccessDeniedError(
        `Employee ${context.employeeId} does not have permission recommendation.staff.modify`,
      )
      return this.createRepository(transaction).latestForTable(
        tableSessionId,context.employeeId,access.permissions.includes('recommendation.staff.modify.all'),
      )
    }, { readOnly: true })
  }

  modify(
    context: RecommendationStaffContext,
    input: Readonly<{
      recommendationPublicId: string
      sourceProductId: string
      targetProductId: string
      reasonCode: RecommendationStaffModificationReason
      idempotencyKey: string
    }>,
  ): Promise<CommandExecution<RecommendationStaffModificationView>> {
    const requestFingerprint = JSON.stringify({
      employeeId: context.employeeId,
      recommendationPublicId: input.recommendationPublicId,
      sourceProductId: input.sourceProductId,
      targetProductId: input.targetProductId,
      reasonCode: input.reasonCode,
    })
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.experience.recommendation.staff-modify',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      resultCodec: modificationCodec,
    }, async (transaction) => {
      const access = await this.createAccess(transaction).resolve(context.employeeId)
      if (!access.permissions.includes('recommendation.staff.modify')) throw new StaffAccessDeniedError(
        `Employee ${context.employeeId} does not have permission recommendation.staff.modify`,
      )
      const result = await this.createRepository(transaction).record({
        ...input,
        employeeId: context.employeeId,
        allowAllTables: access.permissions.includes('recommendation.staff.modify.all'),
        requestSha256: createHash('sha256').update(requestFingerprint).digest('hex'),
      })
      return {
        result,
        auditEvents: [{
          actor: { type: 'employee',employeeId: context.employeeId },
          action: 'customer.experience.recommendation.staff_modified',
          objectType: 'recommendation_session',
          objectId: result.recommendationPublicId,
          businessDate: context.businessDate,
          reason: input.reasonCode,
          afterData: {
            eventId: result.eventId,
            tableSessionId: result.tableSessionId,
            sourceProductId: result.sourceProductId,
            targetProductId: result.targetProductId,
            reasonCode: result.reasonCode,
          },
        }],
        outboxMessages: [],
      }
    })
  }
}

const modificationCodec: JsonCodec<RecommendationStaffModificationView> = {
  encode: (value) => value as unknown as JsonValue,
  decode(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('staff recommendation modification result is invalid')
    }
    const row = value as Partial<RecommendationStaffModificationView>
    for (const field of [
      'eventId','recommendationPublicId','tableSessionId','sourceProductId','sourceProductName',
      'targetProductId','targetProductName','reasonCode','employeeId','occurredAt',
    ] as const) {
      if (typeof row[field] !== 'string') throw new TypeError('staff recommendation modification result is invalid')
    }
    return row as RecommendationStaffModificationView
  },
}
