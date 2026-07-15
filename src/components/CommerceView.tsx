import { CheckCheck, ChefHat, CircleAlert, CircleDollarSign, Clock3, PackageCheck, Play, ShoppingCart, UserRound } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { actOnKdsTask, createCartOrder, getCurrentActorId } from '../api'
import type { BootstrapResponse } from '../shared/contracts'
import type { KdsActionInput } from '../shared/commerce-api'
import type { KdsTask } from '../shared/order-contracts'
import { actionAllowedForAccess, getFulfillmentAccess, stationLabel, taskVisibleToAccess } from './commerce-workspace'
import { MenuOrderingWorkspace, type MenuCartItem } from './MenuOrderingWorkspace'
import './CommerceView.css'

interface CommerceViewProps {
  data: BootstrapResponse
  onRefresh: () => Promise<void>
  onNotice: (message: string) => void
}

const kdsLabels: Record<KdsTask['status'], string> = {
  queued: '待制作', preparing: '制作中', completed: '待取走', picked_up: '配送中', delivered: '已送达',
}

export function CommerceView({ data, onRefresh, onNotice }: CommerceViewProps) {
  const currentActorId = getCurrentActorId()
  const access = getFulfillmentAccess(data, currentActorId)
  const currentEmployee = access.employee
  const occupiedTables = data.tables.filter((table) => table.status === 'occupied')
  const [tableId, setTableId] = useState(occupiedTables[0]?.id ?? '')
  const [workspaceMode, setWorkspaceMode] = useState<'order' | 'fulfillment'>(access.canOrder ? 'order' : 'fulfillment')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const ledgerTotal = data.orderDomain.tableLedgerEntries.reduce((sum, entry) => sum + entry.amount, 0)
  const activeKds = data.orderDomain.kdsTasks.filter((task) => task.status !== 'delivered')
  const visibleKds = useMemo(() => activeKds
    .filter((task) => taskVisibleToAccess(task, access))
    .toSorted((a, b) => {
      const aTiming = taskTiming(a, data, now)
      const bTiming = taskTiming(b, data, now)
      if (aTiming.overdue !== bTiming.overdue) return aTiming.overdue ? -1 : 1
      return taskSortValue(a) - taskSortValue(b)
    }), [activeKds, access, data, now])
  const overdueCount = visibleKds.filter((task) => taskTiming(task, data, now).overdue).length

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  async function submit(items: MenuCartItem[]) {
    if (!currentEmployee) {
      onNotice('当前员工身份无效，请重新登录后下单')
      return
    }
    setBusy(true)
    try {
      await createCartOrder({ tableId, items, actorId: currentEmployee.id, idempotencyKey: `cart-${crypto.randomUUID()}` })
      onNotice('商品已与客人核对，订单已进入出品流程')
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '下单失败')
    } finally {
      setBusy(false)
    }
  }

  async function advance(task: KdsTask, action: KdsActionInput['action']) {
    if (!currentEmployee) {
      onNotice('当前员工身份无效，请重新登录后操作KDS')
      return
    }
    setBusy(true)
    try {
      await actOnKdsTask(task.id, { action, actorId: currentEmployee.id, idempotencyKey: `kds-${action}-${crypto.randomUUID()}` })
      onNotice(`${task.itemName}已更新为${nextLabel(action)}`)
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'KDS操作失败')
    } finally {
      setBusy(false)
    }
  }

  const accountRows = useMemo(() => {
    const grouped = new Map<string, number>()
    for (const entry of data.orderDomain.tableLedgerEntries) {
      grouped.set(entry.tableSessionId, (grouped.get(entry.tableSessionId) ?? 0) + entry.amount)
    }
    return Array.from(grouped, ([sessionId, balance]) => ({ sessionId, balance }))
  }, [data.orderDomain.tableLedgerEntries])
  const latestPaidSignal = data.paymentDomain.paymentIntents
    .filter((intent) => ['succeeded', 'reported_pending_reconciliation'].includes(intent.status))
    .toSorted((left, right) => Date.parse(right.paidAt ?? right.createdAt) - Date.parse(left.paidAt ?? left.createdAt))[0]
  const paidTable = latestPaidSignal ? tableFromSession(data, latestPaidSignal.tableSessionId) : undefined
  const selectedTable = occupiedTables.find((table) => table.id === tableId)

  return (
    <section className="commerce-view">
      <div className="section-heading">
        <div><span className="eyebrow">{access.roleLabel} · {access.scopeLabel}</span><h2>岗位履约工作台</h2></div>
        <span className="count-chip">{visibleKds.length}项当前职责</span>
      </div>
      {latestPaidSignal && <div className="paid-signal" role="status"><CheckCheck size={20} /><div><strong>{paidTable?.code ?? '桌台'} 已收款 {money(latestPaidSignal.amount)}</strong><span>{latestPaidSignal.channel === 'physical_pos' ? '物理POS待对账' : '支付成功，服务与收银已同步'}</span></div></div>}
      {access.canOrder && <div className="commerce-mode-tabs">
        <button className={workspaceMode === 'order' ? 'is-active' : ''} onClick={() => setWorkspaceMode('order')}>全屏点单</button>
        <button className={workspaceMode === 'fulfillment' ? 'is-active' : ''} onClick={() => setWorkspaceMode('fulfillment')}>出品履约 <span>{visibleKds.length}</span></button>
      </div>}

      {workspaceMode === 'order' && access.canOrder ? (
        <MenuOrderingWorkspace
          products={data.products}
          tableLabel={selectedTable ? `${selectedTable.code} · ${selectedTable.displayName}` : '请选择桌台'}
          tableControl={<select aria-label="选择桌台" value={tableId} onChange={(event) => setTableId(event.target.value)}>{occupiedTables.map((table) => <option key={table.id} value={table.id}>{table.code} · {table.displayName} · {table.guestCount}人</option>)}</select>}
          submitLabel="核对无误，确认下单"
          submitHint="提交后自动分发到对应吧台或厨房；完成制作后自动通知取送人员。"
          busy={busy}
          onSubmit={submit}
        />
      ) : <>
      <div className="commerce-metrics">
        <div><ChefHat size={19} /><strong>{visibleKds.length}</strong><span>{access.mode === 'production' ? '待制作' : access.mode === 'delivery' ? '待取送' : '全部待履约'}</span></div>
        <div className={overdueCount > 0 ? 'is-risk' : ''}><CircleAlert size={19} /><strong>{overdueCount}</strong><span>SLA超时</span></div>
        {access.canViewLedger
          ? <div><CircleDollarSign size={19} /><strong>{money(ledgerTotal)}</strong><span>桌账应收</span></div>
          : <div><UserRound size={19} /><strong>{access.stationIds.length || '全'}</strong><span>负责制作工位</span></div>}
      </div>
      <div className={access.canViewLedger ? 'commerce-grid' : 'commerce-grid is-task-only'}>
        <section className="kds-section">
          <div className="commerce-section-title"><ChefHat size={18} /><strong>{access.mode === 'production' ? '可制作任务' : access.mode === 'delivery' ? '待取送任务' : 'KDS全流程'}</strong><span>当前操作：{currentEmployee?.displayName ?? '身份失效，请重新登录'}</span></div>
          <div className="kds-list">
            {visibleKds.length === 0 && <div className="commerce-empty"><CheckCheck size={22} />当前岗位没有待处理商品</div>}
            {visibleKds.map((task) => {
              const table = tableFromSession(data, task.tableSessionId)
              const action = nextAction(task.status)
              const timing = taskTiming(task, data, now)
              const responsibleRole = taskResponsibleRole(task, data)
              return (
                <article className={`kds-row kds-${task.status} ${timing.overdue ? 'is-overdue' : ''}`} key={task.id}>
                  <div className="kds-table"><span>{table?.code ?? task.tableCode ?? '未知桌号'}</span><small>{table?.displayName ?? (task.tableCode ? '按桌号出品' : '桌台未匹配')}</small></div>
                  <div className="kds-product"><strong>{task.itemName} × {task.quantity}</strong><span>{task.specification} · {task.workstation?.name ?? stationLabel(task.stationId)}</span></div>
                  <div className="kds-meta">
                    <span className={`kds-state state-${task.status}`}>{kdsLabels[task.status]}</span>
                    <span><Clock3 size={13} />等待 {formatDuration(timing.waitSeconds)}</span>
                    <span className={timing.overdue ? 'sla-overdue' : 'sla-normal'}>{timing.overdue ? `SLA超时 ${formatDuration(timing.overSeconds)}` : `SLA剩余 ${formatDuration(timing.remainingSeconds)}`}</span>
                    <span>负责岗位 {responsibleRole}</span>
                  </div>
                  {action && actionAllowedForAccess(task.status, access) && <button className="secondary-button" disabled={busy || !currentEmployee} title={currentEmployee ? `由${currentEmployee.displayName}执行` : '请重新登录'} onClick={() => void advance(task, action)}>{actionIcon(action)}{nextLabel(action)}</button>}
                </article>
              )
            })}
          </div>
        </section>

        {access.canViewLedger && <section className="ledger-section">
          <div className="commerce-section-title"><CircleDollarSign size={18} /><strong>桌账余额</strong></div>
          <div className="ledger-list">
            {accountRows.length === 0 && <div className="commerce-empty">暂无桌账流水</div>}
            {accountRows.map((row) => {
              const table = tableFromSession(data, row.sessionId)
              return <div className="ledger-row" key={row.sessionId}><div><strong>{table?.displayName ?? row.sessionId}</strong><span>{table?.code}</span></div><b>{money(row.balance)}</b></div>
            })}
          </div>
        </section>}
      </div>
      </>}
    </section>
  )
}

function tableFromSession(data: BootstrapResponse, sessionId: string) {
  const session = data.songState.tableSessions.find((item) => item.id === sessionId)
  return data.tables.find((table) => table.id === session?.tableId)
}

function nextAction(status: KdsTask['status']): KdsActionInput['action'] | null {
  return status === 'queued' ? 'start' : status === 'preparing' ? 'complete' : status === 'completed' ? 'pickUp' : status === 'picked_up' ? 'deliver' : null
}

function nextLabel(action: KdsActionInput['action']) {
  return action === 'start' ? '接单制作' : action === 'complete' ? '完成制作' : action === 'pickUp' ? '确认取货' : '确认送达'
}

function actionIcon(action: KdsActionInput['action']) {
  return action === 'start' ? <Play size={16} /> : action === 'complete' ? <PackageCheck size={16} /> : action === 'pickUp' ? <ShoppingCart size={16} /> : <CheckCheck size={16} />
}

function money(amount: number) {
  return `¥${(amount / 100).toFixed(2)}`
}

function taskTiming(task: KdsTask, data: BootstrapResponse, now: number) {
  const startedAt = task.status === 'queued' ? task.queuedAt
    : task.status === 'preparing' ? task.startedAt ?? task.queuedAt
      : task.status === 'completed' ? task.completedAt ?? task.queuedAt
        : task.pickedUpAt ?? task.completedAt ?? task.queuedAt
  const linkedServiceTask = task.deliveryServiceTask
    ? data.tasks.find((item) => item.id === task.deliveryServiceTask?.id)
    : undefined
  const snapshot = ['queued', 'preparing'].includes(task.status) ? task.productionSla : task.pickupSla
  const configuredDeadline = task.status === 'picked_up'
    ? linkedServiceTask?.escalateAt ?? snapshot?.dueAt ?? undefined
    : snapshot?.dueAt ?? readTaskString(task, ['slaDeadlineAt', 'deadlineAt', 'dueAt', 'targetAt'])
  const configuredSeconds = snapshot?.targetSeconds
    ?? readTaskNumber(task, ['slaSeconds', 'slaTargetSeconds', 'targetSeconds'])
    ?? readStationSlaSeconds(data, task.stationId, task.status)
  const fallbackSeconds = task.status === 'queued' ? 300 : task.status === 'preparing' ? 600 : task.status === 'completed' ? 180 : 300
  const deadline = configuredDeadline ? Date.parse(configuredDeadline) : Date.parse(startedAt) + (configuredSeconds ?? fallbackSeconds) * 1000
  const waitSeconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000))
  const deltaSeconds = Math.floor((deadline - now) / 1000)
  return {
    waitSeconds,
    overdue: deltaSeconds < 0,
    overSeconds: Math.max(0, -deltaSeconds),
    remainingSeconds: Math.max(0, deltaSeconds),
  }
}

function taskSortValue(task: KdsTask) {
  const queuedAt = Date.parse(task.queuedAt)
  return Number.isFinite(queuedAt) ? queuedAt : 0
}

function readStationSlaSeconds(data: BootstrapResponse, stationId: string, status: KdsTask['status']) {
  const config = data.config as unknown as Record<string, unknown>
  const candidates = [config.workstations, config.fulfillmentWorkstations, config.productionStations]
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const station = candidate.find((item) => isRecord(item) && [item.id, item.stationId, item.workstationId].includes(stationId))
    if (!isRecord(station)) continue
    const stageKey = ['queued', 'preparing'].includes(status) ? 'productionSlaSeconds' : 'deliverySlaSeconds'
    const stageValue = station[stageKey]
    if (typeof stageValue === 'number' && Number.isFinite(stageValue) && stageValue > 0) return stageValue
    const value = station.slaSeconds
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

function readTaskString(task: KdsTask, keys: string[]) {
  const record = task as unknown as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function readTaskNumber(task: KdsTask, keys: string[]) {
  const record = task as unknown as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

function taskResponsibleRole(task: KdsTask, data: BootstrapResponse) {
  const explicit = readTaskString(task, ['responsibleRoleName', 'ownerRoleName', 'roleName'])
  if (explicit) return explicit
  const ownerId = task.deliveryServiceTask?.ownerId
  const owner = ownerId ? data.employees.find((employee) => employee.id === ownerId) : undefined
  const ownerRole = owner ? data.config.roles.find((role) => role.id === owner.roleId)?.name : undefined
  if (ownerRole) return ownerRole
  const roleIds = ['queued', 'preparing'].includes(task.status)
    ? task.workstation?.productionRoleIds
    : task.workstation?.deliveryRoleIds
  const roleNames = roleIds
    ?.filter((roleId) => !['supervisor', 'manager'].includes(roleId))
    .map((roleId) => data.config.roles.find((role) => role.id === roleId)?.name ?? roleId)
  return roleNames && roleNames.length > 0
    ? roleNames.join('/')
    : ['queued', 'preparing'].includes(task.status) ? '出品岗' : '取送岗'
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60) return remainder > 0 ? `${minutes}分${remainder}秒` : `${minutes}分钟`
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
