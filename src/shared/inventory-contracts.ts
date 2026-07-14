export type InventoryQuantity = number

export interface InventoryScope {
  tenantId: string
  storeId: string
}

export type InventoryMovementType =
  | 'receipt'
  | 'sale'
  | 'gift'
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
  objectType: 'inventory_movement' | 'stock_count' | 'bottle_storage_batch'
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

export interface InventoryIdempotencyRecord {
  key: string
  operation: string
  fingerprint: string
  resultType: InventoryDomainResultType
  resultId: string
}

export interface InventoryDomainState extends InventoryScope {
  policy: InventoryOperationPolicy
  balances: InventoryBalance[]
  movements: InventoryMovement[]
  stockCounts: StockCount[]
  bottleBatches: BottleStorageBatch[]
  bottleEvents: BottleStorageEvent[]
  auditEvents: InventoryAuditEvent[]
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
