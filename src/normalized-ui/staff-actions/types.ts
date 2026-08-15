export type StaffActionPermission =
  | 'table.open'
  | 'table.close'
  | 'table.transfer'
  | 'table.assignment.manage'
  | 'order.create'
  | 'order.gift'
  | 'service.execute'
  | 'kds.prepare'
  | 'kds.deliver'

export interface StaffActionActor {
  id: string
  displayName: string
  roleCodes: string[]
  capabilities: string[]
}

export interface StaffActionTableSession {
  id: string
  guestCount: number
  guestProfileSnapshot?: Record<string, unknown>
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

export type FulfillmentStation = 'bar' | 'kitchen' | 'cashier'
export type FulfillmentStatus = 'pending' | 'accepted' | 'preparing' | 'ready'

export interface StaffFulfillmentItem {
  taskId: string
  stationCode: FulfillmentStation
  kdsStatus: FulfillmentStatus
  priority: number
  overdue: boolean
  readyForDelivery: boolean
  canPrepare: boolean
  canDeliver: boolean
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

export type StaffActionNotice = {
  kind: 'success' | 'error' | 'guidance'
  message: string
} | null

export type StaffActionsTab = 'tables' | 'tasks' | 'fulfillment' | 'reservations'
