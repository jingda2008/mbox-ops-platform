/** Money is always represented in the currency's smallest unit, for example cents/fen. */
export type MoneyAmount = number

export type OrderStatus =
  | 'draft'
  | 'authorization_pending'
  | 'submitted'
  | 'in_fulfillment'
  | 'fulfilled'

export type AuthorizationKind = 'discount' | 'gift'
export type AuthorizationStatus = 'pending' | 'granted' | 'rejected'
export type KdsTaskStatus = 'queued' | 'preparing' | 'completed' | 'picked_up' | 'delivered'
export type ItemFulfillmentStatus = 'draft' | KdsTaskStatus
export type TableLedgerEntryType = 'order_gross_charge' | 'order_discount' | 'order_gift'
export type LinkedServiceTaskStatus =
  | 'pending'
  | 'accepted'
  | 'arrived'
  | 'completed'
  | 'confirmed'
  | 'reopened'
  | 'escalated'
  | 'cancelled'

export interface FulfillmentWorkstationConfig {
  id: string
  name: string
  productionRoleIds: string[]
  deliveryRoleIds: string[]
  requiredSkillIds: string[]
  /** Optional only for workstation snapshots persisted before automatic delivery tasks. */
  deliveryServiceTypeId?: string
  productionSlaSeconds: number
  pickupSlaSeconds: number
  configVersion: number
}

export interface FulfillmentSlaSnapshot {
  targetSeconds: number
  dueAt: string | null
}

export interface KdsDeliveryServiceTaskLink {
  id: string
  status: LinkedServiceTaskStatus
  ownerId: string | null
  createdAt: string
}

export interface OrderAmounts {
  grossAmount: MoneyAmount
  discountAmount: MoneyAmount
  giftAmount: MoneyAmount
  payableAmount: MoneyAmount
}

export interface OrderItem {
  id: string
  skuId: string
  name: string
  specification: string
  quantity: number
  unitListPriceAmount: MoneyAmount
  unitSalePriceAmount: MoneyAmount
  unitCostAmount: MoneyAmount
  stationId: string
  configVersion: number
  fulfillmentStatus: ItemFulfillmentStatus
  kdsTaskId: string | null
  addedBy: string
  addedAt: string
}

export interface Order {
  id: string
  tableSessionId: string
  status: OrderStatus
  items: OrderItem[]
  amounts: OrderAmounts
  revision: number
  createdBy: string
  createdAt: string
  submittedBy: string | null
  submittedAt: string | null
  fulfilledAt: string | null
}

export interface OrderAuthorization {
  id: string
  orderId: string
  orderRevision: number
  kind: AuthorizationKind
  lineIds: string[]
  requestedAmount: MoneyAmount
  status: AuthorizationStatus
  requestedBy: string
  requestedAt: string
  decidedBy: string | null
  decidedAt: string | null
  decisionReason: string | null
}

export interface OrderAuthorizationAuthority {
  id: string
  actorId: string
  kinds: AuthorizationKind[]
  maxAmount: MoneyAmount
  /** Null/omitted means all products; otherwise approvals are limited to these product IDs. */
  allowedSkuIds?: string[] | null
  tableSessionIds: string[] | null
  validFrom: string
  validUntil: string
}

export interface KdsTask {
  id: string
  orderId: string
  orderItemId: string
  tableSessionId: string
  stationId: string
  itemName: string
  specification: string
  quantity: number
  status: KdsTaskStatus
  /** Snapshot of routing, roles and SLA so an in-flight task is not changed by later configuration. */
  workstation?: FulfillmentWorkstationConfig
  productionSla?: FulfillmentSlaSnapshot
  pickupSla?: FulfillmentSlaSnapshot
  deliveryServiceTask?: KdsDeliveryServiceTaskLink | null
  queuedAt: string
  startedAt: string | null
  startedBy: string | null
  completedAt: string | null
  completedBy: string | null
  pickedUpAt: string | null
  pickedUpBy: string | null
  deliveredAt: string | null
  deliveredBy: string | null
}

/** Positive amounts increase table receivables; negative amounts reduce them. */
export interface TableLedgerEntry {
  id: string
  tableSessionId: string
  orderId: string
  type: TableLedgerEntryType
  amount: MoneyAmount
  balanceAfter: MoneyAmount
  sequence: number
  actorId: string
  occurredAt: string
  lineIds: string[]
}

export interface IdempotencyRecord {
  key: string
  operation: string
  fingerprint: string
  resultType: 'order' | 'order_item' | 'authorization' | 'kds_task'
  resultId: string
}

export interface OrderDomainState {
  orders: Order[]
  authorizations: OrderAuthorization[]
  authorizationAuthorities: OrderAuthorizationAuthority[]
  /** Optional only for persisted states created before workstation routing was introduced. */
  fulfillmentWorkstations?: FulfillmentWorkstationConfig[]
  kdsTasks: KdsTask[]
  tableLedgerEntries: TableLedgerEntry[]
  idempotencyRecords: IdempotencyRecord[]
}

export interface CreateOrderDraftCommand {
  orderId: string
  tableSessionId: string
  createdBy: string
  occurredAt: string
  idempotencyKey: string
}

export interface OrderItemDraftInput {
  id: string
  skuId: string
  name: string
  specification: string
  quantity: number
  unitListPriceAmount: MoneyAmount
  unitSalePriceAmount: MoneyAmount
  unitCostAmount: MoneyAmount
  stationId: string
  configVersion: number
}

export interface AddOrderItemCommand {
  orderId: string
  item: OrderItemDraftInput
  actorId: string
  occurredAt: string
  idempotencyKey: string
}

export interface RequestOrderAuthorizationCommand {
  authorizationId: string
  orderId: string
  kind: AuthorizationKind
  lineIds: string[]
  requestedBy: string
  occurredAt: string
  idempotencyKey: string
}

export interface DecideOrderAuthorizationCommand {
  authorizationId: string
  decision: 'granted' | 'rejected'
  decidedBy: string
  reason: string
  occurredAt: string
  idempotencyKey: string
}

export interface SubmitOrderCommand {
  orderId: string
  submittedBy: string
  occurredAt: string
  idempotencyKey: string
}

export interface KdsTaskActionCommand {
  taskId: string
  actorId: string
  occurredAt: string
  idempotencyKey: string
}

export interface TableAccountSummary {
  tableSessionId: string
  balance: MoneyAmount
  entries: TableLedgerEntry[]
}
