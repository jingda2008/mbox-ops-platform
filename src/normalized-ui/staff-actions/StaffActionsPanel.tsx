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
  LockKeyhole,
  LockKeyholeOpen,
  MessageSquareText,
  QrCode,
  RefreshCw,
  ScanLine,
  Search,
  Send,
  ShoppingCart,
  Sparkles,
  TableProperties,
  Users,
} from 'lucide-react'
import { StaffActionsApi, StaffActionsApiError, type StaffActionsApiPort, type StaffReservationListOptions } from './staff-actions-api'
import { AssistedOrderSheet } from './AssistedOrderSheet'
import { TablePaymentSheet } from './TablePaymentSheet'
import { ResponsibilityAssignmentPanel } from './ResponsibilityAssignmentPanel'
import { TableObservationSheet } from './TableObservationSheet'
import { TableRecommendationSheet } from './TableRecommendationSheet'
import { TableOrderStatusPanel } from './TableOrderStatusPanel'
import { ParticipantMovementSheet } from './ParticipantMovementSheet'
import { InventoryBarcodeScanner } from '../InventoryBarcodeScanner'
import { useConfirmationDialog } from '../ConfirmationDialog'
import {
  fulfillmentAction,
  actionableFulfillmentItems,
  actionableServiceTasks,
  guidanceForPermission,
  hasPermission,
  OPEN_TABLE_RECOMMENDATION_SCENES,
  recommendationSceneSnapshot,
  requiresCapacityReason,
  tableMoodPresentation,
  tableGroups,
  validateOpenTableInput,
  visibleFulfillmentItems,
  visibleStaffTables,
  type StaffTableScope,
  type OpenTableRecommendationScene,
} from './staff-actions-model'
import type {
  StaffActionNotice,
  StaffActionsTab,
  StaffActionTable,
  StaffFulfillmentData,
  StaffAnnualGiftReservation,
  StaffDailySnackClaim,
  StaffMemberBenefitTasks,
  StaffOperationsData,
  StaffReservation,
  StaffReservationIntakeEntry,
  StaffServiceTask,
} from './types'
import './staff-actions-panel.css'

export interface StaffActionsPanelProps {
  api?: StaffActionsApiPort
  initialTab?: StaffActionsTab
  initialTableSessionId?: string | null
  initialFactId?: string | null
  initialFocus?: string | null
  onLoginRequired?: () => void
}

const TABLE_COLLECTION_PERMISSIONS = [
  'payment.initiate.staff',
  'payment.manual.cash.record',
] as const

function hasTableCollectionPermission(permissions: readonly string[]): boolean {
  return TABLE_COLLECTION_PERMISSIONS.some((permission) => permissions.includes(permission))
}

export function StaffActionsPanel({
  api: suppliedApi,
  initialTab = 'tasks',
  initialTableSessionId = null,
  initialFactId = null,
  initialFocus = null,
  onLoginRequired,
}: StaffActionsPanelProps) {
  const api = useMemo(() => suppliedApi ?? new StaffActionsApi(), [suppliedApi])
  const { confirmAction, promptAction } = useConfirmationDialog()
  const [tab, setTab] = useState<StaffActionsTab>(initialTab)
  const [operations, setOperations] = useState<StaffOperationsData | null>(null)
  const [fulfillment, setFulfillment] = useState<StaffFulfillmentData | null>(null)
  const [memberBenefits,setMemberBenefits]=useState<StaffMemberBenefitTasks|null>(null)
  const [memberBenefitQuery,setMemberBenefitQuery]=useState('')
  const [memberScannerOpen,setMemberScannerOpen]=useState(false)
  const [giftSelections,setGiftSelections]=useState<Record<string,{productId:string;reason:string}>>({})
  const [reservations, setReservations] = useState<StaffReservation[] | null>(null)
  const [priorityQueue, setPriorityQueue] = useState<StaffReservationIntakeEntry[] | null>(null)
  const [reservationMessage, setReservationMessage] = useState<string | null>(null)
  const [reservationRange, setReservationRange] = useState<'current' | 'carryover' | 'history'>('current')
  const [reservationHistoryFrom, setReservationHistoryFrom] = useState('')
  const [reservationHistoryTo, setReservationHistoryTo] = useState('')
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [notice, setNotice] = useState<StaffActionNotice>(null)
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null)
  const [focusedActionId,setFocusedActionId]=useState<string|null>(initialFactId)
  const [guestCount, setGuestCount] = useState('')
  const [openTableRecommendationScene, setOpenTableRecommendationScene] = useState<OpenTableRecommendationScene>('unsure')
  const [capacityReason, setCapacityReason] = useState('')
  const [transferTargetId, setTransferTargetId] = useState<string | null>(null)
  const [transferReason, setTransferReason] = useState('')
  const [closeConfirm, setCloseConfirm] = useState(false)
  const [customerLeftConfirm, setCustomerLeftConfirm] = useState(false)
  const [closeIssue, setCloseIssue] = useState<string | null>(null)
  const [resolutionNotes, setResolutionNotes] = useState<Record<string, string>>({})
  const [carryoverCancelNotes, setCarryoverCancelNotes] = useState<Record<string, string>>({})
  const [carryoverCancelConfirmTaskId, setCarryoverCancelConfirmTaskId] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [orderSheetMode, setOrderSheetMode] = useState<'paid' | 'gift' | null>(null)
  const [tablePaymentOpen, setTablePaymentOpen] = useState(false)
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
  const initialTableFocusAppliedRef = useRef(false)

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
        if (!quiet && !(fulfillmentResult.reason instanceof StaffActionsApiError
          && fulfillmentResult.reason.status === 403)) {
          showNotice({ kind: 'error', message: '桌台与服务已更新，出品待办暂时无法读取' })
        }
      }
      if (operationsResult.value.actor.capabilities.includes('loyalty.redemption.fulfill')
        && api.loadMemberBenefitTasks !== undefined) {
        try {
          setMemberBenefits(await api.loadMemberBenefitTasks(null,controller.signal))
        } catch (error) {
          if (error instanceof StaffActionsApiError && error.status===401) throw error
          setMemberBenefits(null)
          if (!quiet && !(error instanceof StaffActionsApiError && error.status===403)) {
            showNotice({kind:'error',message:'桌台与服务已更新，会员权益待办暂时无法读取'})
          }
        }
      } else setMemberBenefits(null)
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
    const query = reservationListQuery(reservationRange, reservationHistoryFrom, reservationHistoryTo)
    if (query === null) {
      setReservations([])
      setReservationMessage('请选择历史查询的起止日期')
      return
    }
    try {
      const [reservationResult, priorityResult] = await Promise.allSettled([
        api.loadReservations(query, controller.signal),
        api.loadReservationIntake === undefined ? Promise.resolve(null) : api.loadReservationIntake(controller.signal),
      ])
      const results = splitReservationLoadResults(reservationResult, priorityResult)
      if (results.reservationError !== null) throw results.reservationError
      if (results.priorityError instanceof StaffActionsApiError && results.priorityError.code === 'ABORTED') return
      setReservations(results.reservations)
      setPriorityQueue(results.priorityQueue)
      if (results.priorityError !== null) {
        if (results.priorityError instanceof StaffActionsApiError && results.priorityError.status === 401) {
          onLoginRequired?.()
          return
        }
        if (results.priorityError instanceof StaffActionsApiError && results.priorityError.status === 403) {
          setReservationMessage('预约列表已更新；当前岗位无权查看优先安排队列')
          return
        }
        setReservationMessage('预约列表已更新；优先安排队列暂时无法读取，可刷新重试')
        return
      }
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
  }, [api, onLoginRequired, reservationHistoryFrom, reservationHistoryTo, reservationRange])

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
  const fulfillmentVisibleItems = useMemo(() => visibleFulfillmentItems(fulfillment?.workItems ?? []), [fulfillment])
  const filteredMemberBenefits=useMemo(()=>filterMemberBenefitTasks(memberBenefits,memberBenefitQuery),[
    memberBenefitQuery,memberBenefits,
  ])
  const visibleServiceActions = useMemo(() => prioritizeActionFact(
    serviceActions, initialFactId, (task) => task.id,
  ), [initialFactId, serviceActions])
  const visibleFulfillmentCards = useMemo(() => prioritizeActionFact(
    fulfillmentVisibleItems, initialFactId, (item) => item.taskId,
  ), [fulfillmentVisibleItems, initialFactId])
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
    if (initialTableFocusAppliedRef.current || initialTableSessionId === null || operations === null) return
    const table = operations.tables.find((candidate) => candidate.activeSession?.id === initialTableSessionId)
    if (table === undefined) return
    initialTableFocusAppliedRef.current = true
    setTableScope('all')
    setTableQuery(table.code)
    setSelectedTableId(table.id)
  }, [initialTableSessionId, operations])

  useEffect(()=>{
    if(initialFactId===null) return
    const exists=serviceActions.some((task)=>task.id===initialFactId)
      || fulfillmentVisibleItems.some((item)=>item.taskId===initialFactId)
    if(!exists) return
    setFocusedActionId(initialFactId)
    requestAnimationFrame(()=>document.querySelector<HTMLElement>(
      `[data-action-fact-id="${CSS.escape(initialFactId)}"]`,
    )?.scrollIntoView({behavior:'smooth',block:'center'}))
  },[fulfillmentVisibleItems,initialFactId,initialFocus,serviceActions])

  const focusActionCard=(factId:string)=>{
    setFocusedActionId(factId)
    document.querySelector<HTMLElement>(`[data-action-fact-id="${CSS.escape(factId)}"]`)?.focus()
  }

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
    setOpenTableRecommendationScene('unsure')
    setCapacityReason('')
    setTransferTargetId(null)
    setTransferReason('')
    setCloseConfirm(false)
    setCloseIssue(null)
    setNotice(null)
    setOrderSheetMode(null)
    setTablePaymentOpen(false)
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
      guestProfileSnapshot: recommendationSceneSnapshot(openTableRecommendationScene),
      guestCartWritesFrozen: false,
    }
    setPendingAction(`table:${selectedTable.id}`)
    setOperations(replaceTableSession(snapshot, selectedTable.id, optimisticSession))
    try {
      await api.openTable({
        tableId: selectedTable.id,
        ...validated,
        guestProfileSnapshot: recommendationSceneSnapshot(openTableRecommendationScene),
      })
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
      showNotice({ kind: 'guidance', message: '请再次确认结台。系统会先核对付款和出品；有未结事项时会保留桌台并说明原因。' })
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
      await api.closeTable(sessionId, selectedTable.activeSession.status)
      showNotice({ kind: 'success', message: `${selectedTable.code} 已关台，可安排下一桌客人` })
      setCloseConfirm(false)
      setCloseIssue(null)
      await load(true)
    } catch (error) {
      if (error instanceof StaffActionsApiError && error.partialMutation) await load(true)
      else setOperations(snapshot)
      const issue = actionError(error, '关台未完成，已恢复真实桌台状态')
      setCloseConfirm(false)
      setCloseIssue(issue)
      showNotice({ kind: 'error', message: issue })
    } finally {
      actionLocksRef.current.delete(actionKey)
      setPendingAction(null)
    }
  }

  const closeAfterCustomerLeft = async () => {
    if (operations === null || selectedTable?.activeSession === null || selectedTable === null) return
    if (!hasPermission(permissions, 'table.close') || !hasPermission(permissions, 'table.turnover_unsettled')) {
      return revealPermissionGuidance('table.close')
    }
    if (!customerLeftConfirm) {
      setCustomerLeftConfirm(true)
      showNotice({ kind: 'guidance', message: '请再次确认：顾客已离店。系统会释放物理桌台，取消未履约部分；付款、退款和对账后续会原样保留给收银处理。' })
      return
    }
    const snapshot = operations
    const sessionId = selectedTable.activeSession.id
    const actionKey = `table-customer-left:${sessionId}`
    if (actionLocksRef.current.has(actionKey)) return
    actionLocksRef.current.add(actionKey)
    setPendingAction(`table:${selectedTable.id}`)
    setOperations(replaceTableSession(snapshot, selectedTable.id, null))
    try {
      await api.closeTableAfterCustomerLeft(sessionId, '顾客已离店，财务后续处理不阻断物理翻台')
      showNotice({ kind: 'success', message: `${selectedTable.code} 已释放桌台；付款、退款和对账后续已保留到收银处理。` })
      setCustomerLeftConfirm(false)
      setCloseConfirm(false)
      setCloseIssue(null)
      await load(true)
    } catch (error) {
      setOperations(snapshot)
      const issue = actionError(error, '顾客离店翻台未完成，已恢复真实桌台状态')
      setCustomerLeftConfirm(false)
      setCloseIssue(issue)
      showNotice({ kind: 'error', message: issue })
    } finally {
      actionLocksRef.current.delete(actionKey)
      setPendingAction(null)
    }
  }

  const setGuestCartFreeze = async () => {
    if (operations === null || selectedTable?.activeSession === null || selectedTable === null) return
    if (!hasPermission(permissions, 'guest.cart.freeze')) return revealPermissionGuidance('guest.cart.freeze')
    const snapshot = operations
    const frozen = !selectedTable.activeSession.guestCartWritesFrozen
    const actionKey = `guest-cart-freeze:${selectedTable.activeSession.id}`
    if (actionLocksRef.current.has(actionKey)) return
    actionLocksRef.current.add(actionKey)
    setPendingAction(`table:${selectedTable.id}`)
    setOperations(replaceGuestCartFreeze(snapshot, selectedTable.id, frozen))
    try {
      await api.setGuestCartFreeze(
        selectedTable.activeSession.id,
        frozen,
        frozen ? '服务人员核对本桌点单' : undefined,
      )
      showNotice({
        kind: 'success',
        message: frozen
          ? `${selectedTable.code} 顾客购物车已锁定；顾客仍可查看，暂不能增减或付款`
          : `${selectedTable.code} 顾客购物车已恢复共同修改`,
      })
      await load(true)
    } catch (error) {
      setOperations(snapshot)
      showNotice({ kind: 'error', message: actionError(error, '共享购物车状态未更新，请重试') })
    } finally {
      actionLocksRef.current.delete(actionKey)
      setPendingAction(null)
    }
  }

  const actOnReservation = async (reservation: StaffReservation, action: 'confirm' | 'arrive' | 'complete') => {
    const actionKey = `reservation:${reservation.id}:${action}`
    if (actionLocksRef.current.has(actionKey)) return
    actionLocksRef.current.add(actionKey)
    const snapshot = reservations
    setPendingAction(actionKey)
    setReservations((current) => current?.map((item) => item.id === reservation.id
      ? { ...item, status: action === 'confirm' ? 'confirmed' : action === 'arrive' ? 'arrived' : 'completed' }
      : item) ?? null)
    try {
      await api.actOnReservation(reservation.id, action)
      showNotice({
        kind: 'success',
        message: action === 'confirm'
          ? `${reservation.customerName} 的预约已确认`
          : action === 'arrive'
            ? `${reservation.customerName} 已登记到店`
            : `${reservation.customerName} 的预约已完成归档`,
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

  const overridePriority = async (entry: StaffReservationIntakeEntry, mode: 'promote' | 'demote' | 'clear') => {
    if (api.overrideReservationPriority === undefined) return
    const reason = (await promptAction({
      title: '填写优先安排调整原因',
      description: `${mode === 'promote' ? '上调' : mode === 'demote' ? '下调' : '恢复默认'}“${entry.customerName}”的安排顺序。`,
      label: '调整原因',
      confirmLabel: '继续',
    }))?.trim() ?? ''
    if (reason.length < 2) return showNotice({ kind: 'guidance', message: '请填写至少2个字的队列调整原因。' })
    const actionKey = `priority:${entry.kind}:${entry.publicId}`
    if (actionLocksRef.current.has(actionKey)) return
    actionLocksRef.current.add(actionKey); setPendingAction(actionKey)
    try {
      await api.overrideReservationPriority({ kind: entry.kind, publicId: entry.publicId, mode, reason })
      showNotice({ kind: 'success', message: '优先安排顺序已调整；不会绕过门店容量，也不承诺固定桌位。' })
      await loadReservations()
    } catch (error) { showNotice({ kind: 'error', message: actionError(error, '优先安排顺序未调整，请重试') }) }
    finally { actionLocksRef.current.delete(actionKey); setPendingAction(null) }
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
          : action === 'remake'
            ? `${item.item.productName} 已重新进入制作队列`
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

  const cancelCarryoverFulfillment = async (item: StaffFulfillmentData['workItems'][number]) => {
    if (fulfillment === null || !item.carryover) return
    if (!permissions.includes('kds.exception.manage')) {
      return showNotice({ kind: 'guidance', message: '跨营业日遗留取消需要出品异常处理权限，请交给值班经理。' })
    }
    const reasonNote = carryoverCancelNotes[item.taskId]?.trim() ?? ''
    if (reasonNote.length < 4) {
      return showNotice({ kind: 'guidance', message: '请记录遗留原因和现场核对结果，至少4个字。' })
    }
    if (carryoverCancelConfirmTaskId !== item.taskId) {
      setCarryoverCancelConfirmTaskId(item.taskId)
      return showNotice({ kind: 'guidance', message: '请再次确认：只取消这项历史出品，不会改写原营业日收入。' })
    }
    const snapshot = fulfillment
    setPendingAction(`kds-cancel:${item.taskId}`)
    setFulfillment({ ...snapshot, workItems: snapshot.workItems.filter((entry) => entry.taskId !== item.taskId) })
    try {
      await api.cancelKdsTask(item.taskId, reasonNote)
      setCarryoverCancelNotes((current) => {
        const next = { ...current }
        delete next[item.taskId]
        return next
      })
      setCarryoverCancelConfirmTaskId(null)
      showNotice({ kind: 'success', message: `${item.table.code} · ${item.item.productName} 的历史出品已受控取消` })
      await load(true)
    } catch (error) {
      setFulfillment(snapshot)
      showNotice({ kind: 'error', message: actionError(error, '历史出品未取消，任务已恢复') })
    } finally {
      setPendingAction(null)
    }
  }

  const redeemAnnualGift = async (item:StaffAnnualGiftReservation) => {
    if (api.redeemAnnualGift===undefined||pendingAction!==null) return
    const selection=giftSelections[item.reservationId]??{productId:item.originalProductId,reason:''}
    const product=item.allowedProducts.find((candidate)=>candidate.productId===selection.productId)
    if (!product) return showNotice({kind:'guidance',message:'请选择已发布的原礼遇商品或合规替代品'})
    const reason=product.isOriginal?null:selection.reason.trim()
    if (!product.isOriginal&&(reason===null||reason.length<2)) {
      return showNotice({kind:'guidance',message:'使用替代品必须填写至少2个字的替换原因'})
    }
    if (!(await confirmAction({
      title: '确认核销会员礼遇',
      description: `为${item.tableCode}的${item.memberNo||'会员'}核销“${item.title}”？\n实际出品：${product.name} × ${item.quantity}${reason?`\n替换原因：${reason}`:''}`,
      confirmLabel: '确认核销',
    }))) return
    setPendingAction(`member-gift:${item.reservationId}`)
    try {
      await api.redeemAnnualGift({reservationId:item.reservationId,benefitId:item.benefitId,
        customerId:item.customerId,tableSessionId:item.tableSessionId,selectedProductId:product.productId,
        substitutionReason:reason})
      showNotice({kind:'success',message:'会员礼遇已核销并进入待出品；制作送达后才会完成'})
      await load(true)
    } catch (error) { showNotice({kind:'error',message:actionError(error,'会员礼遇未核销')}) }
    finally { setPendingAction(null) }
  }

  const redeemDailySnack = async (item:StaffDailySnackClaim) => {
    if (api.redeemDailySnack===undefined||pendingAction!==null||item.status!=='reserved') return
    if (!(await confirmAction({
      title: '确认核销每日点心',
      description: `核销“${item.title}”后将进入正式出品流程。`,
      confirmLabel: '确认核销',
    }))) return
    setPendingAction(`member-snack:${item.id}`)
    try {
      await api.redeemDailySnack(item.claimCode)
      showNotice({kind:'success',message:'每日点心已核销并进入待出品'})
      await load(true)
    } catch (error) { showNotice({kind:'error',message:actionError(error,'每日点心未核销')}) }
    finally { setPendingAction(null) }
  }

  const cancelAnnualGift = async (item:StaffAnnualGiftReservation) => {
    if (api.cancelAnnualGift===undefined||pendingAction!==null) return
    const reason=(await promptAction({title:'填写取消暂留现场原因',description:`取消${item.tableCode}的“${item.title}”暂留。`,label:'现场原因',confirmLabel:'继续'}))?.trim()??''
    if (reason.length<2) return showNotice({kind:'guidance',message:'必须填写取消原因，礼遇暂留未释放'})
    setPendingAction(`member-gift-cancel:${item.reservationId}`)
    try {
      await api.cancelAnnualGift({reservationId:item.reservationId,customerId:item.customerId,
        tableSessionId:item.tableSessionId,reason})
      showNotice({kind:'success',message:'生日或节日礼遇暂留已取消并释放'})
      await load(true)
    } catch (error) { showNotice({kind:'error',message:actionError(error,'会员礼遇暂留未取消')}) }
    finally { setPendingAction(null) }
  }

  const cancelDailySnack = async (item:StaffDailySnackClaim) => {
    if (api.cancelDailySnack===undefined||pendingAction!==null||item.status!=='reserved') return
    const reason=(await promptAction({title:'填写取消暂留现场原因',description:'取消暂留前，请填写至少2个字的现场原因。',label:'现场原因',confirmLabel:'继续'}))?.trim()??''
    if (reason.length<2) return showNotice({kind:'guidance',message:'必须填写取消原因，暂留未释放'})
    setPendingAction(`member-snack-cancel:${item.id}`)
    try {
      await api.cancelDailySnack(item.claimCode,reason)
      showNotice({kind:'success',message:'每日点心暂留已取消并释放'})
      await load(true)
    } catch (error) { showNotice({kind:'error',message:actionError(error,'每日点心暂留未取消')}) }
    finally { setPendingAction(null) }
  }

  const acceptMemberCode = (code:string) => {
    const normalized=normalizeMemberBenefitScanCode(code)
    setMemberScannerOpen(false)
    setMemberBenefitQuery(normalized)
    setTab('tasks')
    const matched=memberBenefitTaskCount(filterMemberBenefitTasks(memberBenefits,normalized))
    showNotice(matched>0
      ? {kind:'success',message:`已定位 ${matched} 项会员权益待办`}
      : {kind:'guidance',message:'当前负责桌台没有与该会员码或核销码匹配的待办'})
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
                  const canCollect = table.activeSession !== null
                    && hasTableCollectionPermission(permissions)
                    && (table.assignedToActor || permissions.includes('payment.collect.all_tables'))
                  return (
                  <div className="staff-table-tile-shell" key={table.id}>
                    <button
                      type="button"
                      className={`staff-table-tile ${table.activeSession === null ? '' : 'is-open'} ${selectedTableId === table.id ? 'is-selected' : ''}`}
                      onClick={() => selectTable(table)}
                      disabled={pendingAction === `table:${table.id}`}
                    >
                      <strong>{table.code}</strong>
                      <span>{table.activeSession === null ? `${table.capacity}人` : `${table.activeSession.guestCount}人 · ${table.activeSession.status === 'closing' ? '结台中' : '已开台'}`}</span>
                      {table.assignedToActor && <small>负责桌</small>}
                      {mood !== null && (
                        <span className="staff-table-mood" title={`客人状态：${mood.label}`} aria-label={`客人状态：${mood.label}`}>
                          {mood.symbol}
                        </span>
                      )}
                    </button>
                    {canCollect && <button type="button" className="staff-table-quick-payment"
                      aria-label={`${table.code}直接收款`}
                      disabled={pendingAction === `table:${table.id}`}
                      onClick={() => { selectTable(table); setTablePaymentOpen(true) }}>
                      <QrCode size={15} />收款
                    </button>}
                  </div>
                  )
                })}
              </div>
            </section>
          ))}
          {selectedTable !== null && (
            <><TableActionSheet
              table={selectedTable}
              allTables={operations.tables}
              permissions={permissions}
              guestCount={guestCount}
              openTableRecommendationScene={openTableRecommendationScene}
              capacityReason={capacityReason}
              transferTargetId={transferTargetId}
              transferReason={transferReason}
              closeConfirm={closeConfirm}
              customerLeftConfirm={customerLeftConfirm}
              closeIssue={closeIssue}
              pending={pendingAction === `table:${selectedTable.id}`}
              onGuestCount={setGuestCount}
              onOpenTableRecommendationScene={setOpenTableRecommendationScene}
              onCapacityReason={setCapacityReason}
              onTransferTarget={setTransferTargetId}
              onTransferReason={setTransferReason}
              onOpen={() => void openTable()}
              onClose={() => void closeTable()}
              onCloseAfterCustomerLeft={() => void closeAfterCustomerLeft()}
              onTransfer={() => void transferTable()}
              onPermissionGuidance={revealPermissionGuidance}
              onCancelClose={() => { setCloseConfirm(false); setCustomerLeftConfirm(false) }}
              onOrder={() => setOrderSheetMode('paid')}
              onPayment={() => setTablePaymentOpen(true)}
              onGift={() => setOrderSheetMode('gift')}
              onObservation={() => setObservationOpen(true)}
              onRecommendation={() => setRecommendationOpen(true)}
              onParticipantMovement={() => setParticipantMovementOpen(true)}
              onGuestCartFreeze={() => void setGuestCartFreeze()}
              orderStatusPanel={selectedTable.activeSession !== null
                && !selectedTable.activeSession.id.startsWith('optimistic-')
                && (hasPermission(permissions, 'service.execute') || hasPermission(permissions, 'order.view'))
                ? <TableOrderStatusPanel api={api} table={{ code: selectedTable.code, activeSession: selectedTable.activeSession }} />
                : null}
            />
            {selectedTable.activeSession!==null&&memberBenefits!==null&&<MemberBenefitTaskCards
              title={`${selectedTable.code}会员权益`}
              tasks={filterMemberBenefitTasks(memberBenefits,'',selectedTable.activeSession.id)}
              giftSelections={giftSelections} pendingAction={pendingAction}
              onSelection={(reservationId,selection)=>setGiftSelections((current)=>({...current,[reservationId]:selection}))}
              onRedeemGift={(item)=>void redeemAnnualGift(item)}
              onCancelGift={(item)=>void cancelAnnualGift(item)}
              onRedeemSnack={(item)=>void redeemDailySnack(item)}
              onCancelSnack={(item)=>void cancelDailySnack(item)}
            />}</>
          )}
        </div>
      )}

      {tab === 'tasks' && operations !== null && (
        <><div className="staff-member-benefit-tools">
          <label><Search size={17}/><input value={memberBenefitQuery} onChange={(event)=>setMemberBenefitQuery(event.target.value)} placeholder="输入会员号或核销码" aria-label="输入会员号或核销码"/></label>
          <button type="button" onClick={()=>setMemberScannerOpen(true)}><ScanLine size={17}/>扫描会员码</button>
        </div>
        {memberBenefits!==null&&<MemberBenefitTaskCards title="会员权益待办" tasks={filteredMemberBenefits}
          giftSelections={giftSelections} pendingAction={pendingAction}
          onSelection={(reservationId,selection)=>setGiftSelections((current)=>({...current,[reservationId]:selection}))}
          onRedeemGift={(item)=>void redeemAnnualGift(item)}
          onCancelGift={(item)=>void cancelAnnualGift(item)}
          onRedeemSnack={(item)=>void redeemDailySnack(item)}
          onCancelSnack={(item)=>void cancelDailySnack(item)}/>}
        <ActionList empty="当前没有需要处理的服务任务">
          {visibleServiceActions.map((task) => (
            <article
              className={`staff-action-card priority-${task.priority}${focusedActionId===task.id?' is-focused':''}`}
              key={task.id}
              data-action-fact-id={task.id}
              tabIndex={0}
              aria-label={`查看${task.tableCode}${task.title}详情`}
              onClick={(event)=>{
                if((event.target as HTMLElement).closest('button,input,select,textarea,a')) return
                focusActionCard(task.id)
              }}
              onKeyDown={(event)=>{
                if(event.currentTarget!==event.target||!['Enter',' '].includes(event.key)) return
                event.preventDefault();focusActionCard(task.id)
              }}
            >
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
          {serviceActions.length > visibleServiceActions.length && (
            <p className="staff-actions-more">还有 {serviceActions.length - visibleServiceActions.length} 项，完成当前事项后自动补入</p>
          )}
        </ActionList></>
      )}

      {tab === 'fulfillment' && operations !== null && (
        <ActionList empty={fulfillment === null ? '出品队列暂时无法读取，请刷新后重试' : '当前没有需要制作或配送的出品'}>
          {visibleFulfillmentCards.map((item) => {
            const fulfillmentCommand = fulfillmentAction(item)
            const missingPermission = item.kdsStatus === 'failed' ? 'kds.exception.manage' : item.readyForDelivery ? 'kds.deliver' : 'kds.prepare'
            return (
              <article
                className={`staff-action-card ${item.overdue?'is-overdue':''}${focusedActionId===item.taskId?' is-focused':''}`}
                key={item.taskId}
                data-action-fact-id={item.taskId}
                tabIndex={0}
                aria-label={`查看${item.table.code}${item.item.productName}出品详情`}
                onClick={(event)=>{
                  if((event.target as HTMLElement).closest('button,input,select,textarea,a')) return
                  focusActionCard(item.taskId)
                }}
                onKeyDown={(event)=>{
                  if(event.currentTarget!==event.target||!['Enter',' '].includes(event.key)) return
                  event.preventDefault();focusActionCard(item.taskId)
                }}
              >
                <div className="staff-action-card-main">
                  <strong>{item.table.code} · {item.item.productName} × {item.item.quantity}</strong>
                  <p>{item.stationCode === 'bar' ? '吧台' : item.stationCode === 'kitchen' ? '后厨' : '收银'} · {item.kdsStatus === 'failed' ? '制作失败，等待重新制作或后续处理' : item.readyForDelivery ? '待配送' : '待制作'}</p>
                  {item.carryover && <small className="staff-action-carryover">前营业日遗留 · 原营业日 {item.businessDate}，处理结果仍归原订单</small>}
                  {item.attentionMessages.map((message) => <small className="staff-action-note" key={message}>备注：{message}</small>)}
                  {item.overdue && <small className="staff-action-overdue">已超时，优先处理</small>}
                  {fulfillmentCommand === null && <small className="staff-action-readonly">当前账号可查看，不能确认{item.kdsStatus === 'failed' ? '重新制作' : item.readyForDelivery ? '送达' : '制作'}。</small>}
                  {item.carryover && permissions.includes('kds.exception.manage') && (
                    <input
                      className="staff-resolution-note"
                      value={carryoverCancelNotes[item.taskId] ?? ''}
                      maxLength={500}
                      placeholder="若不再出品，记录取消原因和现场核对结果"
                      aria-label={`${item.item.productName}历史出品取消说明`}
                      onChange={(event) => {
                        setCarryoverCancelConfirmTaskId(null)
                        setCarryoverCancelNotes((current) => ({ ...current, [item.taskId]: event.target.value }))
                      }}
                    />
                  )}
                </div>
                <div className="staff-action-card-actions">
                  {fulfillmentCommand !== null && (
                    <button type="button" onClick={() => void runFulfillmentAction(item)} disabled={pendingAction === `kds:${item.taskId}`}>
                      {fulfillmentCommand === 'deliver' ? <Send size={18} /> : <ChefHat size={18} />}
                      {fulfillmentCommand === 'deliver' ? '已送达' : fulfillmentCommand === 'remake' ? '重新制作' : '制作完成'}
                    </button>
                  )}
                  {fulfillmentCommand === null && (
                    <button type="button" className="is-readonly" onClick={() => revealPermissionGuidance(missingPermission)}>查看权限说明</button>
                  )}
                  {item.carryover && permissions.includes('kds.exception.manage') && (
                    <button
                      type="button"
                      className="is-readonly"
                      onClick={() => void cancelCarryoverFulfillment(item)}
                      disabled={pendingAction === `kds-cancel:${item.taskId}`}
                    >
                      {carryoverCancelConfirmTaskId === item.taskId ? '确认取消遗留' : '不再出品'}
                    </button>
                  )}
                </div>
              </article>
            )
          })}
          {fulfillmentVisibleItems.length > visibleFulfillmentCards.length && (
            <p className="staff-actions-more">还有 {fulfillmentVisibleItems.length - visibleFulfillmentCards.length} 项，完成当前事项后自动补入</p>
          )}
        </ActionList>
      )}

      {tab === 'reservations' && (
        <><PriorityQueue entries={priorityQueue} canManage={permissions.includes('reservation.manage')}
          pendingAction={pendingAction} onOverride={(entry, mode) => void overridePriority(entry, mode)} />
        <ReservationList
          reservations={reservations}
          message={reservationMessage}
          pendingAction={pendingAction}
          canManage={permissions.includes('reservation.manage')}
          range={reservationRange}
          historyFrom={reservationHistoryFrom}
          historyTo={reservationHistoryTo}
          onRangeChange={setReservationRange}
          onHistoryFromChange={setReservationHistoryFrom}
          onHistoryToChange={setReservationHistoryTo}
          onAction={(reservation, action) => void actOnReservation(reservation, action)}
          onRefresh={() => void loadReservations()}
        /></>
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
      {tablePaymentOpen && selectedTable?.activeSession !== null && selectedTable !== null && (
        <TablePaymentSheet api={api} table={{ code: selectedTable.code, activeSession: selectedTable.activeSession }}
          onClose={() => setTablePaymentOpen(false)} onUpdated={(message) => {
            showNotice({ kind: 'success', message })
            void load(true)
          }} />
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
      {memberScannerOpen&&<InventoryBarcodeScanner title="扫描会员码或点心核销码" cameraLabel="会员码扫码摄像头画面"
        onClose={()=>setMemberScannerOpen(false)} onDetected={acceptMemberCode}/>}
    </section>
  )
}

function MemberBenefitTaskCards({
  title,tasks,giftSelections,pendingAction,onSelection,onRedeemGift,onCancelGift,onRedeemSnack,onCancelSnack,
}: {
  title:string
  tasks:StaffMemberBenefitTasks
  giftSelections:Record<string,{productId:string;reason:string}>
  pendingAction:string|null
  onSelection(reservationId:string,selection:{productId:string;reason:string}):void
  onRedeemGift(item:StaffAnnualGiftReservation):void
  onCancelGift(item:StaffAnnualGiftReservation):void
  onRedeemSnack(item:StaffDailySnackClaim):void
  onCancelSnack(item:StaffDailySnackClaim):void
}) {
  const count=memberBenefitTaskCount(tasks)
  return <section className="staff-member-benefit-tasks" aria-label={title}>
    <header><div><Gift size={18}/><strong>{title}</strong></div><span>{count} 项</span></header>
    {count===0&&<p className="staff-actions-empty">当前范围没有会员权益暂留。</p>}
    {tasks.annualGifts.map((item)=>{
      const selection=giftSelections[item.reservationId]??{productId:item.originalProductId,reason:''}
      const selected=item.allowedProducts.find((product)=>product.productId===selection.productId)
      return <article className="staff-action-card" key={`gift:${item.reservationId}`}>
        <div className="staff-action-card-main"><strong>{item.tableCode} · {item.title} · {item.quantity}份</strong>
          <small>{item.memberNo||'会员号待确认'} · {item.customerName||'顾客姓名未设置'} · 暂留至 {formatMemberBenefitTime(item.expiresAt)}</small>
          <label>本次出品<select value={selection.productId} onChange={(event)=>onSelection(item.reservationId,{productId:event.target.value,reason:selection.reason})}>
            {item.allowedProducts.map((product)=><option key={product.productId} value={product.productId}>{product.name}{product.isOriginal?'（原礼遇）':'（合规替代）'}</option>)}
          </select></label>
          {selected&&!selected.isOriginal&&<label>替换原因<input minLength={2} maxLength={240} value={selection.reason}
            onChange={(event)=>onSelection(item.reservationId,{...selection,reason:event.target.value})}
            placeholder={selected.configuredReason||'请说明顾客选择或合规原因'}/></label>}
        </div>
        <div className="staff-action-card-actions"><button type="button" disabled={pendingAction!==null} onClick={()=>onRedeemGift(item)}>
          <Gift size={18}/>{pendingAction===`member-gift:${item.reservationId}`?'正在核销':'二次确认并出品'}
        </button><button type="button" className="is-readonly" disabled={pendingAction!==null} onClick={()=>onCancelGift(item)}>
          {pendingAction===`member-gift-cancel:${item.reservationId}`?'正在取消':'取消暂留'}
        </button></div>
      </article>
    })}
    {tasks.dailySnacks.map((item)=><article className="staff-action-card" key={`snack:${item.id}`}>
      <div className="staff-action-card-main"><strong>{item.tableCode||'当前桌台'} · {item.title} · {item.quantity}份</strong>
        <small>{item.memberNo||'会员号待确认'} · 核销码 {item.claimCode}</small>
        <p>{dailySnackTaskStatus(item)}</p>
      </div>
      {item.status==='reserved'&&<div className="staff-action-card-actions">
        <button type="button" disabled={pendingAction!==null} onClick={()=>onRedeemSnack(item)}>
          <Check size={18}/>{pendingAction===`member-snack:${item.id}`?'正在核销':'确认核销并出品'}
        </button>
        <button type="button" className="is-readonly" disabled={pendingAction!==null} onClick={()=>onCancelSnack(item)}>
          {pendingAction===`member-snack-cancel:${item.id}`?'正在取消':'取消暂留'}
        </button>
      </div>}
    </article>)}
  </section>
}

export function filterMemberBenefitTasks(
  tasks:StaffMemberBenefitTasks|null,
  query:string,
  tableSessionId:string|null=null,
):StaffMemberBenefitTasks {
  if (tasks===null) return {annualGifts:[],dailySnacks:[]}
  const needle=normalizeMemberBenefitScanCode(query).toLocaleUpperCase('zh-CN')
  const matches=(values:Array<string|null|undefined>)=>needle===''||values.some((value)=>
    value?.toLocaleUpperCase('zh-CN').includes(needle)===true)
  return {
    annualGifts:tasks.annualGifts.filter((item)=>(tableSessionId===null||item.tableSessionId===tableSessionId)
      &&matches([item.memberNo,item.customerName,item.tableCode,item.title,item.reservationId])),
    dailySnacks:tasks.dailySnacks.filter((item)=>(tableSessionId===null||item.tableSessionId===tableSessionId)
      &&matches([item.memberNo,item.customerName,item.tableCode,item.title,item.claimCode])),
  }
}

export function normalizeMemberBenefitScanCode(value:string):string {
  return value.trim().replace(/^MBOX_(?:MEMBER|CLAIM)_V1:/i,'').trim()
}

export function memberBenefitTaskCount(tasks:StaffMemberBenefitTasks):number {
  return tasks.annualGifts.length+tasks.dailySnacks.length
}

export function splitReservationLoadResults(
  reservations: PromiseSettledResult<StaffReservation[]>,
  priorityQueue: PromiseSettledResult<StaffReservationIntakeEntry[] | null>,
): Readonly<{
  reservations: StaffReservation[] | null
  reservationError: unknown | null
  priorityQueue: StaffReservationIntakeEntry[] | null
  priorityError: unknown | null
}> {
  return {
    reservations: reservations.status === 'fulfilled' ? reservations.value : null,
    reservationError: reservations.status === 'rejected' ? reservations.reason : null,
    priorityQueue: priorityQueue.status === 'fulfilled' ? priorityQueue.value : null,
    priorityError: priorityQueue.status === 'rejected' ? priorityQueue.reason : null,
  }
}

function formatMemberBenefitTime(value:string|null):string {
  if (value===null||!Number.isFinite(Date.parse(value))) return '时间待确认'
  return new Date(value).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})
}

function dailySnackTaskStatus(item:StaffDailySnackClaim):string {
  if (item.status==='reserved') return `已暂留至 ${formatMemberBenefitTime(item.expiresAt)}`
  if (item.status==='redeemed') return `已核销待出品${item.redeemedByEmployeeName?` · ${item.redeemedByEmployeeName}`:''}`
  if (item.status==='fulfilled') return '已完成'
  if (item.status==='compensated') return '线下补偿已完成'
  if (item.status==='cancelled_after_redemption') return '出品失败，已取消并释放'
  if (item.status==='cancelled') return '已取消并释放'
  return '暂留已过期并释放'
}

export function prioritizeActionFact<T>(
  items: readonly T[],
  factId: string | null,
  identify: (item: T) => string,
  limit = 8,
): T[] {
  if (!Number.isSafeInteger(limit) || limit < 1) return []
  if (factId === null) return items.slice(0, limit)
  const target = items.find((item) => identify(item) === factId)
  if (target === undefined) return items.slice(0, limit)
  return [target, ...items.filter((item) => identify(item) !== factId).slice(0, limit - 1)]
}

function PriorityQueue({ entries, canManage, pendingAction, onOverride }: {
  entries: StaffReservationIntakeEntry[] | null; canManage: boolean; pendingAction: string | null
  onOverride(entry: StaffReservationIntakeEntry, mode: 'promote' | 'demote' | 'clear'): void
}) {
  if (entries === null) return null
  const active = entries.filter((entry) => !['cancelled', 'completed', 'no_show'].includes(entry.status))
  return <section className="staff-reservations" aria-label="优先安排队列"><header><div><CalendarDays size={20} /><span><strong>优先安排队列</strong><small>同一到店时段先按会员规则；手动调整必须留原因，不改变容量或桌位承诺。</small></span></div></header>{active.map((entry) => <article className="staff-reservation-card" key={`${entry.kind}:${entry.publicId}`}><div className="staff-reservation-time"><strong>{formatReservationTime(entry.arrivalAt)}</strong><span>{entry.kind === 'waitlist' ? '候位' : '预约'} · {entry.guestCount}人</span></div><div className="staff-reservation-copy"><strong>{entry.customerName}</strong><small>{entry.priorityBooking === null ? '普通安排' : '会员优先安排'}{entry.queueOverride === null ? '' : ` · 已${entry.queueOverride.mode === 'promote' ? '上调' : entry.queueOverride.mode === 'demote' ? '下调' : '恢复默认'}`}</small>{entry.queueOverride !== null && <small>原因：{entry.queueOverride.reason}</small>}</div>{canManage && <div className="staff-inline-actions"><button type="button" disabled={pendingAction !== null} onClick={() => onOverride(entry, 'promote')}>上调</button><button type="button" disabled={pendingAction !== null} onClick={() => onOverride(entry, 'demote')}>下调</button><button type="button" disabled={pendingAction !== null} onClick={() => onOverride(entry, 'clear')}>恢复默认</button></div>}</article>)}</section>
}

function ReservationList({
  reservations, message, pendingAction, canManage, range, historyFrom, historyTo,
  onRangeChange, onHistoryFromChange, onHistoryToChange, onAction, onRefresh,
}: {
  reservations: StaffReservation[] | null
  message: string | null
  pendingAction: string | null
  canManage: boolean
  range: 'current' | 'carryover' | 'history'
  historyFrom: string
  historyTo: string
  onRangeChange(value: 'current' | 'carryover' | 'history'): void
  onHistoryFromChange(value: string): void
  onHistoryToChange(value: string): void
  onAction(reservation: StaffReservation, action: 'confirm' | 'arrive' | 'complete'): void
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
      <div><CalendarDays size={20} /><span><strong>预约与到店</strong><small>{range === 'carryover' ? '跨日仍未闭环的预约' : range === 'history' ? '按原日期查询历史预约' : '待确认预约和当日到店安排'}</small></span></div>
      <button type="button" onClick={onRefresh}><RefreshCw size={17} /> 刷新</button>
    </header>
    <div className="staff-reservation-ranges" aria-label="预约范围">
      <button type="button" className={range === 'current' ? 'is-active' : ''} aria-pressed={range === 'current'} onClick={() => onRangeChange('current')}>当前营业日</button>
      <button type="button" className={range === 'carryover' ? 'is-active' : ''} aria-pressed={range === 'carryover'} onClick={() => onRangeChange('carryover')}>跨日未闭环</button>
      <button type="button" className={range === 'history' ? 'is-active' : ''} aria-pressed={range === 'history'} onClick={() => onRangeChange('history')}>历史查询</button>
    </div>
    {range === 'history' && <div className="staff-reservation-history-range">
      <label>开始日期<input type="date" value={historyFrom} onChange={(event) => onHistoryFromChange(event.target.value)} /></label>
      <label>结束日期<input type="date" min={historyFrom || undefined} value={historyTo} onChange={(event) => onHistoryToChange(event.target.value)} /></label>
      <button type="button" disabled={historyFrom === '' || historyTo === ''} onClick={onRefresh}>查询</button>
    </div>}
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
        {canManage && (reservation.status === 'arrived' || reservation.status === 'seated') && (
          <button type="button" disabled={pending} onClick={() => onAction(reservation, 'complete')}>
            {pending ? '归档中…' : '完成接待'}
          </button>
        )}
      </article>
    })}
  </section>
}

function reservationListQuery(
  range: 'current' | 'carryover' | 'history',
  from: string,
  to: string,
): StaffReservationListOptions | null {
  if (range === 'current') return { range }
  if (range === 'carryover') return { range }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return null
  const end = new Date(`${to}T00:00:00.000+08:00`)
  end.setUTCDate(end.getUTCDate() + 1)
  return {
    range,
    from: new Date(`${from}T00:00:00.000+08:00`).toISOString(),
    to: end.toISOString(),
  }
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
  openTableRecommendationScene: OpenTableRecommendationScene
  capacityReason: string
  transferTargetId: string | null
  transferReason: string
  closeConfirm: boolean
  customerLeftConfirm: boolean
  closeIssue: string | null
  pending: boolean
  onGuestCount(value: string): void
  onOpenTableRecommendationScene(value: OpenTableRecommendationScene): void
  onCapacityReason(value: string): void
  onTransferTarget(value: string | null): void
  onTransferReason(value: string): void
  onOpen(): void
  onClose(): void
  onCloseAfterCustomerLeft(): void
  onTransfer(): void
  onPermissionGuidance(permission: 'table.open' | 'table.close' | 'table.transfer'): void
  onCancelClose(): void
  onOrder(): void
  onPayment(): void
  onGift(): void
  onObservation(): void
  onRecommendation(): void
  onParticipantMovement():void
  onGuestCartFreeze(): void
  orderStatusPanel: React.ReactNode
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
        <span className={table.activeSession === null ? 'status-free' : table.activeSession.status === 'closing' ? 'status-closing' : 'status-open'}>{table.activeSession === null ? '空闲' : table.activeSession.status === 'closing' ? '结台中' : '已开台'}</span>
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
          {hasPermission(props.permissions, 'table.open') && (
            <label className="staff-open-table-scene">
              客群场景（可选）
              <select
                value={props.openTableRecommendationScene}
                aria-label="客群场景（可选）"
                onChange={(event) => props.onOpenTableRecommendationScene(event.target.value as OpenTableRecommendationScene)}
              >
                {OPEN_TABLE_RECOMMENDATION_SCENES.map((scene) => (
                  <option key={scene.value} value={scene.value}>{scene.label}</option>
                ))}
              </select>
            </label>
          )}
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
          <p><strong>{table.activeSession.guestCount}人</strong><span>{table.activeSession.status === 'closing' ? '结台待完成，请先处理下方提示' : '本桌服务进行中'}</span></p>
          {props.orderStatusPanel}
          {table.activeSession.guestCartWritesFrozen && <p className="staff-close-issue" role="status"><strong>顾客购物车已锁定：</strong>顾客仍可查看，服务人员核对完成后请恢复修改。</p>}
          {props.closeIssue !== null && <p className="staff-close-issue" role="alert"><strong>暂不能结台：</strong>{props.closeIssue}</p>}
          <div className="staff-session-actions">
            {hasTableCollectionPermission(props.permissions) && (
              <button type="button" className="is-payment" onClick={props.onPayment}><QrCode size={17} /> 本桌收款</button>
            )}
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
            {hasPermission(props.permissions, 'guest.cart.freeze') && (
              <button type="button" onClick={props.onGuestCartFreeze} disabled={props.pending}>
                {table.activeSession.guestCartWritesFrozen
                  ? <><LockKeyholeOpen size={17} /> 恢复顾客修改</>
                  : <><LockKeyhole size={17} /> 锁定顾客购物车</>}
              </button>
            )}
            {hasPermission(props.permissions, 'table.close') ? (
              <button type="button" className="is-danger" onClick={props.onClose} disabled={props.pending}>
                {props.pending ? '正在结台…' : props.closeConfirm ? table.activeSession.status === 'closing' ? '确认完成结台' : '确认结台' : table.activeSession.status === 'closing' ? '继续结台' : '准备结台'}
              </button>
            ) : (
              <button type="button" onClick={() => props.onPermissionGuidance('table.close')}>关台说明</button>
            )}
            {hasPermission(props.permissions, 'table.close') && hasPermission(props.permissions, 'table.turnover_unsettled') && (
              <button type="button" className="is-danger" onClick={props.onCloseAfterCustomerLeft} disabled={props.pending}>
                {props.pending ? '正在处理…' : props.customerLeftConfirm ? '确认立即翻台' : '顾客离店，立即翻台'}
              </button>
            )}
          </div>
          {(props.closeConfirm || props.customerLeftConfirm) && <button type="button" className="staff-cancel-confirm" data-action-reveal onClick={props.onCancelClose}>取消关台</button>}
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

function replaceGuestCartFreeze(
  data: StaffOperationsData,
  tableId: string,
  frozen: boolean,
): StaffOperationsData {
  return {
    ...data,
    tables: data.tables.map((table) => table.id === tableId && table.activeSession !== null
      ? { ...table, activeSession: { ...table.activeSession, guestCartWritesFrozen: frozen } }
      : table),
  }
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
