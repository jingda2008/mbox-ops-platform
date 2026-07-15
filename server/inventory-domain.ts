import type {
  BottleOwner,
  BottleStorageBatch,
  BottleStorageEvent,
  ConfirmStockCountCommand,
  ConsumeInventoryCommand,
  DepositBottleCommand,
  ExpireStoredBottleCommand,
  InventoryAuditEvent,
  InventoryBalance,
  InventoryIngredientSku,
  InventoryDomainResultType,
  InventoryDomainState,
  InventoryMovement,
  InventoryMovementType,
  InventoryOperationPolicy,
  InventoryRecipeVersion,
  InventoryScope,
  PublishRecipeVersionCommand,
  ReceiveInventoryCommand,
  RejectStockCountCommand,
  ReturnInventoryForRefundCommand,
  StockCount,
  SubmitStockCountCommand,
  TransferStoredBottleCommand,
  UpsertIngredientSkuCommand,
  UseStoredBottleCommand,
  VoidStoredBottleCommand,
} from '../src/shared/inventory-contracts.js'

const EMPTY_POLICY: InventoryOperationPolicy = {
  policyAdminRoleIds: [],
  receiptRoleIds: [],
  stockCountRoleIds: [],
  stockCountApprovalRoleIds: [],
  bottleDepositRoleIds: [],
  bottleUseRoleIds: [],
  bottleApprovalRoleIds: [],
}

export function createInventoryDomainState(
  scope: InventoryScope,
  policy: InventoryOperationPolicy = EMPTY_POLICY,
): InventoryDomainState {
  assertNonEmpty(scope.tenantId, '租户ID')
  assertNonEmpty(scope.storeId, '门店ID')
  return {
    ...scope,
    policy: structuredClone(policy),
    stockAlertRules: [],
    ingredientSkus: [],
    recipeVersions: [],
    balances: [],
    movements: [],
    stockCounts: [],
    bottleBatches: [],
    bottleEvents: [],
    auditEvents: [],
    approvalRequests: [],
    idempotencyRecords: [],
  }
}

/** Repairs optional collections from inventory documents persisted before the feature existed. */
export function normalizeInventoryDomainState(state: InventoryDomainState) {
  state.stockAlertRules ??= []
  state.ingredientSkus ??= []
  state.recipeVersions ??= []
  state.approvalRequests ??= []
  return state
}

function assertNonEmpty(value: string, label: string) {
  if (value.trim().length === 0) throw new Error(`${label}不能为空`)
}

function assertTimestamp(value: string, label = '时间') {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label}必须是有效的ISO时间`)
}

function assertBusinessDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error('营业日必须是YYYY-MM-DD格式')
  }
}

function assertUnitCode(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(value)) {
    throw new Error('计量单位代码不合法')
  }
}

function assertPositiveQuantity(value: number, label = '数量') {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}必须是正安全整数`)
}

function assertNonNegativeQuantity(value: number, label = '数量') {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必须是非负安全整数`)
}

function safeAdd(left: number, right: number, label: string) {
  const result = left + right
  if (!Number.isSafeInteger(result)) throw new Error(`${label}超出安全整数范围`)
  return result
}

function safeMultiply(left: number, right: number, label: string) {
  const result = left * right
  if (!Number.isSafeInteger(result)) throw new Error(`${label}超出安全整数范围`)
  return result
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  switch (typeof value) {
    case 'string':
    case 'boolean':
    case 'number':
      return JSON.stringify(value)
    case 'object': {
      const entries = Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`
    }
    default:
      throw new Error('幂等请求包含不支持的数据类型')
  }
}

function resolveResult(state: InventoryDomainState, resultType: InventoryDomainResultType, resultId: string) {
  switch (resultType) {
    case 'inventory_movement':
      return state.movements.find((item) => item.id === resultId)
    case 'stock_count':
      return state.stockCounts.find((item) => item.id === resultId)
    case 'bottle_storage_batch':
      return state.bottleBatches.find((item) => item.id === resultId)
    case 'bottle_storage_event':
      return state.bottleEvents.find((item) => item.id === resultId)
    case 'ingredient_sku':
      return state.ingredientSkus.find((item) => item.id === resultId)
    case 'recipe_version':
      return state.recipeVersions.find((item) => item.id === resultId)
  }
}

function executeIdempotent<T>(
  state: InventoryDomainState,
  key: string,
  operation: string,
  payload: unknown,
  resultType: InventoryDomainResultType,
  execute: () => T,
  resultId: (result: T) => string,
) {
  assertNonEmpty(key, '幂等键')
  const fingerprintPayload = typeof payload === 'object' && payload !== null
    ? Object.fromEntries(Object.entries(payload).filter(([field]) => field !== 'occurredAt'))
    : payload
  const fingerprint = canonicalize(fingerprintPayload)
  const existing = state.idempotencyRecords.find((record) => record.key === key)
  if (existing) {
    if (existing.operation !== operation || existing.fingerprint !== fingerprint) {
      throw new Error('幂等键已用于不同请求')
    }
    const result = resolveResult(state, existing.resultType, existing.resultId)
    if (!result) throw new Error('幂等记录指向的领域对象不存在')
    return result as T
  }

  const result = execute()
  state.idempotencyRecords.push({ key, operation, fingerprint, resultType, resultId: resultId(result) })
  return result
}

function scope(state: InventoryDomainState): InventoryScope {
  return { tenantId: state.tenantId, storeId: state.storeId }
}

function assertMovementContext(
  command: Pick<ReceiveInventoryCommand, 'movementId' | 'productId' | 'unitCode' | 'actorId' | 'reason' | 'businessDate' | 'occurredAt'>,
) {
  assertNonEmpty(command.movementId, '库存流水ID')
  assertNonEmpty(command.productId, '商品ID')
  assertUnitCode(command.unitCode)
  assertNonEmpty(command.actorId, '操作人')
  assertNonEmpty(command.reason, '操作原因')
  assertBusinessDate(command.businessDate)
  assertTimestamp(command.occurredAt)
}

function audit(
  state: InventoryDomainState,
  event: Omit<InventoryAuditEvent, keyof InventoryScope | 'id'>,
) {
  const id = `${event.objectType}:${event.objectId}:${event.action}:${state.auditEvents.length + 1}`
  state.auditEvents.push({ id, ...scope(state), ...event })
}

function balanceFor(state: InventoryDomainState, productId: string) {
  return state.balances.find((item) => item.productId === productId)
}

function applyMovement(
  state: InventoryDomainState,
  draft: Omit<InventoryMovement, keyof InventoryScope | 'balanceAfter'>,
) {
  if (state.movements.some((item) => item.id === draft.id)) throw new Error('库存流水ID已存在')
  const current = balanceFor(state, draft.productId)
  if (current && current.unitCode !== draft.unitCode) throw new Error('商品库存计量单位不一致')
  const currentQuantity = current?.onHandQuantity ?? 0
  const signedQuantity = draft.direction === 'in' ? draft.quantity : -draft.quantity
  const balanceAfter = safeAdd(currentQuantity, signedQuantity, '库存余额')
  if (balanceAfter < 0) throw new Error('库存不足，禁止产生负库存')

  const movement: InventoryMovement = { ...scope(state), ...draft, balanceAfter }
  if (current) {
    current.onHandQuantity = balanceAfter
    current.revision += 1
    current.updatedAt = draft.occurredAt
  } else {
    const balance: InventoryBalance = {
      ...scope(state),
      productId: draft.productId,
      unitCode: draft.unitCode,
      onHandQuantity: balanceAfter,
      revision: 1,
      updatedAt: draft.occurredAt,
    }
    state.balances.push(balance)
  }
  state.movements.push(movement)
  audit(state, {
    action: `inventory.${draft.type}.recorded.v1`,
    objectType: 'inventory_movement',
    objectId: movement.id,
    actorId: movement.actorId,
    approvalId: movement.approvalId,
    tableSessionId: movement.tableSessionId,
    orderId: movement.orderId,
    reason: draft.reason,
    occurredAt: movement.occurredAt,
    details: {
      productId: movement.productId,
      direction: movement.direction,
      quantity: movement.quantity,
      unitCode: movement.unitCode,
      balanceAfter,
      orderItemId: movement.orderItemId,
      refundId: movement.refundId,
      stockCountId: movement.stockCountId,
    },
  })
  return movement
}

export function receiveInventory(state: InventoryDomainState, command: ReceiveInventoryCommand) {
  assertMovementContext(command)
  assertPositiveQuantity(command.quantity)
  return executeIdempotent(
    state,
    command.idempotencyKey,
    'inventory.receive',
    command,
    'inventory_movement',
    () => applyMovement(state, {
      id: command.movementId,
      productId: command.productId,
      unitCode: command.unitCode,
      type: 'receipt',
      direction: 'in',
      quantity: command.quantity,
      tableSessionId: null,
      orderId: null,
      orderItemId: null,
      refundId: null,
      stockCountId: null,
      approvalId: null,
      actorId: command.actorId,
      reason: command.reason,
      businessDate: command.businessDate,
      occurredAt: command.occurredAt,
      configurationSnapshot: command.configurationSnapshot ? structuredClone(command.configurationSnapshot) : null,
    }),
    (result) => result.id,
  )
}

function consumeInventory(
  state: InventoryDomainState,
  command: ConsumeInventoryCommand,
  type: Extract<InventoryMovementType, 'sale' | 'gift' | 'remake'>,
) {
  assertMovementContext(command)
  assertPositiveQuantity(command.quantity)
  assertNonEmpty(command.tableSessionId, '桌台会话ID')
  assertNonEmpty(command.orderId, '订单ID')
  assertNonEmpty(command.orderItemId, '订单明细ID')
  return executeIdempotent(
    state,
    command.idempotencyKey,
    `inventory.consume.${type}`,
    command,
    'inventory_movement',
    () => applyMovement(state, {
      id: command.movementId,
      productId: command.productId,
      unitCode: command.unitCode,
      type,
      direction: 'out',
      quantity: command.quantity,
      tableSessionId: command.tableSessionId,
      orderId: command.orderId,
      orderItemId: command.orderItemId,
      refundId: null,
      stockCountId: null,
      approvalId: null,
      actorId: command.actorId,
      reason: command.reason,
      businessDate: command.businessDate,
      occurredAt: command.occurredAt,
      configurationSnapshot: command.configurationSnapshot ? structuredClone(command.configurationSnapshot) : null,
    }),
    (result) => result.id,
  )
}

export function consumeInventoryForSale(state: InventoryDomainState, command: ConsumeInventoryCommand) {
  return consumeInventory(state, command, 'sale')
}

export function consumeInventoryForGift(state: InventoryDomainState, command: ConsumeInventoryCommand) {
  return consumeInventory(state, command, 'gift')
}

export function consumeInventoryForRemake(state: InventoryDomainState, command: ConsumeInventoryCommand) {
  return consumeInventory(state, command, 'remake')
}

export function returnInventoryForRefund(
  state: InventoryDomainState,
  command: ReturnInventoryForRefundCommand,
) {
  assertMovementContext(command)
  assertPositiveQuantity(command.quantity)
  assertNonEmpty(command.tableSessionId, '桌台会话ID')
  assertNonEmpty(command.orderId, '订单ID')
  assertNonEmpty(command.orderItemId, '订单明细ID')
  assertNonEmpty(command.refundId, '退款ID')
  return executeIdempotent(
    state,
    command.idempotencyKey,
    'inventory.return.refund',
    command,
    'inventory_movement',
    () => applyMovement(state, {
      id: command.movementId,
      productId: command.productId,
      unitCode: command.unitCode,
      type: 'refund',
      direction: 'in',
      quantity: command.quantity,
      tableSessionId: command.tableSessionId,
      orderId: command.orderId,
      orderItemId: command.orderItemId,
      refundId: command.refundId,
      stockCountId: null,
      approvalId: null,
      actorId: command.actorId,
      reason: command.reason,
      businessDate: command.businessDate,
      occurredAt: command.occurredAt,
    }),
    (result) => result.id,
  )
}

export function getInventoryBalance(state: InventoryDomainState, productId: string) {
  assertNonEmpty(productId, '商品ID')
  return balanceFor(state, productId)?.onHandQuantity ?? 0
}

function assertIngredientSku(command: UpsertIngredientSkuCommand) {
  assertNonEmpty(command.ingredientSkuId, '原料SKU ID')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(command.sku)) throw new Error('原料SKU编码不合法')
  assertNonEmpty(command.name, '原料名称')
  assertUnitCode(command.baseUnitCode)
  assertNonNegativeQuantity(command.costAmountPerBaseUnit, '基础单位成本')
  assertNonEmpty(command.actorId, '操作人')
  assertNonEmpty(command.reason, '调整原因')
  assertTimestamp(command.occurredAt)
  if (command.conversions.length === 0) throw new Error('原料至少需要一个单位换算')
  const units = new Set<string>()
  for (const conversion of command.conversions) {
    assertUnitCode(conversion.unitCode)
    assertPositiveQuantity(conversion.baseQuantity, '单位换算数量')
    if (units.has(conversion.unitCode)) throw new Error('单位换算不能包含重复单位')
    units.add(conversion.unitCode)
  }
  if (!command.conversions.some((item) => item.unitCode === command.baseUnitCode && item.baseQuantity === 1)) {
    throw new Error('基础单位换算必须为1')
  }
}

export function upsertIngredientSku(state: InventoryDomainState, command: UpsertIngredientSkuCommand) {
  normalizeInventoryDomainState(state)
  assertIngredientSku(command)
  return executeIdempotent(
    state,
    command.idempotencyKey,
    'inventory.ingredient.upsert',
    command,
    'ingredient_sku',
    () => {
      const duplicate = state.ingredientSkus.find(
        (item) => item.sku.toLowerCase() === command.sku.toLowerCase() && item.id !== command.ingredientSkuId,
      )
      if (duplicate) throw new Error('原料SKU编码已存在')
      const existing = state.ingredientSkus.find((item) => item.id === command.ingredientSkuId)
      const balance = balanceFor(state, command.ingredientSkuId)
      if (existing && balance && existing.baseUnitCode !== command.baseUnitCode) {
        throw new Error('原料已有库存流水，不能修改基础单位')
      }
      const before = existing ? structuredClone(existing) : null
      const ingredient: InventoryIngredientSku = existing ?? {
        ...scope(state),
        id: command.ingredientSkuId,
        sku: command.sku,
        name: command.name,
        baseUnitCode: command.baseUnitCode,
        costAmountPerBaseUnit: command.costAmountPerBaseUnit,
        conversions: [],
        enabled: command.enabled,
        revision: 0,
        createdAt: command.occurredAt,
        updatedAt: command.occurredAt,
        updatedBy: command.actorId,
      }
      Object.assign(ingredient, {
        sku: command.sku,
        name: command.name,
        baseUnitCode: command.baseUnitCode,
        costAmountPerBaseUnit: command.costAmountPerBaseUnit,
        conversions: structuredClone(command.conversions),
        enabled: command.enabled,
        revision: ingredient.revision + 1,
        updatedAt: command.occurredAt,
        updatedBy: command.actorId,
      })
      if (!existing) state.ingredientSkus.push(ingredient)
      audit(state, {
        action: existing ? 'inventory.ingredient.updated.v1' : 'inventory.ingredient.created.v1',
        objectType: 'ingredient_sku',
        objectId: ingredient.id,
        actorId: command.actorId,
        approvalId: null,
        tableSessionId: null,
        orderId: null,
        reason: command.reason,
        occurredAt: command.occurredAt,
        details: { before, after: structuredClone(ingredient) },
      })
      return ingredient
    },
    (result) => result.id,
  )
}

export function publishRecipeVersion(state: InventoryDomainState, command: PublishRecipeVersionCommand) {
  normalizeInventoryDomainState(state)
  assertNonEmpty(command.recipeVersionId, '配方版本ID')
  assertNonEmpty(command.productId, '菜单商品ID')
  assertNonEmpty(command.actorId, '操作人')
  assertNonEmpty(command.reason, '发布原因')
  assertTimestamp(command.occurredAt)
  if (command.lines.length === 0) throw new Error('配方至少需要一种原料')
  const ingredientIds = new Set<string>()
  for (const line of command.lines) {
    assertNonEmpty(line.ingredientSkuId, '配方原料ID')
    assertPositiveQuantity(line.standardQuantity, '标准耗用')
    if (!Number.isSafeInteger(line.allowedLossBps) || line.allowedLossBps < 0 || line.allowedLossBps > 10_000) {
      throw new Error('允许损耗必须在0%到100%之间')
    }
    if (ingredientIds.has(line.ingredientSkuId)) throw new Error('同一配方不能重复配置原料')
    ingredientIds.add(line.ingredientSkuId)
    if (!state.ingredientSkus.some((item) => item.id === line.ingredientSkuId && item.enabled)) {
      throw new Error(`配方引用的原料不存在或已停用：${line.ingredientSkuId}`)
    }
  }
  return executeIdempotent(
    state,
    command.idempotencyKey,
    'inventory.recipe.publish',
    command,
    'recipe_version',
    () => {
      if (state.recipeVersions.some((item) => item.id === command.recipeVersionId)) throw new Error('配方版本ID已存在')
      const previous = state.recipeVersions.filter((item) => item.productId === command.productId)
      const version = Math.max(0, ...previous.map((item) => item.version)) + 1
      previous.filter((item) => item.status === 'active').forEach((item) => { item.status = 'archived' })
      const recipe: InventoryRecipeVersion = {
        ...scope(state),
        id: command.recipeVersionId,
        productId: command.productId,
        version,
        status: 'active',
        lines: structuredClone(command.lines),
        publishedBy: command.actorId,
        publishedAt: command.occurredAt,
        reason: command.reason,
      }
      state.recipeVersions.push(recipe)
      audit(state, {
        action: 'inventory.recipe.published.v1',
        objectType: 'recipe_version',
        objectId: recipe.id,
        actorId: command.actorId,
        approvalId: null,
        tableSessionId: null,
        orderId: null,
        reason: command.reason,
        occurredAt: command.occurredAt,
        details: {
          archivedRecipeIds: previous.filter((item) => item.status === 'archived').map((item) => item.id),
          recipe: structuredClone(recipe),
        },
      })
      return recipe
    },
    (result) => result.id,
  )
}

export function convertIngredientQuantityToBase(
  state: InventoryDomainState,
  ingredientSkuId: string,
  inputUnitCode: string,
  inputQuantity: number,
) {
  normalizeInventoryDomainState(state)
  assertPositiveQuantity(inputQuantity)
  const ingredient = state.ingredientSkus.find((item) => item.id === ingredientSkuId && item.enabled)
  if (!ingredient) throw new Error('原料SKU不存在或已停用')
  const conversion = ingredient.conversions.find((item) => item.unitCode === inputUnitCode)
  if (!conversion) throw new Error(`原料未配置单位换算：${inputUnitCode}`)
  return {
    ingredient,
    conversion,
    baseQuantity: safeMultiply(inputQuantity, conversion.baseQuantity, '换算后入库数量'),
  }
}

function findStockCount(state: InventoryDomainState, countId: string) {
  const count = state.stockCounts.find((item) => item.id === countId)
  if (!count) throw new Error('盘点记录不存在')
  return count
}

export function submitStockCount(state: InventoryDomainState, command: SubmitStockCountCommand) {
  assertNonEmpty(command.countId, '盘点ID')
  assertNonEmpty(command.productId, '商品ID')
  assertUnitCode(command.unitCode)
  assertNonNegativeQuantity(command.countedQuantity, '盘点数量')
  assertNonEmpty(command.countedBy, '盘点人')
  assertBusinessDate(command.businessDate)
  assertTimestamp(command.occurredAt)
  return executeIdempotent(
    state,
    command.idempotencyKey,
    'inventory.stock_count.submit',
    command,
    'stock_count',
    () => {
      if (state.stockCounts.some((item) => item.id === command.countId)) throw new Error('盘点ID已存在')
      const current = balanceFor(state, command.productId)
      if (current && current.unitCode !== command.unitCode) throw new Error('商品库存计量单位不一致')
      const expectedQuantity = current?.onHandQuantity ?? 0
      const differenceQuantity = safeAdd(command.countedQuantity, -expectedQuantity, '盘点差异')
      if (differenceQuantity !== 0 && !command.approvalId?.trim()) {
        throw new Error('盘点差异必须关联审批')
      }
      const count: StockCount = {
        ...scope(state),
        id: command.countId,
        productId: command.productId,
        unitCode: command.unitCode,
        expectedQuantity,
        countedQuantity: command.countedQuantity,
        differenceQuantity,
        status: differenceQuantity === 0 ? 'applied' : 'pending_confirmation',
        countedBy: command.countedBy,
        countedAt: command.occurredAt,
        approvalId: command.approvalId?.trim() || null,
        confirmedBy: null,
        confirmedAt: differenceQuantity === 0 ? command.occurredAt : null,
        decisionReason: differenceQuantity === 0 ? '盘点无差异' : null,
        adjustmentMovementId: null,
        businessDate: command.businessDate,
      }
      state.stockCounts.push(count)
      audit(state, {
        action: differenceQuantity === 0 ? 'inventory.stock_count.applied.v1' : 'inventory.stock_count.submitted.v1',
        objectType: 'stock_count',
        objectId: count.id,
        actorId: command.countedBy,
        approvalId: count.approvalId,
        tableSessionId: null,
        orderId: null,
        reason: differenceQuantity === 0 ? 'no_variance' : 'variance_requires_second_person',
        occurredAt: command.occurredAt,
        details: { expectedQuantity, countedQuantity: command.countedQuantity, differenceQuantity },
      })
      return count
    },
    (result) => result.id,
  )
}

export function confirmStockCount(state: InventoryDomainState, command: ConfirmStockCountCommand) {
  assertNonEmpty(command.countId, '盘点ID')
  assertNonEmpty(command.adjustmentMovementId, '调整流水ID')
  assertNonEmpty(command.approvalId, '审批ID')
  assertNonEmpty(command.confirmedBy, '复核人')
  assertNonEmpty(command.reason, '复核原因')
  assertTimestamp(command.occurredAt)
  return executeIdempotent(
    state,
    command.idempotencyKey,
    'inventory.stock_count.confirm',
    command,
    'stock_count',
    () => {
      const count = findStockCount(state, command.countId)
      if (count.status !== 'pending_confirmation') throw new Error('盘点差异不在待复核状态')
      if (count.approvalId !== command.approvalId) throw new Error('盘点审批ID不匹配')
      if (count.countedBy === command.confirmedBy) throw new Error('盘点人不能复核自己的差异')
      if (Date.parse(command.occurredAt) < Date.parse(count.countedAt)) throw new Error('复核时间不能早于盘点时间')
      const difference = count.differenceQuantity
      const movement = applyMovement(state, {
        id: command.adjustmentMovementId,
        productId: count.productId,
        unitCode: count.unitCode,
        type: difference > 0 ? 'stock_count_gain' : 'stock_count_loss',
        direction: difference > 0 ? 'in' : 'out',
        quantity: Math.abs(difference),
        tableSessionId: null,
        orderId: null,
        orderItemId: null,
        refundId: null,
        stockCountId: count.id,
        approvalId: command.approvalId,
        actorId: command.confirmedBy,
        reason: command.reason,
        businessDate: count.businessDate,
        occurredAt: command.occurredAt,
      })
      count.status = 'applied'
      count.confirmedBy = command.confirmedBy
      count.confirmedAt = command.occurredAt
      count.decisionReason = command.reason
      count.adjustmentMovementId = movement.id
      audit(state, {
        action: 'inventory.stock_count.confirmed.v1',
        objectType: 'stock_count',
        objectId: count.id,
        actorId: command.confirmedBy,
        approvalId: command.approvalId,
        tableSessionId: null,
        orderId: null,
        reason: command.reason,
        occurredAt: command.occurredAt,
        details: { countedBy: count.countedBy, differenceQuantity: difference, adjustmentMovementId: movement.id },
      })
      return count
    },
    (result) => result.id,
  )
}

export function rejectStockCount(state: InventoryDomainState, command: RejectStockCountCommand) {
  assertNonEmpty(command.countId, '盘点ID')
  assertNonEmpty(command.approvalId, '审批ID')
  assertNonEmpty(command.rejectedBy, '复核人')
  assertNonEmpty(command.reason, '拒绝原因')
  assertTimestamp(command.occurredAt)
  return executeIdempotent(
    state,
    command.idempotencyKey,
    'inventory.stock_count.reject',
    command,
    'stock_count',
    () => {
      const count = findStockCount(state, command.countId)
      if (count.status !== 'pending_confirmation') throw new Error('盘点差异不在待复核状态')
      if (count.approvalId !== command.approvalId) throw new Error('盘点审批ID不匹配')
      if (count.countedBy === command.rejectedBy) throw new Error('盘点人不能复核自己的差异')
      if (Date.parse(command.occurredAt) < Date.parse(count.countedAt)) throw new Error('复核时间不能早于盘点时间')
      count.status = 'rejected'
      count.confirmedBy = command.rejectedBy
      count.confirmedAt = command.occurredAt
      count.decisionReason = command.reason
      audit(state, {
        action: 'inventory.stock_count.rejected.v1',
        objectType: 'stock_count',
        objectId: count.id,
        actorId: command.rejectedBy,
        approvalId: command.approvalId,
        tableSessionId: null,
        orderId: null,
        reason: command.reason,
        occurredAt: command.occurredAt,
        details: { countedBy: count.countedBy, differenceQuantity: count.differenceQuantity },
      })
      return count
    },
    (result) => result.id,
  )
}

function assertOwner(owner: BottleOwner) {
  if (owner.kind === 'member') {
    assertNonEmpty(owner.memberId, '会员ID')
    return
  }
  assertNonEmpty(owner.customerRef, '匿名客户引用')
  assertNonEmpty(owner.displayNameSnapshot, '匿名客户显示名')
}

function cloneOwner(owner: BottleOwner): BottleOwner {
  return owner.kind === 'member' ? { kind: 'member', memberId: owner.memberId } : { ...owner }
}

function findBottleBatch(state: InventoryDomainState, batchId: string) {
  const batch = state.bottleBatches.find((item) => item.id === batchId)
  if (!batch) throw new Error('存酒批次不存在')
  return batch
}

function assertBottleOperationContext(
  command: Pick<UseStoredBottleCommand, 'eventId' | 'batchId' | 'actorId' | 'reason' | 'businessDate' | 'occurredAt'>,
) {
  assertNonEmpty(command.eventId, '存酒事件ID')
  assertNonEmpty(command.batchId, '存酒批次ID')
  assertNonEmpty(command.actorId, '操作人')
  assertNonEmpty(command.reason, '操作原因')
  assertBusinessDate(command.businessDate)
  assertTimestamp(command.occurredAt)
}

function assertActiveBottle(batch: BottleStorageBatch, occurredAt: string) {
  if (!['stored', 'partially_used'].includes(batch.status)) throw new Error('当前存酒状态不允许该操作')
  if (Date.parse(occurredAt) < Date.parse(batch.updatedAt)) throw new Error('操作时间不能早于上一状态变更')
  if (Date.parse(occurredAt) >= Date.parse(batch.expiresAt)) throw new Error('存酒已超过保管期限')
}

function addBottleEvent(
  state: InventoryDomainState,
  draft: Omit<BottleStorageEvent, keyof InventoryScope>,
) {
  if (state.bottleEvents.some((item) => item.id === draft.id)) throw new Error('存酒事件ID已存在')
  const event: BottleStorageEvent = { ...scope(state), ...draft }
  state.bottleEvents.push(event)
  return event
}

export function depositBottle(state: InventoryDomainState, command: DepositBottleCommand) {
  assertNonEmpty(command.batchId, '存酒批次ID')
  assertNonEmpty(command.eventId, '存酒事件ID')
  assertNonEmpty(command.productId, '商品ID')
  assertNonEmpty(command.skuSnapshot, 'SKU快照')
  assertNonEmpty(command.productNameSnapshot, '商品名称快照')
  assertOwner(command.owner)
  assertPositiveQuantity(command.capacityQuantity, '存酒容量')
  assertUnitCode(command.unitCode)
  assertTimestamp(command.expiresAt, '保管到期时间')
  assertNonEmpty(command.tableSessionId, '桌台会话ID')
  assertNonEmpty(command.orderId, '订单ID')
  assertNonEmpty(command.orderItemId, '订单明细ID')
  assertNonEmpty(command.actorId, '操作人')
  assertNonEmpty(command.reason, '存酒原因')
  assertBusinessDate(command.businessDate)
  assertTimestamp(command.occurredAt)
  if (Date.parse(command.expiresAt) <= Date.parse(command.occurredAt)) throw new Error('保管期限必须晚于存入时间')
  return executeIdempotent(
    state,
    command.idempotencyKey,
    'bottle_storage.deposit',
    command,
    'bottle_storage_batch',
    () => {
      if (state.bottleBatches.some((item) => item.id === command.batchId)) throw new Error('存酒批次ID已存在')
      if (state.bottleEvents.some((item) => item.id === command.eventId)) throw new Error('存酒事件ID已存在')
      const batch: BottleStorageBatch = {
        ...scope(state),
        id: command.batchId,
        sourceBatchId: null,
        productId: command.productId,
        skuSnapshot: command.skuSnapshot,
        productNameSnapshot: command.productNameSnapshot,
        owner: cloneOwner(command.owner),
        capacityQuantity: command.capacityQuantity,
        remainingQuantity: command.capacityQuantity,
        unitCode: command.unitCode,
        measurementSource: 'manual_confirmation',
        status: 'stored',
        storedAt: command.occurredAt,
        expiresAt: command.expiresAt,
        originalTableSessionId: command.tableSessionId,
        originalOrderId: command.orderId,
        originalOrderItemId: command.orderItemId,
        storedBy: command.actorId,
        depositApprovalId: command.approvalId?.trim() || null,
        revision: 1,
        updatedAt: command.occurredAt,
      }
      state.bottleBatches.push(batch)
      addBottleEvent(state, {
        id: command.eventId,
        batchId: batch.id,
        relatedBatchId: null,
        type: 'deposit',
        quantity: batch.capacityQuantity,
        remainingAfter: batch.remainingQuantity,
        unitCode: batch.unitCode,
        tableSessionId: command.tableSessionId,
        orderId: command.orderId,
        orderItemId: command.orderItemId,
        actorId: command.actorId,
        approvalId: batch.depositApprovalId,
        approvedBy: null,
        reason: command.reason,
        businessDate: command.businessDate,
        occurredAt: command.occurredAt,
      })
      audit(state, {
        action: 'bottle_storage.deposited.v1',
        objectType: 'bottle_storage_batch',
        objectId: batch.id,
        actorId: command.actorId,
        approvalId: batch.depositApprovalId,
        tableSessionId: command.tableSessionId,
        orderId: command.orderId,
        reason: command.reason,
        occurredAt: command.occurredAt,
        details: {
          productId: batch.productId,
          ownerKind: batch.owner.kind,
          capacityQuantity: batch.capacityQuantity,
          unitCode: batch.unitCode,
          measurementSource: batch.measurementSource,
          expiresAt: batch.expiresAt,
        },
      })
      return batch
    },
    (result) => result.id,
  )
}

export function useStoredBottle(state: InventoryDomainState, command: UseStoredBottleCommand) {
  assertBottleOperationContext(command)
  assertPositiveQuantity(command.quantity, '取用数量')
  assertNonEmpty(command.tableSessionId, '桌台会话ID')
  assertNonEmpty(command.orderId, '订单ID')
  if (command.orderItemId !== undefined) assertNonEmpty(command.orderItemId, '订单明细ID')
  return executeIdempotent(
    state,
    command.idempotencyKey,
    'bottle_storage.use',
    command,
    'bottle_storage_event',
    () => {
      const batch = findBottleBatch(state, command.batchId)
      assertActiveBottle(batch, command.occurredAt)
      if (command.quantity > batch.remainingQuantity) throw new Error('取用数量超过存酒剩余量')
      const remainingAfter = batch.remainingQuantity - command.quantity
      const event = addBottleEvent(state, {
        id: command.eventId,
        batchId: batch.id,
        relatedBatchId: null,
        type: 'use',
        quantity: command.quantity,
        remainingAfter,
        unitCode: batch.unitCode,
        tableSessionId: command.tableSessionId,
        orderId: command.orderId,
        orderItemId: command.orderItemId ?? null,
        actorId: command.actorId,
        approvalId: null,
        approvedBy: null,
        reason: command.reason,
        businessDate: command.businessDate,
        occurredAt: command.occurredAt,
      })
      batch.remainingQuantity = remainingAfter
      batch.status = remainingAfter === 0 ? 'exhausted' : 'partially_used'
      batch.revision += 1
      batch.updatedAt = command.occurredAt
      audit(state, {
        action: 'bottle_storage.used.v1',
        objectType: 'bottle_storage_batch',
        objectId: batch.id,
        actorId: command.actorId,
        approvalId: null,
        tableSessionId: command.tableSessionId,
        orderId: command.orderId,
        reason: command.reason,
        occurredAt: command.occurredAt,
        details: { quantity: command.quantity, unitCode: batch.unitCode, remainingAfter, eventId: event.id },
      })
      return event
    },
    (result) => result.id,
  )
}

function assertIndependentApproval(actorId: string, approvalId: string, approvedBy: string) {
  assertNonEmpty(approvalId, '审批ID')
  assertNonEmpty(approvedBy, '审批人')
  if (actorId === approvedBy) throw new Error('高风险存酒操作必须由另一人审批')
}

export function transferStoredBottle(
  state: InventoryDomainState,
  command: TransferStoredBottleCommand,
) {
  assertNonEmpty(command.eventId, '存酒事件ID')
  assertNonEmpty(command.sourceBatchId, '来源存酒批次ID')
  assertNonEmpty(command.recipientBatchId, '接收存酒批次ID')
  assertOwner(command.recipientOwner)
  assertNonEmpty(command.tableSessionId, '桌台会话ID')
  if (command.orderId !== undefined) assertNonEmpty(command.orderId, '订单ID')
  assertNonEmpty(command.actorId, '操作人')
  assertIndependentApproval(command.actorId, command.approvalId, command.approvedBy)
  assertNonEmpty(command.reason, '转赠原因')
  assertBusinessDate(command.businessDate)
  assertTimestamp(command.occurredAt)
  return executeIdempotent(
    state,
    command.idempotencyKey,
    'bottle_storage.transfer',
    command,
    'bottle_storage_batch',
    () => {
      const sourceBatch = findBottleBatch(state, command.sourceBatchId)
      assertActiveBottle(sourceBatch, command.occurredAt)
      if (state.bottleBatches.some((item) => item.id === command.recipientBatchId)) {
        throw new Error('接收存酒批次ID已存在')
      }
      if (state.bottleEvents.some((item) => item.id === command.eventId)) throw new Error('存酒事件ID已存在')
      const transferredQuantity = sourceBatch.remainingQuantity
      const recipientBatch: BottleStorageBatch = {
        ...scope(state),
        id: command.recipientBatchId,
        sourceBatchId: sourceBatch.id,
        productId: sourceBatch.productId,
        skuSnapshot: sourceBatch.skuSnapshot,
        productNameSnapshot: sourceBatch.productNameSnapshot,
        owner: cloneOwner(command.recipientOwner),
        capacityQuantity: transferredQuantity,
        remainingQuantity: transferredQuantity,
        unitCode: sourceBatch.unitCode,
        measurementSource: 'manual_confirmation',
        status: 'stored',
        storedAt: command.occurredAt,
        expiresAt: sourceBatch.expiresAt,
        originalTableSessionId: sourceBatch.originalTableSessionId,
        originalOrderId: sourceBatch.originalOrderId,
        originalOrderItemId: sourceBatch.originalOrderItemId,
        storedBy: command.actorId,
        depositApprovalId: command.approvalId,
        revision: 1,
        updatedAt: command.occurredAt,
      }
      addBottleEvent(state, {
        id: command.eventId,
        batchId: sourceBatch.id,
        relatedBatchId: recipientBatch.id,
        type: 'transfer',
        quantity: transferredQuantity,
        remainingAfter: 0,
        unitCode: sourceBatch.unitCode,
        tableSessionId: command.tableSessionId,
        orderId: command.orderId ?? null,
        orderItemId: null,
        actorId: command.actorId,
        approvalId: command.approvalId,
        approvedBy: command.approvedBy,
        reason: command.reason,
        businessDate: command.businessDate,
        occurredAt: command.occurredAt,
      })
      sourceBatch.remainingQuantity = 0
      sourceBatch.status = 'transferred'
      sourceBatch.revision += 1
      sourceBatch.updatedAt = command.occurredAt
      state.bottleBatches.push(recipientBatch)
      audit(state, {
        action: 'bottle_storage.transferred.v1',
        objectType: 'bottle_storage_batch',
        objectId: sourceBatch.id,
        actorId: command.actorId,
        approvalId: command.approvalId,
        tableSessionId: command.tableSessionId,
        orderId: command.orderId ?? null,
        reason: command.reason,
        occurredAt: command.occurredAt,
        details: {
          approvedBy: command.approvedBy,
          recipientBatchId: recipientBatch.id,
          recipientOwnerKind: recipientBatch.owner.kind,
          quantity: transferredQuantity,
          unitCode: sourceBatch.unitCode,
        },
      })
      return recipientBatch
    },
    (result) => result.id,
  )
}

export function voidStoredBottle(state: InventoryDomainState, command: VoidStoredBottleCommand) {
  assertBottleOperationContext(command)
  if (command.tableSessionId !== undefined) assertNonEmpty(command.tableSessionId, '桌台会话ID')
  if (command.orderId !== undefined) assertNonEmpty(command.orderId, '订单ID')
  assertIndependentApproval(command.actorId, command.approvalId, command.approvedBy)
  return executeIdempotent(
    state,
    command.idempotencyKey,
    'bottle_storage.void',
    command,
    'bottle_storage_event',
    () => {
      const batch = findBottleBatch(state, command.batchId)
      assertActiveBottle(batch, command.occurredAt)
      const voidedQuantity = batch.remainingQuantity
      const event = addBottleEvent(state, {
        id: command.eventId,
        batchId: batch.id,
        relatedBatchId: null,
        type: 'void',
        quantity: voidedQuantity,
        remainingAfter: 0,
        unitCode: batch.unitCode,
        tableSessionId: command.tableSessionId ?? null,
        orderId: command.orderId ?? null,
        orderItemId: null,
        actorId: command.actorId,
        approvalId: command.approvalId,
        approvedBy: command.approvedBy,
        reason: command.reason,
        businessDate: command.businessDate,
        occurredAt: command.occurredAt,
      })
      batch.remainingQuantity = 0
      batch.status = 'voided'
      batch.revision += 1
      batch.updatedAt = command.occurredAt
      audit(state, {
        action: 'bottle_storage.voided.v1',
        objectType: 'bottle_storage_batch',
        objectId: batch.id,
        actorId: command.actorId,
        approvalId: command.approvalId,
        tableSessionId: command.tableSessionId ?? null,
        orderId: command.orderId ?? null,
        reason: command.reason,
        occurredAt: command.occurredAt,
        details: { approvedBy: command.approvedBy, quantity: voidedQuantity, unitCode: batch.unitCode },
      })
      return event
    },
    (result) => result.id,
  )
}

export function expireStoredBottle(state: InventoryDomainState, command: ExpireStoredBottleCommand) {
  assertBottleOperationContext(command)
  return executeIdempotent(
    state,
    command.idempotencyKey,
    'bottle_storage.expire',
    command,
    'bottle_storage_event',
    () => {
      const batch = findBottleBatch(state, command.batchId)
      if (!['stored', 'partially_used'].includes(batch.status)) throw new Error('当前存酒状态不能标记过期')
      if (Date.parse(command.occurredAt) < Date.parse(batch.expiresAt)) throw new Error('未到保管期限，不能标记过期')
      const expiredQuantity = batch.remainingQuantity
      const event = addBottleEvent(state, {
        id: command.eventId,
        batchId: batch.id,
        relatedBatchId: null,
        type: 'expire',
        quantity: expiredQuantity,
        remainingAfter: 0,
        unitCode: batch.unitCode,
        tableSessionId: null,
        orderId: null,
        orderItemId: null,
        actorId: command.actorId,
        approvalId: null,
        approvedBy: null,
        reason: command.reason,
        businessDate: command.businessDate,
        occurredAt: command.occurredAt,
      })
      batch.remainingQuantity = 0
      batch.status = 'expired'
      batch.revision += 1
      batch.updatedAt = command.occurredAt
      audit(state, {
        action: 'bottle_storage.expired.v1',
        objectType: 'bottle_storage_batch',
        objectId: batch.id,
        actorId: command.actorId,
        approvalId: null,
        tableSessionId: null,
        orderId: null,
        reason: command.reason,
        occurredAt: command.occurredAt,
        details: { quantity: expiredQuantity, unitCode: batch.unitCode, expiresAt: batch.expiresAt },
      })
      return event
    },
    (result) => result.id,
  )
}

export function getBottleBatch(state: InventoryDomainState, batchId: string) {
  assertNonEmpty(batchId, '存酒批次ID')
  return findBottleBatch(state, batchId)
}
