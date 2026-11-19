import { useState } from 'react'
import { Users } from 'lucide-react'
import { StaffActionsApiError, type GuestCountChange } from './staff-actions-api'
import type { StaffActionTableSession } from './types'
import { validateOpenTableInput } from './staff-actions-model'

interface Props {
  tableId: string
  session: StaffActionTableSession
  pending: boolean
  onSave(change: GuestCountChange, key: string): Promise<number>
}

export function TableGuestCountEditor({ tableId, session, pending, onSave }: Props) {
  const [original, setOriginal] = useState<number | null>(null)
  const [text, setText] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [retry, setRetry] = useState<{ key: string; change: GuestCountChange } | null>(null)
  const [confirmation, setConfirmation] = useState<{ count: number; message: string } | null>(null)

  const start = () => {
    setOriginal(session.guestCount)
    setText(String(session.guestCount))
    setReason('')
    setError('')
    setRetry(null)
    setConfirmation(null)
  }
  if (original === null) return (
    <>
      <button type="button" disabled={pending} onClick={start}><Users size={17} />改人数 · {session.guestCount}人</button>
      {confirmation?.count === session.guestCount &&
        <p role="status" className="staff-guest-count-confirmed">{confirmation.message}</p>}
    </>
  )

  const capacity = session.capacityAtOpen
  const count = Number(text)
  const busy = pending || saving
  const locked = busy || retry !== null
  const stale = !saving && !retry && original !== session.guestCount
  const save = async () => {
    if (busy || stale) return
    let attempt = retry
    if (!attempt) {
      const input = validateOpenTableInput({ capacity }, text, reason)
      if ('error' in input) return setError(input.error)
      if (input.capacityOverrideReason && input.capacityOverrideReason.length < 2) return setError('加座说明至少填写两个字')
      attempt = { key: `staff-guest-count-${crypto.randomUUID()}`,
        change: { tableId, locationVersion: session.locationVersion ?? 0, expectedGuestCount: original, ...input } }
    }
    setSaving(true)
    setError('')
    try {
      const current = await onSave(attempt.change, attempt.key)
      setConfirmation({ count: current, message: current === attempt.change.guestCount
        ? `人数已保存，当前 ${current} 人。` : `原修改已确认，本桌随后已调为 ${current} 人。` })
      setOriginal(null)
      setRetry(null)
    } catch (cause) {
      if (cause instanceof StaffActionsApiError && cause.status !== null && cause.status >= 400 && cause.status < 500 &&
          ![408, 429].includes(cause.status)) {
        // A refusal on recovery cannot revoke the first submission's receipt.
        setError(retry ? `${cause.message}。可返回桌台核对当前人数。` : cause.message)
      } else {
        setRetry(attempt)
        setError('保存结果尚未确认，请重试本次保存。')
      }
    } finally {
      setSaving(false)
    }
  }
  return (
    <form className="staff-guest-count-editor" aria-label="修改实际人数" onSubmit={event => { event.preventDefault(); void save() }}>
      <label htmlFor="staff-actual-guest-count">实际人数</label>
      <div className="staff-guest-count-stepper">
        <button type="button" aria-label="减少一人" disabled={locked || count <= 1} onClick={() => setText(String(count - 1))}>−</button>
        <input id="staff-actual-guest-count" inputMode="numeric" pattern="[0-9]*" maxLength={3} value={text}
          disabled={locked} onFocus={event => event.target.select()} onChange={event => setText(event.target.value.replace(/\D/g, ''))} />
        <button type="button" aria-label="增加一人" disabled={locked || count >= 200} onClick={() => setText(String(count + 1))}>＋</button>
      </div>
      {count > capacity && <label className="staff-capacity-reason">超过 {capacity} 人，请填写加座说明
        <input value={reason} maxLength={1000} disabled={locked} onChange={event => setReason(event.target.value)} />
      </label>}
      {stale ? <p role="alert">本桌人数已更新为 {session.guestCount} 人，请重新核对。</p> : error && <p role="alert">{error}</p>}
      <div className="staff-guest-count-buttons">
        <button type="button" disabled={busy} onClick={() => setOriginal(null)}>{retry ? '返回' : '取消'}</button>
        {stale ? <button type="button" onClick={start} disabled={busy}>使用最新人数</button> :
          <button className="is-payment" type="submit" disabled={busy || !text || count === original}>
            {saving ? '正在保存人数…' : retry ? '重试保存' : '保存人数'}
          </button>}
      </div>
    </form>
  )
}
