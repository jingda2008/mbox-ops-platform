import { Banknote, CheckCircle2, Clock3, Image, Mic2, Music2, Play, RotateCcw, Save, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { actOnSongRequest, reportSongPayment, submitPaidSongRequest, updateSingerProfile } from '../api'
import type { BootstrapResponse } from '../shared/contracts'
import type { Singer, SingerProfileWriteInput, SongRequest, SongRequestStatus } from '../shared/song-contracts'
import './SongCenterView.css'

interface SongCenterViewProps {
  data: BootstrapResponse
  onRefresh: () => Promise<void>
  onNotice: (message: string) => void
}

export function SongCenterView({ data, onRefresh, onNotice }: SongCenterViewProps) {
  const appearances = data.songState.performanceSessions.flatMap((session) => session.appearances.map((appearance) => ({ session, appearance })))
  const [appearanceId, setAppearanceId] = useState(appearances.find((item) => item.appearance.acceptingRequests)?.appearance.id ?? appearances[0]?.appearance.id ?? '')
  const selected = appearances.find((item) => item.appearance.id === appearanceId)
  const selectedSinger = data.songState.singers.find((item) => item.id === selected?.appearance.singerId)
  const offers = useMemo(() => data.songState.repertoire.filter((item) => item.singerId === selected?.appearance.singerId && item.enabled), [data.songState.repertoire, selected?.appearance.singerId])
  const [songId, setSongId] = useState(offers[0]?.songId ?? '')
  const [tableSessionId, setTableSessionId] = useState(data.songState.tableSessions.find((item) => item.status === 'open')?.id ?? '')
  const [requestedBy, setRequestedBy] = useState('现场客人')
  const [customerNote, setCustomerNote] = useState('')
  const [references, setReferences] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const effectiveSongId = offers.some((item) => item.songId === songId) ? songId : offers[0]?.songId ?? ''
  const selectedOffer = offers.find((item) => item.songId === effectiveSongId)

  async function run(operation: () => Promise<unknown>, success: string) {
    setBusy(true)
    try {
      await operation()
      onNotice(success)
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '点歌操作失败')
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!selected || !selectedOffer) return
    await run(() => submitPaidSongRequest({
      performanceSessionId: selected.session.id,
      appearanceId: selected.appearance.id,
      tableSessionId,
      singerId: selected.appearance.singerId,
      songId: selectedOffer.songId,
      requestedBy,
      customerNote,
    }), '点歌已创建，等待支付结果')
  }

  const openRequests = data.songState.requests.filter((item) => !['completed', 'cancelled', 'rejected', 'refunded'].includes(item.status))

  return (
    <section className="song-view">
      <div className="section-heading">
        <div><span className="eyebrow">演出与客户互动</span><h2>点歌履约中心</h2></div>
        <span className="count-chip">{openRequests.length}待处理</span>
      </div>
      <div className="song-metrics">
        <SongMetric label="今日场次" value={data.songState.performanceSessions.length} />
        <SongMetric label="在册歌手" value={data.songState.singers.filter((item) => item.active).length} />
        <SongMetric label="可点曲目" value={data.songState.repertoire.filter((item) => item.enabled).length} />
        <SongMetric label="待退款" value={data.songState.requests.filter((item) => item.status === 'refund_required').length} warning />
      </div>
      <div className="performance-strip">
        {appearances.map(({ appearance }) => {
          const singer = data.songState.singers.find((item) => item.id === appearance.singerId)
          return <button key={appearance.id} className={appearance.id === appearanceId ? 'appearance-slot is-selected' : 'appearance-slot'} onClick={() => { setAppearanceId(appearance.id); setSongId(data.songState.repertoire.find((item) => item.singerId === appearance.singerId && item.enabled)?.songId ?? '') }}><Clock3 size={15} /><span><strong>{singer?.displayName}</strong><small>{timeRange(appearance.startsAt, appearance.endsAt)}</small></span><b>{appearance.acceptingRequests ? '接单中' : '暂停'}</b></button>
        })}
      </div>
      {selectedSinger && <SingerProfileEditor key={selectedSinger.id} singer={selectedSinger} busy={busy} onSave={(input) => run(() => updateSingerProfile(selectedSinger.id, input), '歌手资料已保存，顾客端将自动更新')} />}
      <div className="song-workspace">
        <form className="song-order-form" onSubmit={(event) => void submit(event)}>
          <div className="form-heading"><Music2 size={19} /><div><strong>员工辅助点歌</strong><span>绑定桌台、歌手排班和价格快照</span></div></div>
          <label><span>营业桌台</span><select value={tableSessionId} onChange={(event) => setTableSessionId(event.target.value)}>{data.songState.tableSessions.filter((item) => item.status === 'open').map((item) => <option key={item.id} value={item.id}>{item.tableCode}</option>)}</select></label>
          <label><span>演唱歌手</span><select value={appearanceId} onChange={(event) => setAppearanceId(event.target.value)}>{appearances.map(({ appearance }) => <option key={appearance.id} value={appearance.id}>{data.songState.singers.find((item) => item.id === appearance.singerId)?.displayName} · {timeRange(appearance.startsAt, appearance.endsAt)}</option>)}</select></label>
          <label className="wide-field"><span>歌曲</span><select value={effectiveSongId} onChange={(event) => setSongId(event.target.value)}>{offers.map((offer) => { const song = data.songState.songs.find((item) => item.id === offer.songId); return <option key={offer.id} value={offer.songId}>{song?.title} · {money(offer.priceAmount)}</option> })}</select></label>
          <label><span>客人称呼</span><input value={requestedBy} onChange={(event) => setRequestedBy(event.target.value)} /></label>
          <label className="wide-field"><span>备注</span><input value={customerNote} onChange={(event) => setCustomerNote(event.target.value)} placeholder="祝福语、互动偏好或不能公开的信息" /></label>
          <div className="song-payment-boundary"><Banknote size={16} /><span>创建请求不代表已付款；只有支付或物理POS凭证确认后才能进入歌手队列。</span></div>
          <button className="primary-button" disabled={busy || !selectedOffer || !tableSessionId || !requestedBy.trim()}><Music2 size={16} />创建点歌</button>
        </form>
        <div className="song-queue">
          <div className="song-queue-heading"><Mic2 size={19} /><div><strong>点歌队列</strong><span>支付、接单、演唱与退款状态分离</span></div></div>
          {data.songState.requests.length === 0 ? <div className="compact-empty">暂无点歌请求</div> : data.songState.requests.toReversed().map((request) => <SongRequestRow key={request.id} request={request} reference={references[request.id] ?? ''} setReference={(value) => setReferences({ ...references, [request.id]: value })} busy={busy} run={run} />)}
        </div>
      </div>
    </section>
  )
}

function SingerProfileEditor({ singer, busy, onSave }: { singer: Singer; busy: boolean; onSave: (input: SingerProfileWriteInput) => Promise<void> }) {
  const [displayName, setDisplayName] = useState(singer.displayName)
  const [photoUrl, setPhotoUrl] = useState(singer.photoUrl ?? '')
  const [headline, setHeadline] = useState(singer.headline ?? '')
  const [bio, setBio] = useState(singer.bio ?? '')
  const [styleTags, setStyleTags] = useState((singer.styleTags ?? []).join('、'))
  const [active, setActive] = useState(singer.active)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const tags = styleTags.split(/[、,，]/).map((item) => item.trim()).filter(Boolean).slice(0, 6)
    void onSave({ displayName: displayName.trim(), photoUrl: photoUrl.trim(), headline: headline.trim(), bio: bio.trim(), styleTags: [...new Set(tags)], active })
  }

  return <form className="singer-profile-editor" onSubmit={submit}>
    <div className="singer-profile-preview">{photoUrl
      ? <img src={photoUrl} alt="歌手照片预览" />
      : <span><Image size={22} /><small>照片预览</small></span>}</div>
    <div className="singer-profile-fields">
      <label><span>歌手名称</span><input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} /></label>
      <label><span>照片地址</span><input value={photoUrl} maxLength={500} placeholder="/singers/name.jpg 或 https://..." onChange={(event) => setPhotoUrl(event.target.value)} /></label>
      <label><span>亮点文案</span><input value={headline} maxLength={100} placeholder="例如：英文流行 · 氛围女声" onChange={(event) => setHeadline(event.target.value)} /></label>
      <label><span>风格标签</span><input value={styleTags} maxLength={120} placeholder="华语流行、情歌、互动" onChange={(event) => setStyleTags(event.target.value)} /></label>
      <label className="wide-field"><span>歌手简介</span><textarea value={bio} maxLength={600} placeholder="介绍声音特色、擅长曲风和现场互动风格" onChange={(event) => setBio(event.target.value)} /></label>
    </div>
    <div className="singer-profile-actions">
      <label><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /><span>顾客端显示</span></label>
      <button className="primary-button" disabled={busy || !displayName.trim()}><Save size={15} />保存歌手资料</button>
    </div>
  </form>
}

function SongRequestRow({ request, reference, setReference, busy, run }: { request: SongRequest; reference: string; setReference: (value: string) => void; busy: boolean; run: (operation: () => Promise<unknown>, success: string) => Promise<void> }) {
  return <div className="song-request-row"><span className={`song-status status-${request.status}`}>{statusLabel(request.status)}</span><div><strong>{request.tableCode} · {request.priceSnapshot.songTitle}</strong><small>{request.priceSnapshot.singerName} · {money(request.priceSnapshot.priceAmount)} · {request.requestedBy}</small></div><div className="song-request-actions">{request.status === 'pending_payment' && <><input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="支付/物理POS流水号" /><button className="primary-button" disabled={busy || reference.trim().length < 4} onClick={() => void run(() => reportSongPayment(request.id, reference.trim()), '点歌收款凭证已登记')}><Banknote size={14} />登记收款</button><button className="icon-button danger" title="取消未支付点歌" disabled={busy} onClick={() => void run(() => actOnSongRequest(request.id, 'cancel', '客人未支付前取消'), '点歌已取消')}><XCircle size={15} /></button></>}{request.status === 'paid' && <><button className="primary-button" disabled={busy} onClick={() => void run(() => actOnSongRequest(request.id, 'accept'), '歌手队列已接单')}><CheckCircle2 size={14} />接单</button><button className="secondary-button" disabled={busy} onClick={() => void run(() => actOnSongRequest(request.id, 'reject', '现场无法履约，经理发起退款'), '已拒绝并进入退款队列')}>拒绝并退款</button></>}{request.status === 'accepted' && <><button className="primary-button" disabled={busy} onClick={() => void run(() => actOnSongRequest(request.id, 'start'), '已开始演唱')}><Play size={14} />开始演唱</button><button className="secondary-button" disabled={busy} onClick={() => void run(() => actOnSongRequest(request.id, 'reject', '现场无法履约，经理发起退款'), '已拒绝并进入退款队列')}>拒绝并退款</button></>}{request.status === 'performing' && <button className="primary-button" disabled={busy} onClick={() => void run(() => actOnSongRequest(request.id, 'complete'), '本次点歌已完成')}><CheckCircle2 size={14} />完成</button>}{request.status === 'refund_required' && <><input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="退款流水号" /><button className="primary-button" disabled={busy || reference.trim().length < 4} onClick={() => void run(() => actOnSongRequest(request.id, 'refund', '', reference.trim()), '点歌退款已登记')}><RotateCcw size={14} />确认退款</button></>}</div></div>
}

function SongMetric({ label, value, warning = false }: { label: string; value: number; warning?: boolean }) { return <div className={warning && value > 0 ? 'song-metric is-warning' : 'song-metric'}><strong>{value}</strong><span>{label}</span></div> }
function statusLabel(status: SongRequestStatus) { return ({ pending_payment: '待付款', paid: '已付款', accepted: '已接单', performing: '演唱中', completed: '已完成', rejected: '已拒绝', cancelled: '已取消', refund_required: '待退款', refunded: '已退款' } as const)[status] }
function money(amount: number) { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(amount / 100) }
function timeRange(startsAt: string, endsAt: string) { const format = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }); return `${format(startsAt)}-${format(endsAt)}` }
