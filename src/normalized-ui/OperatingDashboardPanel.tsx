import { useEffect, useRef, useState } from 'react'
import { NormalizedApiError, type NormalizedApiClient, type StaffAuthView } from '../normalized-api'
import type { StaffBootstrapView } from '../shared/normalized-contracts'
import type { OperatingDashboardBreakdown, OperatingDashboardSourceQuery, OperatingDashboardTrend } from '../shared/operating-dashboard'
import { EmployeeSalesSummary } from './EmployeeSalesSummary'
import { employeeSales, type EmployeeSalesView } from './employee-sales-presentation'
import { OwnerFinancePanel } from './OwnerFinancePanel'
import { StaffTodoPanel } from './StaffTodoPanel'
import { OperatingDashboardPrintButton } from './OperatingDashboardPrintButton'
import { useStaffViewState } from './staff-view-state'
import { dashboardMoney, dashboardRange, operatingDashboardPath, readDashboardReport, type DashboardReport, type DashboardSelection, type DashboardPeriod } from './operating-dashboard-presentation'
import './operating-dashboard-panel.css'

export function OperatingDashboardPanel({ api, auth, revision = 0, onNavigate, onLoginRequired }: { api: NormalizedApiClient; auth: StaffAuthView; revision?: number; onNavigate?(route: string): void; onLoginRequired(): void }) {
  const [selection, setSelection] = useStaffViewState<DashboardSelection>('operations:period', { period: 'day', anchor: '' })
  const [requestedSource, setSource] = useStaffViewState<OperatingDashboardSourceQuery>('operations:source', {})
  const [reportState, setReportState] = useState<{ key: string; authKey: string; value: DashboardReport } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [reload, setReload] = useState(0)
  const [bootstrapState, setBootstrapState] = useState<{ authKey: string; value: StaffBootstrapView } | null>(null)
  const [bootstrapError, setBootstrapError] = useState('')
  const [sales, setSales] = useState<{ key: string; rows: EmployeeSalesView[] } | null>(null)
  const [salesError, setSalesError] = useState('')
  const [salesReload, setSalesReload] = useState(0)
  const login = useRef(onLoginRequired); login.current = onLoginRequired
  const canProfit = auth.permissions.includes('commercial.profit.view')
  const canReadCost = auth.permissions.includes('commercial.cost.view')
  const source = !canReadCost && requestedSource.kind === 'cost' ? {} : requestedSource
  const canSales = auth.permissions.some(p => ['commercial.sales.view', 'commercial.sales.view_all'].includes(p))
  const canFinance = auth.permissions.some(p => ['commercial.cost.view', 'commercial.cost.manage', 'commercial.payroll.view', 'commercial.payroll.manage', 'commercial.payroll.post'].includes(p))
  const authKey = `${auth.session.id}:${auth.employee.id}:${auth.permissions.join(',')}`
  const bootstrap = bootstrapState?.authKey === authKey ? bootstrapState.value : null
  const key = operatingDashboardPath(selection, source)
  const report = canProfit && reportState?.key === key && reportState.authKey === authKey ? reportState.value : null
  const current = report?.currentBusinessDate ?? bootstrap?.businessDay.date ?? ''
  const range = dashboardRange(selection, current)
  const rangeKey = range ? `${range.start}:${range.end}` : ''
  useEffect(() => {
    let active = true; setBootstrapError('')
    void api.getStaffBootstrap().then(result => { if (active && result.data?.staff.id === auth.employee.id) setBootstrapState({ authKey, value: result.data }) })
      .catch(reason => { if (!active) return; if (reason instanceof NormalizedApiError && reason.recovery === 'login') login.current(); setBootstrapError('当前营业日或待办入口暂未读取，请刷新核对。') })
    return () => { active = false }
  }, [api, authKey, auth.employee.id, revision, reload])
  useEffect(() => {
    const controller = new AbortController(); setError('')
    if (!canProfit) { setReportState(null); setLoading(false); return }
    setLoading(true)
    void api.getEndpoint<{ data: unknown }>(key, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setReportState({ key, authKey, value: readDashboardReport(result.data) })
    }).catch(reason => {
      if (controller.signal.aborted) return
      if (reason instanceof NormalizedApiError && reason.recovery === 'login') login.current()
      if (reason instanceof NormalizedApiError && reason.status === 403) setReportState(null)
      setError(reason instanceof Error ? reason.message : '经营数据暂未读取，请重试')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [api, authKey, canProfit, key, revision, reload])
  useEffect(() => {
    const controller = new AbortController(); setSalesError('')
    if (!canSales || !rangeKey) { setSales(null); return }
    setSales(null)
    void api.getEndpoint<{ data: unknown }>(`/api/commercial-ops/employee-sales?startDate=${range!.start}&endDate=${range!.end}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setSales({ key: rangeKey, rows: employeeSales(result.data) }) })
      .catch(reason => { if (!controller.signal.aborted) { if (reason instanceof NormalizedApiError && reason.recovery === 'login') login.current(); setSalesError(reason instanceof Error ? reason.message : '销售归属暂未读取') } })
    return () => controller.abort()
  }, [api, authKey, canSales, rangeKey, range?.start, range?.end, revision, reload, salesReload])
  function choose(next: DashboardSelection) { setSelection(next); setSource({}) }
  const anchor = selection.anchor || current
  const [yearInput, setYearInput] = useState(anchor.slice(0, 4))
  useEffect(() => setYearInput(anchor.slice(0, 4)), [anchor])
  function choosePeriod(period: DashboardPeriod) { choose({ period, anchor: selection.anchor }) }
  return <div className="operating-dashboard">
    <section aria-label="经营期间" className="operating-period">
      <div role="group" aria-label="当前期间快捷选择">{(['day', 'month', 'year'] as const).map((period, i) => <button type="button" key={period} aria-pressed={selection.period === period && !selection.anchor} onClick={() => choose({ period, anchor: '' })}>{['今日', '本月', '本年'][i]}</button>)}</div>
      <label>查询粒度<select value={selection.period} onChange={event => choosePeriod(event.target.value as DashboardPeriod)}><option value="day">按日</option><option value="month">按月</option><option value="year">按年</option></select></label>
      <label>{selection.period === 'day' ? '指定营业日' : selection.period === 'month' ? '指定月份' : '指定年份'}<input aria-label="经营期间选择" type={selection.period === 'day' ? 'date' : selection.period === 'month' ? 'month' : 'number'} value={selection.period === 'year' ? yearInput : selection.period === 'month' ? anchor.slice(0, 7) : anchor} max={selection.period === 'year' ? current.slice(0, 4) : selection.period === 'month' ? current.slice(0, 7) : current} min={selection.period === 'year' ? '2000' : undefined} onChange={event => {
        const value = event.target.value
        if (selection.period === 'year') { setYearInput(value); if (!/^\d{4}$/.test(value)) return }
        if (value) choose({ period: selection.period, anchor: selection.period === 'year' ? `${value}-01-01` : selection.period === 'month' ? `${value}-01` : value })
      }} /></label>
      <button type="button" onClick={() => setReload(value => value + 1)} disabled={loading}>刷新经营数据</button>
      {range && <p>所选营业日：{range.start} 至 {range.end}{range.end === current ? ' · 截至本次查询' : ''}。跨夜按门店营业日规则归属。</p>}
      {bootstrapError && <p role="alert">{bootstrapError}</p>}
    </section>
    {canProfit ? <section aria-label="老板经营仪表盘">
      {loading && <p role="status">正在读取所选期间…{report ? `当前仍是 ${report.asOf} 的结果。` : ''}</p>}
      {error && <p role="alert">{error}。{report ? `保留 ${report.range.startDate} 至 ${report.effectiveEndDate}、${report.asOf} 的上次结果，尚未更新。` : '当前不能确认金额，不按零计算。'}<button type="button" onClick={() => setReload(value => value + 1)}>重新读取经营数据</button></p>}
      {report && <>
        <OperatingDashboardSummary report={report} />
        <section aria-label="收入与成本趋势"><h2>{selection.period === 'year' ? '每月' : '每日'}收入与成本</h2>{selection.period === 'day' ? <p>单日查看上方汇总和下方来源明细。</p> : <><OperatingTrend rows={report.trend}/><details><summary>查看各期间准确金额</summary><div className="operating-table-wrap"><table><thead><tr><th>期间</th><th>经营收入</th><th>经营成本</th><th>实际净收</th></tr></thead><tbody>{report.trend.map(row => <tr key={row.businessDate}><th>{row.label}{row.provisional ? ' · 暂估' : ''}</th><td>{dashboardMoney(row.incomeMinor)}</td><td>{dashboardMoney(row.costMinor)}</td><td>{dashboardMoney(row.actualNetReceiptsMinor)}</td></tr>)}</tbody></table></div></details></>}</section>
        <div className="operating-breakdowns"><Breakdown title="收入分类" rows={report.incomeBreakdown} onChoose={category => setSource({ kind: 'income', category })}/><Breakdown title="成本分类" rows={report.costBreakdown} onChoose={canReadCost ? category => setSource({ kind: 'cost', category }) : undefined}/></div>
        <section aria-label="经营来源明细"><h2>来源明细</h2><div className="operating-source-controls"><label>来源类型<select value={source.kind ?? ''} onChange={event => setSource(event.target.value ? { kind: event.target.value as NonNullable<OperatingDashboardSourceQuery['kind']> } : {})}><option value="">全部类型</option><option value="income">经营收入</option>{canReadCost && <option value="cost">经营成本</option>}<option value="receipt">实际收款</option><option value="refund">成功退款</option><option value="outstanding">本期待收</option></select></label>{source.category && <button type="button" onClick={() => setSource({ kind: source.kind })}>清除分类筛选</button>}</div>
          <p>共 {report.sources.total} 条来源，当前第 {report.sources.page + 1} 页；汇总包含完整授权范围，不只计算本页。</p>
          {report.sources.rows.length === 0 ? <p>所选来源范围暂无记录。</p> : <div className="operating-table-wrap"><table><thead><tr><th>来源</th><th>归属营业日</th><th>本期金额</th><th>原始金额 / 核对说明</th></tr></thead><tbody>{report.sources.rows.map(row => <tr key={`${row.kind}:${row.id}`}><td>{row.label}<small>{row.publicId}</small></td><td>{row.businessDate ?? '归属待核对'}</td><td>{dashboardMoney(row.amountMinor)}</td><td>{row.originalAmountMinor === undefined ? '—' : dashboardMoney(row.originalAmountMinor)}{row.missingCount > 0 ? ` · ${row.missingCount} 项待补充` : ''}</td></tr>)}</tbody></table></div>}
          <div className="operating-source-controls"><button type="button" disabled={loading || report.sources.page === 0} onClick={() => setSource({ ...source, page: report.sources.page - 1 })}>上一页来源</button><button type="button" disabled={loading || !report.sources.hasMore} onClick={() => setSource({ ...source, page: report.sources.page + 1 })}>下一页来源</button></div>
        </section>
      </>}
      {auth.permissions.includes('order.bill.print') && bootstrap?.store.id && anchor && <OperatingDashboardPrintButton api={api} period={selection.period} anchor={anchor} reportAsOf={report?.asOf ?? '当前尚未读取'} employeeId={auth.employee.id} scopeKey={bootstrap.store.id} allowNew={!loading && !error && report?.printAccess?.allowed === true} blockedReason={loading || error || !report ? '所选期间尚未成功读取，暂不能生成新票据。' : report.printAccess?.reason ?? '打印权限尚未核对，请刷新经营数据。'}/>}
    </section> : <p>当前账号没有全店经营利润查看权限；下方仅显示已授权的费用或销售内容。</p>}
    {canSales && <section aria-label="员工销售归属"><h2>员工销售归属</h2><p>仅显示当前账号授权范围，期间与上方选择一致。</p>{salesError ? <p role="alert">{salesError}<button type="button" onClick={() => setSalesReload(value => value + 1)}>重新读取销售归属</button></p> : sales?.key === rangeKey ? <EmployeeSalesSummary sales={sales.rows}/> : <p role="status">正在读取所选期间销售归属…</p>}</section>}
    {canFinance && range && <OwnerFinancePanel api={api} auth={auth} reportRange={range}/>}
    <section aria-label="当前待处理"><h2>当前待处理 · 截至现在</h2><p>以下事项不受上方历史期间筛选。处理后返回保留原期间，重新核对最新结果。</p>{report && <p>目前全部有效未收款：<strong>{dashboardMoney(report.dashboard.currentAllOutstandingMinor)}</strong>，包含历史遗留；查询时间 {report.asOf}。</p>}{bootstrap && <StaffTodoPanel api={api} bootstrap={bootstrap} onNavigate={onNavigate} onLoginRequired={onLoginRequired}/>}</section>
  </div>
}
export function OperatingDashboardSummary({ report }: { report: DashboardReport }) {
  const d = report.dashboard
  const provisional = report.status === 'provisional' || report.knownMissingCostCount > 0 || report.unassignedIncomeCount > 0
  const metrics = [['经营收入（按订单归属）', d.incomeMinor], ['总经营成本', d.totalCostMinor], [d.operatingProfitMinor < 0 ? '经营亏损' : d.operatingProfitMinor > 0 ? '经营盈利' : '经营持平', d.operatingProfitMinor], ['实际净收', d.actualNetReceiptsMinor], ['成功退款', d.successfulRefundsMinor], ['本期待收款', d.periodOutstandingMinor]] as const
  return <><p>{report.range.startDate} 至 {report.effectiveEndDate} · 更新于 {report.asOf} · {provisional ? '已知部分暂估' : '按已入账数据计算'}，不代表财务已关账。</p><p>覆盖：{report.coverage.join('、')}。</p>{(report.knownMissingCostCount > 0 || report.unassignedIncomeCount > 0) && <p role="status">已识别 {report.knownMissingCostCount} 项成本缺失、{report.unassignedIncomeCount} 项收入归属待核对；相关汇总为已知部分，未知金额未当零。请由有权财务人员核查。</p>}<div className="operating-metrics">{metrics.map(([label, amount]) => <article key={label}><small>{label}{provisional && ['总经营成本', '经营亏损', '经营盈利', '经营持平'].includes(label) ? ' · 暂估' : ''}</small><strong className={amount < 0 ? 'is-negative' : ''}>{dashboardMoney(amount)}</strong></article>)}</div><p>本期实际收款 {dashboardMoney(d.actualReceiptsMinor)} − 成功退款 {dashboardMoney(d.successfulRefundsMinor)} ＝ 实际净收 {dashboardMoney(d.actualNetReceiptsMinor)}；不等于银行到账或余额。</p><p>有效订单 {d.validOrderCount} 笔 · 已支付订单 {d.paidOrderCount} 笔；按原购买去重。经营利润率：{d.incomeMinor > 0 ? `${(d.operatingProfitMinor / d.incomeMinor * 100).toFixed(2)}%${provisional ? '（暂估）' : ''}` : '—（收入为零或负数）'}。</p><p>本期待收为本期产生、截至本次查询仍未收回的有效应收；后续收款会改变这一数值。</p>{report.caveats?.map(note => <p key={note}>{note}</p>)}</>
}
function Breakdown({ title, rows, onChoose }: { title: string; rows: OperatingDashboardBreakdown[]; onChoose?(code: string): void }) { return <section aria-label={title}><h2>{title}</h2>{rows.length ? rows.map(row => <button type="button" key={row.code} disabled={!onChoose} onClick={() => onChoose?.(row.code)}><span>{row.label}{row.missingCount ? ` · ${row.missingCount} 项待补充` : ''}</span><strong>{dashboardMoney(row.amountMinor)}</strong><small>{onChoose ? `查看 ${row.count} 条来源` : '当前仅可查看汇总；费用明细需对应权限'}</small></button>) : <p>本期暂无此类已入账记录。</p>}</section> }

export function OperatingTrend({ rows }: { rows: OperatingDashboardTrend[] }) {
  if (rows.length === 0) return <p>所选期间暂无趋势记录。</p>
  const values = rows.flatMap(row => [row.incomeMinor, row.costMinor])
  const maximum = Math.max(0, ...values), minimum = Math.min(0, ...values)
  const span = maximum - minimum || 1
  const x = (index: number) => 82 + index / Math.max(1, rows.length - 1) * 530
  const y = (amount: number) => 16 + (maximum - amount) / span * 140
  const points = (field: 'incomeMinor' | 'costMinor') => rows.map((row, index) => `${x(index)},${y(row[field])}`).join(' ')
  return <div className="operating-trend"><p><span className="trend-income">实线：经营收入</span> · <span className="trend-cost">虚线：经营成本</span>{rows.some(row => row.provisional) ? '；缺项期间为已知部分暂估。' : ''}</p><svg viewBox="0 0 640 190" role="img" aria-label="所选期间收入与成本趋势，含零值基线；准确金额可展开下表核对">
    <line x1="80" x2="614" y1={y(0)} y2={y(0)} stroke="currentColor"/>
    <text x="2" y="22" fill="currentColor">{dashboardMoney(maximum)}</text><text x="2" y="155" fill="currentColor">{dashboardMoney(minimum)}</text>
    <polyline className="trend-income" points={points('incomeMinor')} fill="none" stroke="currentColor" strokeWidth="2.5"/>
    <polyline className="trend-cost" points={points('costMinor')} fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="6 4"/>
    {rows.length === 1 && <><circle className="trend-income" cx={x(0)} cy={y(rows[0].incomeMinor)} r="3" fill="currentColor"/><circle className="trend-cost" cx={x(0)} cy={y(rows[0].costMinor)} r="3" fill="currentColor"/></>}
    <text x="82" y="183" fill="currentColor">{rows[0].label}</text><text x="612" y="183" textAnchor="end" fill="currentColor">{rows[rows.length - 1].label}</text>
  </svg></div>
}
