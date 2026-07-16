import { Bell, CakeSlice, CheckCircle2, ChevronRight, Clock3, CreditCard, GlassWater, ListChecks, MapPin, MessageCircleMore, Mic2, Music2, Send, ShieldCheck, ShoppingBag, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { checkoutGuestOrder, createGuestOrder, createGuestSongRequest, createGuestTask, getGuestSession, submitGuestTaskFeedback } from '../api'
import type { GuestSessionResponse, GuestTaskView, WechatJsapiParameters } from '../shared/guest-contracts'
import { formatGuestCountdown, guestCustomSongServiceNote, guestErrorMessage, guestFeedbackIdempotencyKey, guestMoodServiceNote, guestReplyNotice, guestSongReplyNotice, guestSongStatusLabel, guestTaskReplyNotice, reconcileGuestReply, resolveGuestStage, trackGuestSongTerminalStates, visibleGuestSongRequests, visibleGuestTasks, type GuestReplyNotice } from './guest-portal-utils'
import { ServiceIcon } from './ServiceIcon'
import { MenuOrderingWorkspace, type MenuCartItem } from './MenuOrderingWorkspace'
import { SuperHighCommunityBand } from './SuperHighCommunityBand'

const guestStatus: Record<GuestTaskView['status'], string> = {
  pending: '正在为您安排伙伴',
  accepted: '服务伙伴正在赶来',
  arrived: '已经到您桌边',
  completed: '想请您确认一下',
  confirmed: '这件事已照顾好',
  reopened: '领班正在继续跟进',
  escalated: '领班已优先接手',
  cancelled: '这次需求已取消',
}

const guestMoods = [
  { id: 'happy', label: '开心', care: '客人心情开心，适合主动问候并推荐互动或点歌。' },
  { id: 'listen', label: '听歌', care: '客人想专心听歌，可简短介绍当晚演出和点歌，避免高频打断。' },
  { id: 'tipsy', label: '微醺', care: '请主动补水，关注饮酒节奏和身体状态，避免继续强推酒水。' },
  { id: 'interactive', label: '互动', care: '客人互动意愿较强，适合用当晚演出、点歌或同桌话题自然破冰。' },
  { id: 'celebrate', label: '庆祝', care: '请询问庆祝主题和称呼，确认是否需要生日歌、小礼物或合影。' },
  { id: 'quiet', label: '安静', care: '客人希望安静放松，请降低打扰频率，仅在补水、安全或结账等必要节点轻声询问。' },
] as const

type GuestMoodId = typeof guestMoods[number]['id']
type GuestErrorNotice = { message: string; source: 'refresh' | 'action' }

const REPLY_DISMISS_MS = 12_000
const ERROR_DISMISS_MS = 8_000

export function GuestPortal() {
  const params = new URLSearchParams(window.location.search)
  const tableCode = params.get('table') ?? 'L01'
  const initialToken = params.get('token') ?? ''
  const requestedPaymentOrderId = params.get('payOrder') ?? ''
  const [data, setData] = useState<GuestSessionResponse | null>(null)
  const [note, setNote] = useState('')
  const [reply, setReply] = useState<GuestReplyNotice | null>(null)
  const [pendingType, setPendingType] = useState<string | null>(null)
  const [error, setError] = useState<GuestErrorNotice | null>(null)
  const [activeTab, setActiveTab] = useState<'menu' | 'service' | 'orders'>(requestedPaymentOrderId ? 'orders' : 'menu')
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const [payingOrderId, setPayingOrderId] = useState('')
  const [selectedMood, setSelectedMood] = useState<GuestMoodId | null>(() => {
    const stored = window.sessionStorage.getItem(`mbox-guest-mood-${tableCode}`)
    return guestMoods.some((mood) => mood.id === stored) ? stored as GuestMoodId : null
  })
  const [songPickerOpen, setSongPickerOpen] = useState(false)
  const [songPickerMode, setSongPickerMode] = useState<'repertoire' | 'custom'>('repertoire')
  const [songBusyId, setSongBusyId] = useState('')
  const [songSingerId, setSongSingerId] = useState('')
  const [customSongTitle, setCustomSongTitle] = useState('')
  const [customSongArtist, setCustomSongArtist] = useState('')
  const [customSongSingerId, setCustomSongSingerId] = useState('')
  const [customSongNote, setCustomSongNote] = useState('')
  const [customSongBusy, setCustomSongBusy] = useState(false)
  const [quickPendingKey, setQuickPendingKey] = useState('')
  const [stageClock, setStageClock] = useState(() => Date.now())
  const [singerProfileId, setSingerProfileId] = useState('')
  const [terminalSongSeenAt, setTerminalSongSeenAt] = useState<Record<string, number>>({})
  const latestTableToken = useRef(initialToken)
  const refreshSequence = useRef(0)

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    try {
      const nextData = await getGuestSession(latestTableToken.current, tableCode)
      if (sequence !== refreshSequence.current) return
      latestTableToken.current = nextData.tableToken
      setData(nextData)
      setReply((current) => reconcileGuestReply(current, nextData.tasks, nextData.songRequests))
      setTerminalSongSeenAt((current) => trackGuestSongTerminalStates(current, nextData.songRequests, Date.now()))
      setError((current) => current?.source === 'refresh' ? null : current)
    } catch (requestError) {
      if (sequence !== refreshSequence.current) return
      setError({
        message: guestErrorMessage(requestError, '现场有点忙，我们正在重新连接服务，稍等一下就好。'),
        source: 'refresh',
      })
    }
  }, [tableCode])

  useEffect(() => {
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      await refresh()
      if (!stopped) timer = window.setTimeout(() => void poll(), 5000)
    }
    void poll()
    return () => {
      stopped = true
      refreshSequence.current += 1
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [refresh])

  useEffect(() => {
    const timer = window.setInterval(() => setStageClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!reply) return
    const timer = window.setTimeout(() => setReply(null), REPLY_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [reply])

  useEffect(() => {
    if (!error) return
    const timer = window.setTimeout(() => setError(null), ERROR_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [error])

  const tableTasks = useMemo(() => visibleGuestTasks(data?.tasks ?? []), [data?.tasks])
  const visibleSongRequests = useMemo(
    () => visibleGuestSongRequests(data?.songRequests ?? [], terminalSongSeenAt, stageClock),
    [data?.songRequests, terminalSongSeenAt, stageClock],
  )
  const customRequestType = data?.serviceTypes.find((serviceType) => serviceType.code === 'CUSTOM_REQUEST')
  const quickServiceTypes = data?.serviceTypes.filter((serviceType) => serviceType.code !== 'CUSTOM_REQUEST') ?? []
  const serviceTypeByCode = useMemo(() => new Map(data?.serviceTypes.map((serviceType) => [serviceType.code, serviceType]) ?? []), [data?.serviceTypes])
  const stage = useMemo(() => {
    const serverOffset = data ? Date.parse(data.serverNow) - Date.now() : 0
    return resolveGuestStage(data?.stageSchedule ?? [], stageClock + serverOffset)
  }, [data, stageClock])
  const featuredAppearance = stage.current ?? stage.next
  const profileAppearance = data?.stageSchedule.find((appearance) => appearance.singerId === singerProfileId) ?? null
  const profileSongOffers = data?.songOffers.filter((offer) => offer.singerId === singerProfileId).slice(0, 6) ?? []
  const songChoices = useMemo(() => {
    const seen = new Set<string>()
    return (data?.songOffers ?? []).filter((offer) => {
      const key = `${offer.singerId}:${offer.songId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [data?.songOffers])
  const songSingers = useMemo(() => {
    const singerIds = new Set(songChoices.map((offer) => offer.singerId))
    return (data?.stageSchedule ?? []).filter((appearance, index, items) => singerIds.has(appearance.singerId) && items.findIndex((item) => item.singerId === appearance.singerId) === index)
  }, [data?.stageSchedule, songChoices])
  const visibleSongChoices = (songSingerId ? songChoices.filter((offer) => offer.singerId === songSingerId) : songChoices).slice(0, 8)

  async function requestService(serviceTypeId: string, requestNote = '') {
    setPendingType(serviceTypeId)
    setError(null)
    try {
      const task = await createGuestTask({
        tableToken: latestTableToken.current,
        serviceTypeId,
        note: requestNote,
        idempotencyKey: `guest-${tableCode}-${serviceTypeId}-${crypto.randomUUID()}`,
      })
      setReply(guestTaskReplyNotice(task.customerReply, task))
      setNote('')
      await refresh()
      return task
    } catch (requestError) {
      setError({
        message: guestErrorMessage(requestError, '这次召唤没有顺利送达，再轻点一次试试；还不行就直接招呼身边伙伴。'),
        source: 'action',
      })
      return null
    } finally {
      setPendingType(null)
    }
  }

  async function recordMood(mood: typeof guestMoods[number]) {
    if (selectedMood === mood.id || pendingType) return
    if (!customRequestType) {
      setError({ message: '今晚状态小卡暂时开小差了，您仍可以直接呼叫我们。', source: 'action' })
      return
    }
    const previousLabel = guestMoods.find((item) => item.id === selectedMood)?.label ?? ''
    const succeeded = await requestService(customRequestType.id, guestMoodServiceNote(mood.label, mood.care, previousLabel))
    if (succeeded) {
      setSelectedMood(mood.id)
      window.sessionStorage.setItem(`mbox-guest-mood-${tableCode}`, mood.id)
    }
  }

  async function requestQuickService(key: string, serviceCode: string, requestNote = '') {
    const serviceType = serviceTypeByCode.get(serviceCode)
    if (!serviceType) {
      setError({ message: '这个快捷服务今晚暂时没开，去“服务”里告诉我们也一样好使。', source: 'action' })
      return
    }
    setQuickPendingKey(key)
    await requestService(serviceType.id, requestNote)
    setQuickPendingKey('')
  }

  async function chooseSong(offer: GuestSessionResponse['songOffers'][number]) {
    if (!data || songBusyId) return
    setSongBusyId(offer.id)
    setError(null)
    try {
      const request = await createGuestSongRequest({
        tableToken: latestTableToken.current,
        appearanceId: offer.appearanceId,
        singerId: offer.singerId,
        songId: offer.songId,
        customerNote: '',
        idempotencyKey: `guest-song-${crypto.randomUUID()}`,
      })
      setReply(guestSongReplyNotice(`《${offer.songTitle}》已经替您递给${offer.singerName}啦～点歌费 ¥${(offer.priceAmount / 100).toFixed(2)}，服务伙伴会先来和您确认，点头后再收款。`, request))
      setSongPickerOpen(false)
      await refresh()
    } catch (requestError) {
      setError({ message: guestErrorMessage(requestError, '这首歌刚才没递出去，再点一次试试，或者让服务伙伴来帮您。'), source: 'action' })
    } finally {
      setSongBusyId('')
    }
  }

  async function openSongService() {
    if (songChoices.length > 0) {
      const defaultSingerId = featuredAppearance?.singerId ?? ''
      setSongSingerId(defaultSingerId)
      setCustomSongSingerId(defaultSingerId)
      setSongPickerMode('repertoire')
      setSongPickerOpen(true)
      return
    }
    await requestQuickService('song', 'ORDER_HELP', '客人希望点歌，请到桌协助查看当日可选歌单。')
  }

  async function submitCustomSong() {
    if (!customRequestType) {
      setError({ message: '歌单外点歌暂时没连上，点一下“呼叫”，我们到桌帮您问歌手。', source: 'action' })
      return
    }
    if (!customSongTitle.trim()) {
      setError({ message: '先告诉我们歌名吧～记得一两个字也可以，我们陪您一起找。', source: 'action' })
      return
    }
    const singerName = data?.stageSchedule.find((appearance) => appearance.singerId === customSongSingerId)?.singerName ?? '不限歌手'
    setCustomSongBusy(true)
    const task = await requestService(customRequestType.id, guestCustomSongServiceNote({
      title: customSongTitle,
      artist: customSongArtist,
      singerName,
      customerNote: customSongNote,
    }))
    if (task) {
      setReply(guestTaskReplyNotice('收到这首私藏啦～服务伙伴这就去问歌手，能不能唱、多少钱、什么时候安排，都会先回来和您确认。', task))
      setCustomSongTitle('')
      setCustomSongArtist('')
      setCustomSongNote('')
      setSongPickerOpen(false)
    }
    setCustomSongBusy(false)
  }

  async function submitCustomRequest() {
    if (!customRequestType) {
      setError({ message: '特别需求通道暂时开小差了，点一下“呼叫”，我们亲自到桌听您说。', source: 'action' })
      return
    }
    if (!note.trim()) {
      setError({ message: '悄悄告诉我们您想要什么吧～写几个字就能送到服务伙伴手里。', source: 'action' })
      return
    }
    await requestService(customRequestType.id, note.trim())
  }

  async function giveFeedback(task: GuestTaskView, action: 'confirm' | 'unresolved') {
    try {
      const updatedTask = await submitGuestTaskFeedback(task.id, {
        tableToken: latestTableToken.current,
        action,
        note: action === 'unresolved' ? '客户反馈仍未解决' : '',
        idempotencyKey: guestFeedbackIdempotencyKey(action),
      })
      setReply(guestTaskReplyNotice(action === 'confirm'
        ? '谢谢您的点头～能照顾好今晚的您，我们也很开心。'
        : '还没照顾到位，抱歉让您再说一次。值班领班已经接手，会继续跟到解决。', updatedTask))
      await refresh()
    } catch (requestError) {
      setError({ message: guestErrorMessage(requestError, '刚才的反馈没有送到，再点一次，我们不让这件事掉在地上。'), source: 'action' })
    }
  }

  async function payOrder(orderId: string, idempotencyKey = `guest-pay-${crypto.randomUUID()}`) {
    if (!data || payingOrderId) return
    setPayingOrderId(orderId)
    setError(null)
    try {
      const result = await checkoutGuestOrder({
        tableToken: latestTableToken.current,
        orderId,
        idempotencyKey,
      })
      if (result.providerRequired) {
        if (result.paymentUrl) {
          window.location.assign(result.paymentUrl)
          return
        }
        const outcome = await invokeWechatJsapi(result.wechatJsapiParameters)
        setReply(guestReplyNotice(outcome === 'succeeded'
          ? '微信支付已经提交～我们正在确认到账，确认后马上更新订单。'
          : outcome === 'cancelled'
            ? '没关系，订单还替您留着～准备好时再点一次微信支付就行。'
            : '订单已经替您留好，但微信支付刚才没有拉起来。稍后再试一次，或呼叫服务伙伴来帮您。'))
      } else {
        const fulfillmentMessage = result.order.createdBy.startsWith('guest-')
          ? '酒水和餐食伙伴已经收到，正在为您准备。'
          : '服务伙伴和出品伙伴都已经收到，不用再重复确认。'
        setReply(guestReplyNotice(`支付成功 ¥${(result.paymentIntent.amount / 100).toFixed(2)}～今晚的快乐继续，${fulfillmentMessage}`))
      }
      setActiveTab('orders')
      await refresh()
    } catch (requestError) {
      setError({ message: guestErrorMessage(requestError, '这次支付没有完成，订单还在，不会重复下单。您可以再试一次或呼叫服务伙伴。'), source: 'action' })
      throw requestError
    } finally {
      setPayingOrderId('')
    }
  }

  async function placeAndPay(items: MenuCartItem[]) {
    if (!data) return
    setCheckoutBusy(true)
    setError(null)
    const idempotencyKey = `guest-cart-${crypto.randomUUID()}`
    try {
      const order = await createGuestOrder({ tableToken: latestTableToken.current, items, idempotencyKey })
      try {
        await payOrder(order.id, `${idempotencyKey}-pay`)
      } catch {
        setActiveTab('orders')
        await refresh()
      }
    } finally {
      setCheckoutBusy(false)
    }
  }

  return (
    <main className="guest-shell">
      <header className="guest-header">
        <div className="guest-brand-lockup">
          <img src="/brand/superhigh-horizontal.png" alt="SUPERHIGH" />
          <i aria-hidden="true" />
          <div><strong>M-BOX</strong><small>LIVEHOUSE · LUJIAZUI</small></div>
        </div>
        <span className="secure-label" title="安全桌码"><ShieldCheck size={16} /><span>安全桌码</span></span>
      </header>

      <section className="guest-table-band">
        <div className="guest-table-copy">
          <small><i aria-hidden="true" />{stage.mode === 'live' && stage.current
            ? `LIVE NOW · ${formatGuestTimeRange(stage.current.startsAt, stage.current.endsAt, data?.store.timezone)}`
            : stage.mode === 'upcoming' && stage.next
              ? `NEXT · ${formatGuestTime(stage.next.startsAt, data?.store.timezone)}`
              : stage.mode === 'finished' ? 'TONIGHT · 演出已结束' : 'LIVE SERVICE · 服务在线'}</small>
          <h1>{data?.table.displayName ?? tableCode}</h1>
          <p><MapPin size={13} />服务专员 · {data?.primaryServiceName ?? '正在安排'}</p>
        </div>
        <button className="guest-stage-status" disabled={!featuredAppearance} onClick={() => featuredAppearance && setSingerProfileId(featuredAppearance.singerId)}>
          {featuredAppearance ? <Music2 size={17} /> : <ShieldCheck size={17} />}
          <strong>{featuredAppearance?.singerName ?? 'M-BOX'}</strong>
          <span>{stage.mode === 'live'
            ? `演出中 · ${formatGuestCountdown(stage.countdownMs)}`
            : stage.mode === 'upcoming' ? `${formatGuestCountdown(stage.countdownMs)} 后登场` : stage.mode === 'finished' ? '今晚演出结束' : '服务在线'}</span>
          {stage.mode === 'live' && stage.next && <em>下一位 {stage.next.singerName} · {formatGuestTime(stage.next.startsAt, data?.store.timezone)}</em>}
          {featuredAppearance && <ChevronRight className="guest-stage-chevron" size={15} aria-hidden="true" />}
        </button>
      </section>

      {profileAppearance && <div className="guest-singer-backdrop" role="presentation" onClick={() => setSingerProfileId('')}>
        <section className="guest-singer-sheet" role="dialog" aria-modal="true" aria-label={`${profileAppearance.singerName}歌手资料`} onClick={(event) => event.stopPropagation()}>
          <header>
            <div className="guest-singer-photo">{profileAppearance.profile.photoUrl
              ? <img src={profileAppearance.profile.photoUrl} alt={profileAppearance.singerName} />
              : <div><Mic2 size={30} /><span>M-BOX LIVE</span></div>}</div>
            <button className="icon-button" title="关闭歌手资料" onClick={() => setSingerProfileId('')}><X size={19} /></button>
          </header>
          <div className="guest-singer-content">
            <small>ARTIST PROFILE</small>
            <h2>{profileAppearance.singerName}</h2>
            <strong>{profileAppearance.profile.headline || 'M-BOX LIVEHOUSE 驻场歌手'}</strong>
            {profileAppearance.profile.styleTags.length > 0 && <div className="guest-singer-tags">{profileAppearance.profile.styleTags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
            <p>{profileAppearance.profile.bio || '这位歌手的故事还在整理中，今晚的演出时间和可点歌曲已经先为您备好。'}</p>
            <div className="guest-singer-schedule"><Clock3 size={17} /><div><span>今晚演出</span><strong>{formatGuestTimeRange(profileAppearance.startsAt, profileAppearance.endsAt, data?.store.timezone)}</strong></div></div>
            <div className="guest-singer-songs">
              <header><span>可点歌曲</span><b>{profileSongOffers.length} 首展示</b></header>
              {profileSongOffers.length > 0 ? profileSongOffers.map((offer) => <button key={offer.id} onClick={() => { setSingerProfileId(''); setSongSingerId(profileAppearance.singerId); setCustomSongSingerId(profileAppearance.singerId); setSongPickerMode('repertoire'); setSongPickerOpen(true) }}><span>{offer.songTitle}<small>{offer.songArtist}</small></span><b>¥{(offer.priceAmount / 100).toFixed(0)}</b><ChevronRight size={15} /></button>) : <p>今晚的歌单还在确认，想听什么可以让我们替您问问。</p>}
            </div>
          </div>
        </section>
      </div>}

      {reply && (
        <div className="guest-reply" role="status" aria-live="polite">
          <CheckCircle2 size={24} aria-hidden="true" />
          <span>{reply.message}</span>
          <button className="guest-notice-close" type="button" title="关闭提示" aria-label="关闭提示" onClick={() => setReply(null)}><X size={17} aria-hidden="true" /></button>
        </div>
      )}
      {error && <div className="error-banner guest-error-banner" role="alert"><span>{error.message}</span><button className="guest-notice-close" type="button" title="关闭错误提示" aria-label="关闭错误提示" onClick={() => setError(null)}><X size={17} aria-hidden="true" /></button></div>}

      <nav className="guest-tabs" aria-label="桌台功能">
        <button className={activeTab === 'menu' ? 'is-active' : ''} onClick={() => setActiveTab('menu')}><ShoppingBag size={18} />点单</button>
        <button className={activeTab === 'service' ? 'is-active' : ''} onClick={() => setActiveTab('service')}><MessageCircleMore size={18} />服务</button>
        <button className={activeTab === 'orders' ? 'is-active' : ''} onClick={() => setActiveTab('orders')}><ListChecks size={18} />订单</button>
      </nav>

      {activeTab === 'menu' && <>
        <section className={`guest-mood-section${selectedMood ? ' has-selection' : ''}`}>
          <header><div><small>YOUR MOOD</small><strong>今晚想怎么嗨？</strong></div><span>{selectedMood ? '已记录 · 可重选' : '可选'}</span></header>
          <div className="guest-mood-row">
            {guestMoods.map((mood) => <button
              key={mood.id}
              className={selectedMood === mood.id ? 'is-selected' : ''}
              aria-pressed={selectedMood === mood.id}
              disabled={pendingType !== null}
              onClick={() => void recordMood(mood)}
            ><img src={`/brand/moods-v2/${mood.id}.png`} alt="" /><span>{mood.label}</span></button>)}
          </div>
        </section>

        <section className="guest-quick-service" aria-label="快捷服务">
          <button disabled={pendingType !== null} onClick={() => void requestQuickService('water', 'ADD_WATER')}><GlassWater size={19} /><span>{quickPendingKey === 'water' ? '正在送达' : '加水'}</span></button>
          <button disabled={pendingType !== null} onClick={() => void openSongService()}><Music2 size={19} /><span>{quickPendingKey === 'song' ? '正在帮您问' : '点歌'}</span></button>
          <button disabled={pendingType !== null} onClick={() => void requestQuickService('birthday', 'BIRTHDAY_CARE')}><CakeSlice size={19} /><span>{quickPendingKey === 'birthday' ? '正在安排' : '生日'}</span></button>
          <button disabled={pendingType !== null} onClick={() => void requestQuickService('call', 'ORDER_HELP', '客人呼叫服务员到桌，请尽快响应。')}><Bell size={19} /><span>{quickPendingKey === 'call' ? '正在叫人' : '呼叫'}</span></button>
        </section>

        {songPickerOpen && <section className="guest-song-picker" aria-label="当晚可点歌曲">
          <header><div><small>LIVE SONGS</small><strong>选择歌曲</strong></div><button className="icon-button" title="关闭点歌" onClick={() => setSongPickerOpen(false)}><X size={18} /></button></header>
          <div className="guest-song-mode" role="tablist" aria-label="点歌方式">
            <button role="tab" aria-selected={songPickerMode === 'repertoire'} className={songPickerMode === 'repertoire' ? 'is-active' : ''} onClick={() => setSongPickerMode('repertoire')}>歌手歌单</button>
            <button role="tab" aria-selected={songPickerMode === 'custom'} className={songPickerMode === 'custom' ? 'is-active' : ''} onClick={() => setSongPickerMode('custom')}>歌单外点歌</button>
          </div>
          {songPickerMode === 'repertoire' ? <>
            {songSingers.length > 1 && <div className="guest-song-singer-filter"><button className={!songSingerId ? 'is-active' : ''} onClick={() => setSongSingerId('')}>全部</button>{songSingers.map((singer) => <button key={singer.singerId} className={songSingerId === singer.singerId ? 'is-active' : ''} onClick={() => { setSongSingerId(singer.singerId); setCustomSongSingerId(singer.singerId) }}>{singer.singerName}</button>)}</div>}
            <div className="guest-song-list">{visibleSongChoices.map((offer) => <article key={offer.id}>
              <div><strong>{offer.songTitle}</strong><span>{offer.songArtist} · {offer.singerName}</span></div>
              <button disabled={Boolean(songBusyId)} onClick={() => void chooseSong(offer)}>{songBusyId === offer.id ? '正在递歌' : `¥${(offer.priceAmount / 100).toFixed(2)} 点歌`}</button>
            </article>)}</div>
            <p>选好后，服务伙伴会先来确认歌曲和费用，您点头后再付款。</p>
          </> : <div className="guest-custom-song">
            <header><Music2 size={17} /><div><strong>歌单里没找到？</strong><span>把私藏曲目告诉我们，先替您问歌手</span></div></header>
            <div className="guest-custom-song-fields">
              <label><span>歌曲名称 <span className="guest-required-mark" aria-hidden="true">*</span><span className="guest-visually-hidden">（必填）</span></span><input value={customSongTitle} maxLength={60} required aria-required="true" placeholder="输入想点的歌" onChange={(event) => setCustomSongTitle(event.target.value)} /></label>
              <label><span>原唱</span><input value={customSongArtist} maxLength={60} placeholder="选填" onChange={(event) => setCustomSongArtist(event.target.value)} /></label>
              <label><span>希望歌手</span><select value={customSongSingerId} onChange={(event) => setCustomSongSingerId(event.target.value)}><option value="">不限歌手</option>{songSingers.map((singer) => <option key={singer.singerId} value={singer.singerId}>{singer.singerName}</option>)}</select></label>
              <label><span>补充信息</span><input value={customSongNote} maxLength={80} placeholder="祝福语或演唱偏好" onChange={(event) => setCustomSongNote(event.target.value)} /></label>
            </div>
            <button disabled={customSongBusy || pendingType !== null || !customSongTitle.trim()} onClick={() => void submitCustomSong()}><Send size={16} />{customSongBusy ? '正在帮您问' : '帮我问问'}</button>
          </div>}
        </section>}

        <MenuOrderingWorkspace
          products={data?.products ?? []}
          tableLabel={data?.table.displayName ?? tableCode}
          submitLabel="确认订单并微信支付"
          submitHint="付款成功后，订单会直接送到吧台和厨房，不用再招呼我们确认。"
          busy={checkoutBusy}
          timeZone={data?.store.timezone}
          onSubmit={placeAndPay}
        />
      </>}

      {activeTab === 'service' && <><section className="guest-services">
        <div className="guest-section-title">
          <span>呼叫服务</span>
          <MessageCircleMore size={20} aria-hidden="true" />
        </div>
        <div className="service-grid">
          {quickServiceTypes.map((serviceType) => (
            <button
              key={serviceType.id}
              className={serviceType.id === 'complaint' ? 'service-button service-button--complaint' : 'service-button'}
              data-service-code={serviceType.code.toLowerCase()}
              disabled={pendingType !== null}
              onClick={() => void requestService(serviceType.id)}
            >
              <ServiceIcon icon={serviceType.icon} size={23} />
              <span>{pendingType === serviceType.id ? '正在送达' : serviceType.name}</span>
              <ChevronRight size={17} aria-hidden="true" />
            </button>
          ))}
        </div>
        <div className="guest-note">
          <span>个性化需求</span>
          <div className="guest-note-row">
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && note.trim() && pendingType === null) void submitCustomRequest()
              }}
              maxLength={300}
              placeholder="悄悄告诉我们：例如需要两杯温水"
            />
            <button disabled={!note.trim() || pendingType !== null || !customRequestType} onClick={() => void submitCustomRequest()}><Send size={17} />{pendingType === customRequestType?.id ? '正在送达' : '告诉我们'}</button>
          </div>
        </div>
      </section>

      <section className="guest-progress">
        <div className="guest-section-title"><span>服务进度</span><Clock3 size={20} /></div>
        {tableTasks.length === 0 ? (
          <div className="guest-empty">现在没有待处理的需求，有需要随时叫我们。</div>
        ) : (
          <div className="guest-task-list">
            {tableTasks.map((task) => {
              const serviceType = data?.serviceTypes.find((item) => item.id === task.serviceTypeId)
              return (
                <article className="guest-task" key={task.id}>
                  <div>
                    <strong>{task.serviceTypeName || serviceType?.name || '服务进度'}</strong>
                    <span>{guestStatus[task.status]} · {task.ownerName ?? '服务团队正在安排'}</span>
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
      </section></>}

      {activeTab === 'orders' && <section className="guest-orders">
        <div className="guest-section-title"><span>订单与出品进度</span><ListChecks size={20} /></div>
        {requestedPaymentOrderId && <div className="guest-payment-sync"><CreditCard size={18} /><span>服务伙伴已经把订单送到您手机啦～确认商品和金额后就可以付款。</span></div>}
        {visibleSongRequests.length > 0 && <div className="guest-song-progress">
          <header><div><Music2 size={18} aria-hidden="true" /><strong>点歌进度</strong></div><span>现场确认与收费</span></header>
          <div className="guest-song-request-list">{visibleSongRequests.map((request) => <article className="guest-song-request" key={request.id}>
            <div><strong>《{request.songTitle}》</strong><span>{request.singerName} · ¥{(request.priceAmount / 100).toFixed(2)}</span></div>
            <b data-status={request.status}>{guestSongStatusLabel(request.status)}</b>
          </article>)}</div>
        </div>}
        {(data?.account.orders.length ?? 0) === 0 ? <div className="guest-empty">还没有点单，慢慢看；想听推荐就叫我们。</div> : (
          <div className="guest-order-list">{data?.account.orders.toReversed().map((order) => {
            const payment = data.account.payments.find((item) => item.orderIds.includes(order.id))
            const paid = payment?.status === 'succeeded'
            return <article className={`guest-order ${order.id === requestedPaymentOrderId ? 'is-payment-target' : ''}`} key={order.id}>
              <header><div><strong>¥{(order.payableAmount / 100).toFixed(2)}</strong><span>{new Date(order.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span></div><b className={payment?.status === 'succeeded' ? 'is-paid' : ''}>{payment?.status === 'succeeded' ? '已支付' : order.status === 'draft' ? '待支付' : '已下单'}</b></header>
              <div>{order.items.map((item) => <div className="guest-order-line" key={item.id}><span>{item.name} × {item.quantity}</span><strong>{fulfillmentLabel(item.fulfillmentStatus)}</strong></div>)}</div>
              {!paid && order.payableAmount > 0 && <button className="guest-pay-button" disabled={Boolean(payingOrderId)} onClick={() => void payOrder(order.id)}><CreditCard size={18} />{payingOrderId === order.id ? '正在拉起微信支付' : `微信支付 ¥${(order.payableAmount / 100).toFixed(2)}`}</button>}
              {!paid && order.payableAmount <= 0 && <div className="guest-no-payment"><CheckCircle2 size={16} />这单已使用赠送或折扣，不用在线付款；服务伙伴会来陪您核对。</div>}
            </article>
          })}</div>
        )}
        {data?.communityBrand && <SuperHighCommunityBand brand={data.communityBrand} compact />}
      </section>}
    </main>
  )
}

async function invokeWechatJsapi(parameters: WechatJsapiParameters | null) {
  if (!parameters) return 'unavailable' as const
  const bridge = await waitForWechatBridge()
  if (!bridge) return 'unavailable' as const
  return new Promise<'succeeded' | 'cancelled'>((resolve) => {
    bridge.invoke('getBrandWCPayRequest', parameters, (result) => {
      resolve(result.err_msg === 'get_brand_wcpay_request:ok' ? 'succeeded' : 'cancelled')
    })
  })
}

interface WechatBridge {
  invoke: (method: string, parameters: WechatJsapiParameters, callback: (result: { err_msg: string }) => void) => void
}

function waitForWechatBridge() {
  const current = (window as typeof window & { WeixinJSBridge?: WechatBridge }).WeixinJSBridge
  if (current) return Promise.resolve(current)
  return new Promise<WechatBridge | null>((resolve) => {
    const onReady = () => {
      window.clearTimeout(timer)
      resolve((window as typeof window & { WeixinJSBridge?: WechatBridge }).WeixinJSBridge ?? null)
    }
    const timer = window.setTimeout(() => {
      document.removeEventListener('WeixinJSBridgeReady', onReady)
      resolve(null)
    }, 1500)
    document.addEventListener('WeixinJSBridgeReady', onReady, { once: true })
  })
}

function fulfillmentLabel(status: GuestSessionResponse['account']['orders'][number]['items'][number]['fulfillmentStatus']) {
  const labels = { draft: '等您付款', queued: '吧台或厨房已收到', preparing: '正在认真制作', completed: '已经做好', picked_up: '正在送来', delivered: '已送到桌' }
  return labels[status]
}

function formatGuestTime(timestamp: string, timeZone = 'Asia/Shanghai') {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone })
}

function formatGuestTimeRange(startsAt: string, endsAt: string, timeZone = 'Asia/Shanghai') {
  return `${formatGuestTime(startsAt, timeZone)}-${formatGuestTime(endsAt, timeZone)}`
}
