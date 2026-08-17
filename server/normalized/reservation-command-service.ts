import type {
  AuditActor,
  CommandExecution,
  JsonCodec,
  JsonObject,
} from './command-executor.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import {
  CustomerRepository,
  type CreateAnonymousCustomerInput,
} from './customer-repository.js'
import {
  ReservationRepository,
  type CreateReservationInput,
  type Reservation,
} from './reservation-repository.js'
import type { StoreScope } from './transaction-runner.js'

export interface CreateReservationCommand extends Omit<
  CreateReservationInput,
  'arrivalGraceEndsAt' | 'reservationPolicyVersion'
> {
  scope: Readonly<StoreScope>
  actor: AuditActor
  businessDate: string
  idempotencyKey: string
  requestFingerprint: string
  anonymousCustomer?: CreateAnonymousCustomerInput
  arrivalGraceEndsAt?: string
  reservationPolicyVersion?: number
}

export interface ReservationTransitionCommand {
  scope: Readonly<StoreScope>
  actor: AuditActor
  businessDate: string
  reservationId: string
  reason?: string | null
  idempotencyKey: string
  requestFingerprint: string
  overridePolicy?: boolean
}

export class ReservationCommandService {
  constructor(private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>) {}

  create(input: Readonly<CreateReservationCommand>): Promise<CommandExecution<Reservation>> {
    if (input.customerId && input.anonymousCustomer) {
      throw new TypeError('Provide customerId or anonymousCustomer, not both')
    }
    return this.commands.execute({
      scope: input.scope,
      operationScope: 'reservation.create',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      resultCodec: reservationCodec,
    }, async (transaction) => {
      const anonymous = input.anonymousCustomer === undefined
        ? null
        : await new CustomerRepository(transaction).createAnonymous(input.anonymousCustomer)
      const policy = await transaction.query<{ policy_version: number; arrival_grace_minutes: number }>(`
        SELECT policy_version, arrival_grace_minutes
        FROM mbox.public_reservation_policies
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        FOR KEY SHARE
      `, [transaction.scope.tenantId, transaction.scope.storeId])
      const policyRow = policy.rows[0]
      if (policyRow === undefined) throw new Error('Reservation policy is not configured')
      if (input.reservationPolicyVersion !== undefined
        && input.reservationPolicyVersion !== policyRow.policy_version) {
        throw new Error('Reservation policy changed; refresh before creating the reservation')
      }
      const policyArrivalGraceEndsAt = new Date(
        Date.parse(input.arrivalAt) + policyRow.arrival_grace_minutes * 60_000,
      ).toISOString()
      if (input.arrivalGraceEndsAt !== undefined
        && Date.parse(input.arrivalGraceEndsAt) !== Date.parse(policyArrivalGraceEndsAt)) {
        throw new Error('Reservation arrival grace must match the active policy')
      }
      const reservation = await new ReservationRepository(transaction).create({
        ...input,
        customerId: input.customerId ?? anonymous?.customer.id ?? null,
        requestHoldExpiresAt: input.requestHoldExpiresAt ?? input.holdExpiresAt ?? null,
        arrivalGraceEndsAt: policyArrivalGraceEndsAt,
        reservationPolicyVersion: policyRow.policy_version,
      })
      const auditEvents = []
      const outboxMessages = []
      if (anonymous?.created) {
        auditEvents.push({
          actor: input.actor,
          action: 'customer.created',
          objectType: 'customer',
          objectId: anonymous.customer.id,
          businessDate: input.businessDate,
          afterData: { identityKind: 'anonymous', publicId: anonymous.customer.publicId },
        })
        outboxMessages.push({
          aggregateType: 'customer',
          aggregateId: anonymous.customer.id,
          aggregateVersion: 1,
          eventType: 'customer.created.v1',
          payload: { customerId: anonymous.customer.id, identityKind: 'anonymous' },
        })
      }
      auditEvents.push({
        actor: input.actor,
        action: 'reservation.created',
        objectType: 'reservation',
        objectId: reservation.id,
        businessDate: input.businessDate,
        afterData: reservationEventJson(reservation),
      })
      outboxMessages.push({
        aggregateType: 'reservation',
        aggregateId: reservation.id,
        aggregateVersion: reservation.aggregateVersion,
        eventType: 'reservation.created.v1',
        payload: reservationEventJson(reservation),
      })
      return { result: reservation, auditEvents, outboxMessages }
    })
  }

  confirm(input: Readonly<ReservationTransitionCommand>): Promise<CommandExecution<Reservation>> {
    return this.transition(input, 'confirm', 'reservation.confirmed')
  }

  arrive(input: Readonly<ReservationTransitionCommand>): Promise<CommandExecution<Reservation>> {
    return this.transition(input, 'arrive', 'reservation.arrived')
  }

  cancel(input: Readonly<ReservationTransitionCommand>): Promise<CommandExecution<Reservation>> {
    return this.transition(input, 'cancel', 'reservation.cancelled')
  }

  private transition(
    input: Readonly<ReservationTransitionCommand>,
    transition: 'confirm' | 'arrive' | 'cancel',
    eventType: string,
  ): Promise<CommandExecution<Reservation>> {
    return this.commands.execute({
      scope: input.scope,
      operationScope: `reservation.${transition}`,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      resultCodec: reservationCodec,
    }, async (transaction) => {
      const repository = new ReservationRepository(transaction)
      const mutation = transition === 'confirm'
        ? await repository.confirmWithResult(input.reservationId)
        : transition === 'arrive'
          ? await repository.arriveWithResult(input.reservationId)
          : await repository.cancelWithResult(input.reservationId, { overridePolicy: input.overridePolicy })
      const reservation = mutation.reservation
      if (!mutation.changed) return { result: reservation, auditEvents: [], outboxMessages: [] }
      const payload: JsonObject = {
        ...reservationEventJson(reservation),
        policyOverride: transition === 'cancel' && input.overridePolicy === true,
      }
      return {
        result: reservation,
        auditEvents: [{
          actor: input.actor,
          action: eventType,
          objectType: 'reservation',
          objectId: reservation.id,
          businessDate: input.businessDate,
          reason: input.reason ?? null,
          afterData: payload,
        }],
        outboxMessages: [{
          aggregateType: 'reservation',
          aggregateId: reservation.id,
          aggregateVersion: reservation.aggregateVersion,
          eventType: `${eventType}.v1`,
          payload,
        }],
      }
    })
  }
}

const reservationCodec: JsonCodec<Reservation> = {
  encode: reservationToJson,
  decode: (value) => {
    if (typeof value !== 'object' || value === null
      || !('id' in value) || typeof value.id !== 'string'
      || !('status' in value) || typeof value.status !== 'string'
      || !('tableLocks' in value) || !Array.isArray(value.tableLocks)) {
      throw new TypeError('Stored reservation result is invalid')
    }
    return value as Reservation
  },
}

function reservationToJson(reservation: Reservation): JsonObject {
  return {
    id: reservation.id,
    publicId: reservation.publicId,
    customerId: reservation.customerId,
    customerName: reservation.customerName,
    contactToken: reservation.contactToken,
    guestCount: reservation.guestCount,
    arrivalAt: reservation.arrivalAt,
    expectedEndAt: reservation.expectedEndAt,
    status: reservation.status,
    source: reservation.source,
    ownerEmployeeId: reservation.ownerEmployeeId,
    note: reservation.note,
    seatPreference: reservation.seatPreference,
    reservationSnapshot: reservation.reservationSnapshot,
    createdAt: reservation.createdAt,
    updatedAt: reservation.updatedAt,
    aggregateVersion: reservation.aggregateVersion,
    customerCancelUntil: reservation.customerCancelUntil,
    cancellationPolicySnapshot: reservation.cancellationPolicySnapshot,
    requestHoldExpiresAt: reservation.requestHoldExpiresAt,
    arrivalGraceEndsAt: reservation.arrivalGraceEndsAt,
    reservationPolicyVersion: reservation.reservationPolicyVersion,
    tableLocks: reservation.tableLocks.map((lock) => ({
      id: lock.id,
      reservationId: lock.reservationId,
      tableId: lock.tableId,
      startsAt: lock.startsAt,
      endsAt: lock.endsAt,
      status: lock.status,
      holdExpiresAt: lock.holdExpiresAt,
      tableCode: lock.tableCode,
      tableDisplayName: lock.tableDisplayName,
    })),
  }
}

function reservationEventJson(reservation: Reservation): JsonObject {
  return {
    publicId: reservation.publicId,
    guestCount: reservation.guestCount,
    arrivalAt: reservation.arrivalAt,
    expectedEndAt: reservation.expectedEndAt,
    status: reservation.status,
    source: reservation.source,
    seatPreference: reservation.seatPreference,
    aggregateVersion: reservation.aggregateVersion,
    contactAvailable: reservation.contactToken.length > 0,
    tableCodes: reservation.tableLocks.map((lock) => lock.tableCode),
  }
}
