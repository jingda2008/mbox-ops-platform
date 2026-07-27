import { Check, CheckCheck, Clock3, MapPin, Navigation, RotateCcw, UserRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ServiceIcon } from './ServiceIcon'
import { taskAcceptMode, taskMatchesQueueFilter, taskQueueFilterForQuery, taskQueueIsOpen } from './task-queue'
import type {
  Employee,
  ServiceTask,
  ServiceTypeConfig,
  Table,
  TaskActionInput,
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

function elapsedLabel(createdAt: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000))
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
  busyTaskIds: ReadonlySet<string>
  currentEmployeeId: string
  claimableTaskIds: ReadonlySet<string>
  compact?: boolean
  focusTaskId?: string | null
  focusQuery?: string | null
  focusRequestId?: number | null
  onClearFocus?: () => void
}

export function TaskQueue({
  tasks,
  tables,
  employees,
  serviceTypes,
  selectedTableId,
  onClearTable,
  onAction,
  busyTaskIds,
  currentEmployeeId,
  claimableTaskIds,
  compact = false,
  focusTaskId = null,
  focusQuery = null,
  focusRequestId = null,
  onClearFocus,
}: TaskQueueProps) {
  const [visibleCount, setVisibleCount] = useState(12)
  const filter = taskQueueFilterForQuery(focusQuery)
  const complaintServiceTypeIds = new Set(serviceTypes
    .filter((serviceType) => serviceType.code === 'COMPLAINT' || serviceType.icon === 'complaint')
    .map((serviceType) => serviceType.id))
  const visibleTasks = tasks
    .filter((task) => !task.archivedAt)
    .filter(taskQueueIsOpen)
    .filter((task) => !selectedTableId || task.tableId === selectedTableId)
    .filter((task) => taskMatchesQueueFilter(task, filter, complaintServiceTypeIds))
    .sort((a, b) => {
      if (focusTaskId && a.id === focusTaskId) return -1
      if (focusTaskId && b.id === focusTaskId) return 1
      const priority = { urgent: 4, high: 3, normal: 2, low: 1 }
      return priority[b.priority] - priority[a.priority] || +new Date(a.createdAt) - +new Date(b.createdAt)
    })
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

  return (
    <section className={`task-queue ${compact ? 'task-queue--compact' : ''}`}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">实时任务</span>
          <h2>{selectedTableId ? '桌台任务' : '待处理队列'}</h2>
        </div>
        <div className="heading-actions">
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
          const atRisk = Date.now() >= new Date(task.warningAt).getTime() && !['arrived', 'completed'].includes(task.status)
          const acceptMode = taskAcceptMode(task, currentEmployeeId, claimableTaskIds.has(task.id))

          return (
            <article
              id={`service-task-${task.id}`}
              className={`task-item priority-${task.priority} ${atRisk ? 'is-at-risk' : ''} ${focusTaskId === task.id ? 'is-navigation-focus' : ''}`}
              key={task.id}
              aria-busy={busyTaskIds.has(task.id)}
            >
              <div className="task-item__top">
                <span className="service-symbol">
                  <ServiceIcon icon={serviceType.icon} size={18} />
                </span>
                <div className="task-item__identity">
                  <div className="task-title-row">
                    <strong>{serviceType.name}</strong>
                    <span className={`status-tag status-${task.status}`}>{fulfillmentDelivery && task.status === 'arrived' ? '配送中' : statusLabels[task.status]}</span>
                  </div>
                  <div className="task-meta">
                    <span><MapPin size={14} />{table.displayName}</span>
                    <span><Clock3 size={14} />{elapsedLabel(task.createdAt)}</span>
                    <span><UserRound size={14} />{owner?.displayName ?? '领班调度池'}</span>
                  </div>
                </div>
              </div>

              {task.note && <p className={`task-note${task.note.includes('【订单重点备注】') ? ' is-important' : ''}`}>{task.note}</p>}
              <div className="ai-directive">
                <span>AI指令</span>
                <ol>
                  {task.actionScript.map((step) => <li key={step}>{step}</li>)}
                </ol>
              </div>

              <div className="task-actions">
                {acceptMode && (
                  <button className="primary-button" disabled={busyTaskIds.has(task.id)} onClick={() => void onAction(task, 'accept')}>
                    <Check size={17} />{acceptMode === 'claim' ? '认领并接单' : fulfillmentDelivery ? '接取送任务' : '接单'}
                  </button>
                )}
                {task.status === 'accepted' && (
                  <button className="primary-button" disabled={busyTaskIds.has(task.id)} onClick={() => void onAction(task, 'arrive')}>
                    <Navigation size={17} />{fulfillmentDelivery ? '确认取货' : '已到桌'}
                  </button>
                )}
                {task.status === 'arrived' && (
                  <button className="primary-button" disabled={busyTaskIds.has(task.id)} onClick={() => void onAction(task, 'complete')}>
                    <CheckCheck size={17} />{fulfillmentDelivery ? '确认送达' : '完成服务'}
                  </button>
                )}
                <span className="task-source">{task.source === 'guest' ? '顾客呼叫' : task.source === 'system' ? '系统触发' : '员工创建'}</span>
              </div>
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
