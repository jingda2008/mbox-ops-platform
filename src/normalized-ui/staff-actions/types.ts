export type StaffActionPermission =
  | 'table.open'
  | 'table.close'
  | 'table.turnover_unsettled'
  | 'table.transfer'
  | 'table.participation.manage'
  | 'table.assignment.manage'
  | 'guest.cart.freeze'
  | 'order.create'
  | 'order.gift'
  | 'payment.initiate.staff'
  | 'service.execute'
  | 'observation.record'
  | 'recommendation.staff.modify'
  | 'kds.prepare'
  | 'kds.deliver'
  | 'kds.exception.manage'

export interface StaffActionActor {
  id: string
  displayName: string
  roleCodes: string[]
  capabilities: string[]
}

export interface StaffActionTableSession {
  id: string
  guestCount: number
  capacityAtOpen: number
  guestProfileSnapshot?: Record<string, unknown>
  guestCartWritesFrozen: boolean
  status: 'open' | 'closing'
  openedAt: string
  latestMood: null | {
    code: string
    occurredAt: string
  }
}

export interface StaffActionTable {
  id: string
  code: string
  displayName: string
  areaId: string
  areaName: string
  capacity: number
  status: 'available' | 'paused' | 'retired'
  assignedToActor: boolean
  activeSession: StaffActionTableSession | null
}

export interface StaffServiceTask {
  id: string
  taskType: string
  tableId: string
  tableCode: string
  tableSessionId: string
  title: string
  detail: string | null
  priority: 'low' | 'normal' | 'high' | 'urgent'
  status: 'pending' | 'acknowledged' | 'in_progress'
  assignedEmployeeId: string | null
  backupEmployeeId: string | null
  assignedToActor: boolean
  interactionMode: 'quick_complete' | 'manager_resolution'
  dueAt: string | null
  createdAt: string
}

export interface StaffOperationsData {
  actor: StaffActionActor
  tables: StaffActionTable[]
  tasks: StaffServiceTask[]
}

export type RecommendationStaffModificationReason =
  | 'customer_request'
  | 'availability_substitution'
  | 'service_recovery'
  | 'staff_judgement'

export interface StaffRecommendationSession {
  recommendationPublicId: string
  tableSessionId: string
  createdAt: string
  options: Array<{
    productId: string
    productName: string
    rank: number
    tier: 'comfortable' | 'enhanced' | 'signature'
    amountMinor: number
    currency: string
  }>
}

export interface StaffRecommendationModification {
  eventId: string
  recommendationPublicId: string
  tableSessionId: string
  sourceProductId: string
  sourceProductName: string
  targetProductId: string
  targetProductName: string
  reasonCode: RecommendationStaffModificationReason
  employeeId: string
  occurredAt: string
}

export type StaffTableAssignmentType = 'primary' | 'backup' | 'temporary'

export interface StaffTableAssignment {
  id: string
  tableId: string
  tableCode: string
  employeeId: string
  employeeName: string
  roleId: string
  roleCode: string
  assignmentType: StaffTableAssignmentType
  startsAt: string
  endsAt: string | null
  reason: string
}

export interface StaffTableAssignmentOptions {
  employees: Array<{
    id: string
    code: string
    displayName: string
  }>
  roles: Array<{
    id: string
    code: string
    name: string
  }>
}

export interface StaffTableParticipant {
  publicId:string
  customerPublicId:string
  role:'reservation_owner'|'organizer'|'payer'|'companion'|'unknown'
  confirmationState:'unconfirmed'|'confirmed'|'corrected'
  identityLevel:'anonymous'|'identified'|'member'
  seatLabel:string|null
  locationStartedAt:string
}

export interface StaffParticipantMovementPreview {
  movementKind:'participant_split'|'participant_merge'
  movedGuestCount:number
  selectedParticipantCount:number
  targetTableId:string
  targetTableSessionId:string|null
  targetCapacity:number
  projectedGuestCount:number
  requiresCapacityOverride:boolean
  roleAdjustments:Array<{
    participantPublicId:string
    fromRole:'organizer'
    toRole:'companion'
    reason:string
  }>
  blockers:Array<{
    code:'ORDER_UNSETTLED'|'ORDER_ITEM_UNRESOLVED'|'KDS_ACTIVE'|'PAYMENT_PENDING'
      |'REFUND_PENDING'|'SERVICE_ACTIVE'|'PRICING_RESERVED'|'SONG_ACTIVE'
      |'BENEFIT_RESERVED'|'EXPERIENCE_ACTIVE'|'REDEMPTION_PENDING'|'CHECKOUT_OFFER_ACTIVE'
    count:number
    label:string
    resolution:string
  }>
  finalRevalidationRequired:true
  accountingBoundary:string
}

export type FulfillmentStation = 'bar' | 'kitchen' | 'cashier'
export type FulfillmentStatus = 'pending' | 'accepted' | 'preparing' | 'ready' | 'failed'

export interface StaffFulfillmentItem {
  taskId: string
  businessDate: string
  carryover: boolean
  stationCode: FulfillmentStation
  kdsStatus: FulfillmentStatus
  priority: number
  overdue: boolean
  readyForDelivery: boolean
  canPrepare: boolean
  canDeliver: boolean
  canRemake: boolean
  dueAt: string | null
  nextActionAt: string
  createdAt: string
  item: {
    productName: string
    quantity: number
    note: string | null
  }
  order: {
    publicId: string
    note: string | null
  }
  table: {
    id: string
    code: string
    assignmentType: 'primary' | 'backup' | null
  }
  attentionMessages: string[]
}

export interface StaffFulfillmentData {
  actor: {
    employeeId: string
    permissions: string[]
    allowedStations: FulfillmentStation[]
    canViewAll: boolean
  }
  generatedAt: string
  workItems: StaffFulfillmentItem[]
}

export interface StaffAnnualGiftReservation {
  reservationId: string
  benefitId: string
  customerId: string
  tableSessionId: string
  tableCode: string
  memberNo: string | null
  customerName: string | null
  ruleKind: 'birthday' | 'festival'
  title: string
  quantity: number
  reservedAt: string
  expiresAt: string
  originalProductId: string
  originalProductName: string
  allowedProducts: Array<{
    productId: string
    name: string
    isOriginal: boolean
    configuredReason: string | null
  }>
}

export interface StaffDailySnackClaim {
  id: string
  claimCode: string
  benefitId: string | null
  benefitReservationId: string | null
  quantity: number
  status: 'reserved' | 'redeemed' | 'fulfilled' | 'cancelled' | 'expired' | 'cancelled_after_redemption' | 'compensated'
  expiresAt: string | null
  redeemedByEmployeeName: string | null
  redeemedAt: string | null
  fulfilledAt: string | null
  title: string
  tableCode?: string
  tableSessionId?: string
  memberNo?: string | null
  customerName?: string | null
}

export interface StaffMemberBenefitTasks {
  annualGifts: StaffAnnualGiftReservation[]
  dailySnacks: StaffDailySnackClaim[]
}

export type StaffReservationStatus =
  | 'pending'
  | 'confirmed'
  | 'arrived'
  | 'seated'
  | 'completed'
  | 'cancelled'
  | 'no_show'

export interface StaffReservation {
  id: string
  publicId: string
  customerName: string
  contactToken?: string
  contactAvailable: boolean
  guestCount: number
  arrivalAt: string
  expectedEndAt: string
  status: StaffReservationStatus
  source: 'wechat' | 'phone' | 'walk_in' | 'employee' | 'integration'
  note: string | null
  seatPreference: 'no_preference' | 'stage_atmosphere' | 'quiet_chat' | 'comfortable_booth' | 'outdoor_view'
  tableLocks: Array<{
    tableCode: string
    tableDisplayName: string
    status: 'held' | 'confirmed' | 'released' | 'expired' | 'cancelled'
  }>
}

export interface StaffReservationIntakeEntry {
  kind: 'reservation' | 'waitlist'
  publicId: string
  customerName: string
  maskedContact: string
  guestCount: number
  arrivalAt: string
  status: string
  tableCodes: string[]
  priorityBooking: { requestHoldMinutes: number } | null
  queueOverride: { mode: 'promote' | 'demote' | 'clear'; reason: string; createdAt: string } | null
}

export type StaffActionNotice = {
  kind: 'success' | 'error' | 'guidance'
  message: string
} | null

export type StaffActionsTab = 'tables' | 'tasks' | 'fulfillment' | 'reservations'
