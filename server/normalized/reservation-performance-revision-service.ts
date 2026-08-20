import { createHash } from 'node:crypto'
import type { AuditEvent, JsonCodec, JsonValue } from './command-executor.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import {
  ReservationPerformanceRevisionRepository,
  type AcknowledgePerformanceImpactInput,
  type PerformanceImpactDecision,
  type PerformanceRevisionKind,
  type PerformanceScheduleRevision,
  type ReservationPerformanceImpact,
} from './reservation-performance-revision-repository.js'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

export interface ReservationPerformanceStaffContext {
  scope: Readonly<StoreScope>
  employeeId: string
  businessDate: string
}

export interface ReservationPerformanceCustomerContext {
  scope: Readonly<StoreScope>
  customerId: string
  actorRef: string
  businessDate: string
}

export class ReservationPerformanceRevisionService {
  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner, 'run'>,
    private readonly commands: NormalizedCommandExecutor,
  ) {}

  revise(
    context: Readonly<ReservationPerformanceStaffContext>,
    input: Readonly<{
      scheduleId: string
      kind: PerformanceRevisionKind
      startsAt: string | null
      endsAt: string | null
      replacementScheduleId: string | null
      reason: string
      idempotencyKey: string
    }>,
  ) {
    const revisionPublicId = publicId('performance-revision', context.scope.storeId, input.idempotencyKey)
    const requestFingerprint = fingerprint(input)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'performance-schedule.revise',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      resultCodec: objectCodec<PerformanceScheduleRevision>('performance revision'),
    }, async (transaction) => {
      const revision = await new ReservationPerformanceRevisionRepository(transaction).revise({
        publicId: revisionPublicId,
        scheduleId: input.scheduleId,
        kind: input.kind,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        replacementScheduleId: input.replacementScheduleId,
        reason: input.reason,
        employeeId: context.employeeId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
      })
      return {
        result: revision,
        auditEvents: [staffAudit(context, revision)],
        outboxMessages: [],
      }
    })
  }

  listRevisionImpacts(
    context: Readonly<ReservationPerformanceStaffContext>,
    revisionPublicId: string,
  ) {
    return this.transactions.run(
      context.scope,
      (transaction) => new ReservationPerformanceRevisionRepository(transaction)
        .listRevisionImpacts(revisionPublicId),
      { readOnly: true },
    )
  }

  listCustomerImpacts(context: Readonly<ReservationPerformanceCustomerContext>) {
    return this.transactions.run(
      context.scope,
      (transaction) => new ReservationPerformanceRevisionRepository(transaction)
        .listCustomerImpacts(context.customerId),
      { readOnly: true },
    )
  }

  acknowledge(
    context: Readonly<ReservationPerformanceCustomerContext>,
    input: Readonly<{
      impactPublicId: string
      decision: PerformanceImpactDecision
      selectedScheduleId: string | null
      idempotencyKey: string
    }>,
  ) {
    const requestFingerprint = fingerprint(input)
    const repositoryInput: AcknowledgePerformanceImpactInput = {
      publicId: publicId('reservation-performance-ack', context.scope.storeId, input.idempotencyKey),
      impactPublicId: input.impactPublicId,
      actingCustomerId: context.customerId,
      decision: input.decision,
      selectedScheduleId: input.selectedScheduleId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
    }
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'reservation.performance-impact.acknowledge',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      resultCodec: objectCodec<ReservationPerformanceImpact>('reservation performance acknowledgement'),
    }, async (transaction) => {
      const impact = await new ReservationPerformanceRevisionRepository(transaction)
        .acknowledge(repositoryInput)
      return {
        result: impact,
        auditEvents: [customerAudit(context, impact)],
        outboxMessages: [],
      }
    })
  }
}

function staffAudit(
  context: Readonly<ReservationPerformanceStaffContext>,
  revision: Readonly<PerformanceScheduleRevision>,
): AuditEvent {
  return {
    actor: { type: 'employee', employeeId: context.employeeId },
    action: `performance_schedule.${revision.kind}`,
    objectType: 'performance_schedule_revision',
    objectId: revision.publicId,
    businessDate: context.businessDate,
    reason: revision.reason,
    beforeData: {
      scheduleId: revision.scheduleId,
      performerId: revision.previousPerformerId,
      startsAt: revision.previousStartsAt,
      endsAt: revision.previousEndsAt,
      status: revision.previousStatus,
    },
    afterData: {
      revisionNumber: revision.revisionNumber,
      revisionKind: revision.kind,
      resultingScheduleId: revision.resultingScheduleId,
      resultingPerformerId: revision.resultingPerformerId,
      resultingStartsAt: revision.resultingStartsAt,
      resultingEndsAt: revision.resultingEndsAt,
      resultingStatus: revision.resultingStatus,
      affectedReservations: revision.affectedReservations,
    },
  }
}

function customerAudit(
  context: Readonly<ReservationPerformanceCustomerContext>,
  impact: Readonly<ReservationPerformanceImpact>,
): AuditEvent {
  const acknowledgement = impact.acknowledgement
  if (acknowledgement === null) throw new Error('Acknowledged impact has no acknowledgement projection')
  return {
    actor: { type: 'guest', ref: context.actorRef },
    action: 'reservation.performance_revision_acknowledged',
    objectType: 'reservation_performance_impact',
    objectId: impact.publicId,
    businessDate: context.businessDate,
    beforeData: {
      reservationPublicId: impact.reservationPublicId,
      revisionPublicId: impact.revision.publicId,
      previousPreferredScheduleId: impact.revision.scheduleId,
    },
    afterData: {
      decision: acknowledgement.decision,
      selectedScheduleId: acknowledgement.selectedScheduleId,
      resultingPreferredScheduleId: acknowledgement.resultingPreferredScheduleId,
      reservationStatus: impact.reservationStatus,
    },
  }
}

function publicId(prefix: string, storeId: string, idempotencyKey: string): string {
  return `${prefix}-${createHash('sha256').update(`${storeId}:${idempotencyKey}`).digest('hex').slice(0, 32)}`
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function objectCodec<Value>(label: string): JsonCodec<Value> {
  return {
    encode: (value) => value as unknown as JsonValue,
    decode: (value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError(`${label} replay payload is invalid`)
      }
      return value as Value
    },
  }
}
