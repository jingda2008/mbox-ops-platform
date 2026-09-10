import { createHash } from 'node:crypto'
import type { JsonObject } from './command-executor.js'
import { OrderRepository } from './order-repository.js'
import type { BundleUnitSelectionInput } from './order-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'
import {MAX_LINE_QUANTITY,MAX_CART_QUANTITY,MAX_CART_AMOUNT_MINOR} from './guest-shared-cart-limits.js'

export interface GuestSharedCartLine {
  productId: string
  portionIds?: readonly string[]
  quantity: number
  name: string
  unitPriceMinor: number | null
  subtotalAmountMinor: number | null
  currency: string | null
  available: boolean
  unavailableReason: string | null
  bundleSelections: readonly BundleUnitSelectionInput[]
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
  portion_ids?: string[]
  quantity: number | string
  product_name: string | null
  unit_price_minor: number | string | null
  currency: string | null
  available: boolean
  unavailable_reason: string | null
  bundle_selections: unknown
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

const MAX_WRITES_PER_TEN_SECONDS = 12

export class GuestSharedCartRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async recordWriteAttempt(input:Readonly<{
    tableSessionId:string
    actorSessionRef:string
    operationId:string
    action:'adjust'|'replace_selection'|'remove'|'clear'|'checkout'
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

  /** Optional recommendation reads must not create a cart or take its write
   * lock. Discard a torn snapshot rather than offering against mixed versions. */
  async findCurrentOpen(tableSessionId:string):Promise<GuestSharedCart|null>{
    const cart=await this.loadOpenForUpdate(tableSessionId,false)
    if(!cart)return null
    const snapshot=await this.snapshot(cart)
    const current=await this.transaction.query<{version:number|string;guest_writes_frozen:boolean}>(`
      SELECT cart.version,session.guest_cart_writes_frozen AS guest_writes_frozen FROM mbox.guest_shared_carts cart
      JOIN mbox.table_sessions session ON session.tenant_id=cart.tenant_id AND session.store_id=cart.store_id AND session.id=cart.table_session_id
      WHERE cart.tenant_id=$1 AND cart.store_id=$2 AND cart.id=$3 AND cart.status='open' AND session.status='open'`,[this.transaction.scope.tenantId,this.transaction.scope.storeId,cart.id])
    return current.rows[0]&&Number(current.rows[0].version)===cart.version&&current.rows[0].guest_writes_frozen===cart.guestWritesFrozen?snapshot:null
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
      bundleSelections?: readonly BundleUnitSelectionInput[]
    }>,
  ): Promise<GuestSharedCart> {
    validateAdjust(input)
    const cart = await this.getOrCreateOpen(tableSessionId, publicId)
    // Keep the request fingerprint compatible with operations written before
    // table-session-scoped idempotency was introduced.  The operation id names
    // the logical action; a later retry may legitimately arrive after checkout
    // has advanced the cart generation.
    const addedSelections=input.bundleSelections??[]
    if(input.delta<=0&&addedSelections.length>0)throw new TypeError('减少商品时不能提交套餐选项')
    if(input.delta>0&&addedSelections.length!==input.delta) {
      // Ordinary products use an empty selection array. Custom bundles are
      // checked authoritatively below, so only reject a partial non-empty set.
      if(addedSelections.length>0)throw new TypeError('每份新增套餐都必须分别提交一组选择')
    }
    const payload = { productId: input.productId, delta: input.delta,
      ...(addedSelections.length>0?{ bundleSelections:bundleSelectionsToJson(addedSelections) }:{}), } as JsonObject
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
      SELECT product_id,quantity,bundle_selections
      FROM mbox.guest_shared_cart_lines
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND cart_id=$3::uuid AND product_id=$4::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, cart.id, input.productId])
    const nextQuantity = Number(current.rows[0]?.quantity ?? 0) + input.delta
    const currentSelections=normalizeStoredBundleSelections(current.rows[0]?.bundle_selections)
    const nextSelections=input.delta>0
      ? [...currentSelections,...addedSelections]
      : currentSelections.slice(0,Math.max(0,currentSelections.length+input.delta))
    if (nextQuantity < 0) {
      throw new GuestSharedCartVersionConflictError(cart)
    }
    if (nextQuantity > MAX_LINE_QUANTITY) {
      throw new GuestSharedCartLimitError(`单个商品最多可加入${MAX_LINE_QUANTITY}件`)
    }
    if (nextQuantity > 0) {
      await new OrderRepository(this.transaction).assertCurrentOrderable([
        { productId: input.productId, quantity: nextQuantity, bundleSelections:nextSelections },
      ], 'guest_qr')
    }
    if (nextQuantity === 0) {
      await this.transaction.query(`
        DELETE FROM mbox.guest_shared_cart_lines
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND cart_id=$3::uuid AND product_id=$4::uuid
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, cart.id, input.productId])
    } else {
      await this.transaction.query(`
        INSERT INTO mbox.guest_shared_cart_lines(
          tenant_id,store_id,cart_id,product_id,quantity,bundle_selections
        ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::integer,$6::jsonb)
        ON CONFLICT (tenant_id,store_id,cart_id,product_id)
        DO UPDATE SET quantity=EXCLUDED.quantity,bundle_selections=EXCLUDED.bundle_selections,
          updated_at=clock_timestamp()
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, cart.id,
        input.productId, nextQuantity,JSON.stringify(nextSelections)])
    }
    await this.assertCartLimits(cart.id)
    const {version,updatedAt} = await this.incrementVersion(cart)
    await this.appendOperation(cart, {
      command: 'adjust', operationId: input.operationId, actorSessionRef: auditActorSessionRef(input.actorSessionRef),
      expectedVersion: input.expectedVersion, resultingVersion: version, payload,
    })
    return this.snapshot({ ...cart, version,updatedAt })
  }

  /** Internal cart mutation only: callers must independently verify an accepted
   * recommendation and re-quote benefits. This never authorizes an order or price.
   * Retire exactly the chosen identity, not the last unit of a same-product line. */
  async replacePortionProduct(tableSessionId:string,publicId:string,input:Readonly<{
    productId:string;portionId:string;targetProductId:string;
    bundleSelection?:BundleUnitSelectionInput;
    expectedGeneration:number;expectedVersion:number;operationId:string;actorSessionRef:string;
  }>):Promise<GuestSharedCart>{
    validateRemove(input)
    validateRemove({...input,productId:input.targetProductId})
    if(input.targetProductId===input.productId)throw new TypeError('替换商品必须不同；修改选项请使用原份次编辑')
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.portionId))throw new TypeError('portionId is invalid')
    const cart=await this.getOrCreateOpen(tableSessionId,publicId)
    const payload={productId:input.productId,portionId:input.portionId,targetProductId:input.targetProductId,
      ...(input.bundleSelection?{bundleSelection:bundleSelectionsToJson([input.bundleSelection])[0]!}:{})} as JsonObject
    if(await this.isOperationReplay(tableSessionId,input.operationId,'replace_portion',payload))return this.snapshot(cart)
    await this.assertWriteAllowed(cart,input.actorSessionRef)
    this.assertExpectedState(cart,input.expectedGeneration,input.expectedVersion)
    const source=cart.lines.find(line=>line.productId===input.productId)
    const index=source?.portionIds?.indexOf(input.portionId)??-1
    if(!source||index<0||source.portionIds?.length!==source.quantity)throw new GuestSharedCartVersionConflictError(cart)
    const target=cart.lines.find(line=>line.productId===input.targetProductId)
    const targetQuantity=(target?.quantity??0)+1
    if(targetQuantity>MAX_LINE_QUANTITY)throw new GuestSharedCartLimitError(`单个商品最多可加入${MAX_LINE_QUANTITY}件`)
    const targetSelections=[...(target?.bundleSelections??[]),...(input.bundleSelection?[input.bundleSelection]:[])]
    await new OrderRepository(this.transaction).assertCurrentOrderable([{productId:input.targetProductId,quantity:targetQuantity,bundleSelections:targetSelections}],'guest_qr')
    const scope=[this.transaction.scope.tenantId,this.transaction.scope.storeId,cart.id]
    await this.transaction.query(`UPDATE mbox.guest_shared_cart_portions SET removed_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND cart_id=$3 AND id=$4 AND removed_at IS NULL`,[...scope,input.portionId])
    if(source.quantity===1){
      await this.transaction.query('DELETE FROM mbox.guest_shared_cart_lines WHERE tenant_id=$1 AND store_id=$2 AND cart_id=$3 AND product_id=$4',[...scope,input.productId])
    }else{
      await this.transaction.query(`UPDATE mbox.guest_shared_cart_lines SET quantity=quantity-1,bundle_selections=$5::jsonb,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND store_id=$2 AND cart_id=$3 AND product_id=$4`,[...scope,input.productId,JSON.stringify(source.bundleSelections.filter((_,position)=>position!==index))])
    }
    await this.transaction.query(`INSERT INTO mbox.guest_shared_cart_lines(tenant_id,store_id,cart_id,product_id,quantity,bundle_selections)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,store_id,cart_id,product_id)
      DO UPDATE SET quantity=EXCLUDED.quantity,bundle_selections=EXCLUDED.bundle_selections,updated_at=clock_timestamp()`,[...scope,input.targetProductId,targetQuantity,JSON.stringify(targetSelections)])
    await this.assertCartLimits(cart.id)
    const {version,updatedAt}=await this.incrementVersion(cart)
    const result=await this.snapshot({...cart,version,updatedAt})
    if(result.lines.some(line=>!line.available))throw new GuestSharedCartLimitError('替换后的商品或库存已变化，请重新确认；原购物车保持不变')
    await this.appendOperation(cart,{command:'replace_portion',operationId:input.operationId,actorSessionRef:auditActorSessionRef(input.actorSessionRef),expectedVersion:input.expectedVersion,resultingVersion:version,payload})
    return result
  }

  async replaceBundleSelection(
    tableSessionId:string,
    publicId:string,
    input:Readonly<{
      productId:string
      unitIndex:number
      portionId?:string
      bundleSelection:BundleUnitSelectionInput
      expectedGeneration:number
      expectedVersion:number
      operationId:string
      actorSessionRef:string
    }>,
  ):Promise<GuestSharedCart>{
    validateReplaceBundleSelection(input)
    const cart=await this.getOrCreateOpen(tableSessionId,publicId)
    const payload={
      productId:input.productId,
      unitIndex:input.unitIndex,
      bundleSelection:bundleSelectionsToJson([input.bundleSelection])[0]!,
      ...(input.portionId?{portionId:input.portionId}:{}),
    } as JsonObject
    if(await this.isOperationReplay(cart.tableSessionId,input.operationId,'replace_selection',payload)){
      return this.snapshot(cart)
    }
    await this.assertWriteAllowed(cart,input.actorSessionRef)
    this.assertExpectedState(cart,input.expectedGeneration,input.expectedVersion)
    const current=await this.transaction.query<LineRow>(`
      SELECT product_id,quantity,bundle_selections,
        ARRAY(SELECT p.id::text FROM mbox.guest_shared_cart_portions p
          WHERE p.tenant_id=$1::uuid AND p.store_id=$2::uuid
            AND p.line_id=guest_shared_cart_lines.id AND p.removed_at IS NULL
          ORDER BY p.ordinal) AS portion_ids
      FROM mbox.guest_shared_cart_lines
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND cart_id=$3::uuid AND product_id=$4::uuid
      FOR UPDATE
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,cart.id,input.productId])
    const line=current.rows[0]
    const quantity=Number(line?.quantity??0)
    const currentSelections=normalizeStoredBundleSelections(line?.bundle_selections)
    if(!line||currentSelections.length!==quantity||input.unitIndex>=quantity
      ||(input.portionId!==undefined&&line.portion_ids?.[input.unitIndex]!==input.portionId)){
      throw new GuestSharedCartVersionConflictError(await this.snapshot(cart))
    }
    const nextSelections=currentSelections.map((selection,index)=>(
      index===input.unitIndex?input.bundleSelection:selection
    ))
    await new OrderRepository(this.transaction).assertCurrentOrderable([{
      productId:input.productId,quantity,bundleSelections:nextSelections,
    }],'guest_qr')
    await this.transaction.query(`
      UPDATE mbox.guest_shared_cart_lines
      SET bundle_selections=$5::jsonb,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND cart_id=$3::uuid AND product_id=$4::uuid
    `,[this.transaction.scope.tenantId,this.transaction.scope.storeId,cart.id,input.productId,
      JSON.stringify(nextSelections)])
    await this.assertCartLimits(cart.id)
    const {version,updatedAt}=await this.incrementVersion(cart)
    await this.appendOperation(cart,{
      command:'replace_selection',operationId:input.operationId,
      actorSessionRef:auditActorSessionRef(input.actorSessionRef),
      expectedVersion:input.expectedVersion,resultingVersion:version,payload,
    })
    return this.snapshot({ ...cart,version,updatedAt })
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
    const {version,updatedAt} = (deleted.rowCount ?? 0) > 0
      ? await this.incrementVersion(cart)
      : cart
    await this.appendOperation(cart, {
      command: 'clear', operationId: input.operationId, actorSessionRef: auditActorSessionRef(input.actorSessionRef),
      expectedVersion: input.expectedVersion, resultingVersion: version, payload,
    })
    return this.snapshot({ ...cart, version,updatedAt })
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
    const {version,updatedAt}=(deleted.rowCount??0)>0?await this.incrementVersion(cart):cart
    await this.appendOperation(cart,{
      command:'remove',operationId:input.operationId,
      actorSessionRef:auditActorSessionRef(input.actorSessionRef),
      expectedVersion:input.expectedVersion,resultingVersion:version,payload,
    })
    return this.snapshot({ ...cart,version,updatedAt })
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

  private async loadOpenForUpdate(tableSessionId: string,lock=true): Promise<Omit<GuestSharedCart, 'lines' | 'totalAmountMinor' | 'currency'> | null> {
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
      ${lock?'FOR UPDATE OF cart':''}
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
      SELECT line.product_id,line.quantity,line.bundle_selections,product.name AS product_name,
        ARRAY(SELECT portion.id::text FROM mbox.guest_shared_cart_portions portion WHERE portion.tenant_id=line.tenant_id AND portion.store_id=line.store_id AND portion.line_id=line.id AND portion.removed_at IS NULL ORDER BY portion.ordinal) AS portion_ids,
        price.amount_minor AS unit_price_minor,price.currency,
        CASE
          WHEN product.id IS NULL OR product.status<>'active' THEN '商品已下架'
          WHEN NOT product.guest_visible OR NOT ('guest_qr'=ANY(product.allowed_channels)) THEN '当前商品暂不对顾客开放'
          WHEN price.amount_minor IS NULL THEN '商品价格待确认'
          WHEN product.product_kind='bundle' AND NOT selection_state.valid
            THEN '套餐选择已变更，请重新选择'
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
          AND (product.product_kind<>'bundle' OR selection_state.valid)
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
        SELECT CASE
          WHEN product.product_kind<>'bundle' THEN jsonb_array_length(line.bundle_selections)=0
          WHEN NOT EXISTS (
            SELECT 1 FROM mbox.product_bundle_choice_groups choice_group
            WHERE choice_group.tenant_id=product.tenant_id
              AND choice_group.store_id=product.store_id
              AND choice_group.bundle_product_id=product.id
          ) THEN jsonb_array_length(line.bundle_selections)=0
          WHEN jsonb_array_length(line.bundle_selections)<>line.quantity THEN false
          ELSE NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(line.bundle_selections) selected_unit
            WHERE (
              SELECT count(*) FROM jsonb_array_elements(selected_unit.value->'groups')
            )<>(
              SELECT count(*) FROM mbox.product_bundle_choice_groups choice_group
              WHERE choice_group.tenant_id=product.tenant_id
                AND choice_group.store_id=product.store_id
                AND choice_group.bundle_product_id=product.id
            ) OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(selected_unit.value->'groups') selected_group
              LEFT JOIN mbox.product_bundle_choice_groups choice_group
                ON choice_group.tenant_id=product.tenant_id
               AND choice_group.store_id=product.store_id
               AND choice_group.bundle_product_id=product.id
               AND choice_group.id::text=selected_group.value->>'groupId'
              WHERE choice_group.id IS NULL
                OR jsonb_array_length(selected_group.value->'productIds')<>choice_group.selection_count
                OR (
                  SELECT count(DISTINCT selected_product.value)
                  FROM jsonb_array_elements_text(selected_group.value->'productIds') selected_product
                )<>choice_group.selection_count
                OR EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements_text(selected_group.value->'productIds') selected_product
                  LEFT JOIN mbox.product_bundle_choice_options choice_option
                    ON choice_option.tenant_id=product.tenant_id
                   AND choice_option.store_id=product.store_id
                   AND choice_option.choice_group_id=choice_group.id
                   AND choice_option.component_product_id::text=selected_product.value
                  WHERE choice_option.id IS NULL
                )
            )
          )
        END AS valid
      ) selection_state ON true
      LEFT JOIN LATERAL (
        SELECT
          CASE WHEN count(*)=0 THEN product.product_kind<>'bundle'
            WHEN product.product_kind='bundle' AND count(*)<>(
              SELECT count(*) FROM mbox.product_bundle_components expected_component
              WHERE expected_component.tenant_id=product.tenant_id
                AND expected_component.store_id=product.store_id
                AND expected_component.bundle_product_id=product.id
            ) + (
              SELECT count(*) FROM jsonb_array_elements(line.bundle_selections) selected_unit
              CROSS JOIN LATERAL jsonb_array_elements(selected_unit.value->'groups') selected_group
              CROSS JOIN LATERAL jsonb_array_elements_text(selected_group.value->'productIds') selected_product
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
            ) + (
              SELECT count(*) FROM jsonb_array_elements(line.bundle_selections) selected_unit
              CROSS JOIN LATERAL jsonb_array_elements(selected_unit.value->'groups') selected_group
              CROSS JOIN LATERAL jsonb_array_elements_text(selected_group.value->'productIds') selected_product
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
                  UNION ALL
                  SELECT option_product.id,option_product.fulfillment_station,
                    option_product.inventory_control_mode,
                    choice_option.quantity::numeric/line.quantity::numeric
                  FROM jsonb_array_elements(line.bundle_selections) selected_unit
                  CROSS JOIN LATERAL jsonb_array_elements(selected_unit.value->'groups') selected_group
                  CROSS JOIN LATERAL jsonb_array_elements_text(selected_group.value->'productIds') selected_product
                  JOIN mbox.product_bundle_choice_options choice_option
                    ON choice_option.tenant_id=product.tenant_id AND choice_option.store_id=product.store_id
                   AND choice_option.choice_group_id=(selected_group.value->>'groupId')::uuid
                   AND choice_option.component_product_id=selected_product.value::uuid
                  JOIN mbox.products option_product
                    ON option_product.tenant_id=choice_option.tenant_id
                   AND option_product.store_id=choice_option.store_id
                   AND option_product.id=choice_option.component_product_id
                  WHERE product.product_kind='bundle' AND option_product.status='active'
                    AND option_product.guest_visible
                    AND 'guest_qr'=ANY(option_product.allowed_channels)
                    AND (option_product.available_from IS NULL OR option_product.available_until IS NULL
                      OR (option_product.available_from<option_product.available_until
                        AND (clock_timestamp() AT TIME ZONE store.timezone)::time>=option_product.available_from
                        AND (clock_timestamp() AT TIME ZONE store.timezone)::time<option_product.available_until)
                      OR (option_product.available_from>=option_product.available_until
                        AND ((clock_timestamp() AT TIME ZONE store.timezone)::time>=option_product.available_from
                          OR (clock_timestamp() AT TIME ZONE store.timezone)::time<option_product.available_until)))
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
          UNION ALL
          SELECT option_product.id,option_product.fulfillment_station,
            option_product.inventory_control_mode,
            choice_option.quantity::numeric/line.quantity::numeric
          FROM jsonb_array_elements(line.bundle_selections) selected_unit
          CROSS JOIN LATERAL jsonb_array_elements(selected_unit.value->'groups') selected_group
          CROSS JOIN LATERAL jsonb_array_elements_text(selected_group.value->'productIds') selected_product
          JOIN mbox.product_bundle_choice_options choice_option
            ON choice_option.tenant_id=product.tenant_id AND choice_option.store_id=product.store_id
           AND choice_option.choice_group_id=(selected_group.value->>'groupId')::uuid
           AND choice_option.component_product_id=selected_product.value::uuid
          JOIN mbox.products option_product
            ON option_product.tenant_id=choice_option.tenant_id
           AND option_product.store_id=choice_option.store_id
           AND option_product.id=choice_option.component_product_id
          WHERE product.product_kind='bundle' AND option_product.status='active'
            AND option_product.guest_visible
            AND 'guest_qr'=ANY(option_product.allowed_channels)
            AND (option_product.available_from IS NULL OR option_product.available_until IS NULL
              OR (option_product.available_from<option_product.available_until
                AND (clock_timestamp() AT TIME ZONE store.timezone)::time>=option_product.available_from
                AND (clock_timestamp() AT TIME ZONE store.timezone)::time<option_product.available_until)
              OR (option_product.available_from>=option_product.available_until
                AND ((clock_timestamp() AT TIME ZONE store.timezone)::time>=option_product.available_from
                  OR (clock_timestamp() AT TIME ZONE store.timezone)::time<option_product.available_until)))
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
        bundleSelections:normalizeStoredBundleSelections(line.bundle_selections),
        portionIds:line.portion_ids??[],
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
        UNION ALL
        SELECT line.product_id,option_product.id,choice_option.quantity::numeric
        FROM mbox.guest_shared_cart_lines line
        JOIN mbox.products product
          ON product.tenant_id=line.tenant_id AND product.store_id=line.store_id
         AND product.id=line.product_id AND product.status='active' AND product.product_kind='bundle'
        CROSS JOIN LATERAL jsonb_array_elements(line.bundle_selections) selected_unit
        CROSS JOIN LATERAL jsonb_array_elements(selected_unit.value->'groups') selected_group
        CROSS JOIN LATERAL jsonb_array_elements_text(selected_group.value->'productIds') selected_product
        JOIN mbox.product_bundle_choice_options choice_option
          ON choice_option.tenant_id=product.tenant_id AND choice_option.store_id=product.store_id
         AND choice_option.choice_group_id=(selected_group.value->>'groupId')::uuid
         AND choice_option.component_product_id=selected_product.value::uuid
        JOIN mbox.products option_product
          ON option_product.tenant_id=choice_option.tenant_id
         AND option_product.store_id=choice_option.store_id
         AND option_product.id=choice_option.component_product_id
         AND option_product.status='active'
         AND option_product.inventory_control_mode='tracked'
         AND option_product.fulfillment_station IN ('bar','kitchen')
        WHERE line.tenant_id=$1::uuid AND line.store_id=$2::uuid AND line.cart_id=$3::uuid
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
  ): Promise<{version:number;updatedAt:string}> {
    const update = await this.transaction.query<{ version: number | string;updated_at:string }>(`
      UPDATE mbox.guest_shared_carts
      SET version=version+1,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='open'
      RETURNING version,updated_at::text
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, cart.id])
    if (!update.rows[0]) throw new GuestSharedCartVersionConflictError()
    return {version:Number(update.rows[0].version),updatedAt:update.rows[0].updated_at}
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
      command: 'adjust' | 'replace_selection' | 'replace_portion' | 'remove' | 'clear' | 'submit'
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

function validateReplaceBundleSelection(input:Readonly<{
  productId:string;unitIndex:number;portionId?:string;bundleSelection:BundleUnitSelectionInput;
  expectedGeneration:number;expectedVersion:number;operationId:string;actorSessionRef:string
}>):void{
  validateRemove(input)
  if(input.portionId!==undefined&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.portionId)){
    throw new TypeError('portionId is invalid')
  }
  if(!Number.isSafeInteger(input.unitIndex)||input.unitIndex<0||input.unitIndex>=MAX_LINE_QUANTITY){
    throw new TypeError('unitIndex is invalid')
  }
  if(!input.bundleSelection||!Array.isArray(input.bundleSelection.groups)
    ||input.bundleSelection.groups.length<1){
    throw new TypeError('bundleSelection is invalid')
  }
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

function normalizeStoredBundleSelections(value:unknown):BundleUnitSelectionInput[]{
  if(!Array.isArray(value))return []
  return value.flatMap((unit)=>{
    if(typeof unit!=='object'||unit===null||Array.isArray(unit))return []
    const groups=(unit as Record<string,unknown>).groups
    if(!Array.isArray(groups))return []
    const normalized=groups.flatMap((group)=>{
      if(typeof group!=='object'||group===null||Array.isArray(group))return []
      const record=group as Record<string,unknown>
      if(typeof record.groupId!=='string'||!Array.isArray(record.productIds)
        ||!record.productIds.every((productId)=>typeof productId==='string'))return []
      return [{ groupId:record.groupId,productIds:record.productIds as string[] }]
    })
    return normalized.length===groups.length?[{ groups:normalized }]:[]
  })
}

function bundleSelectionsToJson(selections:readonly BundleUnitSelectionInput[]):JsonObject[]{
  return selections.map((unit)=>({ groups:unit.groups.map((group)=>({
    groupId:group.groupId,productIds:[...group.productIds],
  })) }))
}

function auditActorSessionRef(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}
