export type InventoryQuantity = number

export interface InventoryScope {
  tenantId: string
  storeId: string
}

export interface InventoryUnitConversion {
  unitCode: string
  /** Number of base units represented by one unitCode. */
  baseQuantity: InventoryQuantity
}

export interface InventoryIngredientSku extends InventoryScope {
  id: string
  sku: string
  name: string
  baseUnitCode: string
  costAmountPerBaseUnit: number
  conversions: InventoryUnitConversion[]
  enabled: boolean
  revision: number
  createdAt: string
  updatedAt: string
  updatedBy: string
}

export interface InventoryRecipeLine {
  ingredientSkuId: string
  /** Standard consumption for one sold/gifted/remade menu item, in the ingredient base unit. */
  standardQuantity: InventoryQuantity
  /** Variance tolerance for stock-loss analysis. It is not added to automatic order consumption. */
  allowedLossBps: number
}

export interface InventoryRecipeVersion extends InventoryScope {
  id: string
  productId: string
  version: number
  status: 'active' | 'archived'
  lines: InventoryRecipeLine[]
  publishedBy: string
  publishedAt: string
  reason: string
}

export type InventoryConsumptionType = 'sale' | 'gift' | 'remake'

export type InventoryMovementConfigurationSnapshot =
  | {
      kind: 'recipe'
      consumptionType: InventoryConsumptionType
      orderedProductId: string
      orderedProductName: string
      orderedQuantity: InventoryQuantity
      recipe: InventoryRecipeVersion
      ingredient: InventoryIngredientSku
      recipeLine: InventoryRecipeLine
    }
  | {
      kind: 'direct_product'
      consumptionType: InventoryConsumptionType
      orderedProductId: string
      orderedProductName: string
      orderedQuantity: InventoryQuantity
      inventoryUnitCode: string
    }
  | {
      kind: 'unit_conversion'
      inputQuantity: InventoryQuantity
      inputUnitCode: string
      conversion: InventoryUnitConversion
      ingredient: InventoryIngredientSku
    }

export type InventoryMovementType =
  | 'receipt'
  | 'sale'
  | 'gift'
  | 'remake'
  | 'refund'
  | 'stock_count_gain'
  | 'stock_count_loss'

export interface InventoryBalance extends InventoryScope {
  productId: string
  unitCode: string
  onHandQuantity: InventoryQuantity
  revision: number
  updatedAt: string
}

export interface InventoryStockAlertRule {
  itemId: string
  enabled: boolean
  /** Warning threshold in the item's inventory unit, or theoretical servings for recipe products. */
  warningQuantity: InventoryQuantity
  updatedAt: string
  updatedBy: string
}

/** Inventory movements are immutable facts. Corrections are represented by new movements. */
export interface InventoryMovement extends InventoryScope {
  id: string
  productId: string
  unitCode: string
  type: InventoryMovementType
  direction: 'in' | 'out'
  quantity: InventoryQuantity
  balanceAfter: InventoryQuantity
  tableSessionId: string | null
  orderId: string | null
  orderItemId: string | null
  refundId: string | null
  stockCountId: string | null
  approvalId: string | null
  actorId: string
  reason: string
  businessDate: string
  occurredAt: string
  /** Immutable configuration used to calculate this movement. */
  configurationSnapshot?: InventoryMovementConfigurationSnapshot | null
}

export type StockCountStatus = 'pending_confirmation' | 'applied' | 'rejected'

export interface StockCount extends InventoryScope {
  id: string
  productId: string
  unitCode: string
  expectedQuantity: InventoryQuantity
  countedQuantity: InventoryQuantity
  differenceQuantity: number
  status: StockCountStatus
  countedBy: string
  countedAt: string
  approvalId: string | null
  confirmedBy: string | null
  confirmedAt: string | null
  decisionReason: string | null
  adjustmentMovementId: string | null
  businessDate: string
}

export type BottleOwner =
  | { kind: 'member'; memberId: string }
  | {
      kind: 'anonymous'
      /** Opaque customer/session reference. Do not put a raw phone number in this field. */
      customerRef: string
      displayNameSnapshot: string
    }

export type BottleStorageStatus =
  | 'stored'
  | 'partially_used'
  | 'exhausted'
  | 'transferred'
  | 'voided'
  | 'expired'

export type BottleStorageEventType = 'deposit' | 'use' | 'transfer' | 'void' | 'expire'

export interface BottleStorageBatch extends InventoryScope {
  id: string
  sourceBatchId: string | null
  productId: string
  skuSnapshot: string
  productNameSnapshot: string
  owner: BottleOwner
  capacityQuantity: InventoryQuantity
  remainingQuantity: InventoryQuantity
  unitCode: string
  /** Commercial V1 only accepts a quantity confirmed by a human operator. */
  measurementSource: 'manual_confirmation'
  status: BottleStorageStatus
  storedAt: string
  expiresAt: string
  originalTableSessionId: string
  originalOrderId: string
  originalOrderItemId: string
  storedBy: string
  depositApprovalId: string | null
  revision: number
  updatedAt: string
}

/** Bottle events are immutable and carry the operational context for every state transition. */
export interface BottleStorageEvent extends InventoryScope {
  id: string
  batchId: string
  relatedBatchId: string | null
  type: BottleStorageEventType
  quantity: InventoryQuantity
  remainingAfter: InventoryQuantity
  unitCode: string
  tableSessionId: string | null
  orderId: string | null
  orderItemId: string | null
  actorId: string
  approvalId: string | null
  approvedBy: string | null
  reason: string
  businessDate: string
  occurredAt: string
}

export interface InventoryAuditEvent extends InventoryScope {
  id: string
  action: string
  objectType: 'inventory_movement' | 'stock_count' | 'bottle_storage_batch' | 'ingredient_sku' | 'recipe_version'
  objectId: string
  actorId: string
  approvalId: string | null
  tableSessionId: string | null
  orderId: string | null
  reason: string
  occurredAt: string
  details: Record<string, unknown>
}

export type InventoryDomainResultType =
  | 'inventory_movement'
  | 'stock_count'
  | 'bottle_storage_batch'
  | 'bottle_storage_event'
  | 'ingredient_sku'
  | 'recipe_version'

export type InventoryApprovalAction = 'bottle_transfer' | 'bottle_void' | 'store_import'
export type InventoryApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface InventoryApprovalActorSnapshot {
  employeeId: string
  displayName: string
  roleId: string
  authenticatedBy: 'signed_session' | 'local_header'
}

export interface InventoryApprovalRequest extends InventoryScope {
  id: string
  action: InventoryApprovalAction
  status: InventoryApprovalStatus
  targetId: string
  requestPayload: Record<string, unknown>
  beforeSnapshot: unknown
  afterSnapshot: unknown | null
  requestedBy: InventoryApprovalActorSnapshot
  requestedAt: string
  requestReason: string
  requestIdempotencyKey: string
  decision: 'approve' | 'reject' | null
  decidedBy: InventoryApprovalActorSnapshot | null
  decidedAt: string | null
  decisionReason: string | null
  decisionIdempotencyKey: string | null
  executedAt: string | null
}

export interface InventoryIdempotencyRecord {
  key: string
  operation: string
  fingerprint: string
  resultType: InventoryDomainResultType
  resultId: string
}

export interface InventoryDomainState extends InventoryScope {
  policy: InventoryOperationPolicy
  stockAlertRules: InventoryStockAlertRule[]
  ingredientSkus: InventoryIngredientSku[]
  recipeVersions: InventoryRecipeVersion[]
  balances: InventoryBalance[]
  movements: InventoryMovement[]
  stockCounts: StockCount[]
  bottleBatches: BottleStorageBatch[]
  bottleEvents: BottleStorageEvent[]
  auditEvents: InventoryAuditEvent[]
  approvalRequests: InventoryApprovalRequest[]
  idempotencyRecords: InventoryIdempotencyRecord[]
}

export interface InventoryOperationPolicy {
  policyAdminRoleIds: string[]
  receiptRoleIds: string[]
  stockCountRoleIds: string[]
  stockCountApprovalRoleIds: string[]
  bottleDepositRoleIds: string[]
  bottleUseRoleIds: string[]
  bottleApprovalRoleIds: string[]
}

export interface ReceiveInventoryCommand {
  movementId: string
  productId: string
  unitCode: string
  quantity: InventoryQuantity
  actorId: string
  reason: string
  businessDate: string
  occurredAt: string
  idempotencyKey: string
  configurationSnapshot?: InventoryMovementConfigurationSnapshot | null
}

export interface ConsumeInventoryCommand {
  movementId: string
  productId: string
  unitCode: string
  quantity: InventoryQuantity
  tableSessionId: string
  orderId: string
  orderItemId: string
  actorId: string
  reason: string
  businessDate: string
  occurredAt: string
  idempotencyKey: string
  configurationSnapshot?: InventoryMovementConfigurationSnapshot | null
}

export interface UpsertIngredientSkuCommand {
  ingredientSkuId: string
  sku: string
  name: string
  baseUnitCode: string
  costAmountPerBaseUnit: number
  conversions: InventoryUnitConversion[]
  enabled: boolean
  actorId: string
  reason: string
  occurredAt: string
  idempotencyKey: string
}

export interface PublishRecipeVersionCommand {
  recipeVersionId: string
  productId: string
  lines: InventoryRecipeLine[]
  actorId: string
  reason: string
  occurredAt: string
  idempotencyKey: string
}

export interface ReturnInventoryForRefundCommand {
  movementId: string
  productId: string
  unitCode: string
  quantity: InventoryQuantity
  tableSessionId: string
  orderId: string
  orderItemId: string
  refundId: string
  actorId: string
  reason: string
  businessDate: string
  occurredAt: string
  idempotencyKey: string
}

export interface SubmitStockCountCommand {
  countId: string
  productId: string
  unitCode: string
  countedQuantity: InventoryQuantity
  countedBy: string
  approvalId?: string
  businessDate: string
  occurredAt: string
  idempotencyKey: string
}

export interface ConfirmStockCountCommand {
  countId: string
  adjustmentMovementId: string
  approvalId: string
  confirmedBy: string
  reason: string
  occurredAt: string
  idempotencyKey: string
}

export interface RejectStockCountCommand {
  countId: string
  approvalId: string
  rejectedBy: string
  reason: string
  occurredAt: string
  idempotencyKey: string
}

export interface DepositBottleCommand {
  batchId: string
  eventId: string
  productId: string
  skuSnapshot: string
  productNameSnapshot: string
  owner: BottleOwner
  capacityQuantity: InventoryQuantity
  unitCode: string
  expiresAt: string
  tableSessionId: string
  orderId: string
  orderItemId: string
  actorId: string
  approvalId?: string
  reason: string
  businessDate: string
  occurredAt: string
  idempotencyKey: string
}

export interface UseStoredBottleCommand {
  eventId: string
  batchId: string
  quantity: InventoryQuantity
  tableSessionId: string
  orderId: string
  orderItemId?: string
  actorId: string
  reason: string
  businessDate: string
  occurredAt: string
  idempotencyKey: string
}

export interface TransferStoredBottleCommand {
  eventId: string
  sourceBatchId: string
  recipientBatchId: string
  recipientOwner: BottleOwner
  tableSessionId: string
  orderId?: string
  actorId: string
  approvalId: string
  approvedBy: string
  reason: string
  businessDate: string
  occurredAt: string
  idempotencyKey: string
}

export interface VoidStoredBottleCommand {
  eventId: string
  batchId: string
  tableSessionId?: string
  orderId?: string
  actorId: string
  approvalId: string
  approvedBy: string
  reason: string
  businessDate: string
  occurredAt: string
  idempotencyKey: string
}

export interface ExpireStoredBottleCommand {
  eventId: string
  batchId: string
  actorId: string
  reason: string
  businessDate: string
  occurredAt: string
  idempotencyKey: string
}
