import { Children, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRightLeft,
  CalendarDays,
  Check,
  ChefHat,
  CircleAlert,
  Gift,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  Search,
  Send,
  ShoppingCart,
  Sparkles,
  TableProperties,
  Users,
} from 'lucide-react'
import { StaffActionsApi, StaffActionsApiError, type StaffActionsApiPort } from './staff-actions-api'
import { AssistedOrderSheet } from './AssistedOrderSheet'
import { ResponsibilityAssignmentPanel } from './ResponsibilityAssignmentPanel'
import { TableObservationSheet } from './TableObservationSheet'
import { TableRecommendationSheet } from './TableRecommendationSheet'
import { ParticipantMovementSheet } from './ParticipantMovementSheet'
import {
  fulfillmentAction,
  actionableFulfillmentItems,
  actionableServiceTasks,
  guidanceForPermission,
  hasPermission,
  requiresCapacityReason,
  tableMoodPresentation,
  tableGroups,
  validateOpenTableInput,
  visibleStaffTables,
  type StaffTableScope,
} from './staff-actions-model'
import type {
  StaffActionNotice,
  StaffActionsTab,
  StaffActionTable,
  StaffFulfillmentData,
  StaffOperationsData,
  StaffReservation,
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
  initialTab = 'tasks',
  onLoginRequired,
}: StaffActionsPanelProps) {
  const api = useMemo(() => suppliedApi ?? new StaffActionsApi(), [suppliedApi])
  const [tab, setTab] = useState<StaffActionsTab>(initialTab)
  const [operations, setOperations] = useState<StaffOperationsData | null>(null)
  const [fulfillment, setFulfillment] = useState<StaffFulfillmentData | null>(null)
  const [reservations, setReservations] = useState<StaffReservation[] | null>(null)
  const [reservationMessage, setReservationMessage] = useState<string | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [notice, setNotice] = useState<StaffActionNotice>(null)
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null)
  const [guestCount, setGuestCount] = useState('')
  const [capacityReason, setCapacityReason] = useState('')
  const [transferTargetId, setTransferTargetId] = useState<string | null>(null)
  const [transferReason, setTransferReason] = useState('')
  const [closeConfirm, setCloseConfirm] = useState(false)
  const [resolutionNotes, setResolutionNotes] = useState<Record<string, string>>({})
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [orderSheetMode, setOrderSheetMode] = useState<'paid' | 'gift' | null>(null)
  const [observationOpen, setObservationOpen] = useState(false)
  const [recommendationOpen, setRecommendationOpen] = useState(false)
  const [participantMovementOpen,setParticipantMovementOpen]=useState(false)
  const [tableScope, setTableScope] = useState<StaffTableScope>('attention')
  const [tableQuery, setTableQuery] = useState('')
  const noticeRef = useRef<HTMLDivElement | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const reservationRequestRef = useRef<AbortController | null>(null)
  const knownActionKeysRef = useRef<Set<string> | null>(null)
  const actionLocksRef = useRef(new Set<string>())
  const pendingActionRef = useRef<string | null>(null)

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
      const [operationsResult, fulfillmentResult] = await Promise.allSettled([
        api.loadOperations(controller.signal),
        api.loadFulfillment(controller.signal),
      ])
      if (operationsResult.status === 'rejected') throw operationsResult.reason
      setOperations(operationsResult.value)
      if (fulfillmentResult.status === 'fulfilled') {
        setFulfillment(fulfillmentResult.value)
      } else if (fulfillmentResult.reason instanceof StaffActionsApiError
        && fulfillmentResult.reason.status === 401) {
        throw fulfillmentResult.reason
      } else {
        setFulfillment(null)
        if (!(fulfillmentResult.reason instanceof StaffActionsApiError
          && fulfillmentResult.reason.status === 403)) {
          showNotice({ kind: 'error', message: '桌台与服务已更新，出品待办暂时无法读取' })
        }
      }
      setPhase('ready')
    } catch (error) {
      if (error instanceof StaffActionsApiError && error.code === 'ABORTED') return
      setPhase('error')
      showNotice({ kind: 'error', message: actionError(error, '现场数据暂时无法读取，请重试') })
      if (error instanceof StaffActionsApiError && error.status === 401) onLoginRequired?.()
    }
  }, [api, onLoginRequired, showNotice])

  const loadReservations = useCallback(async () => {
    reservationRequestRef.current?.abort()
    const controller = new AbortController()
    reservationRequestRef.current = controller
    try {
      setReservations(await api.loadReservations(controller.signal))
      setReservationMessage(null)
    } catch (error) {
      if (error instanceof StaffActionsApiError && error.code === 'ABORTED') return
      if (error instanceof StaffActionsApiError && error.status === 401) {
        onLoginRequired?.()
        return
      }
      if (error instanceof StaffActionsApiError && error.status === 403) {
        setReservations([])
        setReservationMessage('当前岗位没有预约查看权限')
        return
      }
      setReservations([])
      setReservationMessage('预约信息暂时无法读取，请刷新重试')
    }
  }, [api, onLoginRequired])

  useEffect(() => {
    void load()
    return () => {
      requestRef.current?.abort()
      reservationRequestRef.current?.abort()
      if (noticeTimerRef.current !== null) globalThis.clearTimeout(noticeTimerRef.current)
    }
  }, [load])

  useEffect(() => setTab(initialTab), [initialTab])

  useEffect(() => {
    pendingActionRef.current = pendingAction
  }, [pendingAction])

  useEffect(() => {
    if (tab !== 'reservations') return
    void loadReservations()
    const timer = globalThis.setInterval(() => {
      if (document.visibilityState === 'visible' && pendingActionRef.current === null) void loadReservations()
    }, 15_000)
    return () => globalThis.clearInterval(timer)
  }, [loadReservations, tab])

  useEffect(() => {
    const poll = () => {
      if (document.visibilityState === 'visible' && pendingAction === null) void load(true)
    }
    const timer = globalThis.setInterval(poll, 5_000)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') poll()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      globalThis.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [load, pendingAction])

  const revealPermissionGuidance = useCallback((permission: Parameters<typeof guidanceForPermission>[0]) => {
    showNotice({ kind: 'guidance', message: guidanceForPermission(permission) })
  }, [showNotice])

  const selectedTable = operations?.tables.find((table) => table.id === selectedTableId) ?? null
  const permissions = operations?.actor.capabilities ?? []
  const serviceActions = useMemo(() => operations === null
    ? []
    : actionableServiceTasks(operations.tasks, operations.actor.id), [operations])
  const fulfillmentActions = useMemo(() => actionableFulfillmentItems(fulfillment?.workItems ?? []), [fulfillment])
  const attentionTableIds = useMemo(() => new Set([
    ...serviceActions.map((task) => task.tableId),
    ...fulfillmentActions.map((item) => item.table.id),
  ]), [fulfillmentActions, serviceActions])
  const visibleTables = useMemo(() => visibleStaffTables(
    operations?.tables ?? [], tableScope, tableQuery, attentionTableIds,
  ), [attentionTableIds, operations?.tables, tableQuery, tableScope])
  const currentActionKeys = useMemo(() => [
    ...serviceActions.map((task) => `service:${task.id}`),
    ...fulfillmentActions.map((item) => `fulfillment:${item.taskId}`),
  ], [fulfillmentActions, serviceActions])

  useEffect(() => {
    const current = new Set(currentActionKeys)
    const previous = knownActionKeysRef.current
    knownActionKeysRef.current = current
    if (previous === null || pendingAction !== null) return
    const hasNewAttention = serviceActions.some((task) => (
      !previous.has(`service:${task.id}`)
      && (task.priority === 'urgent' || task.interactionMode === 'manager_resolution')
    )) || fulfillmentActions.some((item) => (
      !previous.has(`fulfillment:${item.taskId}`) && (item.readyForDelivery || item.overdue)
    ))
    if (hasNewAttention && typeof navigator.vibrate === 'function') navigator.vibrate([18, 45, 18])
  }, [currentActionKeys, fulfillmentActions, pendingAction, serviceActions])

  const selectTable = (table: StaffActionTable) => {
    setSelectedTableId(table.id)
    setGuestCount('')
    setCapacityReason('')
    setTransferTargetId(null)
    setTransferReason('')
    setCloseConfirm(false)
    setNotice(null)
    setOrderSheetMode(null)
    setObservationOpen(false)
    setRecommendationOpen(false)
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
      capacityAtOpen: selectedTable.capacity,
      status: 'open' as const,
      openedAt: new Date().toISOString(),
      latestMood: null,
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
    const actionKey = `table-close:${sessionId}`
    if (actionLocksRef.current.has(actionKey)) return
    actionLocksRef.current.add(actionKey)
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
      actionLocksRef.current.delete(actionKey)
      setPendingAction(null)
    }
  }

  const actOnReservation = async (reservation: StaffReservation, action: 'confirm' | 'arrive') => {
    const actionKey = `reservation:${reservation.id}:${action}`
    if (actionLocksRef.current.has(actionKey)) return
    actionLocksRef.current.add(actionKey)
    const snapshot = reservations
    setPendingAction(actionKey)
    setReservations((current) => current?.map((item) => item.id === reservation.id
      ? { ...item, status: action === 'confirm' ? 'confirmed' : 'arrived' }
      : item) ?? null)
    try {
      await api.actOnReservation(reservation.id, action)
      showNotice({
        kind: 'success',
        message: action === 'confirm'
          ? `${reservation.customerName} 的预约已确认`
          : `${reservation.customerName} 已登记到店`,
      })
      await loadReservations()
    } catch (error) {
      setReservations(snapshot)
      showNotice({ kind: 'error', message: actionError(error, '预约状态未更新，请重试') })
    } finally {
      actionLocksRef.current.delete(actionKey)
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
    const resolutionNote = resolutionNotes[task.id]?.trim()
    if (task.interactionMode === 'manager_resolution' && (resolutionNote?.length ?? 0) < 4) {
      return showNotice({ kind: 'guidance', message: '投诉需要值班经理简要记录现场处理结果后再完成' })
    }
    const snapshot = operations
    setPendingAction(`service:${task.id}`)
    setOperations({ ...snapshot, tasks: snapshot.tasks.filter((item) => item.id !== task.id) })
    try {
      await api.completeServiceTask(task.id, resolutionNote)
      setResolutionNotes((current) => {
        const next = { ...current }
        delete next[task.id]
        return next
      })
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
          <p>{tab === 'tables' ? '现场调度' : tab === 'tasks' ? '服务执行' : tab === 'fulfillment' ? '出品履约' : '预约接待'}</p>
          <h1>{tab === 'tables' ? '找到桌台，直接处理' : tab === 'tasks' ? '只看需要服务的事' : tab === 'fulfillment' ? '只做当前下一步' : '确认预约与到店'}</h1>
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

      {phase === 'error' && operations !== null && <p className="staff-actions-stale">刷新失败，当前显示上次成功数据。</p>}

      {tab === 'tables' && operations !== null && (
        <div className="staff-table-workspace">
          {permissions.includes('table.assignment.manage') && (
            <ResponsibilityAssignmentPanel api={api} tables={operations.tables} />
          )}
          <div className="staff-table-tools">
            <label><Search size={17} /><input value={tableQuery} onChange={(event) => setTableQuery(event.target.value)} placeholder="搜索桌号或区域" aria-label="搜索桌号或区域" /></label>
            <div role="group" aria-label="桌台显示范围">
              <button type="button" className={tableScope === 'attention' ? 'is-active' : ''} onClick={() => setTableScope('attention')}>营业中</button>
              <button type="button" className={tableScope === 'mine' ? 'is-active' : ''} onClick={() => setTableScope('mine')}>负责桌</button>
              <button type="button" className={tableScope === 'all' ? 'is-active' : ''} onClick={() => setTableScope('all')}>全部</button>
            </div>
          </div>
          {visibleTables.length === 0 && <div className="staff-table-empty"><strong>当前范围没有桌台</strong><span>可搜索桌号，或切换到“全部”查看完整桌图。</span><button type="button" onClick={() => setTableScope('all')}>查看全部桌台</button></div>}
          {tableGroups(visibleTables).map((group) => (
            <section className="staff-table-area" key={group.area}>
              <h3>{group.area}</h3>
              <div className="staff-table-grid">
                {group.tables.map((table) => {
                  const mood = table.activeSession?.latestMood === null || table.activeSession === null
                    ? null
                    : tableMoodPresentation(table.activeSession.latestMood.code)
                  return (
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
                    {mood !== null && (
                      <span className="staff-table-mood" title={`客人状态：${mood.label}`} aria-label={`客人状态：${mood.label}`}>
                        {mood.symbol}
                      </span>
                    )}
                  </button>
                  )
                })}
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
              onOrder={() => setOrderSheetMode('paid')}
              onGift={() => setOrderSheetMode('gift')}
              onObservation={() => setObservationOpen(true)}
              onRecommendation={() => setRecommendationOpen(true)}
              onParticipantMovement={() => setParticipantMovementOpen(true)}
            />
          )}
        </div>
      )}

      {tab === 'tasks' && operations !== null && (
        <ActionList empty="当前没有需要处理的服务任务">
          {serviceActions.slice(0, 8).map((task) => (
            <article className={`staff-action-card priority-${task.priority}`} key={task.id}>
              <div className="staff-action-card-main">
                <strong>{task.tableCode} · {task.title}</strong>
                {task.detail !== null && <p>{task.detail}</p>}
                <small>{task.interactionMode === 'manager_resolution'
                  ? '值班经理处理 · 需留结果'
                  : task.assignedToActor
                    ? '我负责的桌台 · 一键完成'
                    : task.priority === 'urgent' ? '紧急' : task.priority === 'high' ? '优先处理' : '待处理'}</small>
                {task.interactionMode === 'manager_resolution' && (
                  <input
                    className="staff-resolution-note"
                    value={resolutionNotes[task.id] ?? ''}
                    maxLength={500}
                    placeholder="简要记录客人诉求和处理结果"
                    aria-label={`${task.tableCode}投诉处理结果`}
                    onChange={(event) => setResolutionNotes((current) => ({ ...current, [task.id]: event.target.value }))}
                  />
                )}
              </div>
              {hasPermission(permissions, 'service.execute') ? (
                <button type="button" onClick={() => void completeServiceTask(task)} disabled={pendingAction === `service:${task.id}`}>
                  <Check size={18} /> {task.interactionMode === 'manager_resolution' ? '记录并完成' : '完成'}
                </button>
              ) : (
                <button type="button" className="is-readonly" onClick={() => revealPermissionGuidance('service.execute')}>查看说明</button>
              )}
            </article>
          ))}
          {serviceActions.length > 8 && (
            <p className="staff-actions-more">还有 {serviceActions.length - 8} 项，完成当前事项后自动补入</p>
          )}
        </ActionList>
      )}

      {tab === 'fulfillment' && operations !== null && (
        <ActionList empty="当前没有需要制作或配送的出品">
          {fulfillmentActions.slice(0, 8).map((item) => {
            const fulfillmentCommand = fulfillmentAction(item)
            return (
              <article className={`staff-action-card ${item.overdue ? 'is-overdue' : ''}`} key={item.taskId}>
                <div className="staff-action-card-main">
                  <strong>{item.table.code} · {item.item.productName} × {item.item.quantity}</strong>
                  <p>{item.stationCode === 'bar' ? '吧台' : item.stationCode === 'kitchen' ? '后厨' : '收银'} · {item.readyForDelivery ? '待配送' : '待制作'}</p>
                  {item.attentionMessages.map((message) => <small className="staff-action-note" key={message}>备注：{message}</small>)}
                  {item.overdue && <small className="staff-action-overdue">已超时，优先处理</small>}
                </div>
                {fulfillmentCommand !== null && (
                  <button type="button" onClick={() => void runFulfillmentAction(item)} disabled={pendingAction === `kds:${item.taskId}`}>
                    {fulfillmentCommand === 'deliver' ? <Send size={18} /> : <ChefHat size={18} />}
                    {fulfillmentCommand === 'deliver' ? '已送达' : '制作完成'}
                  </button>
                )}
              </article>
            )
          })}
          {fulfillmentActions.length > 8 && (
            <p className="staff-actions-more">还有 {fulfillmentActions.length - 8} 项，完成当前事项后自动补入</p>
          )}
        </ActionList>
      )}

      {tab === 'reservations' && (
        <ReservationList
          reservations={reservations}
          message={reservationMessage}
          pendingAction={pendingAction}
          canManage={permissions.includes('reservation.manage')}
          onAction={(reservation, action) => void actOnReservation(reservation, action)}
          onRefresh={() => void loadReservations()}
        />
      )}

      <span className="staff-actions-announcer" aria-live="polite">
        {pendingAction === null ? '' : '操作正在后台确认'}
      </span>

      {orderSheetMode !== null && selectedTable?.activeSession !== null && selectedTable !== null && (
        <AssistedOrderSheet
          api={api}
          mode={orderSheetMode}
          table={{ code: selectedTable.code, activeSession: selectedTable.activeSession }}
          onClose={() => setOrderSheetMode(null)}
          onSubmitted={(message) => {
            showNotice({ kind: 'success', message })
            void load(true)
          }}
        />
      )}
      {observationOpen && selectedTable?.activeSession !== null && selectedTable !== null && (
        <TableObservationSheet
          api={api}
          tableCode={selectedTable.code}
          tableSessionId={selectedTable.activeSession.id}
          onClose={() => setObservationOpen(false)}
          onSaved={(message) => {
            showNotice({ kind: 'success', message })
            void load(true)
          }}
        />
      )}
      {recommendationOpen && selectedTable?.activeSession !== null && selectedTable !== null && (
        <TableRecommendationSheet api={api} tableCode={selectedTable.code}
          tableSessionId={selectedTable.activeSession.id} onClose={() => setRecommendationOpen(false)}
          onSaved={(message) => { showNotice({ kind: 'success',message });void load(true) }} />
      )}
      {participantMovementOpen && selectedTable?.activeSession !== null && selectedTable !== null && (
        <ParticipantMovementSheet api={api} table={selectedTable} allTables={operations?.tables ?? []}
          onClose={() => setParticipantMovementOpen(false)} onDone={(message) => {
            setParticipantMovementOpen(false);showNotice({ kind:'success',message });void load(true)
          }}/>
      )}
    </section>
  )
}

function ReservationList({ reservations, message, pendingAction, canManage, onAction, onRefresh }: {
  reservations: StaffReservation[] | null
  message: string | null
  pendingAction: string | null
  canManage: boolean
  onAction(reservation: StaffReservation, action: 'confirm' | 'arrive'): void
  onRefresh(): void
}) {
  if (reservations === null) {
    return <div className="staff-reservation-empty"><LoaderCircle className="is-spinning" size={20} /> 正在读取预约</div>
  }
  const active = reservations
    .filter((item) => !['completed', 'cancelled', 'no_show'].includes(item.status))
    .sort((left, right) => Date.parse(left.arrivalAt) - Date.parse(right.arrivalAt))
  return <section className="staff-reservations" aria-label="预约工作台">
    <header>
      <div><CalendarDays size={20} /><span><strong>预约与到店</strong><small>待确认和即将到店优先</small></span></div>
      <button type="button" onClick={onRefresh}><RefreshCw size={17} /> 刷新</button>
    </header>
    {message !== null && <p className="staff-reservation-message">{message}</p>}
    {active.length === 0 ? <p className="staff-reservation-empty">当前没有待处理预约</p> : active.map((reservation) => {
      const pending = pendingAction?.startsWith(`reservation:${reservation.id}:`) === true
      const tableLabel = reservation.tableLocks
        .filter((lock) => lock.status === 'held' || lock.status === 'confirmed')
        .map((lock) => lock.tableCode)
        .join('、') || '待安排桌位'
      return <article className="staff-reservation-card" key={reservation.id}>
        <div className="staff-reservation-time">
          <strong>{formatReservationTime(reservation.arrivalAt)}</strong>
          <span>{reservation.guestCount}人 · {tableLabel}</span>
        </div>
        <div className="staff-reservation-copy">
          <strong>{reservation.customerName}</strong>
          <span>{reservation.contactToken ?? (reservation.contactAvailable ? '联系方式已保护' : '未留联系方式')}</span>
          <small>位置偏好：{staffSeatPreferenceLabel(reservation.seatPreference)}</small>
          {reservation.note !== null && <small>备注：{reservation.note}</small>}
        </div>
        <span className={`staff-reservation-status is-${reservation.status}`}>{reservationStatusLabel(reservation.status)}</span>
        {canManage && reservation.status === 'pending' && (
          <button type="button" disabled={pending} onClick={() => onAction(reservation, 'confirm')}>
            {pending ? '确认中…' : '确认预约'}
          </button>
        )}
        {canManage && reservation.status === 'confirmed' && (
          <button type="button" disabled={pending} onClick={() => onAction(reservation, 'arrive')}>
            {pending ? '登记中…' : '客人到店'}
          </button>
        )}
      </article>
    })}
  </section>
}

function formatReservationTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function reservationStatusLabel(status: StaffReservation['status']): string {
  return ({
    pending: '待确认',
    confirmed: '已确认',
    arrived: '已到店',
    seated: '已入座',
    completed: '已完成',
    cancelled: '已取消',
    no_show: '未到店',
  } satisfies Record<StaffReservation['status'], string>)[status]
}

function staffSeatPreferenceLabel(preference: StaffReservation['seatPreference']): string {
  return ({
    no_preference: '门店安排',
    stage_atmosphere: '靠近舞台',
    quiet_chat: '方便聊天',
    comfortable_booth: '卡座舒适',
    outdoor_view: '室外露台',
  } satisfies Record<StaffReservation['seatPreference'], string>)[preference]
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
  onOrder(): void
  onGift(): void
  onObservation(): void
  onRecommendation(): void
  onParticipantMovement():void
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
    <section className="staff-table-sheet" aria-label={`${table.code}桌台操作`} data-action-reveal>
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
            <label className="staff-capacity-reason" data-action-reveal>
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
            {hasPermission(props.permissions, 'observation.record') && (
              <button type="button" className="is-observation" onClick={props.onObservation}><MessageSquareText size={17} /> 记录桌台情况</button>
            )}
            {hasPermission(props.permissions, 'recommendation.staff.modify') && (
              <button type="button" className="is-recommendation" onClick={props.onRecommendation}>
                <Sparkles size={17} /> 查看/调整推荐
              </button>
            )}
            {hasPermission(props.permissions, 'order.create') && (
              <button type="button" className="is-commerce" onClick={props.onOrder}><ShoppingCart size={17} /> 协助点单</button>
            )}
            {hasPermission(props.permissions, 'order.create') && hasPermission(props.permissions, 'order.gift') && (
              <button type="button" className="is-gift" onClick={props.onGift}><Gift size={17} /> 赠送商品</button>
            )}
            {hasPermission(props.permissions, 'table.transfer') ? (
              <button type="button" onClick={() => props.onTransferTarget(props.transferTargetId === null ? '' : null)}><ArrowRightLeft size={17} /> 转桌</button>
            ) : (
              <button type="button" onClick={() => props.onPermissionGuidance('table.transfer')}>转桌说明</button>
            )}
            {hasPermission(props.permissions,'table.participation.manage') && (
              <button type="button" onClick={props.onParticipantMovement}><Users size={17}/> 人员拆并桌</button>
            )}
            {hasPermission(props.permissions, 'table.close') ? (
              <button type="button" className="is-danger" onClick={props.onClose} disabled={props.pending}>
                {props.pending ? '正在关台…' : props.closeConfirm ? '再次确认关台' : '关台/翻台'}
              </button>
            ) : (
              <button type="button" onClick={() => props.onPermissionGuidance('table.close')}>关台说明</button>
            )}
          </div>
          {props.closeConfirm && <button type="button" className="staff-cancel-confirm" data-action-reveal onClick={props.onCancelClose}>取消关台</button>}
          {props.transferTargetId !== null && (
            <div className="staff-transfer-targets" data-action-reveal>
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

export function ActionList({ children, empty }: { children?: React.ReactNode; empty: string }) {
  const visibleChildren = Children.toArray(children)
  return <div className="staff-action-list">{visibleChildren.length > 0 ? visibleChildren : <p className="staff-actions-empty">{empty}</p>}</div>
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
