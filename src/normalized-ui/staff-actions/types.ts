export type StaffActionPermission =
  | 'table.open'
  | 'table.close'
  | 'table.transfer'
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
  status: 'open' | 'closing'
  openedAt: string
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
  tableId: string
  tableCode: string
  tableSessionId: string
  title: string
  detail: string | null
  priority: 'low' | 'normal' | 'high' | 'urgent'
  status: 'pending' | 'acknowledged' | 'in_progress'
  assignedEmployeeId: string | null
  backupEmployeeId: string | null
  dueAt: string | null
  createdAt: string
}

export interface StaffOperationsData {
  actor: StaffActionActor
  tables: StaffActionTable[]
  tasks: StaffServiceTask[]
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

export type StaffActionNotice = {
  kind: 'success' | 'error' | 'guidance'
  message: string
} | null

export type StaffActionsTab = 'tables' | 'service' | 'fulfillment'
