import { useEffect, useState } from 'react'
import type { MemberParticipation } from '../../shared/member-participation'
import type { StaffActionsApiPort } from './staff-actions-api'
import './member-participation.css'

export function MemberParticipationCard({ code, api, onClose }: {
  code: string; api: StaffActionsApiPort; onClose: () => void
}) {
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{ api: StaffActionsApiPort; revision: number; data?: MemberParticipation; error?: string } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setResult(null)
    if (!api.lookupMemberParticipation) {
      setResult({ api, revision, error: '当前版本暂不支持会员活动查询' })
      return
    }
    void api.lookupMemberParticipation(code, controller.signal).then(data => {
      if (!controller.signal.aborted) setResult({ api, revision, data })
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ api, revision, error: error instanceof Error ? error.message : '会员活动查询失败，请重试' })
    })
    return () => controller.abort()
  }, [code, api, revision])
  const current = result?.api === api && result.revision === revision ? result : null
  const data = current?.data
  return <section className="staff-member-participation" aria-label="会员活动与权益查询" aria-live="polite">
    <header><strong>会员活动与权益</strong><div><button type="button" onClick={() => setRevision(value => value + 1)}>重新查询</button><button type="button" onClick={onClose}>关闭查询</button></div></header>
    {!current && <p>正在查询会员…</p>}
    {current?.error && <p role="alert">{current.error}</p>}
    {data && <>
      <p><strong>{data.displayName ?? '会员'} · {data.memberNo}</strong></p>
      <small>查询时间：{dateText(data.checkedAt)}。扫码只查询；办理前请核对本人，操作时会重新校验。</small>
      <h4>已报名活动</h4>
      {!data.activitiesVisible ? <p>当前账号没有活动查看权限，请由有权限的员工处理。</p> : <>
        {data.registrations.length === 0 && <p>近期没有报名记录。</p>}
        {data.registrations.map(item => <article key={item.publicId}>
          <strong>{item.title} · {item.partySize} 人</strong><small>{dateText(item.startsAt)} · 报名号 {item.publicId}</small>
          <p>{item.guidance}</p><a href={activityLink(item.activityPublicId, item.publicId)}>查看报名与签到</a>
        </article>)}
        <h4>可了解的活动</h4>
        {data.activities.length === 0 && <p>本次查询范围内没有其他可查看活动。</p>}
        {data.activities.map(item => <article key={item.publicId}><strong>{item.title}</strong><small>{dateText(item.startsAt)}</small><p>{item.guidance}</p></article>)}
        <small>最多展示 50 场在售活动及最近 100 条报名。报名请由客人在小程序确认人数和活动须知。</small>
      </>}
      <h4>当前可用券与权益</h4>
      {data.benefits.length === 0 && <p>当前没有剩余可用券；已暂留的领取申请请查看下方权益待办。</p>}
      {data.benefits.map(item => <article key={item.id}><strong>{item.title} · 可用 {item.quantity} 份</strong>
        <small>{item.validUntil ? `有效期至 ${dateText(item.validUntil)}` : '有效期以券面规则为准'}</small><p>{item.guidance}</p></article>)}
    </>}
  </section>
}

function activityLink(activity: string, registration: string) {
  return `/staff/customer-experience?${new URLSearchParams({ activity, registration })}#work=activities`
}
function dateText(value: string) {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}
