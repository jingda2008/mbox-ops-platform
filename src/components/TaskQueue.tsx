import { Check, CheckCheck, Clock3, MapPin, Navigation, RotateCcw, UserRound } from 'lucide-react'
import { ServiceIcon } from './ServiceIcon'
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
  completed: '待客户确认',
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
  compact?: boolean
}

export function TaskQueue({
  tasks,
  tables,
  employees,
  serviceTypes,
  selectedTableId,
  onClearTable,
  onAction,
  compact = false,
}: TaskQueueProps) {
  const visibleTasks = tasks
    .filter((task) => !['confirmed', 'cancelled'].includes(task.status))
    .filter((task) => !selectedTableId || task.tableId === selectedTableId)
    .sort((a, b) => {
      const priority = { urgent: 4, high: 3, normal: 2, low: 1 }
      return priority[b.priority] - priority[a.priority] || +new Date(a.createdAt) - +new Date(b.createdAt)
    })

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

      <div className="task-list" aria-live="polite">
        {visibleTasks.length === 0 && (
          <div className="empty-state">
            <CheckCheck size={24} aria-hidden="true" />
            <strong>当前没有待处理任务</strong>
          </div>
        )}
        {visibleTasks.map((task) => {
          const table = tables.find((item) => item.id === task.tableId)
          const owner = employees.find((item) => item.id === task.ownerId)
          const serviceType = serviceTypes.find((item) => item.id === task.serviceTypeId)
          if (!table || !serviceType) return null
          const fulfillmentDelivery = serviceType.code === 'FULFILLMENT_DELIVERY'
          const atRisk = Date.now() >= new Date(task.warningAt).getTime() && !['arrived', 'completed'].includes(task.status)

          return (
            <article className={`task-item priority-${task.priority} ${atRisk ? 'is-at-risk' : ''}`} key={task.id}>
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

              {task.note && <p className="task-note">{task.note}</p>}
              <div className="ai-directive">
                <span>AI指令</span>
                <ol>
                  {task.actionScript.map((step) => <li key={step}>{step}</li>)}
                </ol>
              </div>

              <div className="task-actions">
                {['pending', 'escalated', 'reopened'].includes(task.status) && task.ownerId && (
                  <button className="primary-button" onClick={() => void onAction(task, 'accept')}>
                    <Check size={17} />{fulfillmentDelivery ? '接取送任务' : '接单'}
                  </button>
                )}
                {task.status === 'accepted' && (
                  <button className="primary-button" onClick={() => void onAction(task, 'arrive')}>
                    <Navigation size={17} />{fulfillmentDelivery ? '确认取货' : '已到桌'}
                  </button>
                )}
                {task.status === 'arrived' && (
                  <button className="primary-button" onClick={() => void onAction(task, 'complete')}>
                    <CheckCheck size={17} />{fulfillmentDelivery ? '确认送达' : '完成服务'}
                  </button>
                )}
                <span className="task-source">{task.source === 'guest' ? '顾客呼叫' : task.source === 'system' ? '系统触发' : '员工创建'}</span>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
