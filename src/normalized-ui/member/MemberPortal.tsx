import { BadgeCheck, CalendarDays, Gift, LoaderCircle, RefreshCw, ShieldCheck, Ticket, Wine } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import './member-portal.css'

interface MemberProfile {
  publicId: string
  displayName: string | null
  tags: string[]
  firstSeenAt: string
}

interface MemberBenefit {
  id: string
  code: string
  type: string
  display: Record<string, unknown>
  quantityAvailable: number
  validUntil: string
}

type MemberPhase = 'loading' | 'ready' | 'identity_required' | 'error'

export function MemberPortal() {
  const [phase, setPhase] = useState<MemberPhase>('loading')
  const [profile, setProfile] = useState<MemberProfile | null>(null)
  const [benefits, setBenefits] = useState<MemberBenefit[]>([])
  const [message, setMessage] = useState('')
  const [operationMessage, setOperationMessage] = useState('')
  const [pendingBenefitId, setPendingBenefitId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setPhase('loading')
    setMessage('')
    try {
      const headers = new Headers({ accept: 'application/json', 'x-mbox-guest-device': guestDeviceKey() })
      const [profileResponse, benefitsResponse] = await Promise.all([
        fetch('/api/guest/customer/profile', { credentials: 'include', headers }),
        fetch('/api/guest/customer/benefits', { credentials: 'include', headers }),
      ])
      if (profileResponse.status === 401 || benefitsResponse.status === 401) {
        setPhase('identity_required')
        return
      }
      if (!profileResponse.ok || !benefitsResponse.ok) throw new Error('会员资料暂时没有接上')
      const profileBody = await profileResponse.json() as { data?: unknown }
      const benefitsBody = await benefitsResponse.json() as { data?: unknown }
      const nextProfile = memberProfile(profileBody.data)
      if (nextProfile === null) throw new Error('会员资料格式无法识别')
      setProfile(nextProfile)
      setBenefits(memberBenefits(benefitsBody.data))
      setPhase('ready')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '会员资料暂时没有接上')
      setPhase('error')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const reserveBenefit = useCallback(async (benefit: MemberBenefit) => {
    if (pendingBenefitId !== null) return
    setPendingBenefitId(benefit.id)
    setOperationMessage('')
    try {
      const response = await fetch(`/api/guest/customer/benefits/${encodeURIComponent(benefit.id)}/reservations`, {
        method: 'POST',
        credentials: 'include',
        headers: new Headers({
          accept: 'application/json',
          'content-type': 'application/json',
          'x-mbox-guest-device': guestDeviceKey(),
          'idempotency-key': `member-benefit-${crypto.randomUUID()}`,
        }),
        body: JSON.stringify({ quantity: 1 }),
      })
      if (response.status === 401) {
        setPhase('identity_required')
        return
      }
      if (!response.ok) throw new Error(await responseMessage(response, '当前暂不能预约这项权益'))
      await load()
      setOperationMessage(`“${benefitName(benefit)}”已预约，请到店后向服务员出示本页。`)
    } catch (error) {
      setOperationMessage(error instanceof Error ? error.message : '当前暂不能预约这项权益')
    } finally {
      setPendingBenefitId(null)
    }
  }, [load, pendingBenefitId])

  if (phase === 'loading') return <MemberGate icon={<LoaderCircle className="is-spinning" />} title="正在读取会员权益" detail="只显示当前微信或访客身份下的真实数据。" />
  if (phase === 'identity_required') return <MemberGate icon={<ShieldCheck />} title="登录后查看会员权益" detail="正式微信小程序或服务号上线后，将在这里完成微信身份授权；当前不会展示测试会员或虚构权益。" />
  if (phase === 'error') return <MemberGate icon={<RefreshCw />} title="会员资料暂时没有接上" detail={message} action={<button type="button" onClick={() => void load()}>重新加载</button>} />
  if (profile === null) return null

  return <main className="normalized-member">
    <header><span className="normalized-member-mark">M</span><div><strong>M-BOX</strong><small>SUPERHIGH CULTURE · MEMBER</small></div><BadgeCheck size={21} /><button type="button" aria-label="刷新会员资料" onClick={() => void load()}><RefreshCw size={18} /></button></header>
    <section className="normalized-member-identity"><p>今晚，欢迎回来</p><h1>{profile.displayName?.trim() || 'M-BOX 会员'}</h1><span>相识于 {formatDate(profile.firstSeenAt)}</span></section>
    <section className="normalized-member-summary"><div><strong>{benefits.reduce((sum, item) => sum + item.quantityAvailable, 0)}</strong><span>可用权益</span></div><div><strong>{profile.tags.length}</strong><span>偏好标签</span></div></section>
    <nav className="normalized-member-actions" aria-label="会员快捷操作">
      <a href="/reserve"><CalendarDays size={18} /><span><strong>预约座位</strong><small>选择日期、时间和位置偏好</small></span></a>
      <button type="button" onClick={() => void load()}><RefreshCw size={18} /><span><strong>刷新权益</strong><small>查看最新可用数量与有效期</small></span></button>
    </nav>
    {profile.tags.length > 0 && <section className="normalized-member-tags" aria-labelledby="member-tags-title"><h2 id="member-tags-title">我的偏好</h2><div>{profile.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></section>}
    {operationMessage !== '' && <p className="normalized-member-operation" role="status">{operationMessage}</p>}
    <section className="normalized-member-benefits"><header><Gift size={18} /><h2>我的权益</h2></header>
      {benefits.length === 0 ? <div className="normalized-member-empty"><Gift size={25} /><strong>当前没有可用权益</strong><span>门店赠送或活动权益到账后会显示在这里。</span><a href="/reserve">先预约到店</a></div> : benefits.map((benefit) => <article key={benefit.id}><span>{benefitIcon(benefit.type)}</span><div><strong>{benefitName(benefit)}</strong><small>{benefitDescription(benefit)} · 有效期至 {formatDate(benefit.validUntil)}</small></div><div className="normalized-member-benefit-action"><b>×{benefit.quantityAvailable}</b><button type="button" disabled={pendingBenefitId !== null || benefit.quantityAvailable < 1} onClick={() => void reserveBenefit(benefit)}>{pendingBenefitId === benefit.id ? '预约中' : '预约使用'}</button></div></article>)}
    </section>
    <p className="normalized-member-note">权益以本页最新状态和门店确认结果为准；部分权益需入座扫码后才能预约使用。</p>
  </main>
}

function MemberGate({ icon, title, detail, action }: { icon: ReactNode; title: string; detail: string; action?: ReactNode }) {
  return <main className="normalized-member-gate"><span className="normalized-member-mark">M</span>{icon}<strong>{title}</strong><p>{detail}</p>{action}</main>
}

function memberProfile(value: unknown): MemberProfile | null {
  if (!isRecord(value) || typeof value.publicId !== 'string' || !Array.isArray(value.tags) || typeof value.firstSeenAt !== 'string') return null
  return { publicId: value.publicId, displayName: typeof value.displayName === 'string' ? value.displayName : null, tags: value.tags.filter((tag): tag is string => typeof tag === 'string'), firstSeenAt: value.firstSeenAt }
}

function memberBenefits(value: unknown): MemberBenefit[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => isRecord(item) && typeof item.id === 'string' && typeof item.code === 'string'
    && typeof item.type === 'string' && isRecord(item.display) && typeof item.quantityAvailable === 'number' && typeof item.validUntil === 'string'
    ? [item as unknown as MemberBenefit] : [])
}

function benefitName(benefit: MemberBenefit): string { return typeof benefit.display.name === 'string' ? benefit.display.name : benefit.code }
function benefitDescription(benefit: MemberBenefit): string { return typeof benefit.display.description === 'string' ? benefit.display.description : '到店后可预约使用' }
function benefitIcon(type: string) { return type === 'discount' || type === 'credit' ? <Ticket size={19} /> : type === 'gift_product' ? <Wine size={19} /> : <Gift size={19} /> }
function formatDate(value: string): string { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

function guestDeviceKey(): string {
  const key = 'mbox-normalized-guest-device-v1'
  try {
    const existing = window.sessionStorage.getItem(key)
    if (existing !== null && existing.length >= 8 && existing.length <= 256) return existing
    const created = `guest-web-${crypto.randomUUID()}`
    window.sessionStorage.setItem(key, created)
    return created
  } catch {
    return `guest-web-${crypto.randomUUID()}`
  }
}

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: unknown } }
    return typeof body.error?.message === 'string' && body.error.message.trim() !== '' ? body.error.message : fallback
  } catch {
    return fallback
  }
}
