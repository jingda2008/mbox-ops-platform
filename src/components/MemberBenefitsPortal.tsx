import { BadgeCheck, CalendarDays, Gift, LoaderCircle, MessageSquareText, Music2, Ticket, Wine } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MemberPortalBenefit, MemberPortalResponse } from '../shared/member-portal-contracts'
import { SuperHighCommunityBand } from './SuperHighCommunityBand'

const levelNames = { standard: '会员', silver: '银卡会员', gold: '金卡会员', platinum: '白金会员' }

export function MemberBenefitsPortal() {
  const memberId = new URLSearchParams(window.location.search).get('member') ?? 'member-amy'
  const [data, setData] = useState<MemberPortalResponse | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch(`/api/dev/member-portal/${encodeURIComponent(memberId)}`)
      .then(async (response) => {
        const body = await response.json() as MemberPortalResponse & { message?: string }
        if (!response.ok) throw new Error(body.message ?? '会员账户载入失败')
        return body
      })
      .then(setData)
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : '会员账户载入失败'))
  }, [memberId])

  if (error) return <main className="member-system-state"><strong>账户暂不可用</strong><span>{error}</span></main>
  if (!data) return <main className="member-system-state"><LoaderCircle className="spin" size={25} /><span>正在载入会员权益</span></main>

  return (
    <main className="member-portal">
      <header className="member-header"><div className="guest-brand"><span>M</span><div><strong>M-BOX</strong>{data.communityBrand && <small>{data.communityBrand.name}旗下空间</small>}</div></div><span>会员中心</span></header>
      <section className="member-identity">
        <span className="member-identity-avatar">{data.member.displayName.slice(0, 1)}</span>
        <div><small>{levelNames[data.member.level]}</small><h1>{data.member.displayName}</h1><p>{data.member.phoneMasked}</p></div>
        <BadgeCheck size={22} />
      </section>
      <section className="member-benefit-summary"><div><strong>{data.benefits.reduce((sum, benefit) => sum + benefit.remainingQuantity, 0)}</strong><span>可用权益</span></div><div><strong>{data.member.serviceAccountBound ? '已绑定' : '未绑定'}</strong><span>微信服务号</span></div><div><strong>{data.member.wecomBound ? '已连接' : '未连接'}</strong><span>企业微信</span></div></section>
      {data.communityBrand && <SuperHighCommunityBand brand={data.communityBrand} />}
      <section className="member-benefit-list">
        <div className="member-section-heading"><Gift size={18} /><h2>我的权益</h2></div>
        {data.benefits.length === 0 ? <div className="member-empty"><Gift size={28} /><strong>暂无可用权益</strong></div> : data.benefits.map((benefit) => <BenefitItem key={benefit.id} benefit={benefit} />)}
      </section>
      <section className="member-message-status"><MessageSquareText size={17} /><span>权益变化将通过已绑定的微信渠道通知</span></section>
    </main>
  )
}

function BenefitItem({ benefit }: { benefit: MemberPortalBenefit }) {
  const Icon = benefit.kind === 'product_gift' ? Wine : benefit.kind === 'song' ? Music2 : benefit.kind === 'amount_coupon' ? Ticket : Gift
  return <article className="member-benefit-item"><span className="member-benefit-icon"><Icon size={20} /></span><div><strong>{benefit.name}</strong><p>{benefit.description}</p><small><CalendarDays size={13} />有效期至 {benefit.validUntil.slice(0, 10)}</small></div><b>×{benefit.remainingQuantity}</b></article>
}
