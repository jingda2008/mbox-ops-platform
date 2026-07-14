import type {
  BootstrapResponse,
  ServiceTypeConfig,
  TableStatus,
  TaskActionInput,
  TaskPriority,
  TaskStatus,
} from './shared/contracts'

const DATABASE_NAME = 'mbox-ops-offline-v1'
const DATABASE_VERSION = 1
const QUEUE_STORE = 'task-actions'
const SNAPSHOT_STORE = 'snapshots'
const LATEST_SNAPSHOT_KEY = 'latest-safe-onsite-snapshot'

export interface OfflineSnapshot {
  schemaVersion: 1
  capturedAt: string
  store: {
    name: string
    businessDate: string
  }
  metrics: {
    occupiedTables: number
    openTasks: number
    atRiskTasks: number
    escalatedTasks: number
    complaints: number
  }
  areas: Array<{
    id: string
    name: string
    shortName: string
    color: string
    sortOrder: number
  }>
  tables: Array<{
    id: string
    code: string
    displayName: string
    areaId: string
    status: TableStatus
    guestCount: number
  }>
  serviceTypes: Array<Pick<ServiceTypeConfig, 'id' | 'name' | 'icon' | 'actionScript'>>
  tasks: Array<{
    id: string
    tableId: string
    serviceTypeId: string
    status: TaskStatus
    priority: TaskPriority
    ownerId: string | null
    createdAt: string
    warningAt: string
    actionScript: string[]
  }>
}

export interface QueuedTaskAction {
  id: string
  taskId: string
  input: TaskActionInput
  createdAt: string
  sequence: number
  attempts: number
  status: 'pending' | 'conflict'
  conflictMessage: string | null
}

export interface OfflineConflict {
  queueId: string
  taskId: string
  idempotencyKey: string
  message: string
}

export interface OfflineStatus {
  online: boolean
  pendingCount: number
  syncing: boolean
  conflict: OfflineConflict | null
}

export interface ReplayResult {
  completedIds: string[]
  conflict: { item: QueuedTaskAction; message: string } | null
  error: unknown | null
}

type TaskActionSender = (item: QueuedTaskAction) => Promise<unknown>
type StatusListener = (status: OfflineStatus) => void

let databasePromise: Promise<IDBDatabase> | null = null
let taskActionSender: TaskActionSender | null = null
let replayPromise: Promise<void> | null = null
let networkReachable = true
let currentStatus: OfflineStatus = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  pendingCount: 0,
  syncing: false,
  conflict: null,
}
const statusListeners = new Set<StatusListener>()

export function sanitizeBootstrapSnapshot(data: BootstrapResponse): OfflineSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    store: {
      name: data.store.name,
      businessDate: data.store.businessDate,
    },
    metrics: {
      occupiedTables: data.metrics.occupiedTables,
      openTasks: data.metrics.openTasks,
      atRiskTasks: data.metrics.atRiskTasks,
      escalatedTasks: data.metrics.escalatedTasks,
      complaints: data.metrics.complaints,
    },
    areas: data.areas.map(({ id, name, shortName, color, sortOrder }) => ({
      id,
      name,
      shortName,
      color,
      sortOrder,
    })),
    tables: data.tables.map(({ id, code, displayName, areaId, status, guestCount }) => ({
      id,
      code,
      displayName,
      areaId,
      status,
      guestCount,
    })),
    serviceTypes: data.config.serviceTypes.map(({ id, name, icon, actionScript }) => ({
      id,
      name,
      icon,
      actionScript: [...actionScript],
    })),
    tasks: data.tasks
      .filter((task) => !['confirmed', 'cancelled'].includes(task.status))
      .map(({ id, tableId, serviceTypeId, status, priority, ownerId, createdAt, warningAt, actionScript }) => ({
        id,
        tableId,
        serviceTypeId,
        status,
        priority,
        ownerId,
        createdAt,
        warningAt,
        actionScript: [...actionScript],
      })),
  }
}

export function buildQueuedTaskAction(
  taskId: string,
  input: TaskActionInput,
  createdAt = new Date().toISOString(),
  sequence = Date.now() * 1000,
): QueuedTaskAction {
  return {
    id: input.idempotencyKey,
    taskId,
    input: { ...input },
    createdAt,
    sequence,
    attempts: 0,
    status: 'pending',
    conflictMessage: null,
  }
}

export async function replayQueuedActionsInOrder(
  items: QueuedTaskAction[],
  send: TaskActionSender,
): Promise<ReplayResult> {
  const completedIds: string[] = []
  const ordered = [...items].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))

  for (const item of ordered) {
    try {
      await send(item)
      completedIds.push(item.id)
    } catch (error) {
      if (httpStatus(error) === 409) {
        return {
          completedIds,
          conflict: { item, message: errorMessage(error, '任务状态冲突') },
          error: null,
        }
      }
      return { completedIds, conflict: null, error }
    }
  }

  return { completedIds, conflict: null, error: null }
}

export function isHighRiskOfflineWrite(path: string, method = 'GET') {
  if (method.toUpperCase() === 'GET') return false
  return [
    /^\/api\/payments(?:\/|$)/,
    /^\/api\/config(?:\/|$)/,
    /^\/api\/benefits(?:\/|$)/,
    /^\/api\/master-data(?:\/|$)/,
    /^\/api\/dev(?:\/|$)/,
    /^\/api\/songs\/requests(?:\/|$)/,
    /^\/api\/commerce\/quick-orders(?:\/|$)/,
  ].some((pattern) => pattern.test(path))
}

export function getOfflineStatus() {
  return { ...currentStatus }
}

export function subscribeOfflineStatus(listener: StatusListener) {
  statusListeners.add(listener)
  listener(getOfflineStatus())
  return () => {
    statusListeners.delete(listener)
  }
}

export function reportNetworkUnavailable() {
  networkReachable = false
  setStatus({ online: false, syncing: false })
}

export function reportNetworkAvailable() {
  networkReachable = true
  setStatus({ online: isOnline() })
}

export async function saveOfflineSnapshot(snapshot: OfflineSnapshot) {
  await putRecord(SNAPSHOT_STORE, { id: LATEST_SNAPSHOT_KEY, snapshot })
}

export async function loadOfflineSnapshot(): Promise<OfflineSnapshot | null> {
  const record = await getRecord<{ id: string; snapshot: OfflineSnapshot }>(SNAPSHOT_STORE, LATEST_SNAPSHOT_KEY)
  return record?.snapshot ?? null
}

export async function queueTaskAction(taskId: string, input: TaskActionInput) {
  const existing = await getRecord<QueuedTaskAction>(QUEUE_STORE, input.idempotencyKey)
  if (existing) return existing

  const queued = await getAllRecords<QueuedTaskAction>(QUEUE_STORE)
  const sequence = Math.max(Date.now() * 1000, ...queued.map((item) => item.sequence + 1))
  const item = buildQueuedTaskAction(taskId, input, new Date().toISOString(), sequence)
  await putRecord(QUEUE_STORE, item)
  await refreshOfflineStatus()
  return item
}

export async function replayTaskActionQueue() {
  if (replayPromise) return replayPromise
  if (!taskActionSender || !isOnline()) return

  replayPromise = (async () => {
    setStatus({ online: true, syncing: true })
    const queued = await getAllRecords<QueuedTaskAction>(QUEUE_STORE)
    const result = await replayQueuedActionsInOrder(queued, taskActionSender!)

    for (const id of result.completedIds) await deleteRecord(QUEUE_STORE, id)

    if (result.conflict) {
      await putRecord(QUEUE_STORE, {
        ...result.conflict.item,
        attempts: result.conflict.item.attempts + 1,
        status: 'conflict',
        conflictMessage: result.conflict.message,
      } satisfies QueuedTaskAction)
    }

    await refreshOfflineStatus()
  })().finally(() => {
    replayPromise = null
    setStatus({ syncing: false })
  })

  return replayPromise
}

export async function discardConflictedTaskAction(queueId: string) {
  const item = await getRecord<QueuedTaskAction>(QUEUE_STORE, queueId)
  if (!item || item.status !== 'conflict') return
  await deleteRecord(QUEUE_STORE, queueId)
  await refreshOfflineStatus()
  await replayTaskActionQueue()
}

export function startOfflineRuntime(sender: TaskActionSender) {
  taskActionSender = sender

  const handleOnline = () => {
    networkReachable = true
    setStatus({ online: true })
    void replayTaskActionQueue()
  }
  const handleOffline = () => {
    networkReachable = false
    setStatus({ online: false, syncing: false })
  }

  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
  void refreshOfflineStatus().then(() => {
    if (isOnline()) void replayTaskActionQueue()
  })

  return () => {
    window.removeEventListener('online', handleOnline)
    window.removeEventListener('offline', handleOffline)
  }
}

async function refreshOfflineStatus() {
  const queued = await getAllRecords<QueuedTaskAction>(QUEUE_STORE)
  const conflictItem = [...queued]
    .sort((left, right) => left.sequence - right.sequence)
    .find((item) => item.status === 'conflict')
  setStatus({
    online: isOnline(),
    pendingCount: queued.length,
    conflict: conflictItem
      ? {
          queueId: conflictItem.id,
          taskId: conflictItem.taskId,
          idempotencyKey: conflictItem.input.idempotencyKey,
          message: conflictItem.conflictMessage ?? '任务状态冲突',
        }
      : null,
  })
}

function setStatus(patch: Partial<OfflineStatus>) {
  currentStatus = { ...currentStatus, ...patch }
  const snapshot = getOfflineStatus()
  statusListeners.forEach((listener) => listener(snapshot))
}

function isOnline() {
  return (typeof navigator === 'undefined' || navigator.onLine) && networkReachable
}

function httpStatus(error: unknown) {
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
    return error.status
  }
  return null
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function openDatabase() {
  if (databasePromise) return databasePromise
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(QUEUE_STORE)) {
        database.createObjectStore(QUEUE_STORE, { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
        database.createObjectStore(SNAPSHOT_STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开离线数据库'))
  })
  return databasePromise
}

async function getRecord<T>(storeName: string, key: IDBValidKey): Promise<T | null> {
  const database = await openDatabase()
  return new Promise<T | null>((resolve, reject) => {
    const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(key)
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null)
    request.onerror = () => reject(request.error ?? new Error('读取离线数据失败'))
  })
}

async function getAllRecords<T>(storeName: string): Promise<T[]> {
  const database = await openDatabase()
  return new Promise<T[]>((resolve, reject) => {
    const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAll()
    request.onsuccess = () => resolve(request.result as T[])
    request.onerror = () => reject(request.error ?? new Error('读取离线队列失败'))
  })
}

async function putRecord(storeName: string, value: unknown) {
  const database = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).put(value)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('写入离线数据失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('写入离线数据已中止'))
  })
}

async function deleteRecord(storeName: string, key: IDBValidKey) {
  const database = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('删除离线数据失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('删除离线数据已中止'))
  })
}
