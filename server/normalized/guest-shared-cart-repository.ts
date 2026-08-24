import { createHash } from 'node:crypto'
import type { JsonObject } from './command-executor.js'
import { OrderRepository } from './order-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

export interface GuestSharedCartLine {
  productId: string
  quantity: number
  name: string
  unitPriceMinor: number | null
  subtotalAmountMinor: number | null
  currency: string | null
  available: boolean
}

export interface GuestSharedCart {
  id: string
  publicId: string
  tableSessionId: string
  generation: number
  version: number
  status: 'open' | 'submitting' | 'submitted' | 'expired'
  lines: readonly GuestSharedCartLine[]
  totalAmountMinor: number | null
  currency: string | null
  updatedAt: string
}

interface CartRow extends Record<string, unknown> {
  id: string
  public_id: string
  table_session_id: string
  generation: number | string
  version: number | string
  status: GuestSharedCart['status']
  updated_at: string
}

interface LineRow extends Record<string, unknown> {
  product_id: string
  quantity: number | string
  product_name: string
  unit_price_minor: number | string | null
  currency: string | null
  available: boolean
}

interface OperationRow extends Record<string, unknown> {
  command: string
  payload: JsonObject
}

export class GuestSharedCartVersionConflictError extends Error {
  constructor() {
    super('购物车已由同桌其他顾客更新，请刷新后再操作')
    this.name = 'GuestSharedCartVersionConflictError'
  }
}

export class GuestSharedCartEmptyError extends Error {
  constructor() {
    super('购物车为空，暂不能结账')
    this.name = 'GuestSharedCartEmptyError'
  }
}

export class GuestSharedCartOperationConflictError extends Error {
  constructor() {
    super('同一购物车操作编号不能用于不同内容')
    this.name = 'GuestSharedCartOperationConflictError'
  }
}

export class GuestSharedCartRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async getOrCreateOpen(tableSessionId: string, publicId: string): Promise<GuestSharedCart> {
    await this.transaction.query(`
      INSERT INTO mbox.guest_shared_carts(
        tenant_id,store_id,table_session_id,public_id,generation,status
      )
      SELECT $1::uuid,$2::uuid,$3::uuid,$4,
        COALESCE((
          SELECT MAX(previous.generation) + 1
          FROM mbox.guest_shared_carts AS previous
          WHERE previous.tenant_id=$1::uuid
            AND previous.store_id=$2::uuid
            AND previous.table_session_id=$3::uuid
        ),1),'open'
      ON CONFLICT (tenant_id,store_id,table_session_id) WHERE status='open' DO NOTHING
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, tableSessionId, publicId])
    const cart = await this.loadOpenForUpdate(tableSessionId)
    if (cart === null) throw new Error('共享购物车未能建立')
    return this.snapshot(cart)
  }

  async readOpen(tableSessionId: string, publicId: string): Promise<GuestSharedCart> {
    return this.getOrCreateOpen(tableSessionId, publicId)
  }

  async adjust(
    tableSessionId: string,
    publicId: string,
    input: Readonly<{
      productId: string
      delta: number
      expectedVersion: number
      operationId: string
      actorSessionRef: string
    }>,
  ): Promise<GuestSharedCart> {
    validateAdjust(input)
    const cart = await this.getOrCreateOpen(tableSessionId, publicId)
    const payload = { productId: input.productId, delta: input.delta } as JsonObject
    if (await this.isOperationReplay(cart.id, input.operationId, 'adjust', payload)) {
      return this.snapshot(cart)
    }
    this.assertExpectedVersion(cart, input.expectedVersion)
    const current = await this.transaction.query<LineRow>(`
      SELECT product_id,quantity
      FROM mbox.guest_shared_cart_lines
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND cart_id=$3::uuid AND product_id=$4::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, cart.id, input.productId])
    const nextQuantity = Number(current.rows[0]?.quantity ?? 0) + input.delta
    if (nextQuantity < 0 || nextQuantity > 99) {
      throw new GuestSharedCartVersionConflictError()
    }
    if (nextQuantity > 0) {
      await new OrderRepository(this.transaction).assertCurrentOrderable([
        { productId: input.productId, quantity: nextQuantity },
      ], 'guest_qr')
    }
    if (nextQuantity === 0) {
      await this.transaction.query(`
        DELETE FROM mbox.guest_shared_cart_lines
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND cart_id=$3::uuid AND product_id=$4::uuid
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, cart.id, input.productId])
    } else {
      await this.transaction.query(`
        INSERT INTO mbox.guest_shared_cart_lines(tenant_id,store_id,cart_id,product_id,quantity)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::integer)
        ON CONFLICT (tenant_id,store_id,cart_id,product_id)
        DO UPDATE SET quantity=EXCLUDED.quantity,updated_at=clock_timestamp()
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, cart.id, input.productId, nextQuantity])
    }
    const version = await this.incrementVersion(cart.id)
    await this.appendOperation(cart, {
      command: 'adjust', operationId: input.operationId, actorSessionRef: auditActorSessionRef(input.actorSessionRef),
      expectedVersion: input.expectedVersion, resultingVersion: version, payload,
    })
    return this.snapshot({ ...cart, version })
  }

  async beginCheckout(
    tableSessionId: string,
    publicId: string,
    input: Readonly<{ expectedVersion: number; operationId: string; actorSessionRef: string }>,
  ): Promise<GuestSharedCart> {
    validateOperation(input.operationId, input.actorSessionRef)
    const cart = await this.getOrCreateOpen(tableSessionId, publicId)
    const payload = {} as JsonObject
    if (await this.isOperationReplay(cart.id, input.operationId, 'submit', payload)) return this.snapshot(cart)
    this.assertExpectedVersion(cart, input.expectedVersion)
    const withLines = await this.snapshot(cart)
    if (withLines.lines.length === 0) throw new GuestSharedCartEmptyError()
    const update = await this.transaction.query<{ version: number | string }>(`
      UPDATE mbox.guest_shared_carts
      SET status='submitting',version=version+1,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='open' AND version=$4::bigint
      RETURNING version
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, cart.id, input.expectedVersion])
    if (!update.rows[0]) throw new GuestSharedCartVersionConflictError()
    return { ...withLines, version: Number(update.rows[0].version), status: 'submitting' }
  }

  async completeCheckout(
    cart: Readonly<GuestSharedCart>,
    input: Readonly<{ orderId: string; expectedVersion: number; operationId: string; actorSessionRef: string }>,
  ): Promise<GuestSharedCart> {
    const update = await this.transaction.query<{ version: number | string }>(`
      UPDATE mbox.guest_shared_carts
      SET status='submitted',submitted_order_id=$4::uuid,submitted_at=clock_timestamp(),version=version+1,
        updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='submitting' AND version=$5::bigint
      RETURNING version
    `,[
      this.transaction.scope.tenantId,this.transaction.scope.storeId,cart.id,input.orderId,cart.version,
    ])
    if (!update.rows[0]) throw new GuestSharedCartVersionConflictError()
    const version = Number(update.rows[0].version)
    await this.appendOperation(cart, {
      command: 'submit', operationId: input.operationId, actorSessionRef: auditActorSessionRef(input.actorSessionRef),
      expectedVersion: input.expectedVersion, resultingVersion: version, payload: { orderId: input.orderId },
    })
    return { ...cart, version, status: 'submitted' }
  }

  private async loadOpenForUpdate(tableSessionId: string): Promise<Omit<GuestSharedCart, 'lines' | 'totalAmountMinor' | 'currency'> | null> {
    const result = await this.transaction.query<CartRow>(`
      SELECT id,public_id,table_session_id,generation,version,status,updated_at::text
      FROM mbox.guest_shared_carts
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND table_session_id=$3::uuid AND status='open'
      ORDER BY generation DESC
      LIMIT 1
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, tableSessionId])
    const row = result.rows[0]
    return row === undefined ? null : {
      id: row.id, publicId: row.public_id, tableSessionId: row.table_session_id,
      generation: Number(row.generation), version: Number(row.version), status: row.status,
      updatedAt: row.updated_at,
    }
  }

  private async snapshot(cart: Omit<GuestSharedCart, 'lines' | 'totalAmountMinor' | 'currency'>): Promise<GuestSharedCart> {
    const lines = await this.transaction.query<LineRow>(`
      SELECT line.product_id,line.quantity,product.name AS product_name,
        price.amount_minor AS unit_price_minor,price.currency,
        product.status='active'
          AND product.guest_visible
          AND 'guest_qr'=ANY(product.allowed_channels)
          AND price.amount_minor IS NOT NULL
          AND (
            product.available_from IS NULL OR product.available_until IS NULL
            OR (product.available_from < product.available_until
              AND (clock_timestamp() AT TIME ZONE store.timezone)::time >= product.available_from
              AND (clock_timestamp() AT TIME ZONE store.timezone)::time < product.available_until)
            OR (product.available_from >= product.available_until
              AND ((clock_timestamp() AT TIME ZONE store.timezone)::time >= product.available_from
                OR (clock_timestamp() AT TIME ZONE store.timezone)::time < product.available_until))
          ) AS available
      FROM mbox.guest_shared_cart_lines AS line
      JOIN mbox.products AS product
        ON product.tenant_id=line.tenant_id AND product.store_id=line.store_id AND product.id=line.product_id
      JOIN mbox.stores AS store
        ON store.tenant_id=line.tenant_id AND store.id=line.store_id AND store.status='active'
      LEFT JOIN LATERAL (
        SELECT candidate.amount_minor,candidate.currency
        FROM mbox.product_prices AS candidate
        WHERE candidate.tenant_id=product.tenant_id
          AND candidate.store_id=product.store_id
          AND candidate.product_id=product.id
          AND candidate.price_type='standard'
          AND candidate.valid_from<=clock_timestamp()
          AND (candidate.valid_until IS NULL OR candidate.valid_until>clock_timestamp())
        ORDER BY candidate.valid_from DESC,candidate.id DESC
        LIMIT 1
      ) AS price ON true
      WHERE line.tenant_id=$1::uuid AND line.store_id=$2::uuid AND line.cart_id=$3::uuid
      ORDER BY line.created_at,line.id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, cart.id])
    const mappedLines = lines.rows.map((line) => {
      const unitPriceMinor = line.unit_price_minor === null ? null : Number(line.unit_price_minor)
      const quantity = Number(line.quantity)
      const available = line.available
        && typeof unitPriceMinor === 'number'
        && Number.isSafeInteger(unitPriceMinor)
        && unitPriceMinor >= 0
      return {
        productId: line.product_id,
        quantity,
        name: line.product_name,
        unitPriceMinor,
        subtotalAmountMinor: available ? unitPriceMinor * quantity : null,
        currency: available ? line.currency : null,
        available,
      }
    })
    const currencies = new Set(mappedLines.filter((line) => line.available).map((line) => line.currency))
    const allPriced = mappedLines.every((line) => line.available && line.subtotalAmountMinor !== null)
    return {
      ...cart,
      lines: mappedLines,
      totalAmountMinor: allPriced && currencies.size <= 1
        ? mappedLines.reduce((sum, line) => sum + line.subtotalAmountMinor!, 0)
        : null,
      currency: allPriced && currencies.size === 1 ? [...currencies][0] ?? null : null,
    }
  }

  private async incrementVersion(cartId: string): Promise<number> {
    const update = await this.transaction.query<{ version: number | string }>(`
      UPDATE mbox.guest_shared_carts
      SET version=version+1,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='open'
      RETURNING version
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, cartId])
    if (!update.rows[0]) throw new GuestSharedCartVersionConflictError()
    return Number(update.rows[0].version)
  }

  private assertExpectedVersion(cart: Readonly<GuestSharedCart>, expectedVersion: number): void {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || cart.version !== expectedVersion) {
      throw new GuestSharedCartVersionConflictError()
    }
  }

  private async isOperationReplay(
    cartId: string,
    operationId: string,
    command: string,
    payload: JsonObject,
  ): Promise<boolean> {
    const operation = await this.transaction.query<OperationRow>(`
      SELECT command,payload
      FROM mbox.guest_shared_cart_operations
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND cart_id=$3::uuid AND operation_id=$4
      LIMIT 1
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,cartId,operationId])
    const row = operation.rows[0]
    if (!row) return false
    if (row.command !== command || stableJson(row.payload) !== stableJson(payload)) {
      throw new GuestSharedCartOperationConflictError()
    }
    return true
  }

  private appendOperation(
    cart: Readonly<GuestSharedCart>,
    input: Readonly<{
      command: 'adjust' | 'submit'
      operationId: string
      actorSessionRef: string
      expectedVersion: number
      resultingVersion: number
      payload: JsonObject
    }>,
  ): Promise<unknown> {
    return this.transaction.query(`
      INSERT INTO mbox.guest_shared_cart_operations(
        tenant_id,store_id,cart_id,generation,operation_id,actor_session_ref,command,
        expected_version,resulting_version,payload
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::integer,$5,$6,$7,$8::bigint,$9::bigint,$10::jsonb)
    `,[
      this.transaction.scope.tenantId,this.transaction.scope.storeId,cart.id,cart.generation,input.operationId,
      input.actorSessionRef,input.command,input.expectedVersion,input.resultingVersion,JSON.stringify(input.payload),
    ])
  }
}

function validateAdjust(input: Readonly<{ productId: string; delta: number; expectedVersion: number; operationId: string; actorSessionRef: string }>): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.productId)) {
    throw new TypeError('productId is invalid')
  }
  if (!Number.isSafeInteger(input.delta) || input.delta === 0 || input.delta < -99 || input.delta > 99) {
    throw new TypeError('delta must be a non-zero integer between -99 and 99')
  }
  validateOperation(input.operationId, input.actorSessionRef)
}

function validateOperation(operationId: string, actorSessionRef: string): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(operationId)) throw new TypeError('operationId is invalid')
  if (actorSessionRef.trim().length < 8 || actorSessionRef.length > 180) throw new TypeError('actorSessionRef is invalid')
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

function auditActorSessionRef(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}
