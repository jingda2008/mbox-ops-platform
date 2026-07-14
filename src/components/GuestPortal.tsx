import { CheckCircle2, ChevronRight, Clock3, MessageCircleMore, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createGuestTask, getGuestSession, submitGuestTaskFeedback } from '../api'
import type { GuestSessionResponse, GuestTaskView } from '../shared/guest-contracts'
import { ServiceIcon } from './ServiceIcon'

const guestStatus: Record<GuestTaskView['status'], string> = {
  pending: '等待接单',
  accepted: '服务人员已接单',
  arrived: '服务人员已到桌',
  completed: '请确认是否解决',
  confirmed: '已解决',
  reopened: '已升级继续处理',
  escalated: '已升级处理',
  cancelled: '已取消',
}

export function GuestPortal() {
  const params = new URLSearchParams(window.location.search)
  const tableCode = params.get('table') ?? 'L01'
  const initialToken = params.get('token') ?? ''
  const [data, setData] = useState<GuestSessionResponse | null>(null)
  const [note, setNote] = useState('')
  const [reply, setReply] = useState('')
  const [pendingType, setPendingType] = useState<string | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      setData(await getGuestSession(initialToken, tableCode))
      setError('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '服务暂时不可用')
    }
  }, [initialToken, tableCode])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const tableTasks = useMemo(() => data?.tasks.slice(0, 5) ?? [], [data?.tasks])

  async function requestService(serviceTypeId: string) {
    setPendingType(serviceTypeId)
    setError('')
    try {
      const task = await createGuestTask({
        tableToken: data?.tableToken ?? initialToken,
        serviceTypeId,
        note,
        idempotencyKey: `guest-${tableCode}-${serviceTypeId}-${crypto.randomUUID()}`,
      })
      setReply(task.customerReply)
      setNote('')
      await refresh()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '请求未提交')
    } finally {
      setPendingType(null)
    }
  }

  async function giveFeedback(task: GuestTaskView, action: 'confirm' | 'unresolved') {
    try {
      await submitGuestTaskFeedback(task.id, {
        tableToken: data?.tableToken ?? initialToken,
        action,
        note: action === 'unresolved' ? '客户反馈仍未解决' : '',
        idempotencyKey: `guest-feedback-${task.id}-${action}-${crypto.randomUUID()}`,
      })
      setReply(action === 'confirm' ? '感谢确认，本次服务已完成。' : '已为您升级处理，值班领班会继续跟进。')
      await refresh()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '反馈未提交')
    }
  }

  return (
    <main className="guest-shell">
      <header className="guest-header">
        <div className="guest-brand"><span>M</span><strong>M-Box</strong></div>
        <span className="secure-label"><ShieldCheck size={16} />桌台会话</span>
      </header>

      <section className="guest-table-band">
        <span>当前桌台</span>
        <div>
          <h1>{data?.table.displayName ?? tableCode}</h1>
          <p>服务专员 · {data?.primaryServiceName ?? '正在安排'}</p>
        </div>
      </section>

      {reply && (
        <div className="guest-reply" role="status">
          <CheckCircle2 size={21} />
          <span>{reply}</span>
        </div>
      )}
      {error && <div className="error-banner" role="alert">{error}</div>}

      <section className="guest-services">
        <div className="guest-section-title">
          <span>呼叫服务</span>
          <MessageCircleMore size={20} aria-hidden="true" />
        </div>
        <div className="service-grid">
          {data?.serviceTypes.map((serviceType) => (
            <button
              key={serviceType.id}
              className={serviceType.id === 'complaint' ? 'service-button service-button--complaint' : 'service-button'}
              disabled={pendingType !== null}
              onClick={() => void requestService(serviceType.id)}
            >
              <ServiceIcon icon={serviceType.icon} size={23} />
              <span>{pendingType === serviceType.id ? '正在提交' : serviceType.name}</span>
              <ChevronRight size={17} aria-hidden="true" />
            </button>
          ))}
        </div>
        <label className="guest-note">
          <span>补充说明</span>
          <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={300} placeholder="例如：需要两杯温水" />
        </label>
      </section>

      <section className="guest-progress">
        <div className="guest-section-title"><span>服务进度</span><Clock3 size={20} /></div>
        {tableTasks.length === 0 ? (
          <div className="guest-empty">暂无进行中的服务</div>
        ) : (
          <div className="guest-task-list">
            {tableTasks.map((task) => {
              const serviceType = data?.serviceTypes.find((item) => item.id === task.serviceTypeId)
              return (
                <article className="guest-task" key={task.id}>
                  <div>
                    <strong>{serviceType?.name}</strong>
                    <span>{guestStatus[task.status]} · {task.ownerName ?? '领班调度池'}</span>
                  </div>
                  {task.status === 'completed' && (
                    <div className="guest-feedback">
                      <button onClick={() => void giveFeedback(task, 'confirm')}>已解决</button>
                      <button className="text-danger" onClick={() => void giveFeedback(task, 'unresolved')}>仍未解决</button>
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </section>
    </main>
  )
}
