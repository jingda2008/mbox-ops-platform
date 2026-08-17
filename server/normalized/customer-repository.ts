import type {
  AuditActor,
  CommandExecution,
  JsonCodec,
  JsonObject,
} from './command-executor.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'

export type CustomerIdentityKind = 'anonymous' | 'wechat' | 'member' | 'manual'
export type CustomerStatus = 'active' | 'merged' | 'blocked' | 'deleted'
export type CustomerPreferenceVisibility = 'public' | 'staff'

export interface CustomerProfileInput {
  displayName?: string | null
  tags?: readonly string[]
  publicTags?: readonly string[]
  preferences?: JsonObject
  publicPreferenceKeys?: readonly string[]
}

export interface CustomerProfile {
  displayName: string | null
  tags: string[]
  publicTags: string[]
  preferences: JsonObject
  publicPreferences: JsonObject
}

export interface CustomerIdentitySummary {
  kind: CustomerIdentityKind
  status: 'active' | 'revoked'
  linkedAt: string
}

export interface Customer {
  id: string
  publicId: string
  status: CustomerStatus
  mergedIntoCustomerId: string | null
  firstSeenAt: string
  lastSeenAt: string
  profile: CustomerProfile
  identities: CustomerIdentitySummary[]
}

export interface PublicCustomer {
  publicId: string
  displayName: string | null
  tags: string[]
  preferences: JsonObject
  firstSeenAt: string
}

export interface CustomerHistoryEvent {
  id: string
  eventType: string
  tableSessionId: string | null
  eventData: JsonObject
  occurredAt: string
}

export interface CreateAnonymousCustomerInput {
  publicId: string
  identityHash?: string | null
  profile?: CustomerProfileInput
}

export interface CreateAnonymousCustomerResult {
  customer: Customer
  created: boolean
}

export interface CreateAnonymousCustomerCommand extends CreateAnonymousCustomerInput {
  scope: Readonly<StoreScope>
  actor: AuditActor
  businessDate: string
  idempotencyKey: string
  requestFingerprint: string
}

export interface LinkCustomerIdentityCommand {
  scope: Readonly<StoreScope>
  actor: AuditActor
  businessDate: string
  customerId: string
  identityKind: CustomerIdentityKind
  identityHash: string
  reason: string
  idempotencyKey: string
  requestFingerprint: string
}

export interface UpdateCustomerProfileCommand {
  scope: Readonly<StoreScope>
  actor: AuditActor
  businessDate: string
  customerId: string
  profile: CustomerProfileInput
  reason: string
  idempotencyKey: string
  requestFingerprint: string
}

export interface MergeCustomersCommand {
  scope: Readonly<StoreScope>
  actor: AuditActor
  businessDate: string
  sourceCustomerId: string
  targetCustomerId: string
  reason: string
  idempotencyKey: string
  requestFingerprint: string
}

interface CustomerRow extends Record<string, unknown> {
  id: string
  public_id: string
  status: CustomerStatus
  merged_into_customer_id: string | null
  first_seen_at: string
  last_seen_at: string
  display_name: string | null
  tags: string[] | null
  public_tags: string[] | null
  preferences: JsonObject | null
  public_preferences: JsonObject | null
  identities: CustomerIdentitySummary[] | null
}

interface IdentityOwnerRow extends Record<string, unknown> {
  customer_id: string
}

interface HistoryRow extends Record<string, unknown> {
  id: string
  event_type: string
  table_session_id: string | null
  event_data: JsonObject
  occurred_at: string
}

export class CustomerNotFoundError extends Error {
  constructor(id: string) {
    super(`Customer was not found: ${id}`)
    this.name = 'CustomerNotFoundError'
  }
}

export class CustomerIdentityConflictError extends Error {
  constructor() {
    super('Hashed customer identity is already linked to another customer')
    this.name = 'CustomerIdentityConflictError'
  }
}

export class CustomerMergeConflictError extends Error {
  constructor(sourceId: string, targetId: string) {
    super(`Customer ${sourceId} cannot be merged into ${targetId}`)
    this.name = 'CustomerMergeConflictError'
  }
}

export class CustomerRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async findById(id: string): Promise<Customer | null> {
    const row = await this.selectById(id, false)
    return row === null ? null : mapCustomer(row)
  }

  async findPublicById(id: string): Promise<PublicCustomer | null> {
    const canonical = await this.resolveCanonical(id)
    return toPublicCustomer(canonical)
  }

  async findByPublicId(publicId: string): Promise<Customer | null> {
    const result = await this.transaction.query<CustomerRow>(`${customerSelectSql()}
      AND c.public_id = $3
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId])
    return result.rows[0] === undefined ? null : mapCustomer(result.rows[0])
  }

  async findByIdentity(identityKind: CustomerIdentityKind, identityHash: string): Promise<Customer | null> {
    validateIdentityHash(identityHash)
    await this.lockIdentity(`${identityKind}:${identityHash}`)
    const owner = await this.identityOwner(identityKind, identityHash)
    return owner === null ? null : this.resolveCanonical(owner.customer_id)
  }

  async createAnonymous(
    input: Readonly<CreateAnonymousCustomerInput>,
  ): Promise<CreateAnonymousCustomerResult> {
    validateCreateAnonymous(input)
    const identityHash = input.identityHash ?? null
    await this.lockIdentity(`anonymous:${identityHash ?? input.publicId}`)

    if (identityHash !== null) {
      const owner = await this.identityOwner('anonymous', identityHash)
      if (owner !== null) {
        return { customer: await this.resolveCanonical(owner.customer_id), created: false }
      }
    }
    const existing = await this.findByPublicId(input.publicId)
    if (existing !== null) return { customer: await this.resolveCanonical(existing.id), created: false }

    const inserted = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.customers (
        tenant_id, store_id, public_id
      ) VALUES ($1::uuid, $2::uuid, $3)
      RETURNING id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.publicId])
    const id = requiredId(inserted, 'customer')
    await this.writeProfile(id, input.profile ?? {})
    if (identityHash !== null) await this.insertIdentity(id, 'anonymous', identityHash)
    await this.appendHistory(id, 'customer.created', null, { source: 'anonymous' })
    return { customer: await this.requireById(id), created: true }
  }

  async linkIdentity(
    customerId: string,
    identityKind: CustomerIdentityKind,
    identityHash: string,
  ): Promise<Customer> {
    validateIdentityHash(identityHash)
    await this.lockIdentity(`${identityKind}:${identityHash}`)
    const customer = await this.resolveCanonical(customerId)
    const owner = await this.identityOwner(identityKind, identityHash)
    if (owner !== null) {
      const ownerCustomer = await this.resolveCanonical(owner.customer_id)
      if (ownerCustomer.id !== customer.id) throw new CustomerIdentityConflictError()
      return ownerCustomer
    }
    await this.insertIdentity(customer.id, identityKind, identityHash)
    await this.appendHistory(customer.id, 'customer.identity-linked', null, { identityKind })
    return this.requireById(customer.id)
  }

  async updateProfile(customerId: string, profile: Readonly<CustomerProfileInput>): Promise<Customer> {
    const customer = await this.resolveCanonical(customerId)
    await this.lockCustomer(customer.id)
    await this.writeProfile(customer.id, profile)
    await this.appendHistory(customer.id, 'customer.profile-updated', null, {
      changedFields: profileFields(profile),
    })
    return this.requireById(customer.id)
  }

  async listHistory(customerId: string, limit = 50): Promise<CustomerHistoryEvent[]> {
    const customer = await this.resolveCanonical(customerId)
    const safeLimit = Math.min(Math.max(limit, 1), 200)
    const result = await this.transaction.query<HistoryRow>(`
      WITH RECURSIVE family(id) AS (
        SELECT $3::uuid
        UNION ALL
        SELECT c.id FROM mbox.customers AS c
        JOIN family ON c.merged_into_customer_id = family.id
        WHERE c.tenant_id = $1::uuid AND c.store_id = $2::uuid
      )
      SELECT event.id, event.event_type, event.table_session_id,
        event.event_data, event.occurred_at::text
      FROM mbox.customer_events AS event
      WHERE event.tenant_id = $1::uuid AND event.store_id = $2::uuid
        AND event.customer_id IN (SELECT id FROM family)
      ORDER BY event.occurred_at DESC, event.id DESC
      LIMIT $4::integer
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customer.id, safeLimit])
    return result.rows.map(mapHistory)
  }

  async resolveCanonical(customerId: string): Promise<Customer> {
    const result = await this.transaction.query<CustomerRow>(`
      WITH RECURSIVE chain AS (
        SELECT c.id, c.merged_into_customer_id, 0 AS depth, ARRAY[c.id] AS path
        FROM mbox.customers AS c
        WHERE c.tenant_id = $1::uuid AND c.store_id = $2::uuid AND c.id = $3::uuid
        UNION ALL
        SELECT c.id, c.merged_into_customer_id, chain.depth + 1, chain.path || c.id
        FROM chain
        JOIN mbox.customers AS c
          ON c.tenant_id = $1::uuid AND c.store_id = $2::uuid
         AND c.id = chain.merged_into_customer_id
        WHERE chain.depth < 31 AND NOT c.id = ANY(chain.path)
      )
      ${customerSelectSql('canonical')}
      AND c.id = (
        SELECT id FROM chain ORDER BY depth DESC LIMIT 1
      )
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId])
    if (result.rows[0] === undefined) throw new CustomerNotFoundError(customerId)
    const customer = mapCustomer(result.rows[0])
    if (customer.status === 'merged') throw new CustomerMergeConflictError(customerId, customer.id)
    return customer
  }

  async merge(sourceCustomerId: string, targetCustomerId: string): Promise<Customer> {
    if (sourceCustomerId === targetCustomerId) return this.resolveCanonical(targetCustomerId)
    // Customer-family rewrites and table-location movements both derive
    // authorization/blocker scope from the canonical family.  Serialize them
    // before taking row locks so a movement cannot authorize against one
    // family root and evaluate business blockers against another.
    await this.transaction.query(`SELECT pg_advisory_xact_lock(hashtextextended(
      'table-customer-movement:' || $1::text || ':' || $2::text, 0
    ))`, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    const orderedIds = [sourceCustomerId, targetCustomerId].sort()
    const locked = await this.transaction.query<{ id: string; status: CustomerStatus; merged_into_customer_id: string | null }>(`
      SELECT id, status, merged_into_customer_id
      FROM mbox.customers
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = ANY($3::uuid[])
      ORDER BY id FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderedIds])
    if (locked.rowCount !== 2) throw new CustomerNotFoundError(sourceCustomerId)
    const source = await this.resolveCanonical(sourceCustomerId)
    const target = await this.resolveCanonical(targetCustomerId)
    if (source.id === target.id) return target
    if (source.id !== sourceCustomerId || target.id !== targetCustomerId || target.status !== 'active') {
      throw new CustomerMergeConflictError(sourceCustomerId, targetCustomerId)
    }

    await this.transaction.query(`
      INSERT INTO mbox.customer_tags (tenant_id, store_id, customer_id, tag, visibility, source)
      SELECT tenant_id, store_id, $4::uuid, tag, visibility, 'merge'
      FROM mbox.customer_tags
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND customer_id = $3::uuid
      ON CONFLICT (tenant_id, store_id, customer_id, tag) DO UPDATE
      SET visibility = CASE
        WHEN mbox.customer_tags.visibility = 'public' OR EXCLUDED.visibility = 'public' THEN 'public'
        ELSE 'staff'
      END,
      source = 'merge'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, source.id, target.id])
    await this.transaction.query(`
      INSERT INTO mbox.customer_preferences (
        tenant_id, store_id, customer_id, preference_key, preference_value, visibility, source, observed_at
      )
      SELECT tenant_id, store_id, $4::uuid, preference_key, preference_value, visibility, 'merge', observed_at
      FROM mbox.customer_preferences
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND customer_id = $3::uuid
      ON CONFLICT (tenant_id, store_id, customer_id, preference_key) DO NOTHING
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, source.id, target.id])
    await this.transaction.query(`
      UPDATE mbox.customer_identities SET customer_id = $4::uuid
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND customer_id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, source.id, target.id])
    await this.transaction.query(`
      UPDATE mbox.customers
      SET status = 'merged', merged_into_customer_id = $4::uuid
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid AND status = 'active'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, source.id, target.id])
    await this.transaction.query(`
      UPDATE mbox.customers
      SET first_seen_at = LEAST(first_seen_at, $4::timestamptz),
          last_seen_at = GREATEST(last_seen_at, $5::timestamptz)
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, target.id, source.firstSeenAt, source.lastSeenAt])
    await this.appendHistory(target.id, 'customer.merged', null, { sourceCustomerId: source.id })
    return this.requireById(target.id)
  }

  private async writeProfile(customerId: string, profile: Readonly<CustomerProfileInput>): Promise<void> {
    const publicKeys = new Set(profile.publicPreferenceKeys ?? [])
    await this.transaction.query(`
      INSERT INTO mbox.customer_profiles (
        tenant_id, store_id, customer_id, display_name
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
      ON CONFLICT (tenant_id, store_id, customer_id) DO UPDATE
      SET display_name = COALESCE(EXCLUDED.display_name, mbox.customer_profiles.display_name)
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      customerId,
      normalizeDisplayName(profile.displayName),
    ])
    if (profile.tags !== undefined || profile.publicTags !== undefined) {
      const existing = await this.transaction.query<{ tag: string; visibility: 'public' | 'staff' }>(`
        SELECT tag, visibility FROM mbox.customer_tags
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND customer_id = $3::uuid
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId])
      const staffTags = profile.tags === undefined
        ? existing.rows.filter((tag) => tag.visibility === 'staff').map((tag) => tag.tag)
        : normalizeTags(profile.tags)
      const visibleTags = profile.publicTags === undefined
        ? existing.rows.filter((tag) => tag.visibility === 'public').map((tag) => tag.tag)
        : normalizeTags(profile.publicTags)
      const publicTags = new Set(visibleTags)
      const allTags = normalizeTags([...staffTags, ...visibleTags])
      await this.transaction.query(`
        DELETE FROM mbox.customer_tags
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND customer_id = $3::uuid
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId])
      for (const tag of allTags) {
        await this.transaction.query(`
          INSERT INTO mbox.customer_tags (tenant_id, store_id, customer_id, tag, visibility)
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
          ON CONFLICT (tenant_id, store_id, customer_id, tag) DO NOTHING
        `, [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          customerId,
          tag,
          publicTags.has(tag) ? 'public' : 'staff',
        ])
      }
    }
    for (const [key, value] of Object.entries(profile.preferences ?? {})) {
      validatePreferenceKey(key)
      await this.transaction.query(`
        INSERT INTO mbox.customer_preferences (
          tenant_id, store_id, customer_id, preference_key, preference_value, visibility
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6)
        ON CONFLICT (tenant_id, store_id, customer_id, preference_key) DO UPDATE
        SET preference_value = EXCLUDED.preference_value,
            visibility = CASE WHEN $7::boolean THEN EXCLUDED.visibility
              ELSE mbox.customer_preferences.visibility END,
            source = 'profile', observed_at = clock_timestamp()
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        customerId,
        key,
        JSON.stringify(value),
        publicKeys.has(key) ? 'public' : 'staff',
        profile.publicPreferenceKeys !== undefined,
      ])
    }
  }

  private async insertIdentity(customerId: string, kind: CustomerIdentityKind, hash: string): Promise<void> {
    const result = await this.transaction.query(`
      INSERT INTO mbox.customer_identities (
        tenant_id, store_id, customer_id, identity_kind, identity_hash
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
      ON CONFLICT (tenant_id, store_id, identity_kind, identity_hash) DO NOTHING
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId, kind, hash])
    if (result.rowCount !== 1) throw new CustomerIdentityConflictError()
  }

  private async identityOwner(kind: CustomerIdentityKind, hash: string): Promise<IdentityOwnerRow | null> {
    const result = await this.transaction.query<IdentityOwnerRow>(`
      SELECT customer_id FROM mbox.customer_identities
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND identity_kind = $3 AND identity_hash = $4 AND status = 'active'
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, kind, hash])
    return result.rows[0] ?? null
  }

  private async appendHistory(
    customerId: string,
    eventType: string,
    tableSessionId: string | null,
    eventData: JsonObject,
  ): Promise<void> {
    await this.transaction.query(`
      INSERT INTO mbox.customer_events (
        tenant_id, store_id, customer_id, event_type, table_session_id, event_data
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::jsonb)
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      customerId,
      eventType,
      tableSessionId,
      JSON.stringify(eventData),
    ])
  }

  private lockIdentity(identity: string): Promise<unknown> {
    return this.transaction.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${this.transaction.scope.tenantId}:${this.transaction.scope.storeId}:${identity}`],
    )
  }

  private async lockCustomer(customerId: string): Promise<void> {
    const result = await this.transaction.query(`
      SELECT id FROM mbox.customers
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customerId])
    if (result.rowCount !== 1) throw new CustomerNotFoundError(customerId)
  }

  private async requireById(id: string): Promise<Customer> {
    const row = await this.selectById(id, false)
    if (row === null) throw new CustomerNotFoundError(id)
    return mapCustomer(row)
  }

  private async selectById(id: string, forUpdate: boolean): Promise<CustomerRow | null> {
    const lock = forUpdate ? 'FOR UPDATE OF c' : ''
    const result = await this.transaction.query<CustomerRow>(`${customerSelectSql()}
      AND c.id = $3::uuid ${lock}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
    return result.rows[0] ?? null
  }
}

export class CustomerCommandService {
  constructor(private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>) {}

  createAnonymous(input: Readonly<CreateAnonymousCustomerCommand>) {
    return this.executeCustomer('customer.create-anonymous', input, async (repository) => {
      const result = await repository.createAnonymous(input)
      return { result, customer: result.customer, action: 'customer.created', changed: result.created }
    }, createCustomerResultCodec)
  }

  linkIdentity(input: Readonly<LinkCustomerIdentityCommand>) {
    requireReason(input.reason, 'identity link reason')
    return this.executeCustomer('customer.link-identity', input, async (repository) => {
      const customer = await repository.linkIdentity(input.customerId, input.identityKind, input.identityHash)
      return { result: customer, customer, action: 'customer.identity-linked', changed: true }
    }, customerCodec)
  }

  updateProfile(input: Readonly<UpdateCustomerProfileCommand>) {
    requireReason(input.reason, 'profile update reason')
    return this.executeCustomer('customer.update-profile', input, async (repository) => {
      const customer = await repository.updateProfile(input.customerId, input.profile)
      return { result: customer, customer, action: 'customer.profile-updated', changed: true }
    }, customerCodec)
  }

  merge(input: Readonly<MergeCustomersCommand>) {
    requireReason(input.reason, 'merge reason')
    return this.executeCustomer('customer.merge', input, async (repository) => {
      const customer = await repository.merge(input.sourceCustomerId, input.targetCustomerId)
      return { result: customer, customer, action: 'customer.merged', changed: true }
    }, customerCodec, input.sourceCustomerId)
  }

  private executeCustomer<Result>(
    operationScope: string,
    input: Readonly<{
      scope: Readonly<StoreScope>
      actor: AuditActor
      businessDate: string
      idempotencyKey: string
      requestFingerprint: string
      reason?: string
    }>,
    operation: (repository: CustomerRepository) => Promise<{
      result: Result
      customer: Customer
      action: string
      changed: boolean
    }>,
    codec: JsonCodec<Result>,
    objectId?: string,
  ): Promise<CommandExecution<Result>> {
    return this.commands.execute({
      scope: input.scope,
      operationScope,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      resultCodec: codec,
    }, async (transaction) => {
      const outcome = await operation(new CustomerRepository(transaction))
      const payload = publicCustomerToJson(toPublicCustomer(outcome.customer))
      return {
        result: outcome.result,
        auditEvents: outcome.changed ? [{
          actor: input.actor,
          action: outcome.action,
          objectType: 'customer',
          objectId: objectId ?? outcome.customer.id,
          businessDate: input.businessDate,
          reason: input.reason,
          afterData: payload,
        }] : [],
        outboxMessages: outcome.changed ? [{
          businessEventKey: `${operationScope}:${input.idempotencyKey}`,
          aggregateType: 'customer',
          aggregateId: outcome.customer.id,
          aggregateVersion: 1,
          eventType: `${outcome.action}.v1`,
          payload,
        }] : [],
      }
    })
  }
}

export function toPublicCustomer(customer: Readonly<Customer>): PublicCustomer {
  return {
    publicId: customer.publicId,
    displayName: customer.profile.displayName,
    tags: customer.profile.publicTags,
    preferences: customer.profile.publicPreferences,
    firstSeenAt: customer.firstSeenAt,
  }
}

const customerCodec: JsonCodec<Customer> = { encode: customerToJson, decode: decodeCustomer }
const createCustomerResultCodec: JsonCodec<CreateAnonymousCustomerResult> = {
  encode: (value) => ({ customer: customerToJson(value.customer), created: value.created }),
  decode: (value) => {
    if (!isObject(value) || typeof value.created !== 'boolean') {
      throw new TypeError('Stored customer creation result is invalid')
    }
    return { customer: decodeCustomer(value.customer), created: value.created }
  },
}

function customerSelectSql(alias = 'c'): string {
  return `
    SELECT c.id, c.public_id, c.status, c.merged_into_customer_id,
      c.first_seen_at::text, c.last_seen_at::text, profile.display_name,
      COALESCE(tags.tags, ARRAY[]::text[]) AS tags,
      COALESCE(tags.public_tags, ARRAY[]::text[]) AS public_tags,
      COALESCE(preferences.preferences, '{}'::jsonb) AS preferences,
      COALESCE(preferences.public_preferences, '{}'::jsonb) AS public_preferences,
      COALESCE(identities.identities, '[]'::jsonb) AS identities
    FROM mbox.customers AS c
    LEFT JOIN mbox.customer_profiles AS profile
      ON profile.tenant_id = c.tenant_id AND profile.store_id = c.store_id
     AND profile.customer_id = c.id
    LEFT JOIN LATERAL (
      SELECT array_agg(tag.tag ORDER BY tag.tag) AS tags,
        array_agg(tag.tag ORDER BY tag.tag)
          FILTER (WHERE tag.visibility = 'public') AS public_tags
      FROM mbox.customer_tags AS tag
      WHERE tag.tenant_id = c.tenant_id AND tag.store_id = c.store_id AND tag.customer_id = c.id
    ) AS tags ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_object_agg(preference.preference_key, preference.preference_value) AS preferences,
        jsonb_object_agg(preference.preference_key, preference.preference_value)
          FILTER (WHERE preference.visibility = 'public') AS public_preferences
      FROM mbox.customer_preferences AS preference
      WHERE preference.tenant_id = c.tenant_id AND preference.store_id = c.store_id
        AND preference.customer_id = c.id
    ) AS preferences ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'kind', identity.identity_kind,
        'status', identity.status,
        'linkedAt', identity.linked_at::text
      ) ORDER BY identity.linked_at, identity.id) AS identities
      FROM mbox.customer_identities AS identity
      WHERE identity.tenant_id = c.tenant_id AND identity.store_id = c.store_id
        AND identity.customer_id = c.id
    ) AS identities ON true
    WHERE c.tenant_id = $1::uuid AND c.store_id = $2::uuid
      ${alias === 'canonical' ? '' : ''}
  `
}

function mapCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    publicId: row.public_id,
    status: row.status,
    mergedIntoCustomerId: row.merged_into_customer_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    profile: {
      displayName: row.display_name,
      tags: row.tags ?? [],
      publicTags: row.public_tags ?? [],
      preferences: row.preferences ?? {},
      publicPreferences: row.public_preferences ?? {},
    },
    identities: row.identities ?? [],
  }
}

function customerToJson(customer: Customer): JsonObject {
  return {
    id: customer.id,
    publicId: customer.publicId,
    status: customer.status,
    mergedIntoCustomerId: customer.mergedIntoCustomerId,
    firstSeenAt: customer.firstSeenAt,
    lastSeenAt: customer.lastSeenAt,
    profile: {
      displayName: customer.profile.displayName,
      tags: customer.profile.tags,
      publicTags: customer.profile.publicTags,
      preferences: customer.profile.preferences,
      publicPreferences: customer.profile.publicPreferences,
    },
    identities: customer.identities.map((identity) => ({
      kind: identity.kind,
      status: identity.status,
      linkedAt: identity.linkedAt,
    })),
  }
}

function publicCustomerToJson(customer: PublicCustomer): JsonObject {
  return { ...customer }
}

function decodeCustomer(value: unknown): Customer {
  if (!isObject(value) || !isObject(value.profile)
    || typeof value.id !== 'string' || typeof value.publicId !== 'string'
    || typeof value.status !== 'string' || typeof value.firstSeenAt !== 'string'
    || typeof value.lastSeenAt !== 'string' || !Array.isArray(value.identities)) {
    throw new TypeError('Stored customer result is invalid')
  }
  return value as unknown as Customer
}

function mapHistory(row: HistoryRow): CustomerHistoryEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    tableSessionId: row.table_session_id,
    eventData: row.event_data,
    occurredAt: row.occurred_at,
  }
}

function requiredId(result: { rowCount: number | null; rows: { id: string }[] }, label: string): string {
  const id = result.rows[0]?.id
  if (result.rowCount !== 1 || id === undefined) throw new Error(`Creating ${label} did not affect one row`)
  return id
}

function validateCreateAnonymous(input: Readonly<CreateAnonymousCustomerInput>): void {
  if (input.publicId.length < 8 || input.publicId.length > 128) {
    throw new TypeError('publicId must contain between 8 and 128 characters')
  }
  if (input.identityHash !== undefined && input.identityHash !== null) validateIdentityHash(input.identityHash)
}

function validateIdentityHash(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError('identityHash must be a lowercase SHA-256 hex digest')
  }
}

function validatePreferenceKey(value: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)) throw new TypeError(`Invalid preference key: ${value}`)
}

function normalizeDisplayName(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const normalized = value.trim()
  return normalized.length === 0 ? null : normalized.slice(0, 128)
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))]
    .map((tag) => tag.slice(0, 64)).sort()
}

function profileFields(profile: Readonly<CustomerProfileInput>): string[] {
  return ['displayName', 'tags', 'publicTags', 'preferences']
    .filter((key) => profile[key as keyof CustomerProfileInput] !== undefined)
}

function requireReason(value: string, label: string): void {
  if (value.trim().length < 2 || value.trim().length > 256) {
    throw new TypeError(`${label} must contain between 2 and 256 characters`)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
