import { Banknote, CalendarDays, CheckCircle2, Clock3, Copy, Download, FileUp, Image, ListChecks, ListMusic, Mic2, Music2, Play, Plus, RotateCcw, Save, Search, UserRound, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { actOnSongRequest, createSinger, createSingerRepertoire, importSingerRepertoire, reportSongOnsiteCollection, submitStaffSongRequest, updatePerformanceSession, updateSingerProfile, updateSingerRepertoire } from '../api'
import type { BootstrapResponse } from '../shared/contracts'
import type { PerformanceSession, PerformanceSessionStatus, RepertoireImportResult, RepertoireWriteInput, Singer, SingerProfileWriteInput, SingerRepertoireEntry, SongCatalogItem, SongRequest, SongRequestStatus } from '../shared/song-contracts'
import { chinaDateTimeLocalValue, chinaLocalDateTimeToIso, formatChinaTime } from '../shared/china-time'
import { moveLocalDatetimeToBusinessDate } from './performance-schedule'
import { downloadRepertoireTemplate, parseRepertoireFile, type RepertoireImportPreview } from './repertoire-file'
import { useRevealPanelScroll } from './use-reveal-panel-scroll'
import './SongCenterView.css'

interface SongCenterViewProps {
  data: BootstrapResponse
  onRefresh: () => Promise<void>
  onNotice: (message: string) => void
}

type SongOperationRunner = (operation: () => Promise<unknown>, success: string | ((result: unknown) => string)) => Promise<boolean>

export function SongCenterView({ data, onRefresh, onNotice }: SongCenterViewProps) {
  const canManage = data.viewer?.permissionIds.includes('song.manage') ?? false
  const [workspaceMode, setWorkspaceMode] = useState<'operations' | 'library' | 'schedule'>('operations')
  const todaysSessions = data.songState.performanceSessions.filter((session) => session.businessDate === data.store.businessDate)
  const appearances = todaysSessions.flatMap((session) => session.appearances.map((appearance) => ({ session, appearance })))
  const [appearanceId, setAppearanceId] = useState(appearances.find((item) => item.appearance.acceptingRequests)?.appearance.id ?? appearances[0]?.appearance.id ?? '')
  const selected = appearances.find((item) => item.appearance.id === appearanceId)
  const offers = useMemo(() => data.songState.repertoire.filter((item) => item.singerId === selected?.appearance.singerId && item.enabled), [data.songState.repertoire, selected?.appearance.singerId])
  const [songId, setSongId] = useState(offers[0]?.songId ?? '')
  const [tableSessionId, setTableSessionId] = useState(data.songState.tableSessions.find((item) => item.status === 'open')?.id ?? '')
  const [requestedBy, setRequestedBy] = useState('现场客人')
  const [customerNote, setCustomerNote] = useState('')
  const [references, setReferences] = useState<Record<string, string>>({})
  const [collectionChannels, setCollectionChannels] = useState<Record<string, 'cash' | 'physical_pos'>>({})
  const [songSearch, setSongSearch] = useState('')
  const [busy, setBusy] = useState(false)

  const assistedOffers = useMemo(() => {
    const keyword = songSearch.trim().toLocaleLowerCase('zh-CN')
    if (!keyword) return offers
    return offers.filter((offer) => {
      const song = data.songState.songs.find((item) => item.id === offer.songId)
      return `${song?.title ?? ''} ${song?.artist ?? ''}`.toLocaleLowerCase('zh-CN').includes(keyword)
    })
  }, [data.songState.songs, offers, songSearch])
  const effectiveSongId = assistedOffers.some((item) => item.songId === songId) ? songId : assistedOffers[0]?.songId ?? ''
  const selectedOffer = assistedOffers.find((item) => item.songId === effectiveSongId)

  async function run(operation: () => Promise<unknown>, success: string | ((result: unknown) => string)): Promise<boolean> {
    setBusy(true)
    try {
      const result = await operation()
      onNotice(`操作成功：${typeof success === 'function' ? success(result) : success}`)
      await onRefresh()
      return true
    } catch (error) {
      onNotice(`操作失败：${error instanceof Error ? error.message : '本次操作未保存'}`)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!selected || !selectedOffer) return
    await run(() => submitStaffSongRequest({
      performanceSessionId: selected.session.id,
      appearanceId: selected.appearance.id,
      tableSessionId,
      singerId: selected.appearance.singerId,
      songId: selectedOffer.songId,
      requestedBy,
      customerNote,
    }), '点歌已创建，先确认歌手能否演唱')
  }

  const openRequests = data.songState.requests.filter((item) => !['completed', 'cancelled', 'rejected', 'refunded'].includes(item.status))

  return (
    <section className="song-view">
      <div className="section-heading">
        <div><span className="eyebrow">演出与客户互动</span><h2>点歌履约中心</h2></div>
        <span className="count-chip">{openRequests.length}待处理</span>
      </div>
      <div className="song-metrics">
        <SongMetric label="今日场次" value={todaysSessions.length} />
        <SongMetric label="在册歌手" value={data.songState.singers.filter((item) => item.active).length} />
        <SongMetric label="可点曲目" value={data.songState.repertoire.filter((item) => item.enabled).length} />
        <SongMetric label="待退款" value={data.songState.requests.filter((item) => item.status === 'refund_required').length} warning />
      </div>
      {canManage && <nav className="song-view-tabs" aria-label="点歌中心功能">
        <button className={workspaceMode === 'operations' ? 'is-active' : ''} onClick={() => setWorkspaceMode('operations')}><ListChecks size={15} />现场履约</button>
        <button className={workspaceMode === 'library' ? 'is-active' : ''} onClick={() => setWorkspaceMode('library')}><UserRound size={15} />歌手曲库</button>
        <button className={workspaceMode === 'schedule' ? 'is-active' : ''} onClick={() => setWorkspaceMode('schedule')}><CalendarDays size={15} />演出排班</button>
      </nav>}
      {workspaceMode === 'operations' && <>
        <div className="performance-strip">
          {appearances.length === 0 ? <div className="song-inline-empty">今天还没有演出排班</div> : appearances.map(({ appearance }) => {
            const singer = data.songState.singers.find((item) => item.id === appearance.singerId)
            return <button key={appearance.id} className={appearance.id === appearanceId ? 'appearance-slot is-selected' : 'appearance-slot'} onClick={() => { setAppearanceId(appearance.id); setSongId(data.songState.repertoire.find((item) => item.singerId === appearance.singerId && item.enabled)?.songId ?? '') }}><Clock3 size={15} /><span><strong>{singer?.displayName}</strong><small>{timeRange(appearance.startsAt, appearance.endsAt)}</small></span><b>{appearance.acceptingRequests ? '接单中' : '暂停'}</b></button>
          })}
        </div>
        <div className="song-workspace">
        <form className="song-order-form" onSubmit={(event) => void submit(event)}>
          <div className="form-heading"><Music2 size={19} /><div><strong>员工辅助点歌</strong><span>绑定桌台、歌手排班和价格快照</span></div></div>
          <label><span>营业桌台</span><select value={tableSessionId} onChange={(event) => setTableSessionId(event.target.value)}>{data.songState.tableSessions.filter((item) => item.status === 'open').map((item) => <option key={item.id} value={item.id}>{item.tableCode}</option>)}</select></label>
          <label><span>演唱歌手</span><select value={appearanceId} onChange={(event) => setAppearanceId(event.target.value)}>{appearances.map(({ appearance }) => <option key={appearance.id} value={appearance.id}>{data.songState.singers.find((item) => item.id === appearance.singerId)?.displayName} · {timeRange(appearance.startsAt, appearance.endsAt)}</option>)}</select></label>
          <label className="wide-field song-assist-search"><span>搜索歌曲或原唱</span><span className="song-search-control"><Search size={15} /><input type="search" value={songSearch} placeholder="输入歌名或原唱" onChange={(event) => setSongSearch(event.target.value)} /></span></label>
          <label className="wide-field"><span>歌曲</span><select value={effectiveSongId} onChange={(event) => setSongId(event.target.value)}>{assistedOffers.length === 0 && <option value="">没有匹配歌曲</option>}{assistedOffers.map((offer) => { const song = data.songState.songs.find((item) => item.id === offer.songId); return <option key={offer.id} value={offer.songId}>{song?.title} · {song?.artist} · {money(offer.priceAmount)}</option> })}</select></label>
          <label><span>客人称呼</span><input value={requestedBy} onChange={(event) => setRequestedBy(event.target.value)} /></label>
          <label className="wide-field"><span>备注</span><input value={customerNote} onChange={(event) => setCustomerNote(event.target.value)} placeholder="祝福语、互动偏好或不能公开的信息" /></label>
          <div className="song-payment-boundary"><Banknote size={16} /><span>点歌不发起线上支付；先确认歌手可以演唱，再由服务员到桌使用现金或物理POS现场收费。</span></div>
          <button className="primary-button" disabled={busy || !selectedOffer || !tableSessionId || !requestedBy.trim()}><Music2 size={16} />创建点歌</button>
        </form>
        <div className="song-queue">
          <div className="song-queue-heading"><Mic2 size={19} /><div><strong>点歌队列</strong><span>服务确认、现场收费、歌手接单和演唱状态实时联动</span></div></div>
          {data.songState.requests.length === 0 ? <div className="compact-empty">暂无点歌请求</div> : data.songState.requests.toReversed().map((request) => <SongRequestRow key={request.id} request={request} reference={references[request.id] ?? ''} setReference={(value) => setReferences({ ...references, [request.id]: value })} collectionChannel={collectionChannels[request.id] ?? 'physical_pos'} setCollectionChannel={(value) => setCollectionChannels({ ...collectionChannels, [request.id]: value })} busy={busy} run={run} />)}
        </div>
        </div>
      </>}
      {canManage && workspaceMode === 'library' && <SingerLibraryManager key={data.revision} data={data} busy={busy} run={run} />}
      {canManage && workspaceMode === 'schedule' && <PerformanceScheduleManager data={data} busy={busy} run={run} />}
    </section>
  )
}

function SingerLibraryManager({ data, busy, run }: { data: BootstrapResponse; busy: boolean; run: SongOperationRunner }) {
  const [singerId, setSingerId] = useState(data.songState.singers.find((item) => item.active)?.id ?? data.songState.singers[0]?.id ?? '')
  const [newSingerName, setNewSingerName] = useState('')
  const [detailMode, setDetailMode] = useState<'repertoire' | 'profile'>('repertoire')
  const singer = data.songState.singers.find((item) => item.id === singerId) ?? data.songState.singers[0]
  const repertoire = data.songState.repertoire.filter((item) => item.singerId === singer?.id)

  return <div className="song-config-page">
    <div className="song-config-toolbar">
      <label><span>管理歌手</span><select value={singer?.id ?? ''} onChange={(event) => setSingerId(event.target.value)}>{data.songState.singers.map((item) => <option key={item.id} value={item.id}>{item.displayName}{item.active ? '' : '（停用）'}</option>)}</select></label>
      <form onSubmit={(event) => { event.preventDefault(); if (!newSingerName.trim()) return; void run(() => createSinger({ displayName: newSingerName.trim(), photoUrl: '', headline: '', bio: '', styleTags: [], active: true }), '歌手已新增，请继续完善资料和歌单') }}>
        <input value={newSingerName} maxLength={80} placeholder="新歌手名称" onChange={(event) => setNewSingerName(event.target.value)} />
        <button className="secondary-button" disabled={busy || !newSingerName.trim()}><Plus size={15} />新增歌手</button>
      </form>
    </div>
    <div className="singer-library-tabs" role="tablist" aria-label="歌手资料功能">
      <button role="tab" aria-selected={detailMode === 'repertoire'} className={detailMode === 'repertoire' ? 'is-active' : ''} onClick={() => setDetailMode('repertoire')}><ListMusic size={15} />歌单管理</button>
      <button role="tab" aria-selected={detailMode === 'profile'} className={detailMode === 'profile' ? 'is-active' : ''} onClick={() => setDetailMode('profile')}><UserRound size={15} />歌手资料</button>
    </div>
    {singer ? <>
      {detailMode === 'profile' && <SingerProfileEditor singer={singer} busy={busy} onSave={(input) => run(() => updateSingerProfile(singer.id, input), '歌手资料已保存，顾客端将自动更新')} />}
      {detailMode === 'repertoire' && <RepertoireManager key={singer.id} data={data} singer={singer} repertoire={repertoire} busy={busy} run={run} />}
    </> : <div className="compact-empty">先新增一位歌手，再维护资料和歌单。</div>}
  </div>
}

function RepertoireManager({ data, singer, repertoire, busy, run }: { data: BootstrapResponse; singer: Singer; repertoire: SingerRepertoireEntry[]; busy: boolean; run: SongOperationRunner }) {
  const [draft, setDraft] = useState({ title: '', artist: '', durationSeconds: 240, priceYuan: '98' })
  const [query, setQuery] = useState('')
  const [fileName, setFileName] = useState('')
  const [fileReading, setFileReading] = useState(false)
  const [preview, setPreview] = useState<RepertoireImportPreview | null>(null)
  const songById = useMemo(() => new Map(data.songState.songs.map((song) => [song.id, song])), [data.songState.songs])
  const filteredRepertoire = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase('zh-CN')
    if (!keyword) return repertoire
    return repertoire.filter((offer) => {
      const song = songById.get(offer.songId)
      return `${song?.title ?? ''} ${song?.artist ?? ''}`.toLocaleLowerCase('zh-CN').includes(keyword)
    })
  }, [query, repertoire, songById])
  const visibleRepertoire = filteredRepertoire.slice(0, 200)

  async function readFile(file: File) {
    setFileName(file.name)
    setFileReading(true)
    try {
      setPreview(await parseRepertoireFile(file))
    } catch (error) {
      setPreview({ rows: [], errors: [error instanceof Error ? error.message : '文件读取失败'] })
    } finally {
      setFileReading(false)
    }
  }

  return <section className="repertoire-manager">
    <div className="form-heading"><ListMusic size={19} /><div><strong>{singer.displayName}的可点歌单</strong><span>曲目、原唱、演唱时长和现场收费价格均可配置</span></div></div>
    <section className="repertoire-import" aria-label="批量导入歌单">
      <div className="repertoire-import-heading">
        <div><strong>一次导入整份歌单</strong><span>支持 Excel (.xlsx) 和 CSV；同名同原唱会更新，不会重复新增。</span></div>
        <div>
          <button type="button" className="secondary-button" onClick={downloadRepertoireTemplate}><Download size={15} />下载模板</button>
          <label className="primary-button repertoire-file-button"><FileUp size={15} />选择文件<input type="file" accept=".xlsx,.csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); event.currentTarget.value = '' }} /></label>
        </div>
      </div>
      {fileReading && <div className="repertoire-import-status">正在读取并校验歌单…</div>}
      {!fileReading && preview && <div className={`repertoire-import-preview${preview.errors.length > 0 ? ' has-errors' : ''}`}>
        <div className="repertoire-import-summary">
          <span><strong>{fileName}</strong><small>{preview.rows.length}首可导入{preview.errors.length > 0 ? ` · ${preview.errors.length}处需修改` : ' · 校验通过'}</small></span>
          <button type="button" className="primary-button" disabled={busy || preview.rows.length === 0 || preview.errors.length > 0} onClick={() => void run(
            () => importSingerRepertoire(singer.id, { rows: preview.rows }),
            (result) => {
              const imported = result as RepertoireImportResult
              return `${singer.displayName}歌单导入完成：新增${imported.created}首，更新${imported.updated}首`
            },
          )}><FileUp size={15} />确认导入{preview.rows.length}首</button>
        </div>
        {preview.errors.length > 0 && <div className="repertoire-import-errors" role="alert">{preview.errors.slice(0, 8).map((error) => <span key={error}>{error}</span>)}{preview.errors.length > 8 && <b>另有{preview.errors.length - 8}处，请修改文件后重新选择。</b>}</div>}
        {preview.errors.length === 0 && <div className="repertoire-import-sample">{preview.rows.slice(0, 5).map((row) => <span key={`${row.title}-${row.artist}`}><strong>{row.title}</strong><small>{row.artist} · {row.durationSeconds}秒 · ¥{(row.priceAmount / 100).toFixed(2)} · {row.enabled ? '启用' : '停用'}</small></span>)}</div>}
      </div>}
    </section>
    <div className="repertoire-subheading"><strong>单首录入</strong><span>临时增加歌曲时使用</span></div>
    <form className="repertoire-create" onSubmit={(event) => {
      event.preventDefault()
      const priceAmount = Math.round(Number(draft.priceYuan) * 100)
      if (!draft.title.trim() || !draft.artist.trim() || !Number.isSafeInteger(priceAmount) || priceAmount <= 0) return
      void run(() => createSingerRepertoire(singer.id, { title: draft.title.trim(), artist: draft.artist.trim(), durationSeconds: draft.durationSeconds, priceAmount, currency: 'CNY', enabled: true }), '歌曲已加入该歌手的可点歌单')
    }}>
      <input value={draft.title} placeholder="歌曲名称" onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
      <input value={draft.artist} placeholder="原唱" onChange={(event) => setDraft({ ...draft, artist: event.target.value })} />
      <label><span>时长(秒)</span><input type="number" min={30} max={1800} value={draft.durationSeconds} onChange={(event) => setDraft({ ...draft, durationSeconds: Number(event.target.value) })} /></label>
      <label><span>价格(元)</span><input inputMode="decimal" value={draft.priceYuan} onChange={(event) => setDraft({ ...draft, priceYuan: event.target.value })} /></label>
      <button className="primary-button" disabled={busy || !draft.title.trim() || !draft.artist.trim()}><Plus size={15} />加入歌单</button>
    </form>
    <div className="repertoire-list-toolbar">
      <span className="song-search-control"><Search size={15} /><input type="search" value={query} placeholder="搜索歌曲或原唱" onChange={(event) => setQuery(event.target.value)} /></span>
      <b>{filteredRepertoire.length}/{repertoire.length}首</b>
    </div>
    <div className="repertoire-list">{repertoire.length === 0 ? <div className="compact-empty">这位歌手还没有可点歌曲</div> : filteredRepertoire.length === 0 ? <div className="compact-empty">没有匹配的歌曲</div> : visibleRepertoire.map((offer) => {
      const song = songById.get(offer.songId)
      return song ? <RepertoireRow key={offer.id} song={song} offer={offer} busy={busy} run={run} /> : null
    })}{filteredRepertoire.length > visibleRepertoire.length && <div className="repertoire-list-limit">当前显示前200首，请输入歌名或原唱继续缩小范围。</div>}</div>
  </section>
}

function RepertoireRow({ song, offer, busy, run }: { song: SongCatalogItem; offer: SingerRepertoireEntry; busy: boolean; run: SongOperationRunner }) {
  const [draft, setDraft] = useState<RepertoireWriteInput>({ title: song.title, artist: song.artist, durationSeconds: song.durationSeconds, priceAmount: offer.priceAmount, currency: offer.currency, enabled: offer.enabled })
  return <form className="repertoire-row" onSubmit={(event) => { event.preventDefault(); void run(() => updateSingerRepertoire(offer.id, draft), '曲目与价格已更新') }}>
    <input aria-label="歌曲名称" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
    <input aria-label="歌曲原唱" value={draft.artist} onChange={(event) => setDraft({ ...draft, artist: event.target.value })} />
    <input aria-label="歌曲时长（秒）" type="number" min={30} max={1800} value={draft.durationSeconds} onChange={(event) => setDraft({ ...draft, durationSeconds: Number(event.target.value) })} />
    <label className="price-input"><span>¥</span><input aria-label="点歌价格（元）" inputMode="decimal" value={(draft.priceAmount / 100).toString()} onChange={(event) => setDraft({ ...draft, priceAmount: Math.round(Number(event.target.value) * 100) })} /></label>
    <label className="enabled-toggle"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span>{draft.enabled ? '顾客可见' : '已暂停'}</span></label>
    <button className="secondary-button" disabled={busy || !draft.title.trim() || !draft.artist.trim() || !Number.isSafeInteger(draft.durationSeconds) || draft.durationSeconds < 30 || !Number.isSafeInteger(draft.priceAmount) || draft.priceAmount <= 0}><Save size={14} />保存</button>
  </form>
}

interface ScheduleRowDraft {
  id: string
  singerId: string
  startsAt: string
  endsAt: string
  requestOpensAt: string
  requestClosesAt: string
  acceptingRequests: boolean
  advanceBookingEnabled: boolean
  extensionNegotiationEnabled: boolean
  extensionThresholdMinutes: number
}

// oxlint-disable-next-line react/only-export-components
export const scheduleDateFieldLabels = {
  startsAt: '演出开始',
  endsAt: '演出结束',
  requestOpensAt: '预约开放',
  requestClosesAt: '点歌截止',
} as const

function PerformanceScheduleManager({ data, busy, run }: { data: BootstrapResponse; busy: boolean; run: SongOperationRunner }) {
  const sessions = data.songState.performanceSessions.toSorted((left, right) => (
    right.businessDate.localeCompare(left.businessDate) || right.startsAt.localeCompare(left.startsAt)
  ))
  const todaySession = sessions.find((item) => item.businessDate === data.store.businessDate)
  const [selectedSessionId, setSelectedSessionId] = useState(todaySession?.id ?? sessions[0]?.id ?? '')
  const [draftId, setDraftId] = useState(sessions.length === 0 ? `performance_${crypto.randomUUID()}` : '')
  const [template, setTemplate] = useState<PerformanceSession | null>(null)
  const [editorRevealTick, setEditorRevealTick] = useState(0)
  const editorPanelRef = useRevealPanelScroll<HTMLDivElement>(editorRevealTick)
  const selectedSession = sessions.find((item) => item.id === selectedSessionId) ?? null
  const isNew = Boolean(draftId)

  function editSession(sessionId: string) {
    setSelectedSessionId(sessionId)
    setDraftId('')
    setTemplate(null)
  }

  function newSchedule(source: PerformanceSession | null = null) {
    setSelectedSessionId('')
    setTemplate(source)
    setDraftId(`performance_${crypto.randomUUID()}`)
    setEditorRevealTick((value) => value + 1)
  }

  return <div className="schedule-manager">
    <div className="schedule-manager-bar">
      <label><span>正在编辑</span><select value={isNew ? '__new__' : selectedSessionId} onChange={(event) => event.target.value === '__new__' ? newSchedule() : editSession(event.target.value)}>
        {isNew && <option value="__new__">新排班（尚未发布）</option>}
        {sessions.map((item) => <option key={item.id} value={item.id}>{item.businessDate} · {item.title} · V{item.configVersion ?? 1}</option>)}
      </select></label>
      <div className="schedule-manager-actions">
        <button type="button" className="secondary-button" onClick={() => newSchedule()}><Plus size={15} />新建空白排班</button>
        <button type="button" className="secondary-button" disabled={!selectedSession} onClick={() => newSchedule(selectedSession)}><Copy size={15} />复制当前排班</button>
      </div>
    </div>
    <div className="schedule-manager-note">
      <strong>{isNew ? template ? '已复制，先修改营业日和时间' : '从空白排班开始' : `${selectedSession?.businessDate} 已发布版本`}</strong>
      <span>歌手、顺序、时间、预约开关和点歌规则都可修改；保存后客户页面自动读取最新版本。</span>
    </div>
    <div className="reveal-panel-target" ref={editorPanelRef}>
      <PerformanceScheduleEditor
        key={selectedSession?.id ?? draftId}
        data={data}
        session={selectedSession}
        template={template}
        sessionId={selectedSession?.id ?? draftId}
        busy={busy}
        run={run}
        onSaved={editSession}
      />
    </div>
  </div>
}

function PerformanceScheduleEditor({ data, session, template, sessionId, busy, run, onSaved }: { data: BootstrapResponse; session: PerformanceSession | null; template: PerformanceSession | null; sessionId: string; busy: boolean; run: SongOperationRunner; onSaved: (sessionId: string) => void }) {
  const source = session ?? template
  const [businessDate, setBusinessDate] = useState(source?.businessDate ?? data.store.businessDate)
  const [title, setTitle] = useState(source?.title ?? '')
  const [status, setStatus] = useState<PerformanceSessionStatus>(session?.status ?? 'scheduled')
  const [rows, setRows] = useState<ScheduleRowDraft[]>(source?.appearances.map((item) => ({
    ...item,
    startsAt: localDatetime(item.startsAt), endsAt: localDatetime(item.endsAt),
    requestOpensAt: localDatetime(item.requestOpensAt), requestClosesAt: localDatetime(item.requestClosesAt),
    advanceBookingEnabled: item.advanceBookingEnabled ?? true,
    extensionNegotiationEnabled: item.extensionNegotiationEnabled ?? true,
    extensionThresholdMinutes: item.extensionThresholdMinutes ?? 10,
  })) ?? [])
  const [appearanceRevealTick, setAppearanceRevealTick] = useState(0)
  const appearancePanelRef = useRevealPanelScroll<HTMLDivElement>(appearanceRevealTick)
  const firstAppearanceDate = rows[0]?.startsAt.slice(0, 10) ?? businessDate
  const datesNeedAlignment = rows.length > 0 && firstAppearanceDate !== businessDate

  function changeBusinessDate(nextBusinessDate: string) {
    setRows((currentRows) => currentRows.map((row) => ({
      ...row,
      startsAt: moveLocalDatetimeToBusinessDate(row.startsAt, businessDate, nextBusinessDate),
      endsAt: moveLocalDatetimeToBusinessDate(row.endsAt, businessDate, nextBusinessDate),
      requestOpensAt: moveLocalDatetimeToBusinessDate(row.requestOpensAt, businessDate, nextBusinessDate),
      requestClosesAt: moveLocalDatetimeToBusinessDate(row.requestClosesAt, businessDate, nextBusinessDate),
    })))
    setBusinessDate(nextBusinessDate)
  }

  function addAppearance() {
    const singerId = data.songState.singers.find((item) => item.active)?.id ?? data.songState.singers[0]?.id ?? ''
    const previousEnd = rows.at(-1)?.endsAt
    const startsAt = previousEnd ? shiftLocalDatetime(previousEnd, 20) : `${businessDate}T20:30`
    const endsAt = shiftLocalDatetime(startsAt, 45)
    setRows([...rows, {
      id: `appearance_${crypto.randomUUID()}`, singerId, startsAt, endsAt,
      requestOpensAt: `${businessDate}T12:00`, requestClosesAt: shiftLocalDatetime(endsAt, -5),
      acceptingRequests: true, advanceBookingEnabled: true, extensionNegotiationEnabled: true, extensionThresholdMinutes: 10,
    }])
    setAppearanceRevealTick((value) => value + 1)
  }

  function alignDatesToBusinessDate() {
    setRows((currentRows) => currentRows.map((row) => ({
      ...row,
      startsAt: moveLocalDatetimeToBusinessDate(row.startsAt, firstAppearanceDate, businessDate),
      endsAt: moveLocalDatetimeToBusinessDate(row.endsAt, firstAppearanceDate, businessDate),
      requestOpensAt: moveLocalDatetimeToBusinessDate(row.requestOpensAt, firstAppearanceDate, businessDate),
      requestClosesAt: moveLocalDatetimeToBusinessDate(row.requestClosesAt, firstAppearanceDate, businessDate),
    })))
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (rows.length === 0) return
    const appearances = rows.map((row) => ({ ...row, startsAt: chinaLocalDateTimeToIso(row.startsAt), endsAt: chinaLocalDateTimeToIso(row.endsAt), requestOpensAt: chinaLocalDateTimeToIso(row.requestOpensAt), requestClosesAt: chinaLocalDateTimeToIso(row.requestClosesAt) }))
    const startsAt = appearances.flatMap((item) => [item.startsAt, item.requestOpensAt]).toSorted()[0]!
    const endsAt = appearances.flatMap((item) => [item.endsAt, item.requestClosesAt]).toSorted().at(-1)!
    const saved = await run(() => updatePerformanceSession(sessionId, { businessDate, title: title.trim(), status, startsAt, endsAt, appearances, expectedVersion: session?.configVersion ?? (session ? 1 : undefined) }), '演出排班已发布，顾客端会自动更新')
    if (saved) onSaved(sessionId)
  }

  return <form className="schedule-editor" onSubmit={(event) => void save(event)}>
    <div className="schedule-toolbar">
      <label><span>1. 营业日</span><input type="date" value={businessDate} onChange={(event) => changeBusinessDate(event.target.value)} /></label>
      <label className="schedule-title"><span>2. 排班名称 · {session ? `当前V${session.configVersion ?? 1}` : '新排班'}</span><input value={title} maxLength={120} placeholder="例如：周五现场演出" onChange={(event) => setTitle(event.target.value)} /></label>
      <label><span>状态</span><select value={status} onChange={(event) => setStatus(event.target.value as PerformanceSessionStatus)}><option value="scheduled">待演出</option><option value="live">演出中</option><option value="completed">已结束</option><option value="cancelled">已取消</option></select></label>
      <button type="button" className="secondary-button" disabled={busy || data.songState.singers.length === 0} onClick={addAppearance}><Plus size={15} />3. 添加歌手轮次</button>
    </div>
    {datesNeedAlignment && <div className="schedule-date-warning" role="alert"><span><strong>轮次日期与营业日不一致</strong><small>当前轮次从{firstAppearanceDate}开始，保存前请对齐到{businessDate}。</small></span><button type="button" className="secondary-button" onClick={alignDatesToBusinessDate}>一键对齐日期</button></div>}
    <div className="schedule-list">
      {rows.length === 0 ? <div className="compact-empty">还没有演出轮次，点击“增加一轮”开始排班。</div> : rows.map((row, index) => <div className={index === rows.length - 1 ? 'schedule-row reveal-panel-target' : 'schedule-row'} ref={index === rows.length - 1 ? appearancePanelRef : undefined} key={row.id}>
        <div className="schedule-row-heading">
          <strong>第{index + 1}轮</strong>
          <button type="button" className="icon-button danger" title={`删除第${index + 1}轮`} aria-label={`删除第${index + 1}轮`} onClick={() => setRows(rows.filter((item) => item.id !== row.id))}><XCircle size={16} /></button>
        </div>
        <div className="schedule-row-body"><div className="schedule-fields">
          <label className="schedule-field schedule-singer-field"><span>歌手</span><select aria-label={`第${index + 1}轮歌手`} value={row.singerId} onChange={(event) => setRows(rows.map((item) => item.id === row.id ? { ...item, singerId: event.target.value } : item))}>{data.songState.singers.filter((item) => item.active || item.id === row.singerId).map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
          {(Object.keys(scheduleDateFieldLabels) as Array<keyof typeof scheduleDateFieldLabels>).map((field) => <label className="schedule-field" key={field}><span>{scheduleDateFieldLabels[field]}</span><input aria-label={`第${index + 1}轮${scheduleDateFieldLabels[field]}`} type="datetime-local" value={row[field]} onChange={(event) => setRows(rows.map((item) => item.id === row.id ? { ...item, [field]: event.target.value } : item))} /></label>)}
          <label className="schedule-field schedule-request-status"><span>点歌状态</span><span className="enabled-toggle"><input type="checkbox" checked={row.acceptingRequests} onChange={(event) => setRows(rows.map((item) => item.id === row.id ? { ...item, acceptingRequests: event.target.checked } : item))} /><span>{row.acceptingRequests ? '可点歌' : '暂停'}</span></span></label>
        </div><div className="schedule-policy-fields">
          <label className="enabled-toggle"><input type="checkbox" checked={row.advanceBookingEnabled} onChange={(event) => setRows(rows.map((item) => item.id === row.id ? { ...item, advanceBookingEnabled: event.target.checked } : item))} /><span>允许歌手到场前预约</span></label>
          <label className="enabled-toggle"><input type="checkbox" checked={row.extensionNegotiationEnabled} onChange={(event) => setRows(rows.map((item) => item.id === row.id ? { ...item, extensionNegotiationEnabled: event.target.checked } : item))} /><span>允许剩余时间不足时协商延长</span></label>
          <label><span>协商阈值</span><input type="number" min={1} max={60} value={row.extensionThresholdMinutes} onChange={(event) => setRows(rows.map((item) => item.id === row.id ? { ...item, extensionThresholdMinutes: Number(event.target.value) } : item))} /><b>分钟</b></label>
        </div></div>
      </div>)}
    </div>
    <div className="schedule-actions"><span>全部为北京时间。修改营业日时，所有轮次会自动平移到新日期。</span><button className="primary-button" disabled={busy || rows.length === 0 || !title.trim() || datesNeedAlignment}><Save size={15} />4. 保存并发布</button></div>
  </form>
}

function SingerProfileEditor({ singer, busy, onSave }: { singer: Singer; busy: boolean; onSave: (input: SingerProfileWriteInput) => Promise<boolean> }) {
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

function SongRequestRow({ request, reference, setReference, collectionChannel, setCollectionChannel, busy, run }: { request: SongRequest; reference: string; setReference: (value: string) => void; collectionChannel: 'cash' | 'physical_pos'; setCollectionChannel: (value: 'cash' | 'physical_pos') => void; busy: boolean; run: SongOperationRunner }) {
  const modeLabel = request.requestMode === 'advance_reservation' ? '提前预约' : request.requestMode === 'extension_negotiation' ? '延长协商' : '本轮点歌'
  return <div className="song-request-row"><span className={`song-status status-${request.status}`}>{statusLabel(request.status)}</span><div><strong>{request.tableCode} · {request.priceSnapshot.songTitle}</strong><small>{request.priceSnapshot.singerName} · {modeLabel} · 排班V{request.scheduleVersion} / 歌单V{request.priceSnapshot.configVersion} · {money(request.priceSnapshot.priceAmount)}</small></div><div className="song-request-actions">{request.status === 'pending_confirmation' && <><button className="primary-button" disabled={busy} onClick={() => void run(() => actOnSongRequest(request.id, 'confirm'), '歌手、时间与费用已确认，请到桌现场收费')}><CheckCircle2 size={14} />确认可安排</button><button className="secondary-button" disabled={busy} onClick={() => void run(() => actOnSongRequest(request.id, 'reject', '歌手或现场安排无法演唱'), '已反馈客人本次无法安排')}>无法安排</button></>}{request.status === 'pending_payment' && <><select aria-label="现场收费方式" value={collectionChannel} onChange={(event) => setCollectionChannel(event.target.value as 'cash' | 'physical_pos')}><option value="physical_pos">物理POS</option><option value="cash">现金</option></select><input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="现场收款凭证号" /><button className="primary-button" disabled={busy || reference.trim().length < 4} onClick={() => void run(() => reportSongOnsiteCollection(request.id, reference.trim(), collectionChannel), '现场收款已登记，等待歌手接单')}><Banknote size={14} />登记现场收款</button><button className="icon-button danger" title="取消未收款点歌" disabled={busy} onClick={() => void run(() => actOnSongRequest(request.id, 'cancel', '客人现场付款前取消'), '点歌已取消')}><XCircle size={15} /></button></>}{request.status === 'paid' && <><button className="primary-button" disabled={busy} onClick={() => void run(() => actOnSongRequest(request.id, 'accept'), '歌手队列已接单')}><CheckCircle2 size={14} />接单</button><button className="secondary-button" disabled={busy} onClick={() => void run(() => actOnSongRequest(request.id, 'reject', '现场无法履约，经理发起退款'), '已拒绝并进入退款队列')}>拒绝并退款</button></>}{request.status === 'accepted' && <><button className="primary-button" disabled={busy} onClick={() => void run(() => actOnSongRequest(request.id, 'start'), '已开始演唱')}><Play size={14} />开始演唱</button><button className="secondary-button" disabled={busy} onClick={() => void run(() => actOnSongRequest(request.id, 'reject', '现场无法履约，经理发起退款'), '已拒绝并进入退款队列')}>拒绝并退款</button></>}{request.status === 'performing' && <button className="primary-button" disabled={busy} onClick={() => void run(() => actOnSongRequest(request.id, 'complete'), '本次点歌已完成')}><CheckCircle2 size={14} />完成</button>}{request.status === 'refund_required' && <><input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="退款流水号" /><button className="primary-button" disabled={busy || reference.trim().length < 4} onClick={() => void run(() => actOnSongRequest(request.id, 'refund', '', reference.trim()), '点歌退款已登记')}><RotateCcw size={14} />确认退款</button></>}</div></div>
}

function SongMetric({ label, value, warning = false }: { label: string; value: number; warning?: boolean }) { return <div className={warning && value > 0 ? 'song-metric is-warning' : 'song-metric'}><strong>{value}</strong><span>{label}</span></div> }
function statusLabel(status: SongRequestStatus) { return ({ pending_confirmation: '待确认', pending_payment: '待现场收费', paid: '现场已收款', accepted: '已接单', performing: '演唱中', completed: '已完成', rejected: '无法安排', cancelled: '已取消', refund_required: '待退款', refunded: '已退款' } as const)[status] }
function money(amount: number) { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(amount / 100) }
function timeRange(startsAt: string, endsAt: string) { return `${formatChinaTime(startsAt)}-${formatChinaTime(endsAt)}` }
function localDatetime(value: string) { return chinaDateTimeLocalValue(value) }
function shiftLocalDatetime(value: string, minutes: number) { return localDatetime(new Date(Date.parse(chinaLocalDateTimeToIso(value)) + minutes * 60_000).toISOString()) }
