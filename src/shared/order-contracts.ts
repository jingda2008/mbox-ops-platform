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
export type KdsExceptionKind = 'shortage' | 'production_rejection' | 'wrong_item'
export type KdsExceptionReasonCode =
  | 'product_out_of_stock'
  | 'ingredient_out_of_stock'
  | 'equipment_unavailable'
  | 'quality_rejected'
  | 'wrong_product'
  | 'wrong_specification'
  | 'damaged'
  | 'other'
export type KdsExceptionEventType = 'reported' | 'manager_disposition'
export type KdsManagerDisposition = 'cancelled' | 'remake'
export type KdsManagerReasonCode =
  | 'unavailable_confirmed'
  | 'guest_cancelled'
  | 'manager_cancelled'
  | 'service_recovery'
  | 'quality_recovery'
  | 'other'
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
  /** False marks an operational component of a paid bundle; it never changes the guest bill. */
  commercialLine?: boolean
  /** Bundle component lines point to the paid parent line for audit, refund and analytics. */
  parentOrderItemId?: string | null
  /** False keeps a paid bundle shell from consuming stock; its component lines consume stock instead. */
  inventoryTracked?: boolean
  /** Optional for compatibility with orders persisted before non-fulfillment products. */
  requiresFulfillment?: boolean
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
  /** Order-level guest fulfillment request. Optional only for orders persisted before this field existed. */
  fulfillmentNote?: string
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
  /** Maximum value of one authorization decision. */
  maxAmount: MoneyAmount
  /** Null/omitted means all products; otherwise approvals are limited to these product IDs. */
  allowedSkuIds?: string[] | null
  /** Product categories extend the explicit product allow-list. Null/omitted means no category restriction. */
  allowedCategoryIds?: string[] | null
  tableSessionIds: string[] | null
  /** Optional cumulative controls. Null/omitted means no additional cap for that dimension. */
  maxPerTableAmount?: MoneyAmount | null
  maxPerShiftAmount?: MoneyAmount | null
  maxPerBusinessDayAmount?: MoneyAmount | null
  maxPerMonthAmount?: MoneyAmount | null
  maxPerBusinessDayCount?: number | null
  maxQuantityPerOrder?: number | null
  validFrom: string
  validUntil: string
}

export interface KdsRemakeLink {
  orderItemId: string
  kdsTaskId: string
  exceptionId: string
  attempt: number
}

export interface KdsExceptionEvent {
  id: string
  exceptionId: string
  type: KdsExceptionEventType
  exceptionKind: KdsExceptionKind
  reasonCode: KdsExceptionReasonCode | KdsManagerReasonCode
  reasonNote: string | null
  orderId: string
  orderItemId: string
  kdsTaskId: string
  originalOrderItemId: string
  originalKdsTaskId: string
  actorId: string
  actorRoleId: string
  occurredAt: string
  managerDisposition: KdsManagerDisposition | null
  remakeKdsTaskId: string | null
}

export interface KdsTask {
  id: string
  orderId: string
  orderItemId: string
  tableSessionId: string
  /** Minimal routing label projected to workstation roles without exposing table details. */
  tableCode?: string
  stationId: string
  itemName: string
  specification: string
  quantity: number
  /** Immutable order-note snapshot shared with production and delivery roles. */
  fulfillmentNote?: string
  status: KdsTaskStatus
  /** Snapshot of routing, roles and SLA so an in-flight task is not changed by later configuration. */
  workstation?: FulfillmentWorkstationConfig
  productionSla?: FulfillmentSlaSnapshot
  pickupSla?: FulfillmentSlaSnapshot
  deliveryServiceTask?: KdsDeliveryServiceTaskLink | null
  /** Present on compensation tasks; the original order item and KDS task are never replaced. */
  remakeOf?: KdsRemakeLink | null
  /** Append-only exception history. Optional only for tasks persisted before exception handling. */
  exceptionEvents?: KdsExceptionEvent[]
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
  resultType: 'order' | 'order_item' | 'authorization' | 'kds_task' | 'kds_exception_event'
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
  fulfillmentNote?: string
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
  commercialLine?: boolean
  parentOrderItemId?: string | null
  inventoryTracked?: boolean
  requiresFulfillment?: boolean
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

export interface ReportKdsExceptionCommand {
  exceptionId: string
  eventId: string
  taskId: string
  exceptionKind: KdsExceptionKind
  reasonCode: KdsExceptionReasonCode
  reasonNote: string
  actorId: string
  actorRoleId: string
  occurredAt: string
  idempotencyKey: string
}

export interface DecideKdsExceptionCommand {
  eventId: string
  exceptionId: string
  disposition: KdsManagerDisposition
  reasonCode: KdsManagerReasonCode
  reasonNote: string
  remakeTaskId: string | null
  actorId: string
  actorRoleId: string
  occurredAt: string
  idempotencyKey: string
}

export interface TableAccountSummary {
  tableSessionId: string
  balance: MoneyAmount
  entries: TableLedgerEntry[]
}
