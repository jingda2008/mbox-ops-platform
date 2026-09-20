export interface KitchenDestination {
  taskId: string
  tableSessionId: string
  tableId: string
  tableCode: string
  locationVersion: number
  orderPublicId: string
  orderCreatedAt: string
}

export interface KitchenPendingItem extends KitchenDestination {
  itemId: string
  productId: string
  productName: string
  specification: string
  itemNote: string
  orderNote: string
  unmade: number
  canPrepare: boolean
}

export interface KitchenBatchUnit extends KitchenDestination {
  unitId: string
  itemId: string
  state: 'unmade' | 'started' | 'ready' | 'delivered'
  held: boolean
  stopped: boolean
  originalTableCode: string
}

export interface KitchenProductionBatch {
  id: string
  productId: string
  productName: string
  specification: string
  itemNote: string
  orderNote: string
  employeeId: string
  employeeName: string
  createdAt: string
  startedAt: string | null
  anchorAt: string
  equipment: string | null
  releasedAt: string | null
  expectedSeconds: number | null
  originalQuantity: number
  units: KitchenBatchUnit[]
}

export interface KitchenBoardData {
  canStart:boolean
  employeeId: string
  canPrepare: boolean
  actionSessionValid: boolean
  generatedAt: string
  pending: KitchenPendingItem[]
  batches: KitchenProductionBatch[]
  equipmentLabels: string[]
  legacyTaskIds: string[]
}

export interface KitchenStartSelection {
  taskId: string
  quantity: number
  expectedUnmade: number
  tableId: string
  tableSessionId: string
  locationVersion: number
}

export type KitchenCommand = {
  action: 'start' | 'quick-ready'
  compatibilityKey: string
  items: KitchenStartSelection[]
  equipment: string | null
  expectedSeconds: number | null
} | {
  action: 'release'
  batchId: string
} | {
  action: 'ready'
  batchId: string
  items: Array<Omit<KitchenStartSelection, 'quantity' | 'expectedUnmade'> & {unitIds: string[]}>
}

export interface KitchenCommandResult {
  batchId: string
  action: KitchenCommand['action']
  quantity: number
  released: boolean
}

export function kitchenCompatibilityKey(item: Pick<KitchenPendingItem, 'productId' | 'specification' | 'itemNote' | 'orderNote'>): string {
  return JSON.stringify([item.productId, item.specification, item.itemNote, item.orderNote])
}
