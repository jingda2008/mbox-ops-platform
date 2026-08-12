import type {
  StaffActionPermission,
  StaffActionTable,
  StaffFulfillmentItem,
  StaffServiceTask,
} from './types'

const SERVICE_PRIORITY: Record<StaffServiceTask['priority'], number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
}

export type StaffUnifiedAction =
  | { kind: 'service'; key: string; task: StaffServiceTask }
  | { kind: 'fulfillment'; key: string; item: StaffFulfillmentItem }

export function hasPermission(permissions: readonly string[], permission: StaffActionPermission): boolean {
  return permissions.includes(permission)
}

export function requiresCapacityReason(table: Pick<StaffActionTable, 'capacity'>, guestCount: number | null): boolean {
  return guestCount !== null && Number.isSafeInteger(guestCount) && guestCount > table.capacity
}

export function validateOpenTableInput(
  table: Pick<StaffActionTable, 'capacity'>,
  guestCountText: string,
  capacityReason: string,
): { guestCount: number; capacityOverrideReason?: string } | { error: string } {
  const guestCount = Number(guestCountText)
  if (!/^\d+$/.test(guestCountText.trim()) || !Number.isSafeInteger(guestCount) || guestCount < 1 || guestCount > 200) {
    return { error: '请先选择或输入实际到店人数' }
  }
  if (guestCount > table.capacity && capacityReason.trim().length === 0) {
    return { error: `人数超过桌台容量${table.capacity}人，请填写加座说明` }
  }
  return {
    guestCount,
    ...(guestCount > table.capacity ? { capacityOverrideReason: capacityReason.trim() } : {}),
  }
}

export function actionableServiceTasks(
  tasks: readonly StaffServiceTask[],
  actorId: string,
): StaffServiceTask[] {
  return tasks
    .filter((task) => task.status === 'pending' || task.status === 'acknowledged' || task.status === 'in_progress')
    .toSorted((left, right) => {
      const leftMine = left.assignedToActor || left.assignedEmployeeId === actorId || left.backupEmployeeId === actorId ? 1 : 0
      const rightMine = right.assignedToActor || right.assignedEmployeeId === actorId || right.backupEmployeeId === actorId ? 1 : 0
      if (leftMine !== rightMine) return rightMine - leftMine
      const priority = SERVICE_PRIORITY[right.priority] - SERVICE_PRIORITY[left.priority]
      if (priority !== 0) return priority
      return eventTime(left.dueAt ?? left.createdAt) - eventTime(right.dueAt ?? right.createdAt)
    })
}

export function actionableFulfillmentItems(items: readonly StaffFulfillmentItem[]): StaffFulfillmentItem[] {
  return items
    .filter((item) => item.canPrepare || item.canDeliver)
    .toSorted((left, right) => {
      if (left.overdue !== right.overdue) return left.overdue ? -1 : 1
      const leftReady = left.canDeliver && left.readyForDelivery ? 1 : 0
      const rightReady = right.canDeliver && right.readyForDelivery ? 1 : 0
      if (leftReady !== rightReady) return rightReady - leftReady
      if (left.priority !== right.priority) return right.priority - left.priority
      return eventTime(left.dueAt ?? left.nextActionAt ?? left.createdAt)
        - eventTime(right.dueAt ?? right.nextActionAt ?? right.createdAt)
    })
}

export function unifiedActionQueue(
  serviceTasks: readonly StaffServiceTask[],
  fulfillmentItems: readonly StaffFulfillmentItem[],
  actorId: string,
): StaffUnifiedAction[] {
  const actions: StaffUnifiedAction[] = [
    ...actionableServiceTasks(serviceTasks, actorId).map((task) => ({
      kind: 'service' as const, key: `service:${task.id}`, task,
    })),
    ...actionableFulfillmentItems(fulfillmentItems).map((item) => ({
      kind: 'fulfillment' as const, key: `fulfillment:${item.taskId}`, item,
    })),
  ]
  return actions.toSorted((left, right) => {
    const rank = unifiedActionRank(left) - unifiedActionRank(right)
    if (rank !== 0) return rank
    return unifiedActionTime(left) - unifiedActionTime(right)
  })
}

function unifiedActionRank(action: StaffUnifiedAction): number {
  if (action.kind === 'service') {
    if (action.task.interactionMode === 'manager_resolution'
      || action.task.taskType.includes('safety')) return 0
    if (action.task.priority === 'urgent') return 1
    if (action.task.assignedToActor) return 4
    return action.task.priority === 'high' ? 5 : 6
  }
  if (action.item.overdue) return 2
  if (action.item.readyForDelivery && action.item.canDeliver) {
    return action.item.table.assignmentType === null ? 5 : 3
  }
  return 8
}

function unifiedActionTime(action: StaffUnifiedAction): number {
  return action.kind === 'service'
    ? eventTime(action.task.dueAt ?? action.task.createdAt)
    : eventTime(action.item.dueAt ?? action.item.nextActionAt ?? action.item.createdAt)
}

export function fulfillmentAction(item: StaffFulfillmentItem): 'complete' | 'deliver' | null {
  if (item.canDeliver && item.readyForDelivery && item.kdsStatus === 'ready') return 'deliver'
  if (item.canPrepare && item.kdsStatus !== 'ready') return 'complete'
  return null
}

const TABLE_MOOD_PRESENTATION: Readonly<Record<string, { symbol: string; label: string }>> = Object.freeze({
  happy: { symbol: '☺', label: '开心' },
  excited: { symbol: '✦', label: '兴奋' },
  listening: { symbol: '♫', label: '听歌' },
  social: { symbol: '✧', label: '想互动' },
  celebrating: { symbol: '★', label: '庆祝' },
  quiet: { symbol: '☾', label: '安静' },
  tired: { symbol: '·', label: '有点累' },
  uncomfortable: { symbol: '!', label: '不太舒服' },
})

export function tableMoodPresentation(code: string): { symbol: string; label: string } {
  return TABLE_MOOD_PRESENTATION[code] ?? { symbol: '·', label: '客人状态' }
}

export function tableGroups(tables: readonly StaffActionTable[]): Array<{ area: string; tables: StaffActionTable[] }> {
  const groups = new Map<string, StaffActionTable[]>()
  for (const table of tables) {
    const current = groups.get(table.areaName) ?? []
    current.push(table)
    groups.set(table.areaName, current)
  }
  return [...groups.entries()].map(([area, values]) => ({
    area,
    tables: values.toSorted((left, right) => left.code.localeCompare(right.code, 'zh-CN', { numeric: true })),
  }))
}

export function guidanceForPermission(permission: StaffActionPermission): string {
  if (permission === 'table.open') return '当前账号只能查看桌台，请联系店长或有开台权限的同事处理。'
  if (permission === 'table.close') return '关台会结束本桌服务，请联系店长或有翻台权限的同事处理。'
  if (permission === 'table.transfer') return '转桌需要有转桌权限的同事处理，系统会保留原桌次和责任记录。'
  if (permission === 'service.execute') return '这项服务需要负责服务的同事或值班经理处理。'
  if (permission === 'kds.prepare') return '该出品只能由对应制作岗位完成。'
  return '该出品已制作完成，需要负责本桌或候补服务员确认送达。'
}

function eventTime(value: string): number {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER
}
