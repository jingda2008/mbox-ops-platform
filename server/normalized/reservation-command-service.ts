import {lockReservationPolicy} from './reservation-policy-lock.js'
import type {
  AuditActor,
  CommandExecution,
  JsonCodec,
  JsonObject,
} from './command-executor.js'
import { hashRequestFingerprint, IdempotencyConflictError, NormalizedCommandExecutor } from './command-executor.js'
import {
  CustomerRepository,
  type CreateAnonymousCustomerInput,
} from './customer-repository.js'
import {
  ReservationRepository,
  type CreateReservationInput,
  type Reservation,
} from './reservation-repository.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'

export interface CreateReservationCommand extends Omit<
  CreateReservationInput,
  'arrivalGraceEndsAt' | 'reservationPolicyVersion'
> {
  scope: Readonly<StoreScope>
  actor: AuditActor
  businessDate: string
  idempotencyKey: string
  requestFingerprint: string
  retireTableBoundCreate?: boolean
  nativeReceipt?: boolean
  authorizeNative?: (transaction: ScopedTransaction) => Promise<void>
  prepareNative?: (transaction: ScopedTransaction) => Promise<Partial<CreateReservationInput>>
  anonymousCustomer?: CreateAnonymousCustomerInput
  arrivalGraceEndsAt?: string
  reservationPolicyVersion?: number
}

export interface ReservationTransitionCommand {
  nativeReceipt?: boolean
  authorizeNative?: (transaction: ScopedTransaction) => Promise<void>
  scope: Readonly<StoreScope>
  actor: AuditActor
  businessDate: string
  reservationId: string
  reason?: string | null
  idempotencyKey: string
  requestFingerprint: string
  overridePolicy?: boolean
}

export class ReservationTablePreassignmentRetiredError extends Error {
  constructor(){super('预约已改为接待名额登记，请更新客户端后重新填写；尚未创建或绑定桌台');this.name='ReservationTablePreassignmentRetiredError'}
}

export class ReservationCommandService {
  constructor(private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>) {}

  create(input: Readonly<CreateReservationCommand>): Promise<CommandExecution<Reservation>> {
    if (input.customerId && input.anonymousCustomer) {
      throw new TypeError('Provide customerId or anonymousCustomer, not both')
    }
    return this.commands.execute({
      scope: input.scope,
      operationScope: input.nativeReceipt ? 'reservation.create.native' : 'reservation.create',
      retainReceipt: input.nativeReceipt === true || input.retireTableBoundCreate === true,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      resultCodec: reservationCodec,
    }, async (transaction) => {
      if(input.retireTableBoundCreate)throw new ReservationTablePreassignmentRetiredError()
      const prepared = input.nativeReceipt ? await input.prepareNative?.(transaction) : undefined
      const anonymous = input.anonymousCustomer === undefined
        ? null
        : await new CustomerRepository(transaction).createAnonymous(input.anonymousCustomer)
      await lockReservationPolicy(transaction)
      const policy = await transaction.query<{ policy_version: number; arrival_grace_minutes: number }>(`
        SELECT policy_version, arrival_grace_minutes
        FROM mbox.public_reservation_policies
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
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
        ...prepared,
        customerId: input.customerId ?? anonymous?.customer.id ?? null,
        requestHoldExpiresAt: prepared?.requestHoldExpiresAt ?? prepared?.holdExpiresAt ?? input.requestHoldExpiresAt ?? input.holdExpiresAt ?? null,
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
    }, async transaction => {
      if(input.nativeReceipt || input.retireTableBoundCreate)await input.authorizeNative?.(transaction)
      if(input.retireTableBoundCreate){
        const operationScope=input.nativeReceipt?'reservation.create.native':'reservation.create'
        const row=(await transaction.query<{request_sha256:string;status:string;response_snapshot:JsonObject}>(`SELECT request_sha256,status,response_snapshot FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND operation_scope=$3 AND idempotency_key=$4 FOR UPDATE`,[input.scope.tenantId,input.scope.storeId,operationScope,input.idempotencyKey])).rows[0]
        if(row?.status==='completed'){
          if(row.request_sha256!==hashRequestFingerprint(input.requestFingerprint))throw new IdempotencyConflictError(operationScope,input.idempotencyKey)
          // Old web fingerprints omitted these two accepted fields. Check them
          // against the original stored result before allowing legacy recovery.
          const original=row.response_snapshot.result
          if(!input.nativeReceipt && (!original || typeof original!=='object' || Array.isArray(original)
            || original.customerId!==(input.customerId??null)
            || original.ownerEmployeeId!==(input.ownerEmployeeId??null)))throw new IdempotencyConflictError(operationScope,input.idempotencyKey)
          await transaction.query("UPDATE mbox.idempotency_records SET expires_at='infinity'::timestamptz WHERE tenant_id=$1 AND store_id=$2 AND operation_scope=$3 AND idempotency_key=$4",[input.scope.tenantId,input.scope.storeId,operationScope,input.idempotencyKey])
        }
      }
    })
  }

  confirm(input: Readonly<ReservationTransitionCommand>): Promise<CommandExecution<Reservation>> {
    return this.transition(input, 'confirm', 'reservation.confirmed')
  }

  arrive(input: Readonly<ReservationTransitionCommand>): Promise<CommandExecution<Reservation>> {
    return this.transition(input, 'arrive', 'reservation.arrived')
  }

  complete(input: Readonly<ReservationTransitionCommand>): Promise<CommandExecution<Reservation>> {
    return this.transition(input, 'complete', 'reservation.completed')
  }

  cancel(input: Readonly<ReservationTransitionCommand>): Promise<CommandExecution<Reservation>> {
    return this.transition(input, 'cancel', 'reservation.cancelled')
  }

  private transition(
    input: Readonly<ReservationTransitionCommand>,
    transition: 'confirm' | 'arrive' | 'complete' | 'cancel',
    eventType: string,
  ): Promise<CommandExecution<Reservation>> {
    return this.commands.execute({
      scope: input.scope,
      operationScope: input.nativeReceipt ? `reservation.${transition}.native` : `reservation.${transition}`,
      retainReceipt: input.nativeReceipt === true,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      resultCodec: reservationCodec,
    }, async (transaction) => {
      const repository = new ReservationRepository(transaction)
      const mutation = transition === 'confirm'
        ? await repository.confirmWithResult(input.reservationId)
        : transition === 'arrive'
          ? await repository.arriveWithResult(input.reservationId)
          : transition === 'complete'
            ? await repository.completeWithResult(input.reservationId)
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
    }, input.nativeReceipt ? input.authorizeNative : undefined)
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
