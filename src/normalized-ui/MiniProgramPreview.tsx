import { useMemo, useState } from 'react'
import {
  ArrowLeft, CalendarDays, Check, ChevronRight, Crown, Gift, House, MapPin,
  Martini, Music2, ScanLine, ShieldCheck, TicketCheck, UserRound, UsersRound,
} from 'lucide-react'
import './mini-program-preview.css'

type Tab = 'home' | 'reservation' | 'order' | 'community' | 'profile'

const tabs: Array<{ code: Tab; label: string; icon: typeof House }> = [
  { code: 'home', label: '首页', icon: House },
  { code: 'reservation', label: '预约', icon: CalendarDays },
  { code: 'order', label: '点单', icon: Martini },
  { code: 'community', label: '超嗨', icon: UsersRound },
  { code: 'profile', label: '我的', icon: UserRound },
]

export function MiniProgramPreview() {
  const [tab, setTab] = useState<Tab>('home')
  const [tableReady, setTableReady] = useState(false)
  const [reservationStep, setReservationStep] = useState(1)
  const [activityOpen, setActivityOpen] = useState<'paid' | 'free' | null>(null)
  const [partySize, setPartySize] = useState(2)
  const content = useMemo(() => ({
    home: <HomePreview onScan={() => { setTableReady(true); setTab('order') }} onActivity={() => { setActivityOpen('paid'); setTab('community') }} />,
    reservation: <ReservationPreview step={reservationStep} onStep={setReservationStep} />,
    order: <OrderPreview tableReady={tableReady} onScan={() => setTableReady(true)} />,
    community: <CommunityPreview open={activityOpen} onOpen={setActivityOpen} partySize={partySize} onPartySize={setPartySize} />,
    profile: <ProfilePreview />,
  })[tab], [activityOpen, partySize, reservationStep, tab, tableReady])

  return <main className="mini-preview-stage">
    <section className="mini-preview-shell" aria-label="M-BOX 小程序交互预览">
      <header className="mini-preview-status"><span>21:08</span><strong>M-BOX</strong><span>交互预览</span></header>
      <div className="mini-preview-content">{content}</div>
      <nav className="mini-preview-tabs" aria-label="小程序主导航">
        {tabs.map((item) => {
          const Icon = item.icon
          return <button key={item.code} type="button" className={tab === item.code ? 'is-active' : ''} onClick={() => setTab(item.code)}><Icon size={20} /><span>{item.label}</span></button>
        })}
      </nav>
    </section>
  </main>
}

function HomePreview({ onScan, onActivity }: { onScan(): void; onActivity(): void }) {
  return <>
    <header className="mini-home-hero">
      <span className="mini-kicker">M-BOX · LUJIAZUI</span>
      <h1>让今晚，<br />自然发生。</h1>
      <p>现场音乐、好酒和刚好的照顾。</p>
      <button type="button" onClick={onScan}><ScanLine size={19} />扫码入座并点单</button>
    </header>
    <section className="mini-section mini-tonight">
      <header><div><small>TONIGHT</small><strong>今晚的现场</strong></div><span>8月15日</span></header>
      <article><div className="mini-live-time"><b>21:30</b><span>第一场</span></div><div><strong>Live Band · 城市夜航</strong><p>主唱 林南 · 吉他 周木 · 约45分钟</p></div><ChevronRight size={18} /></article>
      <article><div className="mini-live-time"><b>23:00</b><span>第二场</span></div><div><strong>Acoustic · 深夜点唱</strong><p>可在入座后提交今晚点歌</p></div><ChevronRight size={18} /></article>
    </section>
    <section className="mini-section mini-home-shortcuts"><header><strong>到店前也能安排</strong><span>少填、分步确认</span></header><div><button type="button"><CalendarDays /><strong>预约座位</strong><small>三步完成</small></button><button type="button" onClick={onActivity}><UsersRound /><strong>本周超嗨</strong><small>查看活动</small></button></div></section>
  </>
}

function ReservationPreview({ step, onStep }: { step: number; onStep(value: number): void }) {
  return <><Band eyebrow="RESERVATION" title="预约一晚好状态" copy="只在当前步骤展示必要信息，提交前统一确认。" />
    <section className="mini-section mini-reservation">
      <div className="mini-progress" aria-label={`预约第${step}步`}><i className={step >= 1 ? 'is-done' : ''}>1</i><span></span><i className={step >= 2 ? 'is-done' : ''}>2</i><span></span><i className={step >= 3 ? 'is-done' : ''}>3</i></div>
      {step === 1 && <div className="mini-step-card"><small>STEP 1 / 3</small><h2>什么时候来？</h2><label>到店日期<span>8月16日 周六</span></label><label>到店时间<span>20:30</span></label><label>同行人数<span>2 人</span></label></div>}
      {step === 2 && <div className="mini-step-card"><small>STEP 2 / 3</small><h2>更喜欢什么位置？</h2><button type="button" className="mini-option is-selected"><strong>舒适卡座</strong><span>适合聊天，也能看见舞台</span><Check /></button><button type="button" className="mini-option"><strong>舞台附近</strong><span>更沉浸，现场音量较高</span></button><div className="mini-show-hint"><Music2 /><span><strong>当晚 21:30 有现场演出</strong><small>已按预约日期匹配，不再写死时间</small></span></div></div>}
      {step === 3 && <div className="mini-step-card"><small>STEP 3 / 3</small><h2>确认你的预约</h2><dl><div><dt>时间</dt><dd>周六 20:30</dd></div><div><dt>人数</dt><dd>2 人</dd></div><div><dt>倾向</dt><dd>舒适卡座</dd></div></dl><div className="mini-rule is-free"><Check />本时段无需线上定金；门店确认后生效</div></div>}
      <div className="mini-step-actions">{step > 1 && <button type="button" className="mini-quiet" onClick={() => onStep(step - 1)}>上一步</button>}<button type="button" className="mini-primary" onClick={() => onStep(Math.min(3, step + 1))}>{step === 3 ? '提交预约' : '下一步'}</button></div>
    </section>
  </>
}

function OrderPreview({ tableReady, onScan }: { tableReady: boolean; onScan(): void }) {
  if (!tableReady) return <><Band eyebrow="ORDER AT TABLE" title="入座后，再开始点单" copy="先扫描桌面二维码，确认门店、桌号和开台状态，避免误下单。" />
    <section className="mini-order-gate"><div><ScanLine size={36} /></div><h2>扫描本桌二维码</h2><p>正式菜单只在有效桌码和已开台状态下开放。预约、演出和活动仍可直接浏览。</p><button type="button" className="mini-primary" onClick={onScan}>模拟扫码确认桌号</button><small><ShieldCheck size={14} />不会因打开页面自动创建订单或扣款</small></section>
  </>
  return <><header className="mini-order-head"><span><MapPin size={14} />陆家嘴店 · A08桌 · 已开台</span><h1>今晚想喝点什么？</h1><p>朋友聚会 · 2人 <button type="button">调整</button></p></header>
    <section className="mini-section"><header><div><small>JUST FOR THIS TABLE</small><strong>三档，差别说清楚</strong></div><span>按库存实时推荐</span></header><div className="mini-product is-featured"><div><em>最适合本桌</em><strong>两人微醺现场</strong><span>两杯核心酒水 · 分享小食 · 今晚点歌权益</span></div><b>¥398</b><button type="button">加入点单</button></div><div className="mini-product"><div><em>更尽兴</em><strong>乐队主场分享夜</strong><span>酒水升级 · 分享冷食 · 隐藏互动</span></div><b>¥598</b><button type="button">加入点单</button></div><p className="mini-upgrade-note">付款前如有真实适配的升级，只展示一次；拒绝后不反复打扰。</p></section>
  </>
}

function CommunityPreview({ open, onOpen, partySize, onPartySize }: { open: 'paid' | 'free' | null; onOpen(value: 'paid' | 'free' | null): void; partySize: number; onPartySize(value: number): void }) {
  if (open === 'free') return <><header className="mini-detail-nav"><button type="button" onClick={() => onOpen(null)}><ArrowLeft />返回活动</button><span>活动详情</span></header><div className="mini-activity-cover"><MapPin /><span>SUPERHIGH WALK</span></div><section className="mini-activity-detail"><em>免费活动 · 提交后确认名额</em><h1>陆家嘴夜景<br />音乐散步</h1><p className="mini-activity-meta">8月20日 周三 19:00<br />M-BOX陆家嘴店集合</p><div className="mini-price"><strong>免费</strong><span>无需订金或线上付款<br />限20位</span></div><div className="mini-detail-block"><h2>这次包含</h2><ul><li><Check />领队带领的夜景路线</li><li><Gift />签到后赠送无酒精饮品券</li></ul></div><div className="mini-detail-block"><h2>参加前请确认</h2><ul><li><ShieldCheck />请穿适合步行的鞋</li><li><MapPin />如遇恶劣天气将提前通知</li></ul></div><div className="mini-stepper"><span>报名人数</span><div><button type="button" onClick={() => onPartySize(Math.max(1, partySize - 1))}>−</button><b>{partySize}</b><button type="button" onClick={() => onPartySize(Math.min(6, partySize + 1))}>＋</button></div></div><button type="button" className="mini-primary">免费报名</button><small className="mini-payment-caption">真实页面提交后由服务端确认名额，不会发起扣款</small></section></>
  if (open === 'paid') return <><header className="mini-detail-nav"><button type="button" onClick={() => onOpen(null)}><ArrowLeft />返回活动</button><span>活动详情</span></header><div className="mini-activity-cover"><Music2 /><span>SUPERHIGH 08</span></div><section className="mini-activity-detail"><em>收费报名 · 支付能力未接入时阻断</em><h1>歌手主场后的<br />深夜小聚</h1><p className="mini-activity-meta">8月16日 周六 23:20<br />M-BOX陆家嘴店集合</p><div className="mini-price"><strong>¥168<small>/人</small></strong><span>计划收取 ¥50/人订金<br />支付能力接通后开放</span></div><div className="mini-detail-block"><h2>这次包含</h2><ul><li><Check />活动限定欢迎饮品 1 杯</li><li><Check />歌手交流与限定点唱</li><li><Gift />报名成功赠送饮品券 1 张</li></ul></div><div className="mini-detail-block"><h2>参加前请确认</h2><ul><li><ShieldCheck />须年满18周岁，请勿酒后驾车</li><li><MapPin />请提前15分钟到店签到</li></ul></div><div className="mini-stepper"><span>报名人数</span><div><button type="button" onClick={() => onPartySize(Math.max(1, partySize - 1))}>−</button><b>{partySize}</b><button type="button" onClick={() => onPartySize(Math.min(6, partySize + 1))}>＋</button></div></div><button type="button" className="mini-primary" disabled>收费报名暂未开放</button><small className="mini-payment-caption">当前不会创建报名、占用名额或发起扣款</small></section></>
  return <><Band eyebrow="SUPERHIGH" title="今晚之外，继续相遇" copy="音乐、城市与真实的人；先看详情，再决定是否参加。" />
    <section className="mini-section mini-community-list"><header><strong>近期活动</strong><span>1 场可报名 · 1 场待开放</span></header><article className="mini-event-card"><div className="mini-event-art"><Music2 /><span>仅30位</span></div><div><em>会员音乐夜</em><h2>歌手主场后的深夜小聚</h2><p>周六 23:20 · M-BOX陆家嘴店</p><footer><strong>¥168/人</strong><button type="button" onClick={() => onOpen('paid')}>查看详情<ChevronRight /></button></footer></div></article><article className="mini-event-row"><div><em>城市漫步</em><strong>陆家嘴夜景音乐散步</strong><span>周三 19:00 · 无需预付</span></div><button type="button" onClick={() => onOpen('free')}>详情<ChevronRight /></button></article></section>
  </>
}

function ProfilePreview() {
  return <><Band eyebrow="MY M-BOX" title="你的今晚，都在这里" copy="订单、预约、活动和真正可使用的权益。" />
    <section className="mini-member"><div><Crown /><span>GOLD MEMBER</span></div><strong>1,280<small>可用积分</small></strong><button type="button">会员码</button></section>
    <section className="mini-section mini-benefits"><header><strong>我的权益与赠送</strong><span>2 项可用</span></header><article><div><Gift /><span><strong>活动限定饮品券</strong><small>来自“深夜小聚”报名赠送</small></span><b>可使用</b></div><footer>2026.09.15 前有效 <button type="button">查看使用规则</button></footer></article><article><div><TicketCheck /><span><strong>会员点歌优先券</strong><small>到店扫码后可核销</small></span><b>可使用</b></div><footer>仅限有现场演出的营业日</footer></article></section>
    <section className="mini-section mini-personal-links"><button type="button"><span>我的预约<small>1 个待到店</small></span><ChevronRight /></button><button type="button"><span>我的活动<small>1 个待参加</small></span><ChevronRight /></button><button type="button"><span>服务进度<small>查看请求与反馈</small></span><ChevronRight /></button></section>
  </>
}

function Band({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) {
  return <header className="mini-band"><span>{eyebrow}</span><h1>{title}</h1><p>{copy}</p></header>
}
