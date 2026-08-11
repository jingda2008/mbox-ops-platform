import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  ChefHat,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  Send,
  TableProperties,
  Users,
} from 'lucide-react'
import { StaffActionsApi, StaffActionsApiError, type StaffActionsApiPort } from './staff-actions-api'
import {
  actionableFulfillmentItems,
  actionableServiceTasks,
  fulfillmentAction,
  guidanceForPermission,
  hasPermission,
  requiresCapacityReason,
  tableGroups,
  validateOpenTableInput,
} from './staff-actions-model'
import type {
  StaffActionNotice,
  StaffActionsTab,
  StaffActionTable,
  StaffFulfillmentData,
  StaffOperationsData,
  StaffServiceTask,
} from './types'
import './staff-actions-panel.css'

export interface StaffActionsPanelProps {
  api?: StaffActionsApiPort
  initialTab?: StaffActionsTab
  onLoginRequired?: () => void
}

export function StaffActionsPanel({
  api: suppliedApi,
  initialTab = 'tables',
  onLoginRequired,
}: StaffActionsPanelProps) {
  const api = useMemo(() => suppliedApi ?? new StaffActionsApi(), [suppliedApi])
  const [tab, setTab] = useState<StaffActionsTab>(initialTab)
  const [operations, setOperations] = useState<StaffOperationsData | null>(null)
  const [fulfillment, setFulfillment] = useState<StaffFulfillmentData | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [notice, setNotice] = useState<StaffActionNotice>(null)
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null)
  const [guestCount, setGuestCount] = useState('')
  const [capacityReason, setCapacityReason] = useState('')
  const [transferTargetId, setTransferTargetId] = useState<string | null>(null)
  const [transferReason, setTransferReason] = useState('')
  const [closeConfirm, setCloseConfirm] = useState(false)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const noticeRef = useRef<HTMLDivElement | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null)
  const requestRef = useRef<AbortController | null>(null)

  const showNotice = useCallback((nextNotice: Exclude<StaffActionNotice, null>) => {
    if (noticeTimerRef.current !== null) globalThis.clearTimeout(noticeTimerRef.current)
    setNotice(nextNotice)
    globalThis.setTimeout(() => noticeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0)
    noticeTimerRef.current = globalThis.setTimeout(() => {
      setNotice(null)
      noticeTimerRef.current = null
    }, nextNotice.kind === 'guidance' ? 6_000 : 3_200)
  }, [])

  const load = useCallback(async (quiet = false) => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    if (!quiet) setPhase('loading')
    try {
      const [nextOperations, nextFulfillment] = await Promise.all([
        api.loadOperations(controller.signal),
        api.loadFulfillment(controller.signal),
      ])
      setOperations(nextOperations)
      setFulfillment(nextFulfillment)
      setPhase('ready')
    } catch (error) {
      if (error instanceof StaffActionsApiError && error.code === 'ABORTED') return
      setPhase('error')
      showNotice({ kind: 'error', message: actionError(error, '现场数据暂时无法读取，请重试') })
      if (error instanceof StaffActionsApiError && error.status === 401) onLoginRequired?.()
    }
  }, [api, onLoginRequired, showNotice])

  useEffect(() => {
    void load()
    return () => {
      requestRef.current?.abort()
      if (noticeTimerRef.current !== null) globalThis.clearTimeout(noticeTimerRef.current)
    }
  }, [load])

  const revealPermissionGuidance = useCallback((permission: Parameters<typeof guidanceForPermission>[0]) => {
    showNotice({ kind: 'guidance', message: guidanceForPermission(permission) })
  }, [showNotice])

  const selectedTable = operations?.tables.find((table) => table.id === selectedTableId) ?? null
  const permissions = operations?.actor.capabilities ?? []
  const serviceTasks = operations === null ? [] : actionableServiceTasks(operations.tasks, operations.actor.id)
  const fulfillmentItems = fulfillment === null ? [] : actionableFulfillmentItems(fulfillment.workItems)

  const selectTable = (table: StaffActionTable) => {
    setSelectedTableId(table.id)
    setGuestCount('')
    setCapacityReason('')
    setTransferTargetId(null)
    setTransferReason('')
    setCloseConfirm(false)
    setNotice(null)
  }

  const openTable = async () => {
    if (operations === null || selectedTable === null) return
    if (!hasPermission(permissions, 'table.open')) return revealPermissionGuidance('table.open')
    const validated = validateOpenTableInput(selectedTable, guestCount, capacityReason)
    if ('error' in validated) return showNotice({ kind: 'error', message: validated.error })
    const snapshot = operations
    const optimisticSession = {
      id: `optimistic-${selectedTable.id}`,
      guestCount: validated.guestCount,
      status: 'open' as const,
      openedAt: new Date().toISOString(),
    }
    setPendingAction(`table:${selectedTable.id}`)
    setOperations(replaceTableSession(snapshot, selectedTable.id, optimisticSession))
    try {
      await api.openTable({ tableId: selectedTable.id, ...validated })
      showNotice({ kind: 'success', message: `${selectedTable.code} 已开台，${validated.guestCount}人` })
      await load(true)
    } catch (error) {
      setOperations(snapshot)
      showNotice({ kind: 'error', message: actionError(error, '开台未完成，桌台状态已恢复') })
    } finally {
      setPendingAction(null)
    }
  }

  const closeTable = async () => {
    if (operations === null || selectedTable?.activeSession === null || selectedTable === null) return
    if (!hasPermission(permissions, 'table.close')) return revealPermissionGuidance('table.close')
    if (!closeConfirm) {
      setCloseConfirm(true)
      return
    }
    const snapshot = operations
    const sessionId = selectedTable.activeSession.id
    setPendingAction(`table:${selectedTable.id}`)
    setOperations(replaceTableSession(snapshot, selectedTable.id, null))
    try {
      await api.closeTable(sessionId)
      showNotice({ kind: 'success', message: `${selectedTable.code} 已关台，可安排下一桌客人` })
      setCloseConfirm(false)
      await load(true)
    } catch (error) {
      if (error instanceof StaffActionsApiError && error.partialMutation) await load(true)
      else setOperations(snapshot)
      showNotice({ kind: 'error', message: actionError(error, '关台未完成，已恢复真实桌台状态') })
    } finally {
      setPendingAction(null)
    }
  }

  const transferTable = async () => {
    if (operations === null || selectedTable?.activeSession === null || selectedTable === null || transferTargetId === null) return
    if (!hasPermission(permissions, 'table.transfer')) return revealPermissionGuidance('table.transfer')
    const target = operations.tables.find((table) => table.id === transferTargetId)
    if (target === undefined) return showNotice({ kind: 'error', message: '请选择有效的目标桌台' })
    const needsReason = selectedTable.activeSession.guestCount > target.capacity
    if (needsReason && transferReason.trim().length === 0) {
      return showNotice({ kind: 'error', message: `人数超过${target.code}容量${target.capacity}人，请填写加座说明` })
    }
    const snapshot = operations
    const session = selectedTable.activeSession
    setPendingAction(`table:${selectedTable.id}`)
    setOperations(transferSession(snapshot, selectedTable.id, target.id, session))
    try {
      await api.transferTable({
        tableSessionId: session.id,
        targetTableId: target.id,
        ...(needsReason ? { capacityOverrideReason: transferReason.trim() } : {}),
      })
      showNotice({ kind: 'success', message: `${selectedTable.code} 已转至 ${target.code}` })
      setSelectedTableId(target.id)
      setTransferTargetId(null)
      setTransferReason('')
      await load(true)
    } catch (error) {
      setOperations(snapshot)
      showNotice({ kind: 'error', message: actionError(error, '转桌未完成，桌台状态已恢复') })
    } finally {
      setPendingAction(null)
    }
  }

  const completeServiceTask = async (task: StaffServiceTask) => {
    if (operations === null) return
    if (!hasPermission(permissions, 'service.execute')) return revealPermissionGuidance('service.execute')
    const snapshot = operations
    setPendingAction(`service:${task.id}`)
    setOperations({ ...snapshot, tasks: snapshot.tasks.filter((item) => item.id !== task.id) })
    try {
      await api.completeServiceTask(task.id)
      showNotice({ kind: 'success', message: `${task.tableCode} 的“${task.title}”已完成` })
      await load(true)
    } catch (error) {
      setOperations(snapshot)
      showNotice({ kind: 'error', message: actionError(error, '服务任务未完成，任务已恢复') })
    } finally {
      setPendingAction(null)
    }
  }

  const runFulfillmentAction = async (item: StaffFulfillmentData['workItems'][number]) => {
    if (fulfillment === null) return
    const action = fulfillmentAction(item)
    if (action === null) {
      return revealPermissionGuidance(item.readyForDelivery ? 'kds.deliver' : 'kds.prepare')
    }
    const snapshot = fulfillment
    setPendingAction(`kds:${item.taskId}`)
    setFulfillment({ ...snapshot, workItems: snapshot.workItems.filter((entry) => entry.taskId !== item.taskId) })
    try {
      await api.runKdsAction(item.taskId, action)
      showNotice({
        kind: 'success',
        message: action === 'deliver'
          ? `${item.table.code} · ${item.item.productName} 已送达`
          : `${item.item.productName} 已制作完成，配送岗位已收到`,
      })
      await load(true)
    } catch (error) {
      setFulfillment(snapshot)
      showNotice({ kind: 'error', message: actionError(error, '出品状态未更新，任务已恢复') })
    } finally {
      setPendingAction(null)
    }
  }

  if (operations === null && phase === 'loading') {
    return <div className="staff-actions-gate"><LoaderCircle className="is-spinning" /> 正在读取现场</div>
  }

  return (
    <section className="staff-actions-panel" aria-label="现场高频操作">
      <header className="staff-actions-header">
        <div>
          <p>现场执行</p>
          <h2>现在要处理什么</h2>
        </div>
        <button type="button" className="staff-actions-icon" aria-label="刷新现场" onClick={() => void load()}>
          <RefreshCw size={18} className={phase === 'loading' ? 'is-spinning' : ''} />
        </button>
      </header>

      <div ref={noticeRef} className={`staff-actions-notice ${notice === null ? 'is-hidden' : `is-${notice.kind}`}`} role="status">
        {notice?.kind === 'error' ? <CircleAlert size={18} /> : notice?.kind === 'guidance' ? <AlertTriangle size={18} /> : <Check size={18} />}
        <span>{notice?.message}</span>
        {notice !== null && <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>×</button>}
      </div>

      <nav className="staff-actions-tabs" aria-label="现场工作分类">
        <TabButton active={tab === 'tables'} label="桌台" count={operations?.tables.length ?? 0} onClick={() => setTab('tables')} />
        <TabButton active={tab === 'service'} label="服务" count={serviceTasks.length} onClick={() => setTab('service')} />
        <TabButton active={tab === 'fulfillment'} label="出品" count={fulfillmentItems.length} onClick={() => setTab('fulfillment')} />
      </nav>

      {phase === 'error' && operations !== null && <p className="staff-actions-stale">刷新失败，当前显示上次成功数据。</p>}

      {tab === 'tables' && operations !== null && (
        <div className="staff-table-workspace">
          {tableGroups(operations.tables).map((group) => (
            <section className="staff-table-area" key={group.area}>
              <h3>{group.area}</h3>
              <div className="staff-table-grid">
                {group.tables.map((table) => (
                  <button
                    type="button"
                    className={`staff-table-tile ${table.activeSession === null ? '' : 'is-open'} ${selectedTableId === table.id ? 'is-selected' : ''}`}
                    key={table.id}
                    onClick={() => selectTable(table)}
                    disabled={pendingAction === `table:${table.id}`}
                  >
                    <strong>{table.code}</strong>
                    <span>{table.activeSession === null ? `${table.capacity}人` : `${table.activeSession.guestCount}人 · 已开台`}</span>
                    {table.assignedToActor && <small>负责桌</small>}
                  </button>
                ))}
              </div>
            </section>
          ))}
          {selectedTable !== null && (
            <TableActionSheet
              table={selectedTable}
              allTables={operations.tables}
              permissions={permissions}
              guestCount={guestCount}
              capacityReason={capacityReason}
              transferTargetId={transferTargetId}
              transferReason={transferReason}
              closeConfirm={closeConfirm}
              pending={pendingAction === `table:${selectedTable.id}`}
              onGuestCount={setGuestCount}
              onCapacityReason={setCapacityReason}
              onTransferTarget={setTransferTargetId}
              onTransferReason={setTransferReason}
              onOpen={() => void openTable()}
              onClose={() => void closeTable()}
              onTransfer={() => void transferTable()}
              onPermissionGuidance={revealPermissionGuidance}
              onCancelClose={() => setCloseConfirm(false)}
            />
          )}
        </div>
      )}

      {tab === 'service' && operations !== null && (
        <ActionList empty="当前没有需要处理的服务任务">
          {serviceTasks.map((task) => (
            <article className={`staff-action-card priority-${task.priority}`} key={task.id}>
              <div className="staff-action-card-main">
                <strong>{task.tableCode} · {task.title}</strong>
                {task.detail !== null && <p>{task.detail}</p>}
                <small>{task.priority === 'urgent' ? '紧急' : task.priority === 'high' ? '优先处理' : '待处理'}</small>
              </div>
              {hasPermission(permissions, 'service.execute') ? (
                <button type="button" onClick={() => void completeServiceTask(task)} disabled={pendingAction === `service:${task.id}`}>
                  <Check size={18} /> 完成
                </button>
              ) : (
                <button type="button" className="is-readonly" onClick={() => revealPermissionGuidance('service.execute')}>查看说明</button>
              )}
            </article>
          ))}
        </ActionList>
      )}

      {tab === 'fulfillment' && (
        <ActionList empty="当前岗位没有需要制作或配送的出品">
          {fulfillmentItems.map((item) => {
            const action = fulfillmentAction(item)
            return (
              <article className={`staff-action-card ${item.overdue ? 'is-overdue' : ''}`} key={item.taskId}>
                <div className="staff-action-card-main">
                  <strong>{item.table.code} · {item.item.productName} × {item.item.quantity}</strong>
                  <p>{item.stationCode === 'bar' ? '吧台' : item.stationCode === 'kitchen' ? '后厨' : '收银'} · {item.readyForDelivery ? '待配送' : '待制作'}</p>
                  {item.attentionMessages.map((message) => <small className="staff-action-note" key={message}>备注：{message}</small>)}
                  {item.overdue && <small className="staff-action-overdue">已超时，优先处理</small>}
                </div>
                {action !== null && (
                  <button type="button" onClick={() => void runFulfillmentAction(item)} disabled={pendingAction === `kds:${item.taskId}`}>
                    {action === 'deliver' ? <Send size={18} /> : <ChefHat size={18} />}
                    {action === 'deliver' ? '已送达' : '制作完成'}
                  </button>
                )}
              </article>
            )
          })}
        </ActionList>
      )}

      <span className="staff-actions-announcer" aria-live="polite">
        {pendingAction === null ? '' : '操作正在后台确认'}
      </span>
    </section>
  )
}

interface TableActionSheetProps {
  table: StaffActionTable
  allTables: StaffActionTable[]
  permissions: readonly string[]
  guestCount: string
  capacityReason: string
  transferTargetId: string | null
  transferReason: string
  closeConfirm: boolean
  pending: boolean
  onGuestCount(value: string): void
  onCapacityReason(value: string): void
  onTransferTarget(value: string | null): void
  onTransferReason(value: string): void
  onOpen(): void
  onClose(): void
  onTransfer(): void
  onPermissionGuidance(permission: 'table.open' | 'table.close' | 'table.transfer'): void
  onCancelClose(): void
}

function TableActionSheet(props: TableActionSheetProps) {
  const { table } = props
  const guestNumber = /^\d+$/.test(props.guestCount) ? Number(props.guestCount) : null
  const transferTarget = props.allTables.find((candidate) => candidate.id === props.transferTargetId) ?? null
  const transferNeedsReason = transferTarget !== null && table.activeSession !== null
    && table.activeSession.guestCount > transferTarget.capacity
  const availableTargets = props.allTables.filter((candidate) => (
    candidate.id !== table.id && candidate.status === 'available' && candidate.activeSession === null
  ))

  return (
    <section className="staff-table-sheet" aria-label={`${table.code}桌台操作`}>
      <header>
        <span className="staff-table-sheet-icon"><TableProperties size={20} /></span>
        <div><strong>{table.code} · {table.displayName}</strong><small>{table.areaName} · 容量{table.capacity}人</small></div>
        <span className={table.activeSession === null ? 'status-free' : 'status-open'}>{table.activeSession === null ? '空闲' : '已开台'}</span>
      </header>

      {table.activeSession === null ? (
        <div className="staff-open-table">
          <label><Users size={17} /> 实际到店人数</label>
          <div className="staff-count-picks">
            {Array.from({ length: Math.min(8, Math.max(4, table.capacity + 2)) }, (_, index) => index + 1).map((count) => (
              <button type="button" className={props.guestCount === String(count) ? 'is-active' : ''} key={count} onClick={() => props.onGuestCount(String(count))}>{count}</button>
            ))}
            <input
              inputMode="numeric"
              pattern="[0-9]*"
              min="1"
              max="200"
              value={props.guestCount}
              aria-label="实际到店人数"
              placeholder="其他"
              onChange={(event) => props.onGuestCount(event.target.value.replace(/\D/g, '').slice(0, 3))}
            />
          </div>
          {requiresCapacityReason(table, guestNumber) && (
            <label className="staff-capacity-reason">
              加座说明
              <input value={props.capacityReason} maxLength={1000} placeholder="例如：现场加2把椅子，通道已确认" onChange={(event) => props.onCapacityReason(event.target.value)} />
            </label>
          )}
          {hasPermission(props.permissions, 'table.open') ? (
            <button className="staff-primary-action" type="button" onClick={props.onOpen} disabled={props.pending || props.guestCount.length === 0}>
              {props.pending ? <LoaderCircle className="is-spinning" size={18} /> : <Check size={18} />} 确认开台
            </button>
          ) : (
            <button className="staff-guidance-action" type="button" onClick={() => props.onPermissionGuidance('table.open')}>联系有权限同事开台</button>
          )}
        </div>
      ) : (
        <div className="staff-open-session">
          <p><strong>{table.activeSession.guestCount}人</strong><span>本桌服务进行中</span></p>
          <div className="staff-session-actions">
            {hasPermission(props.permissions, 'table.transfer') ? (
              <button type="button" onClick={() => props.onTransferTarget(props.transferTargetId === null ? '' : null)}><ArrowRightLeft size={17} /> 转桌</button>
            ) : (
              <button type="button" onClick={() => props.onPermissionGuidance('table.transfer')}>转桌说明</button>
            )}
            {hasPermission(props.permissions, 'table.close') ? (
              <button type="button" className="is-danger" onClick={props.onClose}>{props.closeConfirm ? '再次确认关台' : '关台/翻台'}</button>
            ) : (
              <button type="button" onClick={() => props.onPermissionGuidance('table.close')}>关台说明</button>
            )}
          </div>
          {props.closeConfirm && <button type="button" className="staff-cancel-confirm" onClick={props.onCancelClose}>取消关台</button>}
          {props.transferTargetId !== null && (
            <div className="staff-transfer-targets">
              <strong>选择空闲目标桌台</strong>
              <div>
                {availableTargets.map((candidate) => (
                  <button
                    type="button"
                    className={props.transferTargetId === candidate.id ? 'is-active' : ''}
                    key={candidate.id}
                    onClick={() => props.onTransferTarget(candidate.id)}
                  >{candidate.code}<small>{candidate.capacity}人</small></button>
                ))}
              </div>
              {availableTargets.length === 0 && <p>当前没有可转入的空闲桌台。</p>}
              {transferNeedsReason && (
                <label>加座说明<input value={props.transferReason} maxLength={1000} placeholder="说明加座及现场安全确认" onChange={(event) => props.onTransferReason(event.target.value)} /></label>
              )}
              <button className="staff-primary-action" type="button" onClick={props.onTransfer} disabled={props.pending || transferTarget === null}>确认转桌</button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function TabButton({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick(): void }) {
  return <button type="button" className={active ? 'is-active' : ''} aria-current={active ? 'page' : undefined} onClick={onClick}><span>{label}</span><small>{count}</small></button>
}

function ActionList({ children, empty }: { children: React.ReactNode; empty: string }) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : children !== null && children !== undefined
  return <div className="staff-action-list">{hasChildren ? children : <p className="staff-actions-empty">{empty}</p>}</div>
}

function replaceTableSession(
  data: StaffOperationsData,
  tableId: string,
  session: StaffActionTable['activeSession'],
): StaffOperationsData {
  return { ...data, tables: data.tables.map((table) => table.id === tableId ? { ...table, activeSession: session } : table) }
}

function transferSession(
  data: StaffOperationsData,
  sourceTableId: string,
  targetTableId: string,
  session: NonNullable<StaffActionTable['activeSession']>,
): StaffOperationsData {
  return {
    ...data,
    tables: data.tables.map((table) => {
      if (table.id === sourceTableId) return { ...table, activeSession: null }
      if (table.id === targetTableId) return { ...table, activeSession: session }
      return table
    }),
  }
}

function actionError(error: unknown, fallback: string): string {
  if (error instanceof StaffActionsApiError || error instanceof Error) return error.message
  return fallback
}
