import { useEffect, useRef, useState } from 'react'
import type { MemberVisitStatus } from '../../shared/member-visit'
import type { StaffActionsApiPort } from './staff-actions-api'
import { useConfirmationDialog } from '../ConfirmationDialog'

export function MemberVisitPanel({ code, api }: { code: string; api: StaffActionsApiPort }) {
  const { confirmAction } = useConfirmationDialog()
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{ api: StaffActionsApiPort; code: string; data: MemberVisitStatus } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const generation = useRef({ active: false })
  useEffect(() => {
    const current = { active: true }
    generation.current = current
    const controller = new AbortController()
    setResult(null); setError(''); setNotice(''); setBusy(false); inFlight.current = false
    if (!api.loadMemberVisit) { setError('当前版本暂不支持到店签到'); return }
    void api.loadMemberVisit(code, controller.signal).then(data => {
      if (!controller.signal.aborted && current.active) setResult({ api, code, data })
    }).catch(reason => { if (!controller.signal.aborted) setError(message(reason)) })
    return () => { controller.abort(); current.active = false }
  }, [api, code, revision])
  const data = result?.api === api && result.code === code ? result.data : null
  async function submit(action: 'check-in' | 'cancel') {
    if (!data || !data.canCheckIn || inFlight.current) return
    const current = generation.current
    const original = data
    inFlight.current = true; setBusy(true); setError(''); setNotice('')
    try {
      if (action === 'cancel' && !await confirmAction({ title: '撤回这次到店签到', description: `${code} · ${original.businessDate} 营业日。保留原签到和撤回记录。`, confirmLabel: '确认撤回' })) return
      if (!current.active) return
      const visit = action === 'check-in' ? await api.checkInMemberVisit!(code, original.businessDate)
        : await api.cancelMemberVisit!(code, original.businessDate, original.visit!.id)
      if (!current.active) return
      // A recovered receipt can describe a visit subsequently cancelled by a
      // colleague. Always show the current fact, not that historical receipt.
      const latest = await api.loadMemberVisit!(code)
      if (!current.active) return
      setResult({ api, code, data: latest })
      setNotice(visit.status === 'checked_in'
        ? latest.visit ? '本营业日到店签到已确认；重复签到只保留一次。' : '原签到记录已撤回或营业日已切换，请核对当前状态后再签到。'
        : latest.visit ? '原签到已撤回；当前还有一条新的到店签到。' : '误签到已撤回。')
    } catch (reason) { if (current.active) setError(message(reason)) }
    finally { if (current.active) { inFlight.current = false; setBusy(false) } }
  }
  return <section aria-label="仅到店签到">
    <h4>仅到店签到</h4><p>只记录会员到店，不代表参加活动，不扣券、不发积分或套餐。</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!data && !error && <p>正在读取本营业日签到…</p>}
    {data && <>
      <p>营业日：{data.businessDate}（每日早上 6 点切换）</p>
      {data.visit ? <>
        <strong>本营业日已签到</strong><p>{new Date(data.visit.checkedInAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} · 经办员工：{data.visit.employeeName}</p>
        {data.canCheckIn && api.cancelMemberVisit && <button type="button" disabled={busy} onClick={()=>void submit('cancel')}>撤回误签到</button>}
      </> : data.canCheckIn && api.checkInMemberVisit ? <button type="button" disabled={busy} onClick={()=>void submit('check-in')}>{busy ? '正在确认…' : '确认到店签到'}</button>
        : <p>当前账号无到店签到操作权限，请由有权限员工办理。</p>}
    </>}
    <button type="button" disabled={busy} onClick={()=>setRevision(value=>value+1)}>重新读取签到</button>
  </section>
}
function message(error: unknown) { return error instanceof Error ? error.message : '签到结果未确认，请重新读取状态后重试' }
