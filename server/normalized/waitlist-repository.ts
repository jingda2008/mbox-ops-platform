import { createHash } from 'node:crypto'
import type {
  AuditActor,
  CommandExecution,
  JsonCodec,
  JsonObject,
} from './command-executor.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'

export type WaitlistStatus = 'waiting' | 'notified' | 'arrived' | 'seated' | 'cancelled' | 'expired'
export type WaitlistSource = 'wechat' | 'phone' | 'walk_in' | 'employee'

export interface ProtectedContact {
  hash: string
  encryptedBase64: string
  keyId: string
  masked: string
}

export interface WaitlistEntry {
  id: string
  publicId: string
  customerId: string | null
  customerName: string
  maskedContact: string
  guestCount: number
  desiredArrivalAt: string
  source: WaitlistSource
  status: WaitlistStatus
  ownerEmployeeId: string | null
  note: string | null
  aggregateVersion: number
  createdAt: string
  updatedAt: string
}

export interface CreateWaitlistInput {
  publicId: string
  customerId?: string | null
  customerName: string
  contact: ProtectedContact
  guestCount: number
  desiredArrivalAt: string
  source: WaitlistSource
  ownerEmployeeId?: string | null
  note?: string | null
}

interface WaitlistRow extends Record<string, unknown> {
  id: string
  public_id: string
  customer_id: string | null
  customer_name: string
  masked_contact: string
  guest_count: number
  desired_arrival_at: string
  source: WaitlistSource
  status: WaitlistStatus
  owner_employee_id: string | null
  note: string | null
  aggregate_version: string | number
  created_at: string
  updated_at: string
}

export class WaitlistNotFoundError extends Error {
  constructor() {
    super('没有找到对应候位记录')
    this.name = 'WaitlistNotFoundError'
  }
}

export class WaitlistTransitionError extends Error {
  constructor(from: WaitlistStatus, to: WaitlistStatus) {
    super(`候位状态不能从${from}变更为${to}`)
    this.name = 'WaitlistTransitionError'
  }
}

export class WaitlistRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async create(input: Readonly<CreateWaitlistInput>): Promise<WaitlistEntry> {
    validateCreate(input)
    const result = await this.transaction.query<WaitlistRow>(`
      INSERT INTO mbox.waitlist_entries (
        tenant_id, store_id, public_id, customer_id, customer_name,
        contact_hash, encrypted_contact, encryption_key_id, masked_contact,
        guest_count, desired_arrival_at, source, owner_employee_id, note
      ) VALUES (
        $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, decode($7, 'base64'), $8, $9,
        $10, $11::timestamptz, $12, $13::uuid, $14
      )
      RETURNING id, public_id, customer_id, customer_name, masked_contact,
        guest_count, desired_arrival_at::text, source, status, owner_employee_id,
        note, aggregate_version, created_at::text, updated_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.publicId,
      input.customerId ?? null,
      input.customerName.trim(),
      input.contact.hash,
      input.contact.encryptedBase64,
      input.contact.keyId,
      input.contact.masked,
      input.guestCount,
      input.desiredArrivalAt,
      input.source,
      input.ownerEmployeeId ?? null,
      input.note?.trim() || null,
    ])
    const entry = mapRow(requiredRow(result.rows[0], 'waitlist create'))
    await this.appendEvent(entry.id, null, entry.status, 'waitlist.created', 'guest', null, null)
    return entry
  }

  async findOwnedByPublicId(publicId: string, customerId: string): Promise<WaitlistEntry | null> {
    const result = await this.transaction.query<WaitlistRow>(`
      SELECT id, public_id, customer_id, customer_name, masked_contact,
        guest_count, desired_arrival_at::text, source, status, owner_employee_id,
        note, aggregate_version, created_at::text, updated_at::text
      FROM mbox.waitlist_entries
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND public_id = $3 AND customer_id = $4::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId, customerId])
    return result.rows[0] ? mapRow(result.rows[0]) : null
  }

  async listForStaff(input: Readonly<{
    ownerEmployeeIds: readonly string[]
    canViewAll: boolean
    from: string
    to: string
    status?: WaitlistStatus | null
  }>): Promise<WaitlistEntry[]> {
    const result = await this.transaction.query<WaitlistRow>(`
      SELECT id, public_id, customer_id, customer_name, masked_contact,
        guest_count, desired_arrival_at::text, source, status, owner_employee_id,
        note, aggregate_version, created_at::text, updated_at::text
      FROM mbox.waitlist_entries
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND desired_arrival_at >= $3::timestamptz AND desired_arrival_at < $4::timestamptz
        AND ($5::text IS NULL OR status = $5)
        AND ($6::boolean OR owner_employee_id = ANY($7::uuid[]))
      ORDER BY
        CASE status WHEN 'arrived' THEN 0 WHEN 'waiting' THEN 1 WHEN 'notified' THEN 2 ELSE 3 END,
        desired_arrival_at, created_at, id
      LIMIT 500
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.from,
      input.to,
      input.status ?? null,
      input.canViewAll,
      [...input.ownerEmployeeIds],
    ])
    return result.rows.map(mapRow)
  }

  async transition(input: Readonly<{
    id: string
    to: WaitlistStatus
    actorType: 'guest' | 'employee' | 'system'
    actorRefHash?: string | null
    reason?: string | null
  }>): Promise<{ entry: WaitlistEntry; changed: boolean }> {
    const selected = await this.transaction.query<WaitlistRow>(`
      SELECT id, public_id, customer_id, customer_name, masked_contact,
        guest_count, desired_arrival_at::text, source, status, owner_employee_id,
        note, aggregate_version, created_at::text, updated_at::text
      FROM mbox.waitlist_entries
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.id])
    const current = selected.rows[0]
    if (!current) throw new WaitlistNotFoundError()
    if (current.status === input.to) return { entry: mapRow(current), changed: false }
    if (!allowedTransition(current.status, input.to)) {
      throw new WaitlistTransitionError(current.status, input.to)
    }
    const updated = await this.transaction.query<WaitlistRow>(`
      UPDATE mbox.waitlist_entries
      SET status = $4, aggregate_version = aggregate_version + 1
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      RETURNING id, public_id, customer_id, customer_name, masked_contact,
        guest_count, desired_arrival_at::text, source, status, owner_employee_id,
        note, aggregate_version, created_at::text, updated_at::text
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.id, input.to])
    const entry = mapRow(requiredRow(updated.rows[0], 'waitlist transition'))
    await this.appendEvent(
      entry.id,
      current.status,
      entry.status,
      `waitlist.${entry.status}`,
      input.actorType,
      input.actorRefHash ?? null,
      input.reason ?? null,
    )
    return { entry, changed: true }
  }

  private async appendEvent(
    id: string,
    from: WaitlistStatus | null,
    to: WaitlistStatus,
    eventType: string,
    actorType: 'guest' | 'employee' | 'system',
    actorRefHash: string | null,
    reason: string | null,
  ): Promise<void> {
    await this.transaction.query(`
      INSERT INTO mbox.waitlist_events (
        tenant_id, store_id, waitlist_entry_id, event_type,
        from_status, to_status, actor_type, actor_ref_hash, reason
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9)
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      id,
      eventType,
      from,
      to,
      actorType,
      actorRefHash,
      reason,
    ])
  }
}

export interface WaitlistCommandInput {
  scope: Readonly<StoreScope>
  actor: AuditActor
  businessDate: string
  idempotencyKey: string
  requestFingerprint: string
}

export class WaitlistCommandService {
  constructor(private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>) {}

  create(input: Readonly<WaitlistCommandInput & CreateWaitlistInput>): Promise<CommandExecution<WaitlistEntry>> {
    return this.commands.execute({
      scope: input.scope,
      operationScope: 'waitlist.create',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      resultCodec: waitlistCodec,
    }, async (transaction) => {
      const entry = await new WaitlistRepository(transaction).create(input)
      return commandOutcome(input, entry, 'waitlist.created')
    })
  }

  transition(input: Readonly<WaitlistCommandInput & {
    entryId: string
    to: WaitlistStatus
    reason?: string | null
  }>): Promise<CommandExecution<WaitlistEntry>> {
    return this.commands.execute({
      scope: input.scope,
      operationScope: `waitlist.${input.to}`,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      resultCodec: waitlistCodec,
    }, async (transaction) => {
      const actorType = input.actor.type === 'employee' ? 'employee' : input.actor.type === 'system' ? 'system' : 'guest'
      const mutation = await new WaitlistRepository(transaction).transition({
        id: input.entryId,
        to: input.to,
        actorType,
        actorRefHash: input.actor.ref === undefined ? null : sha256(input.actor.ref),
        reason: input.reason,
      })
      if (!mutation.changed) return { result: mutation.entry, auditEvents: [], outboxMessages: [] }
      return commandOutcome(input, mutation.entry, `waitlist.${input.to}`)
    })
  }
}

const waitlistCodec: JsonCodec<WaitlistEntry> = {
  encode: (entry) => ({
    id: entry.id,
    publicId: entry.publicId,
    customerId: entry.customerId,
    customerName: entry.customerName,
    maskedContact: entry.maskedContact,
    guestCount: entry.guestCount,
    desiredArrivalAt: entry.desiredArrivalAt,
    source: entry.source,
    status: entry.status,
    ownerEmployeeId: entry.ownerEmployeeId,
    note: entry.note,
    aggregateVersion: entry.aggregateVersion,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }),
  decode: (value) => {
    if (!isObject(value) || typeof value.id !== 'string' || typeof value.publicId !== 'string') {
      throw new TypeError('Stored waitlist result is invalid')
    }
    return value as unknown as WaitlistEntry
  },
}

function commandOutcome(
  input: Readonly<WaitlistCommandInput>,
  entry: WaitlistEntry,
  action: string,
): {
  result: WaitlistEntry
  auditEvents: Array<{
    actor: AuditActor
    action: string
    objectType: string
    objectId: string
    businessDate: string
    reason?: string | null
    afterData: JsonObject
  }>
  outboxMessages: Array<{
    aggregateType: string
    aggregateId: string
    aggregateVersion: number
    eventType: string
    payload: JsonObject
  }>
} {
  const payload: JsonObject = {
    publicId: entry.publicId,
    guestCount: entry.guestCount,
    desiredArrivalAt: entry.desiredArrivalAt,
    source: entry.source,
    status: entry.status,
  }
  return {
    result: entry,
    auditEvents: [{
      actor: input.actor,
      action,
      objectType: 'waitlist_entry',
      objectId: entry.id,
      businessDate: input.businessDate,
      afterData: payload,
    }],
    outboxMessages: [{
      aggregateType: 'waitlist_entry',
      aggregateId: entry.id,
      aggregateVersion: entry.aggregateVersion,
      eventType: `${action}.v1`,
      payload,
    }],
  }
}

function mapRow(row: WaitlistRow): WaitlistEntry {
  return {
    id: row.id,
    publicId: row.public_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    maskedContact: row.masked_contact,
    guestCount: Number(row.guest_count),
    desiredArrivalAt: row.desired_arrival_at,
    source: row.source,
    status: row.status,
    ownerEmployeeId: row.owner_employee_id,
    note: row.note,
    aggregateVersion: Number(row.aggregate_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function allowedTransition(from: WaitlistStatus, to: WaitlistStatus): boolean {
  const allowed: Record<WaitlistStatus, readonly WaitlistStatus[]> = {
    waiting: ['notified', 'arrived', 'cancelled', 'expired'],
    notified: ['arrived', 'cancelled', 'expired'],
    arrived: ['seated', 'cancelled'],
    seated: [],
    cancelled: [],
    expired: [],
  }
  return allowed[from].includes(to)
}

function validateCreate(input: Readonly<CreateWaitlistInput>): void {
  if (input.publicId.length < 8 || input.publicId.length > 128) throw new TypeError('publicId length is invalid')
  if (input.customerName.trim().length < 1 || input.customerName.trim().length > 128) {
    throw new TypeError('customerName length is invalid')
  }
  if (!Number.isInteger(input.guestCount) || input.guestCount < 1 || input.guestCount > 200) {
    throw new TypeError('guestCount must be an integer between 1 and 200')
  }
  if (!Number.isFinite(Date.parse(input.desiredArrivalAt))) throw new TypeError('desiredArrivalAt is invalid')
  if (!/^[0-9a-f]{64}$/.test(input.contact.hash)) throw new TypeError('contact hash is invalid')
  if (input.contact.encryptedBase64.length < 24) throw new TypeError('encrypted contact is invalid')
  if (input.contact.masked.trim().length < 3) throw new TypeError('masked contact is invalid')
}

function requiredRow<Row>(row: Row | undefined, label: string): Row {
  if (!row) throw new Error(`${label} did not return a row`)
  return row
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
