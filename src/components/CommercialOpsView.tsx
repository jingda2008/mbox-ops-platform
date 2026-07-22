import {
  BadgeCheck, Banknote, BarChart3, ChevronDown, ChevronRight, CircleAlert, Download, Gift, LoaderCircle,
  PackagePlus, Printer, QrCode, RefreshCw, RotateCcw, Save, ScanLine, Settings2, Tags,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import QRCode from 'qrcode'
import * as commercialApi from '../commercial-ops-api'
import type { BootstrapResponse } from '../shared/contracts'
import type { CommercialOpsConfig, CommercialOpsWorkspace, PrintJob, ScanCodeBinding } from '../shared/commercial-ops-contracts'
import { formatChinaDateTime } from '../shared/china-time'
import { useRevealPanelScroll } from './use-reveal-panel-scroll'
import './CommercialOpsView.css'

type Tab = 'overview' | 'stock' | 'print-jobs' | 'printing' | 'vouchers' | 'customers' | 'sales' | 'rules'
type PrintJobFilter = 'all' | 'queued' | 'failed' | 'printed'
type Notice = { tone: 'success' | 'error'; message: string }

export function CommercialOpsView({ data, onRefresh }: { data: BootstrapResponse; onRefresh: () => Promise<void> }) {
  const [workspace, setWorkspace] = useState<CommercialOpsWorkspace | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [printJobFilter, setPrintJobFilter] = useState<PrintJobFilter>('all')
  const [panelRevealTick, setPanelRevealTick] = useState(0)
  const contentRef = useRevealPanelScroll<HTMLDivElement>(panelRevealTick)
  const permissions = new Set(data.viewer?.permissionIds ?? [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setWorkspace(await commercialApi.getCommercialOpsWorkspace())
    } catch (error) {
      setNotice({ tone: 'error', message: errorMessage(error) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function execute(key: string, success: string, action: () => Promise<unknown>) {
    setBusy(key)
    setNotice(null)
    try {
      await action()
      await Promise.all([load(), onRefresh()])
      setNotice({ tone: 'success', message: success })
    } catch (error) {
      setNotice({ tone: 'error', message: errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  if (!workspace) return <section className="commercial-ops-view"><div className="commercial-empty">{loading ? <LoaderCircle className="spin" size={22} /> : <CircleAlert size={22} />}{loading ? '正在载入经营工具' : notice?.message ?? '经营工具暂不可用'}</div></section>

  const state = workspace.state
  const canInventory = permissions.has('inventory.manage') || permissions.has('inventory.approve')
  const canConfig = permissions.has('config.manage')
  const canOperatePrintJobs = permissions.has('kds.prepare') || canConfig
  const canVoucher = permissions.has('payment.collect')
  const canTags = permissions.has('benefit.manage')
  const tabs: Array<{ id: Tab; label: string; visible: boolean }> = [
    { id: 'overview', label: '经营概览', visible: true },
    { id: 'stock', label: '扫码进货', visible: canInventory },
    { id: 'print-jobs', label: '打印任务', visible: true },
    { id: 'printing', label: '打印分流', visible: canConfig },
    { id: 'vouchers', label: '团购核销', visible: canVoucher },
    { id: 'customers', label: '客户标签', visible: canTags },
    { id: 'sales', label: '员工业绩', visible: workspace.salesByEmployeeCategory.length > 0 || permissions.has('order.view') },
    { id: 'rules', label: '经营规则', visible: canConfig },
  ]

  function revealTab(nextTab: Tab) {
    setTab(nextTab)
    setPanelRevealTick((current) => current + 1)
  }

  function revealPrintJobs(filter: PrintJobFilter) {
    setPrintJobFilter(filter)
    revealTab('print-jobs')
  }

  return <section className="commercial-ops-view">
    <header className="commercial-heading">
      <div><span className="eyebrow">进货、打印、核销与经营分析</span><h2>经营工具</h2></div>
      <button className="secondary-button" disabled={loading || Boolean(busy)} onClick={() => void load()}><RefreshCw className={loading ? 'spin' : ''} size={16} />刷新</button>
    </header>
    {notice && <div className={`commercial-notice is-${notice.tone}`} role="status">{notice.tone === 'success' ? <BadgeCheck size={17} /> : <CircleAlert size={17} />}{notice.message}</div>}
    <nav className="commercial-tabs">{tabs.filter((item) => item.visible).map((item) => <button key={item.id} className={tab === item.id ? 'is-active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>
    <div ref={contentRef} className="commercial-tab-panel">
      {tab === 'overview' && <CommercialOverview workspace={workspace} onRevealPrintJobs={revealPrintJobs} />}
      {tab === 'stock' && canInventory && <StockTools data={data} workspace={workspace} busy={busy} execute={execute} />}
      {tab === 'print-jobs' && <PrintJobTools data={data} workspace={workspace} filter={printJobFilter} onFilterChange={setPrintJobFilter} canOperate={canOperatePrintJobs} canConfig={canConfig} busy={busy} execute={execute} onOpenConfig={() => revealTab('printing')} />}
      {tab === 'printing' && canConfig && <PrintingTools data={data} config={state.config} busy={busy} execute={execute} />}
      {tab === 'vouchers' && canVoucher && <VoucherTools data={data} workspace={workspace} busy={busy} execute={execute} />}
      {tab === 'customers' && canTags && <CustomerTools data={data} workspace={workspace} busy={busy} execute={execute} />}
      {tab === 'sales' && <SalesTools workspace={workspace} />}
      {tab === 'rules' && canConfig && <RuleTools config={state.config} busy={busy} execute={execute} />}
    </div>
  </section>
}

function CommercialOverview({ workspace, onRevealPrintJobs }: { workspace: CommercialOpsWorkspace; onRevealPrintJobs: (filter: PrintJobFilter) => void }) {
  const queued = workspace.state.printJobs.filter((job) => job.status === 'queued').length
  const failed = workspace.state.printJobs.filter((job) => job.status === 'failed').length
  const procurementCost = workspace.state.procurementBatches.reduce((sum, item) => sum + item.totalCostAmount, 0)
  const voucherSettlement = workspace.state.voucherRedemptions.filter((item) => item.status === 'redeemed').reduce((sum, item) => sum + item.settlementAmount, 0)
  return <div className="commercial-content">
    <div className="commercial-metrics">
      <Metric icon={<QrCode size={19} />} value={workspace.state.scanCodeBindings.filter((item) => item.enabled).length} label="已绑定货品码" />
      <Metric icon={<Printer size={19} />} value={queued} label="待打印任务" warning={queued > 0} onClick={() => onRevealPrintJobs('queued')} />
      <Metric icon={<CircleAlert size={19} />} value={failed} label="打印失败" warning={failed > 0} onClick={() => onRevealPrintJobs('failed')} />
      <Metric icon={<PackagePlus size={19} />} value={money(procurementCost)} label="采购批次成本" />
      <Metric icon={<Gift size={19} />} value={money(voucherSettlement)} label="团购结算额" />
    </div>
    <section className="commercial-section"><SectionTitle icon={<BarChart3 size={18} />} title="当前经营能力" />
      <div className="commercial-capability-grid">
        <Capability title="防重复上单" value={workspace.state.config.orderSafety.enabled ? `${workspace.state.config.orderSafety.duplicateWindowSeconds}秒复核` : '未开启'} />
        <Capability title="双机分流" value={`${workspace.state.config.printers.filter((item) => item.enabled).length}台 · ${workspace.state.config.printerRoutes.filter((item) => item.enabled).length}条路由`} />
        <Capability title="鸡尾酒损耗" value={`${(workspace.state.config.inventoryControl.cocktailAllowedLossBps / 100).toFixed(1)}%`} />
        <Capability title="线上打赏" value={workspace.state.config.tipping.enabled ? '已开启' : '未开启'} />
      </div>
    </section>
  </div>
}

function StockTools({ data, workspace, busy, execute }: ToolProps) {
  const inventory = data.inventoryDomain
  const targets = useMemo(() => [
    ...data.products.map((item) => ({ type: 'product' as const, id: item.id, name: item.name, sku: item.sku, unit: 'unit' })),
    ...(inventory?.ingredientSkus ?? []).map((item) => ({ type: 'ingredient' as const, id: item.id, name: item.name, sku: item.sku, unit: item.baseUnitCode })),
  ], [data.products, inventory?.ingredientSkus])
  const [targetKey, setTargetKey] = useState(targets[0] ? `${targets[0].type}:${targets[0].id}` : '')
  const [code, setCode] = useState('')
  const [countMode, setCountMode] = useState<'integer' | 'decimal'>('integer')
  const [supplier, setSupplier] = useState('')
  const [receivingScanCode, setReceivingScanCode] = useState('')
  const [supplierRef, setSupplierRef] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [unitCostYuan, setUnitCostYuan] = useState('0')
  const selected = targets.find((item) => `${item.type}:${item.id}` === targetKey)
  const binding = workspace.state.scanCodeBindings.find((item) => item.targetId === selected?.id && item.targetType === selected?.type)

  function selectByScannedCode(value: string) {
    setReceivingScanCode(value)
    const matched = workspace.state.scanCodeBindings.find((item) => item.enabled && item.code === value.trim())
    if (!matched) return
    setTargetKey(`${matched.targetType}:${matched.targetId}`)
    setCode(matched.code)
    setCountMode(matched.countMode)
  }

  function saveBinding(event: FormEvent) {
    event.preventDefault()
    if (!selected || !code.trim()) return
    void execute('scan-binding', '货品码绑定已保存，扫码入库和盘点可直接识别', () => commercialApi.upsertScanBinding({
      bindingId: binding?.id, code: code.trim(), symbology: /^\d{13}$/.test(code.trim()) ? 'ean13' : 'qr',
      targetType: selected.type, targetId: selected.id, countMode, enabled: true, reason: '门店货品码建档',
    }))
  }

  function receive(event: FormEvent) {
    event.preventDefault()
    if (!selected || !supplier.trim()) return
    void execute('procurement', '采购批次与实际进价已记录，库存同步入账', () => commercialApi.receiveProcurement({
      targetType: selected.type, targetId: selected.id, scanCode: binding?.code,
      supplierName: supplier.trim(), supplierReference: supplierRef.trim(), quantity,
      unitCode: selected.unit, unitCostAmount: Math.max(0, Math.round(Number(unitCostYuan) * 100)), reason: '供应商到货验收入库',
    }))
  }

  return <div className="commercial-content commercial-two-column">
    <section className="commercial-section"><SectionTitle icon={<ScanLine size={18} />} title="货品码绑定" />
      <form className="commercial-form" onSubmit={saveBinding}>
        <Field label="商品或原料"><select value={targetKey} onChange={(event) => { setTargetKey(event.target.value); const next = targets.find((item) => `${item.type}:${item.id}` === event.target.value); const found = workspace.state.scanCodeBindings.find((item) => item.targetId === next?.id && item.targetType === next?.type); setCode(found?.code ?? '') }}>{targets.map((item) => <option key={`${item.type}:${item.id}`} value={`${item.type}:${item.id}`}>{item.name} · {item.sku}</option>)}</select></Field>
        <Field label="扫码值"><input required autoFocus placeholder="扫描二维码/条形码或手工输入" value={code} onChange={(event) => setCode(event.target.value)} /></Field>
        <Field label="盘点数量"><select value={countMode} onChange={(event) => setCountMode(event.target.value as typeof countMode)}><option value="integer">只计整数</option><option value="decimal">允许小数</option></select></Field>
        <button className="primary-button" disabled={!selected || !code.trim() || Boolean(busy)}><Save size={16} />保存绑定</button>
      </form>
      <div className="scan-binding-list">{workspace.state.scanCodeBindings.map((item) => <div key={item.id}><QrCode size={17} /><span><strong>{targetName(data, item)}</strong><small>{item.code}</small></span><button className="icon-button" title="下载货品二维码" onClick={() => void downloadBindingQr(item, targetName(data, item))}><Download size={16} /></button></div>)}</div>
    </section>
    <section className="commercial-section"><SectionTitle icon={<PackagePlus size={18} />} title="扫码进货与批次成本" />
      <form className="commercial-form" onSubmit={receive}>
        <Field label="扫描货品二维码/条形码"><input autoFocus placeholder="扫码后自动识别货品" value={receivingScanCode} onChange={(event) => selectByScannedCode(event.target.value)} /></Field>
        <Field label="当前货品"><input disabled value={selected ? `${selected.name} · ${binding?.code ?? '未绑定码'}` : ''} /></Field>
        <Field label="供应商"><input required value={supplier} onChange={(event) => setSupplier(event.target.value)} /></Field>
        <Field label="供应商单号"><input value={supplierRef} onChange={(event) => setSupplierRef(event.target.value)} /></Field>
        <div className="commercial-field-pair"><Field label={`数量（${selected?.unit ?? 'unit'}）`}><input required type="number" min={countMode === 'integer' ? 1 : 0.01} step={countMode === 'integer' ? 1 : 0.01} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} /></Field><Field label="本批单价（元）"><input required type="number" min={0} step="0.01" value={unitCostYuan} onChange={(event) => setUnitCostYuan(event.target.value)} /></Field></div>
        <button className="primary-button" disabled={!selected || !supplier.trim() || Boolean(busy)}><PackagePlus size={16} />验收入库</button>
      </form>
      <div className="commercial-records">{workspace.state.procurementBatches.toReversed().slice(0, 12).map((item) => <div key={item.id}><span><strong>{targetName(data, item)}</strong><small>{item.supplierName} · {formatChinaDateTime(item.receivedAt, { second: undefined })}</small></span><b>{item.quantity} {item.unitCode}</b><em>{money(item.totalCostAmount)}</em></div>)}</div>
    </section>
  </div>
}

function PrintJobTools({
  data, workspace, filter, onFilterChange, canOperate, canConfig, busy, execute, onOpenConfig,
}: {
  data: BootstrapResponse
  workspace: CommercialOpsWorkspace
  filter: PrintJobFilter
  onFilterChange: (filter: PrintJobFilter) => void
  canOperate: boolean
  canConfig: boolean
  busy: string
  execute: Execute
  onOpenConfig: () => void
}) {
  const [expandedJobId, setExpandedJobId] = useState('')
  const [failureReasons, setFailureReasons] = useState<Record<string, string>>({})
  const jobs = workspace.state.printJobs.toSorted((left, right) => Date.parse(right.queuedAt) - Date.parse(left.queuedAt))
  const visibleJobs = filter === 'all' ? jobs : jobs.filter((job) => job.status === filter)
  const counts = {
    all: jobs.length,
    queued: jobs.filter((job) => job.status === 'queued').length,
    failed: jobs.filter((job) => job.status === 'failed').length,
    printed: jobs.filter((job) => job.status === 'printed').length,
  }

  function updateJob(job: PrintJob, status: 'queued' | 'printed' | 'failed', note: string, success: string) {
    void execute(`print-job:${job.id}:${status}`, success, () => commercialApi.reportPrintJobResult(job.id, { status, error: note }))
  }

  return <div className="commercial-content print-job-workspace">
    <section className="commercial-section">
      <header className="print-job-heading">
        <SectionTitle icon={<Printer size={18} />} title="打印任务处理" />
        {canConfig && <button type="button" className="secondary-button" onClick={onOpenConfig}><Settings2 size={16} />打印设置</button>}
      </header>
      <div className="print-job-filters" aria-label="打印任务筛选">
        {([
          ['all', '全部'], ['queued', '待打印'], ['failed', '失败'], ['printed', '已打印'],
        ] as const).map(([id, label]) => <button type="button" key={id} className={filter === id ? 'is-active' : ''} onClick={() => onFilterChange(id)}>{label}<b>{counts[id]}</b></button>)}
      </div>
      {visibleJobs.length === 0
        ? <div className="print-job-empty"><BadgeCheck size={22} /><strong>{filter === 'queued' ? '当前没有待打印任务' : filter === 'failed' ? '当前没有打印失败任务' : '当前筛选下没有任务'}</strong><span>切换上方状态可查看其他打印记录</span></div>
        : <div className="print-job-list">{visibleJobs.map((job) => {
          const order = data.orderDomain.orders.find((candidate) => candidate.id === job.orderId)
          const session = data.songState.tableSessions.find((candidate) => candidate.id === order?.tableSessionId)
          const route = workspace.state.config.printerRoutes.find((candidate) => candidate.id === job.routeId)
          const printer = workspace.state.config.printers.find((candidate) => candidate.id === job.printerId)
          const items = order?.items.filter((item) => job.orderItemIds.includes(item.id)) ?? []
          const expanded = expandedJobId === job.id
          const failureReason = failureReasons[job.id] ?? '打印机无响应'
          return <article key={job.id} className={`print-job-card is-${job.status}`}>
            <button type="button" className="print-job-summary" aria-expanded={expanded} aria-controls={`print-job-detail-${job.id}`} onClick={() => setExpandedJobId(expanded ? '' : job.id)}>
              <span className={`print-job-status is-${job.status}`}>{printJobStatus(job.status)}</span>
              <span className="print-job-primary"><strong>{session?.tableCode ?? '桌台待核对'} · {route?.name ?? '打印单'}</strong><small>{items.length > 0 ? items.map((item) => `${item.name} ×${item.quantity}`).join('、') : `订单 ${shortId(job.orderId)}`}</small></span>
              <span className="print-job-device"><strong>{printer?.name ?? '打印机未配置'}</strong><small>{formatChinaDateTime(job.queuedAt, { second: undefined })}</small></span>
              <ChevronDown size={18} />
            </button>
            {expanded && <div id={`print-job-detail-${job.id}`} className="print-job-detail">
              <dl>
                <div><dt>桌台</dt><dd>{session?.tableCode ?? '未关联当前桌台'}</dd></div>
                <div><dt>订单</dt><dd>{shortId(job.orderId)}</dd></div>
                <div><dt>打印路由</dt><dd>{route?.name ?? job.routeId}{route && !route.enabled ? '（已停用）' : ''}</dd></div>
                <div><dt>目标设备</dt><dd>{printer?.name ?? job.printerId}{printer && !printer.enabled ? '（已停用）' : ''}</dd></div>
                <div><dt>连接方式</dt><dd>{printerConnectionLabel(printer?.connectionMode)}{canConfig && printer?.endpointReference ? ` · ${printer.endpointReference}` : ''}</dd></div>
                <div><dt>尝试次数</dt><dd>{job.attempts}次</dd></div>
              </dl>
              <div className="print-job-items"><strong>本次打印内容</strong>{items.length > 0 ? items.map((item) => <div key={item.id}><span>{item.name}<small>{item.specification}</small></span><b>×{item.quantity}</b></div>) : <p>订单明细已归档，请凭订单号追溯。</p>}</div>
              {job.lastError && <div className="print-job-error"><CircleAlert size={17} /><span><strong>上次失败原因</strong>{job.lastError}</span></div>}
              {canOperate ? <div className="print-job-actions">
                {job.status === 'queued' && <>
                  <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => updateJob(job, 'printed', '员工确认打印单已正常输出', `${session?.tableCode ?? '该桌'}打印任务已完成`)}><BadgeCheck size={16} />确认已打印</button>
                  <label><span>故障原因</span><select value={failureReason} onChange={(event) => setFailureReasons((current) => ({ ...current, [job.id]: event.target.value }))}><option>打印机无响应</option><option>打印机离线</option><option>打印机缺纸</option><option>打印机卡纸</option><option>打印内容不完整</option></select></label>
                  <button type="button" className="danger-secondary-button" disabled={Boolean(busy)} onClick={() => updateJob(job, 'failed', failureReason, `${session?.tableCode ?? '该桌'}打印故障已登记`)}><CircleAlert size={16} />登记故障</button>
                </>}
                {job.status === 'failed' && <>
                  <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => updateJob(job, 'queued', '故障处理后由员工重新加入打印队列', `${session?.tableCode ?? '该桌'}任务已重新加入打印队列`)}><RotateCcw size={16} />重新加入队列</button>
                  <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => updateJob(job, 'printed', '员工确认故障后已人工补打', `${session?.tableCode ?? '该桌'}补打已确认完成`)}><BadgeCheck size={16} />确认已补打</button>
                </>}
                {job.status === 'printed' && <span className="print-job-complete"><BadgeCheck size={16} />任务已完成，无需继续操作</span>}
              </div> : <div className="print-job-readonly">当前岗位可查看详情；打印回执由吧台、厨房或管理人员处理。</div>}
            </div>}
          </article>
        })}</div>}
    </section>
  </div>
}

function PrintingTools({ data, config, busy, execute }: { data: BootstrapResponse; config: CommercialOpsConfig; busy: string; execute: Execute }) {
  const [draft, setDraft] = useState(() => structuredClone(config))
  const [reason, setReason] = useState('配置酒水与小吃双打印机分流')
  function submit(event: FormEvent) {
    event.preventDefault()
    void execute('printing', '打印机与酒水/小吃分流规则已发布', () => commercialApi.updateCommercialOpsConfig(configPayload(draft), reason))
  }
  return <form className="commercial-content" onSubmit={submit}>
    <section className="commercial-section"><SectionTitle icon={<Printer size={18} />} title="打印机设备" />
      <div className="printer-grid">{draft.printers.map((printer, index) => <div key={printer.id}><Field label="设备名称"><input value={printer.name} onChange={(event) => setDraft({ ...draft, printers: draft.printers.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })} /></Field><Field label="连接方式"><select value={printer.connectionMode} onChange={(event) => setDraft({ ...draft, printers: draft.printers.map((item, itemIndex) => itemIndex === index ? { ...item, connectionMode: event.target.value as typeof printer.connectionMode } : item) })}><option value="android_bridge">安卓打印桥</option><option value="network">网络打印机</option><option value="browser">浏览器打印</option></select></Field><Field label="设备地址/编号"><input placeholder="正式接硬件时填写IP或设备ID" value={printer.endpointReference} onChange={(event) => setDraft({ ...draft, printers: draft.printers.map((item, itemIndex) => itemIndex === index ? { ...item, endpointReference: event.target.value } : item) })} /></Field><label className="commercial-toggle"><input type="checkbox" checked={printer.enabled} onChange={(event) => setDraft({ ...draft, printers: draft.printers.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: event.target.checked } : item) })} />启用</label></div>)}</div>
    </section>
    <section className="commercial-section"><SectionTitle icon={<Settings2 size={18} />} title="出品分流" />
      <div className="route-list">{draft.printerRoutes.map((route, index) => <div key={route.id}><strong>{route.name}</strong><Field label="打印机"><select value={route.printerId} onChange={(event) => setDraft({ ...draft, printerRoutes: draft.printerRoutes.map((item, itemIndex) => itemIndex === index ? { ...item, printerId: event.target.value } : item) })}>{draft.printers.map((printer) => <option key={printer.id} value={printer.id}>{printer.name}</option>)}</select></Field><Field label="工作站"><select multiple value={route.stationIds} onChange={(event) => setDraft({ ...draft, printerRoutes: draft.printerRoutes.map((item, itemIndex) => itemIndex === index ? { ...item, stationIds: [...event.currentTarget.selectedOptions].map((option) => option.value) } : item) })}>{data.config.workstations.map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}</select></Field><Field label="份数"><input type="number" min={1} max={3} value={route.copies} onChange={(event) => setDraft({ ...draft, printerRoutes: draft.printerRoutes.map((item, itemIndex) => itemIndex === index ? { ...item, copies: Number(event.target.value) } : item) })} /></Field></div>)}</div>
      <div className="commercial-save-band"><Field label="发布原因"><input required minLength={2} value={reason} onChange={(event) => setReason(event.target.value)} /></Field><button className="primary-button" disabled={Boolean(busy)}><Save size={16} />发布分流配置</button></div>
    </section>
  </form>
}

function VoucherTools({ data, workspace, busy, execute }: ToolProps) {
  const [platform, setPlatform] = useState('大众点评/美团')
  const [campaign, setCampaign] = useState('门店团购券')
  const [code, setCode] = useState('')
  const [faceYuan, setFaceYuan] = useState('100')
  const [settlementYuan, setSettlementYuan] = useState('90')
  const [tableSessionId, setTableSessionId] = useState('')
  function submit(event: FormEvent) {
    event.preventDefault()
    void execute('voucher', '团购券核销成功，券码已脱敏留痕', async () => {
      await commercialApi.redeemGroupVoucher({ platform, campaignName: campaign, voucherCode: code.trim(), faceValueAmount: Math.round(Number(faceYuan) * 100), settlementAmount: Math.round(Number(settlementYuan) * 100), tableSessionId: tableSessionId || undefined, reason: '顾客现场出示并确认核销' })
      setCode('')
    })
  }
  return <div className="commercial-content commercial-two-column"><section className="commercial-section"><SectionTitle icon={<Gift size={18} />} title="现场团购券核销" /><form className="commercial-form" onSubmit={submit}><Field label="平台"><input value={platform} onChange={(event) => setPlatform(event.target.value)} /></Field><Field label="活动/券名"><input value={campaign} onChange={(event) => setCampaign(event.target.value)} /></Field><Field label="券码"><input required autoFocus value={code} onChange={(event) => setCode(event.target.value)} /></Field><div className="commercial-field-pair"><Field label="券面额（元）"><input type="number" min={0} value={faceYuan} onChange={(event) => setFaceYuan(event.target.value)} /></Field><Field label="平台结算（元）"><input type="number" min={0} value={settlementYuan} onChange={(event) => setSettlementYuan(event.target.value)} /></Field></div><Field label="关联桌次"><select value={tableSessionId} onChange={(event) => setTableSessionId(event.target.value)}><option value="">暂不关联</option>{data.songState.tableSessions.filter((item) => item.status === 'open').map((item) => <option key={item.id} value={item.id}>{item.tableCode}</option>)}</select></Field><button className="primary-button" disabled={!code.trim() || Boolean(busy)}><BadgeCheck size={16} />确认核销</button></form></section><section className="commercial-section"><SectionTitle icon={<Banknote size={18} />} title="最近核销" /><div className="commercial-records">{workspace.state.voucherRedemptions.toReversed().slice(0, 20).map((item) => <div key={item.id}><span><strong>{item.campaignName}</strong><small>{item.platform} · {item.voucherCodeMasked}</small></span><b>{money(item.faceValueAmount)}</b><em>{money(item.settlementAmount)}</em></div>)}</div></section></div>
}

function CustomerTools({ data, workspace, busy, execute }: ToolProps) {
  const [editing, setEditing] = useState<Record<string, string>>({})
  return <div className="commercial-content"><section className="commercial-section"><SectionTitle icon={<Tags size={18} />} title="顾客标签与消费分层" />
    <div className="customer-tag-list">{data.members.map((member) => <article key={member.id}><div><strong>{member.displayName}</strong><span>{member.level} · 到店{member.visitCount}次 · 累计{money(member.totalSpendAmount)}</span></div><div className="member-tags">{member.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><label><span>标签（逗号分隔）</span><input value={editing[member.id] ?? member.tags.join(',')} onChange={(event) => setEditing((current) => ({ ...current, [member.id]: event.target.value }))} /></label><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void execute(`tags:${member.id}`, `${member.displayName}的顾客标签已更新`, () => commercialApi.updateMemberTags(member.id, (editing[member.id] ?? member.tags.join(',')).split(/[,，]/).map((item) => item.trim()).filter(Boolean), '根据本次到店与消费表现更新标签'))}><Save size={15} />保存</button></article>)}</div>
    <div className="tag-dictionary"><strong>标签字典</strong>{workspace.state.customerTagDefinitions.filter((item) => item.enabled).map((item) => <span key={item.id} style={{ borderColor: item.color }}>{item.name}</span>)}</div>
  </section></div>
}

function SalesTools({ workspace }: { workspace: CommercialOpsWorkspace }) {
  return <div className="commercial-content"><section className="commercial-section"><SectionTitle icon={<BarChart3 size={18} />} title="服务员品类销售" /><div className="commercial-table-wrap"><table><thead><tr><th>员工</th><th>品类</th><th>订单</th><th>数量</th><th>销售额</th><th>成本</th><th>毛利</th></tr></thead><tbody>{workspace.salesByEmployeeCategory.map((row) => <tr key={`${row.employeeId}:${row.categoryId}`}><td>{row.employeeName}</td><td>{row.categoryName}</td><td>{row.orderCount}</td><td>{row.quantity}</td><td>{money(row.salesAmount)}</td><td>{money(row.costAmount)}</td><td>{money(row.grossProfitAmount)}</td></tr>)}</tbody></table></div></section></div>
}

function RuleTools({ config, busy, execute }: { config: CommercialOpsConfig; busy: string; execute: Execute }) {
  const [draft, setDraft] = useState(() => structuredClone(config))
  const [reason, setReason] = useState('更新防重复上单、库存损耗和打赏规则')
  function submit(event: FormEvent) { event.preventDefault(); void execute('rules', '经营规则已发布并立即对新业务生效', () => commercialApi.updateCommercialOpsConfig(configPayload(draft), reason)) }
  return <form className="commercial-content" onSubmit={submit}><section className="commercial-section"><SectionTitle icon={<Settings2 size={18} />} title="订单、库存与互动规则" /><div className="rule-grid"><label className="commercial-toggle"><input type="checkbox" checked={draft.orderSafety.enabled} onChange={(event) => setDraft({ ...draft, orderSafety: { ...draft.orderSafety, enabled: event.target.checked } })} />防重复上单</label><Field label="相同订单复核（秒）"><input type="number" min={5} max={300} value={draft.orderSafety.duplicateWindowSeconds} onChange={(event) => setDraft({ ...draft, orderSafety: { ...draft.orderSafety, duplicateWindowSeconds: Number(event.target.value) } })} /></Field><Field label="每桌每分钟上限"><input type="number" min={1} max={20} value={draft.orderSafety.maxOrdersPerMinute} onChange={(event) => setDraft({ ...draft, orderSafety: { ...draft.orderSafety, maxOrdersPerMinute: Number(event.target.value) } })} /></Field><Field label="鸡尾酒合理损耗（%）"><input type="number" min={0} max={50} step={0.1} value={draft.inventoryControl.cocktailAllowedLossBps / 100} onChange={(event) => setDraft({ ...draft, inventoryControl: { ...draft.inventoryControl, cocktailAllowedLossBps: Math.round(Number(event.target.value) * 100) } })} /></Field><Field label="小吃盘点"><select value={draft.inventoryControl.snackCountMode} onChange={(event) => setDraft({ ...draft, inventoryControl: { ...draft.inventoryControl, snackCountMode: event.target.value as 'integer' | 'decimal' } })}><option value="integer">只计整数</option><option value="decimal">允许小数</option></select></Field><label className="commercial-toggle"><input type="checkbox" checked={draft.tipping.enabled} onChange={(event) => setDraft({ ...draft, tipping: { ...draft.tipping, enabled: event.target.checked } })} />线上打赏</label></div><div className="commercial-save-band"><Field label="发布原因"><input required minLength={2} value={reason} onChange={(event) => setReason(event.target.value)} /></Field><button className="primary-button" disabled={Boolean(busy)}><Save size={16} />发布经营规则</button></div></section></form>
}

interface ToolProps { data: BootstrapResponse; workspace: CommercialOpsWorkspace; busy: string; execute: Execute }
type Execute = (key: string, success: string, action: () => Promise<unknown>) => void

function Metric({ icon, value, label, warning = false, onClick }: { icon: ReactNode; value: number | string; label: string; warning?: boolean; onClick?: () => void }) {
  const content = <>{icon}<strong>{value}</strong><span>{label}</span>{onClick && <ChevronRight className="metric-chevron" size={17} />}</>
  return onClick
    ? <button type="button" className={warning ? 'is-warning is-actionable' : 'is-actionable'} aria-label={`${label}${value}，查看详情`} onClick={onClick}>{content}</button>
    : <div className={warning ? 'is-warning' : ''}>{content}</div>
}
function Capability({ title, value }: { title: string; value: string }) { return <div><span>{title}</span><strong>{value}</strong></div> }
function SectionTitle({ icon, title }: { icon: ReactNode; title: string }) { return <header className="commercial-section-title">{icon}<strong>{title}</strong></header> }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="commercial-field"><span>{label}</span>{children}</label> }
function money(amount: number) { return `¥${(amount / 100).toFixed(2)}` }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : '经营工具操作失败' }
function shortId(id: string) { return id.length > 12 ? id.slice(-12) : id }
function printJobStatus(status: PrintJob['status']) { return status === 'queued' ? '待打印' : status === 'failed' ? '打印失败' : '已打印' }
function printerConnectionLabel(mode?: CommercialOpsConfig['printers'][number]['connectionMode']) { return mode === 'network' ? '网络打印机' : mode === 'android_bridge' ? '安卓打印桥' : mode === 'browser' ? '浏览器打印' : '连接方式未配置' }
function targetName(data: BootstrapResponse, item: { targetType: 'product' | 'ingredient'; targetId: string }) { return item.targetType === 'product' ? data.products.find((product) => product.id === item.targetId)?.name ?? item.targetId : data.inventoryDomain?.ingredientSkus.find((ingredient) => ingredient.id === item.targetId)?.name ?? item.targetId }
function configPayload(config: CommercialOpsConfig) { const { version: _version, updatedAt: _updatedAt, updatedBy: _updatedBy, ...payload } = config; return payload }

async function downloadBindingQr(binding: ScanCodeBinding, name: string) {
  const dataUrl = await QRCode.toDataURL(binding.code, { width: 900, margin: 2, errorCorrectionLevel: 'H' })
  const anchor = document.createElement('a')
  anchor.href = dataUrl
  anchor.download = `${name}-${binding.code}-货品码.png`
  anchor.click()
}
