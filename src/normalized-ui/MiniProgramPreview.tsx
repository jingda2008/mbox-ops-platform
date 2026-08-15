import { useMemo, useState } from 'react'
import { CalendarDays, Check, ChevronRight, Crown, House, Martini, Music2, UserRound, UsersRound } from 'lucide-react'
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
  const [tab, setTab] = useState<Tab>('community')
  const [partySize, setPartySize] = useState(2)
  const content = useMemo(() => ({
    home: <HomePreview />,
    reservation: <ReservationPreview />,
    order: <OrderPreview />,
    community: <CommunityPreview partySize={partySize} onPartySize={setPartySize} />,
    profile: <ProfilePreview />,
  })[tab], [partySize, tab])

  return <main className="mini-preview-stage">
    <section className="mini-preview-shell" aria-label="M-BOX 小程序交互预览">
      <header className="mini-preview-status"><span>21:08</span><strong>M-BOX</strong><span>演示数据</span></header>
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

function HomePreview() {
  return <><Band eyebrow="M-BOX LUJIAZUI" title="今晚，为你安排好" copy="现场弹唱 20:30 · 乐队第一场 21:30" />
    <section className="mini-section"><header><strong>现在适合做什么</strong><span>入场后</span></header><div className="mini-action-grid"><button><Martini />开始点单<small>按人数和场景推荐</small></button><button><Music2 />现场点歌<small>按今晚排班提交</small></button></div></section>
    <section className="mini-section"><header><strong>今晚演出</strong><span>场间有节奏</span></header><div className="mini-timeline"><i></i><div><strong>21:30 乐队现场</strong><span>第一场 · 45分钟</span></div><ChevronRight /></div></section>
  </>
}

function ReservationPreview() {
  return <><Band eyebrow="RESERVATION" title="先确认容量，再提交安排" copy="位置、费用和定金规则在提交前说清楚" />
    <section className="mini-section mini-form"><label>人数<span>2 人</span></label><label>到店时间<span>周六 20:30</span></label><label>位置倾向<span>舒适卡座</span></label><div className="mini-rule is-free"><Check />当前不要求线上定金，门店确认后生效</div><button className="mini-primary">确认并提交预约</button></section>
  </>
}

function OrderPreview() {
  return <><Band eyebrow="TONIGHT EXPERIENCE" title="先选场景，再选酒水" copy="组合优先，付款前可看到一次真实升级选择" />
    <section className="mini-choice"><span>今晚是 <strong>朋友聚会</strong></span><span>想喝 <strong>请帮我选</strong></span><button>帮我选</button></section>
    <section className="mini-section"><header><strong>为本桌安排</strong><span>三档可比较</span></header><div className="mini-product"><div><em>推荐</em><strong>两人微醺现场</strong><span>两杯核心酒水 · 仪式果盘 · 现场权益</span></div><b>¥398</b><button>选择</button></div><div className="mini-product"><div><em>尽兴</em><strong>乐队主场分享夜</strong><span>酒水升级 · 分享冷食 · 隐藏互动</span></div><b>¥598</b><button>选择</button></div></section>
  </>
}

function CommunityPreview({ partySize, onPartySize }: { partySize: number; onPartySize(value: number): void }) {
  return <><Band eyebrow="SUPERHIGH TRIBE" title="不只今晚见" copy="现场音乐、城市活动和会员小聚都在这里召集" />
    <section className="mini-section"><div className="mini-activity"><div className="mini-activity-art"><Music2 /><span>限 30 位</span></div><div><em>会员音乐夜</em><h2>歌手主场后的深夜小聚</h2><p>周六 23:20 · M-BOX陆家嘴店</p><strong>¥168/人</strong><div className="mini-rule is-deposit"><Crown />需付 ¥50/人订金，15分钟内完成</div><div className="mini-stepper"><span>报名人数</span><div><button onClick={() => onPartySize(Math.max(1, partySize - 1))}>−</button><b>{partySize}</b><button onClick={() => onPartySize(Math.min(6, partySize + 1))}>＋</button></div></div><button className="mini-primary">报名并支付 ¥{partySize * 50} 订金</button></div></div></section>
    <section className="mini-section"><div className="mini-activity mini-activity-compact"><em>城市漫步</em><h2>陆家嘴夜景音乐散步</h2><p>周三 19:00 · 门店集合</p><div className="mini-rule is-free"><Check />无需预付，提交后直接确认</div><button className="mini-secondary">加入这次活动</button></div></section>
  </>
}

function ProfilePreview() {
  return <><Band eyebrow="M-BOX MEMBER" title="今晚，按你的方式来" copy="偏好会在下次到店时继续使用" />
    <section className="mini-member"><div><Crown /><span>GOLD MEMBER</span></div><strong>MBX-8F3A71</strong><b>1,280<small>当前积分</small></b></section>
    <section className="mini-section mini-form"><header><strong>我的到店偏好</strong><span>服务时参考</span></header><label>常喝酒水<span>红酒</span></label><label>希望的服务方式<span>适度照顾</span></label><button className="mini-primary">保存偏好</button></section>
  </>
}

function Band({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) {
  return <header className="mini-band"><span>{eyebrow}</span><h1>{title}</h1><p>{copy}</p></header>
}
