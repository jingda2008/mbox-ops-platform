import { Check, CheckCheck, Clock3, Focus, MapPin, Navigation, RotateCcw, UserRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ServiceIcon } from './ServiceIcon'
import {
  compareTaskQueueItems,
  taskAcceptMode,
  taskMatchesQueueFilter,
  taskQueueActionMode,
  taskQueueFilterForQuery,
  taskQueueIsVisible,
  taskRepeatSummary,
  taskWorkflowLevel,
} from './task-queue'
import { stabilizeOperationalOrder } from './stable-operational-order'
import { serverClockOffset, useSecondClock } from './use-second-clock'
import type {
  Employee,
  ManagerTaskActionInput,
  ServiceTask,
  ServiceTypeConfig,
  Table,
  TaskActionInput,
  TaskTransferCandidate,
} from '../shared/contracts'

const statusLabels: Record<ServiceTask['status'], string> = {
  pending: '待接单',
  accepted: '已接单',
  arrived: '已到桌',
  completed: '已完成',
  confirmed: '已解决',
  reopened: '仍未解决',
  escalated: '已升级',
  cancelled: '已取消',
}

function elapsedLabel(createdAt: string, nowMs: number) {
  const seconds = Math.max(0, Math.floor((nowMs - new Date(createdAt).getTime()) / 1000))
  if (seconds < 60) return `${seconds}秒`
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
}

interface TaskQueueProps {
  tasks: ServiceTask[]
  tables: Table[]
  employees: Employee[]
  serviceTypes: ServiceTypeConfig[]
  selectedTableId: string | null
  onClearTable: () => void
  onAction: (task: ServiceTask, action: TaskActionInput['action']) => Promise<void>
  onManagerAction: (
    task: ServiceTask,
    action: ManagerTaskActionInput['action'],
    targetEmployeeId?: string,
  ) => Promise<void>
  onLoadTransferCandidates: (task: ServiceTask) => Promise<TaskTransferCandidate[]>
  busyTaskIds: ReadonlySet<string>
  currentEmployeeId: string
  claimableTaskIds: ReadonlySet<string>
  canManageTasks: boolean
  compact?: boolean
  focusTaskId?: string | null
  focusQuery?: string | null
  focusRequestId?: number | null
  onClearFocus?: () => void
  serverNow: string
}

export function TaskQueue({
  tasks,
  tables,
  employees,
  serviceTypes,
  selectedTableId,
  onClearTable,
  onAction,
  onManagerAction,
  onLoadTransferCandidates,
  busyTaskIds,
  currentEmployeeId,
  claimableTaskIds,
  canManageTasks,
  compact = false,
  focusTaskId = null,
  focusQuery = null,
  focusRequestId = null,
  onClearFocus,
  serverNow,
}: TaskQueueProps) {
  const clockOffset = serverClockOffset(serverNow)
  const nowMs = useSecondClock(clockOffset)
  const [visibleCount, setVisibleCount] = useState(12)
  const [pendingTaskIds, setPendingTaskIds] = useState<Set<string>>(() => new Set())
  const [managerTaskId, setManagerTaskId] = useState<string | null>(null)
  const [transferTaskId, setTransferTaskId] = useState<string | null>(null)
  const [transferCandidates, setTransferCandidates] = useState<TaskTransferCandidate[]>([])
  const [selectedTransferEmployeeId, setSelectedTransferEmployeeId] = useState('')
  const [busyMode, setBusyMode] = useState(() => (
    typeof window !== 'undefined' && window.localStorage.getItem('mbox-staff-busy-mode') === '1'
  ))
  const taskOrderIds = useRef<string[]>([])
  const previousFocusTaskId = useRef<string | null>(null)
  const filter = taskQueueFilterForQuery(focusQuery)
  const serviceTypeById = new Map(serviceTypes.map((serviceType) => [serviceType.id, serviceType]))
  const complaintServiceTypeIds = new Set(serviceTypes
    .filter((serviceType) => serviceType.code === 'COMPLAINT' || serviceType.icon === 'complaint')
    .map((serviceType) => serviceType.id))
  const rankedVisibleTasks = tasks
    .filter((task) => !task.archivedAt)
    .filter((task) => taskQueueIsVisible(task, serviceTypeById.get(task.serviceTypeId)))
    .filter((task) => !selectedTableId || task.tableId === selectedTableId)
    .filter((task) => taskMatchesQueueFilter(task, filter, complaintServiceTypeIds))
    .filter((task) => {
      if (!busyMode || selectedTableId || filter !== 'all') return true
      const serviceType = serviceTypeById.get(task.serviceTypeId)
      const atRisk = nowMs >= new Date(task.warningAt).getTime()
      return task.priority === 'urgent'
        || atRisk
        || task.ownerId === currentEmployeeId
        || serviceType?.code === 'FULFILLMENT_DELIVERY'
    })
    .sort((a, b) => {
      if (focusTaskId && a.id === focusTaskId) return -1
      if (focusTaskId && b.id === focusTaskId) return 1
      return compareTaskQueueItems(a, b, serviceTypeById, currentEmployeeId, claimableTaskIds)
    })
  if (previousFocusTaskId.current !== focusTaskId) {
    previousFocusTaskId.current = focusTaskId
    taskOrderIds.current = []
  }
  const interactionTaskIds = new Set([
    ...busyTaskIds,
    ...pendingTaskIds,
    ...(focusTaskId ? [focusTaskId] : []),
  ])
  const visibleTasks = stabilizeOperationalOrder(rankedVisibleTasks, taskOrderIds.current, interactionTaskIds)
  taskOrderIds.current = visibleTasks.map((task) => task.id)
  const displayedTasks = visibleTasks.slice(0, visibleCount)
  const filterLabel = filter === 'sla-risk'
    ? '仅看 SLA 风险'
    : filter === 'escalated'
      ? '仅看升级任务'
      : filter === 'complaint'
        ? '仅看投诉接管'
        : ''

  useEffect(() => {
    if (focusRequestId === null) return
    setVisibleCount(12)
    if (!focusTaskId || !tasks.some((task) => task.id === focusTaskId)) return
    window.requestAnimationFrame(() => {
      document.getElementById(`service-task-${focusTaskId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [focusRequestId, focusTaskId, tasks])

  async function runAction(task: ServiceTask, action: TaskActionInput['action']) {
    setPendingTaskIds((current) => new Set(current).add(task.id))
    try {
      await onAction(task, action)
    } finally {
      setPendingTaskIds((current) => {
        const next = new Set(current)
        next.delete(task.id)
        return next
      })
    }
  }

  async function runManagerAction(
    task: ServiceTask,
    action: ManagerTaskActionInput['action'],
    targetEmployeeId?: string,
  ) {
    setPendingTaskIds((current) => new Set(current).add(task.id))
    try {
      await onManagerAction(task, action, targetEmployeeId)
      setManagerTaskId(null)
      setTransferTaskId(null)
      setTransferCandidates([])
      setSelectedTransferEmployeeId('')
    } finally {
      setPendingTaskIds((current) => {
        const next = new Set(current)
        next.delete(task.id)
        return next
      })
    }
  }

  async function openTransfer(task: ServiceTask) {
    setTransferTaskId(task.id)
    setTransferCandidates([])
    setSelectedTransferEmployeeId('')
    setPendingTaskIds((current) => new Set(current).add(task.id))
    try {
      const candidates = await onLoadTransferCandidates(task)
      setTransferCandidates(candidates)
      setSelectedTransferEmployeeId(candidates[0]?.employeeId ?? '')
    } finally {
      setPendingTaskIds((current) => {
        const next = new Set(current)
        next.delete(task.id)
        return next
      })
    }
  }

  return (
    <section className={`task-queue ${compact ? 'task-queue--compact' : ''}`}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">实时任务</span>
          <h2>{selectedTableId ? '桌台任务' : '待处理队列'}</h2>
        </div>
        <div className="heading-actions">
          {!selectedTableId && (
            <button
              className={`task-busy-mode${busyMode ? ' is-active' : ''}`}
              type="button"
              aria-pressed={busyMode}
              title="只看紧急、即将超时、待送达和本人责任任务"
              onClick={() => {
                const next = !busyMode
                setBusyMode(next)
                window.localStorage.setItem('mbox-staff-busy-mode', next ? '1' : '0')
              }}
            >
              <Focus size={16} />{busyMode ? '忙时聚焦中' : '忙时聚焦'}
            </button>
          )}
          {selectedTableId && (
            <button className="icon-button" title="清除桌台筛选" onClick={onClearTable}>
              <RotateCcw size={18} aria-hidden="true" />
            </button>
          )}
          <span className="count-chip">{visibleTasks.length}</span>
        </div>
      </div>

      {filterLabel && (
        <div className="task-queue__focus" role="status">
          <span>{filterLabel} · {visibleTasks.length}项</span>
          {onClearFocus && <button type="button" onClick={onClearFocus}>查看全部</button>}
        </div>
      )}

      <div className="task-list" aria-live="polite">
        {visibleTasks.length === 0 && (
          <div className="empty-state">
            <CheckCheck size={24} aria-hidden="true" />
            <strong>{filterLabel ? `${filterLabel.replace('仅看 ', '')}已处理完成或状态已更新` : '当前没有待处理任务'}</strong>
          </div>
        )}
        {displayedTasks.map((task) => {
          const table = tables.find((item) => item.id === task.tableId)
          const owner = employees.find((item) => item.id === task.ownerId)
          const serviceType = serviceTypes.find((item) => item.id === task.serviceTypeId)
          if (!table || !serviceType) return null
          const fulfillmentDelivery = serviceType.code === 'FULFILLMENT_DELIVERY'
          const atRisk = nowMs >= new Date(task.warningAt).getTime() && !['arrived', 'completed'].includes(task.status)
          const acceptMode = taskAcceptMode(task, currentEmployeeId, claimableTaskIds.has(task.id))
          const workflowLevel = taskWorkflowLevel(serviceType, task)
          const actionMode = taskQueueActionMode(task, serviceType, currentEmployeeId, claimableTaskIds.has(task.id))
          const repeatSummary = taskRepeatSummary(task)
          const actionBusy = busyTaskIds.has(task.id) || pendingTaskIds.has(task.id)
          const isOwnTask = task.ownerId === currentEmployeeId
          const canSuperviseTask = canManageTasks && !isOwnTask
          const visibleActionMode = canSuperviseTask ? null : actionMode
          const responsibilityLabel = isOwnTask
            ? '我的任务'
            : task.ownerId
              ? `他人任务 · ${owner?.displayName ?? '待确认'}负责`
              : '待接管'

          return (
            <article
              id={`service-task-${task.id}`}
              className={`task-item task-item--${workflowLevel.toLowerCase()} priority-${task.priority} ${atRisk ? 'is-at-risk' : ''} ${focusTaskId === task.id ? 'is-navigation-focus' : ''}`}
              key={task.id}
              aria-busy={actionBusy}
            >
              <div className="task-item__top">
                <span className="service-symbol">
                  <ServiceIcon icon={serviceType.icon} size={18} />
                </span>
                <div className="task-item__identity">
                  <div className="task-title-row">
                    <strong>{serviceType.name}</strong>
                    <div className="task-title-tags">
                      {canManageTasks && <span className={`responsibility-tag ${isOwnTask ? 'is-own' : task.ownerId ? 'is-others' : 'is-unowned'}`}>{responsibilityLabel}</span>}
                      {workflowLevel !== 'L1' && (
                        <span className={`status-tag status-${task.status}`}>{fulfillmentDelivery && task.status === 'arrived' ? '配送中' : statusLabels[task.status]}</span>
                      )}
                    </div>
                  </div>
                  <div className="task-meta">
                    <span><MapPin size={14} />{table.displayName}</span>
                    <span><Clock3 size={14} />{elapsedLabel(task.createdAt, nowMs)}</span>
                    {workflowLevel !== 'L1' && <span><UserRound size={14} />{owner?.displayName ?? '领班调度池'}</span>}
                  </div>
                </div>
              </div>

              {task.note && <p className={`task-note${task.note.includes('【订单重点备注】') ? ' is-important' : ''}`}>{task.note}</p>}
              {repeatSummary && <p className="task-repeat" role="status">{repeatSummary}</p>}
              {workflowLevel !== 'L1' && task.actionScript.length > 0 && (
                <div className="ai-directive">
                  <span>AI指令</span>
                  <ol>
                    {task.actionScript.map((step) => <li key={step}>{step}</li>)}
                  </ol>
                </div>
              )}

              <div className="task-actions">
                {visibleActionMode === 'quick-complete' && (
                  <button
                    className="primary-button task-action-button"
                    disabled={actionBusy}
                    onClick={() => void runAction(task, 'quick_complete')}
                  >
                    <CheckCheck size={17} />{actionBusy ? '正在提交…' : fulfillmentDelivery ? '已送达' : '已处理'}
                  </button>
                )}
                {workflowLevel === 'L2' && visibleActionMode === 'accept' && (
                  <button className="primary-button task-action-button" disabled={actionBusy} onClick={() => void runAction(task, 'accept')}>
                    <Check size={17} />{actionBusy ? '正在提交…' : acceptMode === 'claim' ? '我来处理' : '开始处理'}
                  </button>
                )}
                {workflowLevel === 'L2' && visibleActionMode === 'complete' && (
                  <button className="primary-button task-action-button" disabled={actionBusy} onClick={() => void runAction(task, 'complete')}>
                    <CheckCheck size={17} />{actionBusy ? '正在提交…' : '完成'}
                  </button>
                )}
                {workflowLevel === 'L3' && visibleActionMode === 'accept' && (
                  <button className="primary-button task-action-button" disabled={actionBusy} onClick={() => void runAction(task, 'accept')}>
                    <Check size={17} />{actionBusy ? '正在提交…' : acceptMode === 'claim' ? '认领并接单' : fulfillmentDelivery ? '接取送任务' : '接单'}
                  </button>
                )}
                {workflowLevel === 'L3' && visibleActionMode === 'arrive' && (
                  <button className="primary-button task-action-button" disabled={actionBusy} onClick={() => void runAction(task, 'arrive')}>
                    <Navigation size={17} />{actionBusy ? '正在提交…' : fulfillmentDelivery ? '确认取货' : '已到桌'}
                  </button>
                )}
                {workflowLevel === 'L3' && visibleActionMode === 'complete' && (
                  <button className="primary-button task-action-button" disabled={actionBusy} onClick={() => void runAction(task, 'complete')}>
                    <CheckCheck size={17} />{actionBusy ? '正在提交…' : fulfillmentDelivery ? '确认送达' : '完成服务'}
                  </button>
                )}
                {canSuperviseTask && (
                  <button
                    className="secondary-button task-action-button"
                    disabled={actionBusy}
                    type="button"
                    aria-expanded={managerTaskId === task.id}
                    onClick={() => {
                      const nextTaskId = managerTaskId === task.id ? null : task.id
                      setManagerTaskId(nextTaskId)
                      setTransferTaskId(null)
                      setTransferCandidates([])
                      setSelectedTransferEmployeeId('')
                    }}
                  >
                    <Focus size={17} />处理
                  </button>
                )}
                {workflowLevel !== 'L1' && <span className="task-source">{task.source === 'guest' ? '顾客呼叫' : task.source === 'system' ? '系统触发' : '员工创建'}</span>}
              </div>
              {canSuperviseTask && managerTaskId === task.id && (
                <div className="manager-task-actions">
                  <strong>店长处理</strong>
                  <div className="manager-task-actions__buttons">
                    <button type="button" disabled={actionBusy} onClick={() => void runManagerAction(task, 'assist_complete')}>
                      <CheckCheck size={16} />协助完成
                    </button>
                    <button type="button" disabled={actionBusy} onClick={() => void runManagerAction(task, 'takeover')}>
                      <UserRound size={16} />店长接管
                    </button>
                    <button type="button" disabled={actionBusy} onClick={() => void openTransfer(task)}>
                      <RotateCcw size={16} />转派他人
                    </button>
                  </div>
                  {transferTaskId === task.id && (
                    <div className="manager-task-transfer">
                      {transferCandidates.length > 0 ? (
                        <>
                          <label>
                            <span>转派给</span>
                            <select
                              value={selectedTransferEmployeeId}
                              onChange={(event) => setSelectedTransferEmployeeId(event.target.value)}
                            >
                              {transferCandidates.map((candidate) => (
                                <option key={candidate.employeeId} value={candidate.employeeId}>
                                  {candidate.displayName} · 当前{candidate.load}/{candidate.capacity}项
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            className="primary-button"
                            type="button"
                            disabled={actionBusy || !selectedTransferEmployeeId}
                            onClick={() => void runManagerAction(task, 'transfer', selectedTransferEmployeeId)}
                          >
                            确认转派
                          </button>
                        </>
                      ) : (
                        <span>{actionBusy ? '正在查找合适人员…' : '当前没有可接收此任务的第三人'}</span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </article>
          )
        })}
        {displayedTasks.length < visibleTasks.length && (
          <div className="task-list-more">
            <span>优先展示前 {displayedTasks.length} 条</span>
            <button className="secondary-button" type="button" onClick={() => setVisibleCount((count) => count + 12)}>
              再看 {Math.min(12, visibleTasks.length - displayedTasks.length)} 条
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
