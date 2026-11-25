import { useCallback, useEffect, useState } from 'react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import { useConfirmationDialog } from './ConfirmationDialog'

type CaseView = {
  id?: string
  sourceSuffix: string
  keeperSuffix: string
  requestedBy?: string
  maskedPhone?: string
  reason?: string
  status: 'new' | 'pending' | 'approved' | 'rejected'
}
const path = '/api/staff/membership-recovery/duplicates'

export function DuplicateMembershipPanel({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  const { promptAction } = useConfirmationDialog()
  const [item, setItem] = useState<CaseView | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const load = useCallback(
    async () => setItem((await api.getEndpoint<{ data: CaseView | null }>(path)).data),
    [api],
  )
  useEffect(() => {
    void load().catch(() => setNotice('并户记录暂时无法读取，请刷新。'))
  }, [load])
  const canVerify = auth.permissions.includes('customer.membership.recovery.verify')
  const canReview =
    auth.permissions.includes('customer.membership.merge.approve') && item?.requestedBy !== auth.employee.id
  async function act(action: 'request' | 'approve' | 'reject') {
    if (!item || busy) return
    const title = { request: '提交并户申请', approve: '确认并户', reject: '驳回并户申请' }[action]
    const reason = await promptAction({
      title,
      label: action === 'request' ? '与本人核实的依据' : '复核依据',
      description: '旧卡尾号 ' + item.sourceSuffix + '，保留卡尾号 ' + item.keeperSuffix + '。',
      confirmLabel: title,
    })
    if (!reason?.trim()) return
    setBusy(true)
    try {
      await api.postEndpoint(
        action === 'request' ? path : path + '/' + item.id + '/' + action,
        { reason },
        { idempotencyKey: crypto.randomUUID() },
      )
      setNotice('')
      await load()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '请刷新后查看并户记录。')
    } finally {
      setBusy(false)
    }
  }
  if (!item) return notice ? <p role="status">{notice}</p> : null
  return (
    <section className="activity-admin-list">
      <header>
        <strong>同手机号会员并户</strong>
      </header>
      <article>
        <div>
          <strong>
            旧卡 {item.sourceSuffix} → 保留 {item.keeperSuffix}
          </strong>
          <small>
            {item.maskedPhone}{' '}
            {{ new: '待核验', pending: '待独立复核', approved: '已并户', rejected: '已驳回' }[item.status]}
          </small>
          {item.reason && <p>{item.reason}</p>}
        </div>
        <div className="staff-inline-actions">
          {(item.status === 'new' || item.status === 'rejected') && canVerify && (
            <button disabled={busy} onClick={() => void act('request')}>
              提交复核
            </button>
          )}
          {item.status === 'pending' && canReview && (
            <>
              {canVerify && (
                <button disabled={busy} onClick={() => void act('approve')}>
                  复核并户
                </button>
              )}
              <button disabled={busy} onClick={() => void act('reject')}>
                驳回
              </button>
            </>
          )}
        </div>
      </article>
      {notice && <p role="status">{notice}</p>}
      <button disabled={busy} onClick={() => void load().catch(() => setNotice('暂时无法刷新。'))}>
        刷新并户记录
      </button>
    </section>
  )
}
