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
  unavailableReason: string | null
}

export interface GuestSharedCart {
  id: string
  publicId: string
  tableSessionId: string
  generation: number
  version: number
  status: 'open' | 'submitting' | 'submitted' | 'expired'
  guestWritesFrozen: boolean
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
  guest_writes_frozen: boolean
}

interface LineRow extends Record<string, unknown> {
  product_id: string
  quantity: number | string
  product_name: string | null
  unit_price_minor: number | string | null
  currency: string | null
  available: boolean
  unavailable_reason: string | null
}

interface OperationRow extends Record<string, unknown> {
  command: string
  payload: JsonObject
}

export interface GuestSharedCartCheckoutTransition {
  submittedCart: GuestSharedCart
  nextCart: GuestSharedCart
}

export class GuestSharedCartVersionConflictError extends Error {
  constructor(readonly latestCart: GuestSharedCart | null = null) {
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

export class GuestSharedCartLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuestSharedCartLimitError'
  }
}

export class GuestSharedCartRateLimitedError extends Error {
  constructor() {
    super('购物车操作过于频繁，请稍候再试')
    this.name = 'GuestSharedCartRateLimitedError'
  }
}

export class GuestSharedCartFrozenError extends Error {
  constructor() {
    super('服务人员正在核对本桌点单，顾客修改已暂时锁定')
    this.name = 'GuestSharedCartFrozenError'
  }
}

const MAX_LINE_QUANTITY = 20
const MAX_CART_QUANTITY = 60
const MAX_CART_AMOUNT_MINOR = 2_000_000
const MAX_WRITES_PER_TEN_SECONDS = 12

export class GuestSharedCartRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async recordWriteAttempt(input:Readonly<{
    tableSessionId:string
    actorSessionRef:string
    operationId:string
    action:'adjust'|'remove'|'clear'|'checkout'
  }>):Promise<boolean>{
    validateOperation(input.operationId,input.actorSessionRef)
    const actorSessionRef=auditActorSessionRef(input.actorSessionRef)
    // Serialize the short sliding window for one table+guest principal. Without
    // this lock a burst of concurrent requests could all count before any of
    // their sibling attempts commits.
    await this.transaction.query(`
      SELECT pg_advisory_xact_lock(hashtextextended(
        $1::uuid::text||':'||$2::uuid::text||':'||$3::uuid::text||':'||$4::text,0
      ))
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,input.tableSessionId,actorSessionRef])
    await this.transaction.query(`
      DELETE FROM mbox.guest_shared_cart_write_attempts
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND occurred_at<clock_timestamp()-interval '1 day'
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId])
    await this.transaction.query(`
      INSERT INTO mbox.guest_shared_cart_write_attempts(
        tenant_id,store_id,table_session_id,actor_session_ref,operation_id,action
      ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6)
    `,[
      this.transaction.scope.tenantId,this.transaction.scope.storeId,input.tableSessionId,
      actorSessionRef,input.operationId,input.action,
    ])
    const recent=await this.transaction.query<{ attempt_count:string }>(`
      SELECT count(*)::text AS attempt_count
      FROM mbox.guest_shared_cart_write_attempts
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND table_session_id=$3::uuid
        AND actor_session_ref=$4 AND occurred_at>clock_timestamp()-interval '10 seconds'
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,input.tableSessionId,actorSessionRef])
    return Number(recent.rows[0]?.attempt_count??0)<=MAX_WRITES_PER_TEN_SECONDS
  }

  async getOrCreateOpen(tableSessionId: string, publicId: string): Promise<GuestSharedCart> {
    const insertOpen = () => this.transaction.query(`
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
    await insertOpen()
    let cart = await this.loadOpenForUpdate(tableSessionId)
    // A checkout may have changed the visible open cart to submitted while this
    // request was waiting on its row lock. Retry creation once after the lock is
    // released so a late positive add can be placed into the next generation.
    if (cart === null) {
      await insertOpen()
      cart = await this.loadOpenForUpdate(tableSessionId)
    }
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
      expectedGeneration: number
      expectedVersion: number
      operationId: string
      actorSessionRef: string
    }>,
  ): Promise<GuestSharedCart> {
    validateAdjust(input)
    const cart = await this.getOrCreateOpen(tableSessionId, publicId)
    // Keep the request fingerprint compatible with operations written before
    // table-session-scoped idempotency was introduced.  The operation id names
    // the logical action; a later retry may legitimately arrive after checkout
    // has advanced the cart generation.
    const payload = { productId: input.productId, delta: input.delta } as JsonObject
    if (await this.isOperationReplay(cart.tableSessionId, input.operationId, 'adjust', payload)) {
      return this.snapshot(cart)
    }
    await this.assertWriteAllowed(cart, input.actorSessionRef)
    const latePositiveAdd = input.delta > 0
      && cart.generation === input.expectedGeneration + 1
      && cart.version === 0
      && await this.wasSubmittedGeneration(cart.tableSessionId, input.expectedGeneration)
    if (!latePositiveAdd) this.assertExpectedState(cart, input.expectedGeneration, input.expectedVersion)
    const current = await this.transaction.query<LineRow>(`
      SELECT product_id,quantity
      FROM mbox.guest_shared_cart_lines
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND cart_id=$3::uuid AND product_id=$4::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, cart.id, input.productId])
    const nextQuantity = Number(current.rows[0]?.quantity ?? 0) + input.delta
    if (nextQuantity < 0) {
      throw new GuestSharedCartVersionConflictError(cart)
    }
    if (nextQuantity > MAX_LINE_QUANTITY) {
      throw new GuestSharedCartLimitError(`单个商品最多可加入${MAX_LINE_QUANTITY}件`)
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
    await this.assertCartLimits(cart.id)
    const version = await this.incrementVersion(cart)
    await this.appendOperation(cart, {
      command: 'adjust', operationId: input.operationId, actorSessionRef: auditActorSessionRef(input.actorSessionRef),
      expectedVersion: input.expectedVersion, resultingVersion: version, payload,
    })
    return this.snapshot({ ...cart, version })
  }

  async clear(
    tableSessionId: string,
    publicId: string,
    input: Readonly<{
      expectedGeneration: number
      expectedVersion: number
      operationId: string
      actorSessionRef: string
    }>,
  ): Promise<GuestSharedCart> {
    validateClear(input)
    const cart = await this.getOrCreateOpen(tableSessionId, publicId)
    const payload = {} as JsonObject
    if (await this.isOperationReplay(cart.tableSessionId, input.operationId, 'clear', payload)) {
      return this.snapshot(cart)
    }
    await this.assertWriteAllowed(cart, input.actorSessionRef)
    this.assertExpectedState(cart, input.expectedGeneration, input.expectedVersion)
    const deleted = await this.transaction.query(`
      DELETE FROM mbox.guest_shared_cart_lines
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND cart_id=$3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, cart.id])
    // Clearing an already-empty cart is a valid, idempotent no-op.  It still
    // records the command so a retry cannot be mistaken for a later clear.
    const version = (deleted.rowCount ?? 0) > 0
      ? await this.incrementVersion(cart)
      : cart.version
    await this.appendOperation(cart, {
      command: 'clear', operationId: input.operationId, actorSessionRef: auditActorSessionRef(input.actorSessionRef),
      expectedVersion: input.expectedVersion, resultingVersion: version, payload,
    })
    return this.snapshot({ ...cart, version })
  }

  async removeLine(
    tableSessionId:string,
    publicId:string,
    input:Readonly<{
      productId:string
      expectedGeneration:number
      expectedVersion:number
      operationId:string
      actorSessionRef:string
    }>,
  ):Promise<GuestSharedCart> {
    validateRemove(input)
    const cart=await this.getOrCreateOpen(tableSessionId,publicId)
    const payload={ productId:input.productId } as JsonObject
    if (await this.isOperationReplay(cart.tableSessionId,input.operationId,'remove',payload)) {
      return this.snapshot(cart)
    }
    await this.assertWriteAllowed(cart,input.actorSessionRef)
    this.assertExpectedState(cart,input.expectedGeneration,input.expectedVersion)
    const deleted=await this.transaction.query(`
      DELETE FROM mbox.guest_shared_cart_lines
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND cart_id=$3::uuid AND product_id=$4::uuid
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,cart.id,input.productId])
    // Removing an unpriced line can make the remaining cart priceable again.
    // Recheck the authoritative amount cap before committing so an attacker
    // cannot hide an over-limit priced basket behind one stale-price line.
    await this.assertCartLimits(cart.id)
    const version=(deleted.rowCount??0)>0?await this.incrementVersion(cart):cart.version
    await this.appendOperation(cart,{
      command:'remove',operationId:input.operationId,
      actorSessionRef:auditActorSessionRef(input.actorSessionRef),
      expectedVersion:input.expectedVersion,resultingVersion:version,payload,
    })
    return this.snapshot({ ...cart,version })
  }

  async beginCheckout(
    tableSessionId: string,
    publicId: string,
    input: Readonly<{
      expectedGeneration: number
      expectedVersion: number
      operationId: string
      actorSessionRef: string
    }>,
  ): Promise<GuestSharedCart> {
    validateOperation(input.operationId, input.actorSessionRef)
    const cart = await this.getOrCreateOpen(tableSessionId, publicId)
    const payload = {} as JsonObject
    if (await this.isOperationReplay(cart.tableSessionId, input.operationId, 'submit', payload)) {
      return this.snapshot(cart)
    }
    await this.assertWriteAllowed(cart, input.actorSessionRef)
    this.assertExpectedState(cart, input.expectedGeneration, input.expectedVersion)
    await this.assertCartLimits(cart.id)
    const withLines = await this.snapshot(cart)
    if (withLines.lines.length === 0) throw new GuestSharedCartEmptyError()
    if (withLines.lines.some((line) => !line.available)) {
      throw new GuestSharedCartLimitError('购物车中有暂不可售商品，请处理后再结账')
    }
    const update = await this.transaction.query<{ version: number | string }>(`
      UPDATE mbox.guest_shared_carts
      SET status='submitting',version=version+1,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='open' AND version=$4::bigint
      RETURNING version
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, cart.id, input.expectedVersion])
    if (!update.rows[0]) throw new GuestSharedCartVersionConflictError(withLines)
    return { ...withLines, version: Number(update.rows[0].version), status: 'submitting' }
  }

  async completeCheckout(
    cart: Readonly<GuestSharedCart>,
    input: Readonly<{
      orderId: string
      expectedVersion: number
      operationId: string
      actorSessionRef: string
      nextCartPublicId: string
    }>,
  ): Promise<GuestSharedCartCheckoutTransition> {
    const update = await this.transaction.query<{ version: number | string }>(`
      UPDATE mbox.guest_shared_carts
      SET status='submitted',submitted_order_id=$4::uuid,submitted_at=clock_timestamp(),version=version+1,
        updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='submitting' AND version=$5::bigint
      RETURNING version
    `,[
      this.transaction.scope.tenantId,this.transaction.scope.storeId,cart.id,input.orderId,cart.version,
    ])
    if (!update.rows[0]) throw new GuestSharedCartVersionConflictError(cart)
    const version = Number(update.rows[0].version)
    await this.appendOperation(cart, {
      command: 'submit', operationId: input.operationId, actorSessionRef: auditActorSessionRef(input.actorSessionRef),
      expectedVersion: input.expectedVersion, resultingVersion: version,
      payload: {},
    })
    const submittedCart = { ...cart, version, status: 'submitted' as const }
    await this.transaction.query(`
      INSERT INTO mbox.guest_shared_carts(
        tenant_id,store_id,table_session_id,public_id,generation,status
      ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::integer,'open')
      ON CONFLICT(tenant_id,store_id,table_session_id) WHERE status='open' DO NOTHING
    `, [
      this.transaction.scope.tenantId,this.transaction.scope.storeId,cart.tableSessionId,
      input.nextCartPublicId,cart.generation+1,
    ])
    const next = await this.loadOpenForUpdate(cart.tableSessionId)
    if (!next || next.generation !== cart.generation + 1 || next.version !== 0) {
      throw new Error('结账后下一代共享购物车未能原子建立')
    }
    return { submittedCart, nextCart: await this.snapshot(next) }
  }

  private async loadOpenForUpdate(tableSessionId: string): Promise<Omit<GuestSharedCart, 'lines' | 'totalAmountMinor' | 'currency'> | null> {
    const result = await this.transaction.query<CartRow>(`
      SELECT cart.id,cart.public_id,cart.table_session_id,cart.generation,cart.version,
        cart.status,cart.updated_at::text,session.guest_cart_writes_frozen AS guest_writes_frozen
      FROM mbox.guest_shared_carts cart
      JOIN mbox.table_sessions session
        ON session.tenant_id=cart.tenant_id AND session.store_id=cart.store_id
       AND session.id=cart.table_session_id AND session.status='open'
      WHERE cart.tenant_id=$1::uuid AND cart.store_id=$2::uuid
        AND cart.table_session_id=$3::uuid AND cart.status='open'
      ORDER BY cart.generation DESC
      LIMIT 1
      FOR UPDATE OF cart
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, tableSessionId])
    const row = result.rows[0]
    return row === undefined ? null : {
      id: row.id, publicId: row.public_id, tableSessionId: row.table_session_id,
      generation: Number(row.generation), version: Number(row.version), status: row.status,
      guestWritesFrozen: row.guest_writes_frozen, updatedAt: row.updated_at,
    }
  }

  private async snapshot(cart: Omit<GuestSharedCart, 'lines' | 'totalAmountMinor' | 'currency'>): Promise<GuestSharedCart> {
    const lines = await this.transaction.query<LineRow>(`
      SELECT line.product_id,line.quantity,product.name AS product_name,
        price.amount_minor AS unit_price_minor,price.currency,
        CASE
          WHEN product.id IS NULL OR product.status<>'active' THEN '商品已下架'
          WHEN NOT product.guest_visible OR NOT ('guest_qr'=ANY(product.allowed_channels)) THEN '当前商品暂不对顾客开放'
          WHEN price.amount_minor IS NULL THEN '商品价格待确认'
          WHEN product.inventory_control_mode='tracked' AND NOT inventory_state.configuration_complete
            THEN '商品配方正在更新'
          WHEN product.inventory_control_mode='tracked' AND NOT inventory_state.available
            THEN '当前库存不足'
          WHEN NOT (
            product.available_from IS NULL OR product.available_until IS NULL
            OR (product.available_from < product.available_until
              AND (clock_timestamp() AT TIME ZONE store.timezone)::time >= product.available_from
              AND (clock_timestamp() AT TIME ZONE store.timezone)::time < product.available_until)
            OR (product.available_from >= product.available_until
              AND ((clock_timestamp() AT TIME ZONE store.timezone)::time >= product.available_from
                OR (clock_timestamp() AT TIME ZONE store.timezone)::time < product.available_until))
          ) THEN '当前不在可售时间'
          ELSE NULL
        END AS unavailable_reason,
        COALESCE(product.status='active'
          AND product.guest_visible
          AND 'guest_qr'=ANY(product.allowed_channels)
          AND price.amount_minor IS NOT NULL
          AND (product.inventory_control_mode<>'tracked' OR (
            inventory_state.configuration_complete AND inventory_state.available
          ))
          AND (
            product.available_from IS NULL OR product.available_until IS NULL
            OR (product.available_from < product.available_until
              AND (clock_timestamp() AT TIME ZONE store.timezone)::time >= product.available_from
              AND (clock_timestamp() AT TIME ZONE store.timezone)::time < product.available_until)
            OR (product.available_from >= product.available_until
              AND ((clock_timestamp() AT TIME ZONE store.timezone)::time >= product.available_from
                OR (clock_timestamp() AT TIME ZONE store.timezone)::time < product.available_until))
          ),false) AS available
      FROM mbox.guest_shared_cart_lines AS line
      LEFT JOIN mbox.products AS product
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
      LEFT JOIN LATERAL (
        SELECT
          CASE WHEN count(*)=0 THEN product.product_kind<>'bundle'
            WHEN product.product_kind='bundle' AND count(*)<>(
              SELECT count(*) FROM mbox.product_bundle_components expected_component
              WHERE expected_component.tenant_id=product.tenant_id
                AND expected_component.store_id=product.store_id
                AND expected_component.bundle_product_id=product.id
            ) THEN false
            ELSE bool_and(
              required_product.inventory_control_mode='not_managed'
              OR required_product.fulfillment_station NOT IN ('bar','kitchen')
              OR EXISTS (
                SELECT 1 FROM mbox.recipes recipe
                WHERE recipe.tenant_id=product.tenant_id AND recipe.store_id=product.store_id
                  AND recipe.product_id=required_product.product_id
                  AND recipe.status='active' AND recipe.effective_at<=clock_timestamp()
                  AND EXISTS (
                    SELECT 1 FROM mbox.recipe_items component
                    WHERE component.tenant_id=recipe.tenant_id AND component.store_id=recipe.store_id
                      AND component.recipe_id=recipe.id AND component.quantity>0
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM mbox.recipe_items component
                    LEFT JOIN mbox.inventory_items item
                      ON item.tenant_id=component.tenant_id AND item.store_id=component.store_id
                     AND item.id=component.inventory_item_id
                    LEFT JOIN mbox.inventory_balances balance
                      ON balance.tenant_id=component.tenant_id AND balance.store_id=component.store_id
                     AND balance.inventory_item_id=component.inventory_item_id
                    WHERE component.tenant_id=recipe.tenant_id AND component.store_id=recipe.store_id
                      AND component.recipe_id=recipe.id
                      AND (component.quantity<=0 OR component.expected_waste_quantity<0
                        OR item.id IS NULL OR item.status<>'active' OR balance.id IS NULL)
                  )
              )
            ) END AS configuration_complete,
          CASE WHEN count(*)=0 THEN false
            WHEN product.product_kind='bundle' AND count(*)<>(
              SELECT count(*) FROM mbox.product_bundle_components expected_component
              WHERE expected_component.tenant_id=product.tenant_id
                AND expected_component.store_id=product.store_id
                AND expected_component.bundle_product_id=product.id
            ) THEN false
            ELSE bool_and(
              required_product.inventory_control_mode='not_managed'
              OR required_product.fulfillment_station NOT IN ('bar','kitchen')
              OR EXISTS (
                SELECT 1 FROM mbox.recipes recipe
                WHERE recipe.tenant_id=product.tenant_id AND recipe.store_id=product.store_id
                  AND recipe.product_id=required_product.product_id
                  AND recipe.status='active' AND recipe.effective_at<=clock_timestamp()
                  AND EXISTS (
                    SELECT 1 FROM mbox.recipe_items component
                    WHERE component.tenant_id=recipe.tenant_id AND component.store_id=recipe.store_id
                      AND component.recipe_id=recipe.id AND component.quantity>0
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM mbox.recipe_items component
                    LEFT JOIN mbox.inventory_items item
                      ON item.tenant_id=component.tenant_id AND item.store_id=component.store_id
                     AND item.id=component.inventory_item_id
                    LEFT JOIN mbox.inventory_balances balance
                      ON balance.tenant_id=component.tenant_id AND balance.store_id=component.store_id
                     AND balance.inventory_item_id=component.inventory_item_id
                    WHERE component.tenant_id=recipe.tenant_id AND component.store_id=recipe.store_id
                      AND component.recipe_id=recipe.id
                      AND (component.quantity<=0 OR component.expected_waste_quantity<0
                        OR item.id IS NULL OR item.status<>'active' OR balance.id IS NULL
                        OR balance.on_hand_quantity-balance.reserved_quantity
                          < ((component.quantity+component.expected_waste_quantity)
                            * required_product.multiplier * line.quantity
                            / recipe.yield_quantity::numeric))
                  )
              )
            ) AND NOT EXISTS (
              SELECT 1
              FROM (
                SELECT recipe_component.inventory_item_id,
                  sum(
                    (recipe_component.quantity+recipe_component.expected_waste_quantity)
                    * aggregate_product.multiplier * line.quantity
                    / aggregate_recipe.yield_quantity::numeric
                  ) AS required_quantity
                FROM (
                  SELECT product.id AS product_id,product.fulfillment_station,
                    product.inventory_control_mode,1::numeric AS multiplier
                  WHERE product.product_kind<>'bundle'
                  UNION ALL
                  SELECT component_product.id,component_product.fulfillment_station,
                    component_product.inventory_control_mode,bundle_component.quantity::numeric
                  FROM mbox.product_bundle_components bundle_component
                  JOIN mbox.products component_product
                    ON component_product.tenant_id=bundle_component.tenant_id
                   AND component_product.store_id=bundle_component.store_id
                   AND component_product.id=bundle_component.component_product_id
                  WHERE bundle_component.tenant_id=product.tenant_id
                    AND bundle_component.store_id=product.store_id
                    AND bundle_component.bundle_product_id=product.id
                    AND product.product_kind='bundle'
                    AND component_product.status='active'
                ) aggregate_product
                JOIN LATERAL (
                  SELECT recipe.id,recipe.yield_quantity
                  FROM mbox.recipes recipe
                  WHERE recipe.tenant_id=product.tenant_id AND recipe.store_id=product.store_id
                    AND recipe.product_id=aggregate_product.product_id
                    AND recipe.status='active' AND recipe.effective_at<=clock_timestamp()
                  ORDER BY recipe.effective_at DESC,recipe.id DESC LIMIT 1
                ) aggregate_recipe
                  ON aggregate_product.inventory_control_mode='tracked'
                 AND aggregate_product.fulfillment_station IN ('bar','kitchen')
                JOIN mbox.recipe_items recipe_component
                  ON recipe_component.tenant_id=product.tenant_id
                 AND recipe_component.store_id=product.store_id
                 AND recipe_component.recipe_id=aggregate_recipe.id
                GROUP BY recipe_component.inventory_item_id
              ) aggregate_requirement
              LEFT JOIN mbox.inventory_items aggregate_item
                ON aggregate_item.tenant_id=product.tenant_id
               AND aggregate_item.store_id=product.store_id
               AND aggregate_item.id=aggregate_requirement.inventory_item_id
              LEFT JOIN mbox.inventory_balances aggregate_balance
                ON aggregate_balance.tenant_id=product.tenant_id
               AND aggregate_balance.store_id=product.store_id
               AND aggregate_balance.inventory_item_id=aggregate_requirement.inventory_item_id
              WHERE aggregate_item.id IS NULL OR aggregate_item.status<>'active'
                OR aggregate_balance.id IS NULL
                OR aggregate_balance.on_hand_quantity-aggregate_balance.reserved_quantity
                  < aggregate_requirement.required_quantity
            ) END AS available
        FROM (
          SELECT product.id AS product_id,product.fulfillment_station,
            product.inventory_control_mode,1::numeric AS multiplier
          WHERE product.product_kind<>'bundle'
          UNION ALL
          SELECT component_product.id,component_product.fulfillment_station,
            component_product.inventory_control_mode,component.quantity::numeric
          FROM mbox.product_bundle_components component
          JOIN mbox.products component_product
            ON component_product.tenant_id=component.tenant_id
           AND component_product.store_id=component.store_id
           AND component_product.id=component.component_product_id
          WHERE component.tenant_id=product.tenant_id AND component.store_id=product.store_id
            AND component.bundle_product_id=product.id AND product.product_kind='bundle'
            AND component_product.status='active'
        ) required_product
      ) inventory_state ON true
      WHERE line.tenant_id=$1::uuid AND line.store_id=$2::uuid AND line.cart_id=$3::uuid
      ORDER BY line.created_at,line.id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, cart.id])
    const cartWideInventoryShortages=await this.cartWideInventoryShortageProductIds(cart.id)
    const mappedLines = lines.rows.map((line) => {
      const unitPriceMinor = line.unit_price_minor === null ? null : Number(line.unit_price_minor)
      const quantity = Number(line.quantity)
      const cartWideInventoryAvailable=!cartWideInventoryShortages.has(line.product_id)
      const available = line.available&&cartWideInventoryAvailable
        && typeof unitPriceMinor === 'number'
        && Number.isSafeInteger(unitPriceMinor)
        && unitPriceMinor >= 0
      return {
        productId: line.product_id,
        quantity,
        name: line.product_name || '暂不可用商品',
        unitPriceMinor,
        subtotalAmountMinor: available ? unitPriceMinor * quantity : null,
        currency: available ? line.currency : null,
        available,
        unavailableReason: available?null:cartWideInventoryAvailable
          ? line.unavailable_reason||'商品信息正在更新，暂不可结算'
          : '本桌购物车合计库存不足',
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

  private async cartWideInventoryShortageProductIds(cartId:string):Promise<Set<string>> {
    const result=await this.transaction.query<{ product_id:string }>(`
      WITH cart_components AS (
        SELECT line.product_id AS cart_product_id,required_product.product_id,
          required_product.multiplier*line.quantity::numeric AS required_units
        FROM mbox.guest_shared_cart_lines line
        JOIN mbox.products product
          ON product.tenant_id=line.tenant_id AND product.store_id=line.store_id
         AND product.id=line.product_id AND product.status='active'
        CROSS JOIN LATERAL (
          SELECT product.id AS product_id,1::numeric AS multiplier,
            product.fulfillment_station,product.inventory_control_mode
          WHERE product.product_kind<>'bundle'
          UNION ALL
          SELECT component_product.id,component.quantity::numeric,
            component_product.fulfillment_station,component_product.inventory_control_mode
          FROM mbox.product_bundle_components component
          JOIN mbox.products component_product
            ON component_product.tenant_id=component.tenant_id
           AND component_product.store_id=component.store_id
           AND component_product.id=component.component_product_id
           AND component_product.status='active'
          WHERE component.tenant_id=product.tenant_id AND component.store_id=product.store_id
            AND component.bundle_product_id=product.id AND product.product_kind='bundle'
        ) required_product
        WHERE line.tenant_id=$1::uuid AND line.store_id=$2::uuid AND line.cart_id=$3::uuid
          AND required_product.inventory_control_mode='tracked'
          AND required_product.fulfillment_station IN ('bar','kitchen')
      ), recipe_demands AS (
        SELECT component.cart_product_id,recipe_item.inventory_item_id,
          (recipe_item.quantity+recipe_item.expected_waste_quantity)
            *component.required_units/recipe.yield_quantity::numeric AS required_quantity
        FROM cart_components component
        JOIN LATERAL (
          SELECT candidate.id,candidate.yield_quantity
          FROM mbox.recipes candidate
          WHERE candidate.tenant_id=$1::uuid AND candidate.store_id=$2::uuid
            AND candidate.product_id=component.product_id AND candidate.status='active'
            AND candidate.effective_at<=clock_timestamp()
          ORDER BY candidate.effective_at DESC,candidate.id DESC LIMIT 1
        ) recipe ON true
        JOIN mbox.recipe_items recipe_item
          ON recipe_item.tenant_id=$1::uuid AND recipe_item.store_id=$2::uuid
         AND recipe_item.recipe_id=recipe.id
      ), total_demands AS (
        SELECT inventory_item_id,sum(required_quantity) AS required_quantity
        FROM recipe_demands GROUP BY inventory_item_id
      ), shortages AS (
        SELECT demand.inventory_item_id
        FROM total_demands demand
        LEFT JOIN mbox.inventory_items item
          ON item.tenant_id=$1::uuid AND item.store_id=$2::uuid AND item.id=demand.inventory_item_id
        LEFT JOIN mbox.inventory_balances balance
          ON balance.tenant_id=$1::uuid AND balance.store_id=$2::uuid
         AND balance.inventory_item_id=demand.inventory_item_id
        WHERE item.id IS NULL OR item.status<>'active' OR balance.id IS NULL
          OR balance.on_hand_quantity-balance.reserved_quantity<demand.required_quantity
      )
      SELECT DISTINCT demand.cart_product_id AS product_id
      FROM recipe_demands demand JOIN shortages USING(inventory_item_id)
      ORDER BY demand.cart_product_id
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,cartId])
    return new Set(result.rows.map((row)=>row.product_id))
  }

  private async incrementVersion(
    cart: Readonly<Omit<GuestSharedCart, 'lines' | 'totalAmountMinor' | 'currency'>>,
  ): Promise<number> {
    const update = await this.transaction.query<{ version: number | string }>(`
      UPDATE mbox.guest_shared_carts
      SET version=version+1,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='open'
      RETURNING version
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, cart.id])
    if (!update.rows[0]) throw new GuestSharedCartVersionConflictError()
    return Number(update.rows[0].version)
  }

  private async assertWriteAllowed(
    cart: Readonly<Omit<GuestSharedCart, 'lines' | 'totalAmountMinor' | 'currency'>>,
    actorSessionRef: string,
  ): Promise<void> {
    if (cart.guestWritesFrozen) throw new GuestSharedCartFrozenError()
    const recent = await this.transaction.query<{ operation_count: string }>(`
      SELECT count(*)::text AS operation_count
      FROM mbox.guest_shared_cart_operations
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND cart_id=$3::uuid
        AND actor_session_ref=$4 AND occurred_at>clock_timestamp()-interval '10 seconds'
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      cart.id,
      auditActorSessionRef(actorSessionRef),
    ])
    if (Number(recent.rows[0]?.operation_count ?? 0) >= MAX_WRITES_PER_TEN_SECONDS) {
      throw new GuestSharedCartRateLimitedError()
    }
  }

  private async assertCartLimits(cartId: string): Promise<void> {
    const totals = await this.transaction.query<{
      total_quantity: string
      total_amount_minor: string
      all_priced: boolean
    }>(`
      SELECT COALESCE(sum(line.quantity),0)::text AS total_quantity,
        COALESCE(sum(line.quantity*price.amount_minor),0)::text AS total_amount_minor,
        COALESCE(bool_and(price.amount_minor IS NOT NULL),true) AS all_priced
      FROM mbox.guest_shared_cart_lines line
      LEFT JOIN LATERAL (
        SELECT candidate.amount_minor
        FROM mbox.product_prices candidate
        WHERE candidate.tenant_id=line.tenant_id AND candidate.store_id=line.store_id
          AND candidate.product_id=line.product_id AND candidate.price_type='standard'
          AND candidate.valid_from<=clock_timestamp()
          AND (candidate.valid_until IS NULL OR candidate.valid_until>clock_timestamp())
        ORDER BY candidate.valid_from DESC,candidate.id DESC LIMIT 1
      ) price ON true
      WHERE line.tenant_id=$1::uuid AND line.store_id=$2::uuid AND line.cart_id=$3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, cartId])
    const row = totals.rows[0]
    if (Number(row?.total_quantity ?? 0) > MAX_CART_QUANTITY) {
      throw new GuestSharedCartLimitError(`本桌购物车合计最多${MAX_CART_QUANTITY}件`)
    }
    // PostgreSQL SUM ignores NULL.  The priced subtotal is therefore still an
    // authoritative lower bound when another line has lost its current price;
    // never let that unrelated invalid line disable the monetary safety cap.
    if (Number(row?.total_amount_minor ?? 0) > MAX_CART_AMOUNT_MINOR) {
      throw new GuestSharedCartLimitError(`本桌购物车合计金额最多¥${(MAX_CART_AMOUNT_MINOR / 100).toFixed(2)}`)
    }
  }

  private async wasSubmittedGeneration(tableSessionId: string, generation: number): Promise<boolean> {
    const result = await this.transaction.query<{ submitted: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM mbox.guest_shared_carts previous
        WHERE previous.tenant_id=$1::uuid AND previous.store_id=$2::uuid
          AND previous.table_session_id=$3::uuid AND previous.generation=$4::integer
          AND previous.status='submitted'
      ) AS submitted
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      tableSessionId,
      generation,
    ])
    return result.rows[0]?.submitted === true
  }

  private assertExpectedState(
    cart: Readonly<GuestSharedCart>, expectedGeneration: number, expectedVersion: number,
  ): void {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1
      || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0
      || cart.generation !== expectedGeneration || cart.version !== expectedVersion) {
      throw new GuestSharedCartVersionConflictError(cart)
    }
  }

  private async isOperationReplay(
    tableSessionId: string,
    operationId: string,
    command: string,
    payload: JsonObject,
  ): Promise<boolean> {
    const operation = await this.transaction.query<OperationRow>(`
      SELECT command,payload
      FROM mbox.guest_shared_cart_operations
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND table_session_id=$3::uuid AND scope_operation_id=$4
      LIMIT 1
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,tableSessionId,operationId])
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
      command: 'adjust' | 'remove' | 'clear' | 'submit'
      operationId: string
      actorSessionRef: string
      expectedVersion: number
      resultingVersion: number
      payload: JsonObject
    }>,
  ): Promise<unknown> {
    return this.transaction.query(`
      INSERT INTO mbox.guest_shared_cart_operations(
        tenant_id,store_id,cart_id,table_session_id,generation,operation_id,scope_operation_id,
        actor_session_ref,command,
        expected_version,resulting_version,payload
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::integer,$6,$6,$7,$8,$9::bigint,$10::bigint,$11::jsonb)
    `,[
      this.transaction.scope.tenantId,this.transaction.scope.storeId,cart.id,cart.tableSessionId,
      cart.generation,input.operationId,input.actorSessionRef,input.command,input.expectedVersion,
      input.resultingVersion,JSON.stringify(input.payload),
    ])
  }
}

function validateAdjust(input: Readonly<{
  productId: string
  delta: number
  expectedGeneration: number
  expectedVersion: number
  operationId: string
  actorSessionRef: string
}>): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.productId)) {
    throw new TypeError('productId is invalid')
  }
  if (!Number.isSafeInteger(input.delta) || input.delta === 0 || input.delta < -99 || input.delta > 99) {
    throw new TypeError('delta must be a non-zero integer between -99 and 99')
  }
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) {
    throw new TypeError('expectedGeneration is invalid')
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new TypeError('expectedVersion is invalid')
  }
  validateOperation(input.operationId, input.actorSessionRef)
}

function validateClear(input: Readonly<{
  expectedGeneration: number
  expectedVersion: number
  operationId: string
  actorSessionRef: string
}>): void {
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) {
    throw new TypeError('expectedGeneration is invalid')
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new TypeError('expectedVersion is invalid')
  }
  validateOperation(input.operationId, input.actorSessionRef)
}

function validateRemove(input:Readonly<{
  productId:string;expectedGeneration:number;expectedVersion:number;operationId:string;actorSessionRef:string
}>):void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.productId)) {
    throw new TypeError('productId is invalid')
  }
  validateClear(input)
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
