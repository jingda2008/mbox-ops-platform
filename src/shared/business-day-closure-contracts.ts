export type BusinessDayBlockerCode =
  | 'ORDER_UNSETTLED'
  | 'ORDER_ITEM_UNRESOLVED'
  | 'KDS_ACTIVE'
  | 'PAYMENT_PENDING'
  | 'INVENTORY_RESERVED'
  | 'REFUND_PENDING'
  | 'SERVICE_ACTIVE'
  | 'PRICING_RESERVED'
  | 'SONG_ACTIVE'
  | 'BENEFIT_RESERVED'
  | 'EXPERIENCE_ACTIVE'
  | 'REDEMPTION_PENDING'
  | 'CHECKOUT_OFFER_ACTIVE'

export interface BusinessDayBlockerFact {
  type: 'order' | 'order_item' | 'kds_task' | 'payment' | 'inventory_reservation' | 'refund'
    | 'service_task' | 'pricing_authorization' | 'song_request' | 'benefit_reservation'
    | 'experience_plan' | 'member_redemption' | 'checkout_offer'
  id: string
  reference: string
  title: string
  status: string
  statusLabel: string
  amountMinor: number | null
  quantityText: string | null
  orderId: string | null
  orderPublicId: string | null
  employeeRelationLabel: string
  relatedEmployeeName: string | null
  actionRoute: string
}

export interface BusinessDayNavigationContext {
  businessDayBlockerFact: BusinessDayBlockerFact
}

export interface BusinessDayBlockerTarget {
  route: '/staff/payments' | '/staff/live'
  focus: 'orders' | 'fulfillment' | 'payments' | 'refunds' | 'inventory' | 'table_exception'
  tableSessionId: string
  tableCode: string
  query: string
}

export interface BusinessDayTableBlocker {
  tableSessionId: string
  tableCode: string
  code: BusinessDayBlockerCode
  count: number
  label: string
  resolution: string
  target: BusinessDayBlockerTarget
  facts: BusinessDayBlockerFact[]
}

export interface ClosedBusinessDayTable {
  tableSessionId: string
  tableCode: string
  previousStatus: 'open' | 'closing'
  closedAt: string
}

export interface BusinessDayClosureItem {
  businessDayId: string
  businessDate: string
  status: 'closed' | 'awaiting_close'
  closedTableSessions: ClosedBusinessDayTable[]
  blockers: BusinessDayTableBlocker[]
}

export interface BusinessDayClosureResult {
  businessDays: BusinessDayClosureItem[]
  closedBusinessDayCount: number
  closedTableSessionCount: number
  blockedTableSessionCount: number
}
