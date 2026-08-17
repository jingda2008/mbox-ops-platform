import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import './customer-experience-analytics-panel.css'

interface RecommendationRow {
  productId: string; productName: string; currency: string
  generated: number; exposed: number; selected: number; ignored: number; rejected: number; staffModified: number
  ordered: number; paid: number; refunded: number
  paidAmountMinor: number; refundedAmountMinor: number
  frozenCostMinor: number | null; contributionAmountMinor: number | null
  complaintOrderCount: number; followOnPaidOrderCount: number; repeatPurchaseOrderCount: number
}

interface ProductRow {
  productId: string; productName: string; paidOrderCount: number; soldQuantity: number
  paidRevenueMinor: number; refundedAmountMinor: number; frozenCostMinor: number | null
  contributionAmountMinor: number | null
  observationCount: number; praiseCount: number; complaintCount: number
  remainingCount: number; servedLateCount: number; correctedCount: number
  averageObservationConfidence: number | null
}

interface Suggestion {
  productId: string; productName: string; kind: string; recommendation: string
  sampleSize: number; supportingEvidence: number; opposingEvidence: number
  confidence: number; confidenceBasis: string
}

interface AnalyticsView {
  recommendation: RecommendationRow[]
  products: ProductRow[]
  dataQuality: {
    totalInputs: number; confirmedInputs: number; unmatchedInputs: number; correctedEvents: number
    unmatchedRate: number; correctionRate: number
    missingFacts: {
      recommendationWithoutExposureCount: number
      paidRecommendationCostUnavailableCount: number
      complaintWithoutOrderLinkCount: number
    }
    staff: Array<{
      employeeId: string; employeeName: string; inputCount: number; confirmedCount: number
      unmatchedInputCount: number; correctedEventCount: number
      positiveEventCount: number; neutralEventCount: number; negativeEventCount: number
    }>
  }
  weeklySuggestions: Suggestion[]
  packageOptions: Array<{ productId: string; productName: string }>
  filterCapabilities: {
    occasion: { available: true; basis: string }
    package: { available: true; basis: string }
    customerSegment: { available: false; reason: string; requiredFact: string }
  }
  generatedAt: string
  decisionBoundary: string
}

interface ObservationEvidence {
  eventId: string; tableCode: string; productName: string | null; employeeName: string
  performancePhase: string | null; expressionKind: string; eventType: string; degree: string | null
  rawExcerpt: string; confidence: number; revisionNo: number; corrected: boolean; occurredAt: string
}

interface AnalyticsFilters {
  productId: string
  packageProductId: string
  employeeId: string
  partySize: string
  occasion: string
  performancePhase: string
  tableCode: string
  recommendationOutcome: string
}

const EMPTY_FILTERS: AnalyticsFilters = {
  productId: '', packageProductId: '', employeeId: '', partySize: '', occasion: '', performancePhase: '', tableCode: '',
  recommendationOutcome: 'all',
}

export function CustomerExperienceAnalyticsPanel({ api, auth }: {
  api: NormalizedApiClient
  auth: StaffAuthView
}) {
  const allowed = auth.permissions.includes('recommendation.analytics.view')
    && auth.permissions.includes('product.observation.analytics.view')
  const canViewRaw = auth.permissions.includes('observation.view.raw')
  const [days, setDays] = useState('7')
  const [draftFilters, setDraftFilters] = useState<AnalyticsFilters>(EMPTY_FILTERS)
  const [appliedFilters, setAppliedFilters] = useState<AnalyticsFilters>(EMPTY_FILTERS)
  const [productOptions, setProductOptions] = useState<Array<{ id: string; name: string }>>([])
  const [employeeOptions, setEmployeeOptions] = useState<Array<{ id: string; name: string }>>([])
  const [view, setView] = useState<AnalyticsView | null>(null)
  const [evidence, setEvidence] = useState<ObservationEvidence[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const range = useMemo(() => {
    const until = new Date()
    const from = new Date(until.getTime()-Number(days)*24*60*60*1000)
    return { from: from.toISOString(), until: until.toISOString() }
  }, [days])

  async function load() {
    if (!allowed || busy) return
    setBusy(true); setNotice('')
    try {
      const queryParams = new URLSearchParams(range)
      for (const [key,value] of Object.entries(appliedFilters)) if (value) queryParams.set(key,value)
      const query = queryParams.toString()
      const [response,evidenceResponse] = await Promise.all([
        api.getEndpoint<{ data: AnalyticsView }>(`/api/staff/customer-experience/analytics?${query}`),
        canViewRaw ? api.getEndpoint<{ data: ObservationEvidence[] }>(
          `/api/staff/customer-experience/analytics/observations?${query}&limit=50`,
        ) : Promise.resolve({ data: [] }),
      ])
      setView(response.data)
      setEvidence(evidenceResponse.data)
      setProductOptions((current) => mergeOptions(current,[
        ...response.data.products.map((item) => ({ id: item.productId,name: item.productName })),
        ...response.data.recommendation.map((item) => ({ id: item.productId,name: item.productName })),
      ]))
      setEmployeeOptions((current) => mergeOptions(current,response.data.dataQuality.staff.map((item) => ({
        id: item.employeeId,name: item.employeeName,
      }))))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '经营分析暂时无法读取')
    } finally { setBusy(false) }
  }

  useEffect(() => { void load() }, [allowed, days, canViewRaw, appliedFilters]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!allowed) return null
  return <section className="ce-analytics" aria-labelledby="ce-analytics-title">
    <header className="ce-analytics__header">
      <div>
        <p className="ce-analytics__eyebrow">客户体验与商品观察</p>
        <h2 id="ce-analytics-title">经营分析</h2>
        <p>按权威订单、退款、冻结成本和已确认观察计算，不用展示快照推断金额。</p>
      </div>
      <div className="ce-analytics__actions">
        <label>观察周期
          <select value={days} onChange={(event) => setDays(event.target.value)}>
            <option value="7">最近7天</option><option value="28">最近28天</option><option value="84">最近84天</option>
          </select>
        </label>
        <button type="button" onClick={() => void load()} disabled={busy}>{busy ? '读取中' : '刷新'}</button>
      </div>
    </header>
    <form className="ce-analytics__filters" onSubmit={(event) => {
      event.preventDefault(); setAppliedFilters({ ...draftFilters })
    }}>
      <label>商品
        <select value={draftFilters.productId} onChange={(event) => setDraftFilters({ ...draftFilters,productId:event.target.value })}>
          <option value="">全部商品</option>
          {productOptions.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label>套餐（强订单行）
        <select value={draftFilters.packageProductId} onChange={(event) => setDraftFilters({
          ...draftFilters,packageProductId:event.target.value,
        })}>
          <option value="">全部套餐</option>
          {(view?.packageOptions ?? []).map((item) => (
            <option value={item.productId} key={item.productId}>{item.productName}</option>
          ))}
        </select>
      </label>
      <label>记录员工（仅观察）
        <select value={draftFilters.employeeId} onChange={(event) => setDraftFilters({ ...draftFilters,employeeId:event.target.value })}>
          <option value="">全部员工</option>
          {employeeOptions.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label>桌号
        <input value={draftFilters.tableCode} maxLength={32} pattern="[A-Za-z0-9_-]+"
          onChange={(event) => setDraftFilters({ ...draftFilters,tableCode:event.target.value })} placeholder="如 A08" />
      </label>
      <label>人数
        <input type="number" min="1" max="100" inputMode="numeric" value={draftFilters.partySize}
          onChange={(event) => setDraftFilters({ ...draftFilters,partySize:event.target.value })} placeholder="全部" />
      </label>
      <label>来店场景（同桌事实）
        <select value={draftFilters.occasion}
          onChange={(event) => setDraftFilters({ ...draftFilters,occasion:event.target.value })}>
          <option value="">全部场景</option><option value="business">商务</option><option value="friends">朋友聚会</option>
          <option value="date">约会</option><option value="birthday">生日</option><option value="music">音乐</option>
          <option value="relax">放松</option><option value="other">其他</option>
        </select>
      </label>
      <label>客群（暂不可用）
        <select value="" disabled aria-describedby="ce-analytics-segment-boundary">
          <option value="">缺事件时点分群事实</option>
        </select>
      </label>
      <label>演出阶段
        <select value={draftFilters.performancePhase} onChange={(event) => setDraftFilters({ ...draftFilters,performancePhase:event.target.value })}>
          <option value="">全部阶段</option><option value="before_show">演出前</option><option value="acoustic">弹唱</option>
          <option value="band_live">乐队现场</option><option value="intermission">中场</option><option value="after_show">演出后</option>
        </select>
      </label>
      <label>推荐结果（仅推荐）
        <select value={draftFilters.recommendationOutcome} onChange={(event) => setDraftFilters({
          ...draftFilters,recommendationOutcome:event.target.value,
        })}>
          <option value="all">全部结果</option><option value="paid">已付款</option>
          <option value="refunded">已退款</option><option value="complaint">有订单投诉</option>
          <option value="follow_on_order">同桌后续付款</option><option value="repeat_purchase">后续同品复购</option>
          <option value="margin_unavailable">贡献金额缺成本</option>
        </select>
      </label>
      <div className="ce-analytics__filter-actions">
        <button type="submit" disabled={busy}>应用筛选</button>
        <button type="button" className="ce-analytics__secondary" onClick={() => {
          setDraftFilters(EMPTY_FILTERS); setAppliedFilters(EMPTY_FILTERS)
        }} disabled={busy}>清除</button>
      </div>
    </form>
    {notice ? <p className="ce-analytics__notice" role="status">{notice}</p> : null}
    {view ? <>
      <p className="ce-analytics__boundary">{view.decisionBoundary}</p>
      <div className="ce-analytics__filter-boundary" id="ce-analytics-segment-boundary">
        <p><strong>场景口径：</strong>{view.filterCapabilities.occasion.basis}</p>
        <p><strong>套餐口径：</strong>{view.filterCapabilities.package.basis}</p>
        <p><strong>客群暂不可筛：</strong>{view.filterCapabilities.customerSegment.reason}</p>
      </div>
      <div className="ce-analytics__metrics" aria-label="数据质量摘要">
        <Metric label="已确认记录" value={view.dataQuality.confirmedInputs} helper={`共录入 ${view.dataQuality.totalInputs} 条`} />
        <Metric label="未匹配比例" value={percent(view.dataQuality.unmatchedRate)} helper={`${view.dataQuality.unmatchedInputs} 条需继续核对`} />
        <Metric label="员工修订比例" value={percent(view.dataQuality.correctionRate)} helper={`${view.dataQuality.correctedEvents} 次追加修订`} />
      </div>
      <div className="ce-analytics__quality-gaps" aria-label="推荐归因数据缺口">
        <Metric label="推荐未记录展示" value={view.dataQuality.missingFacts.recommendationWithoutExposureCount}
          helper="无法计算真实选择率" />
        <Metric label="实付推荐缺冻结成本" value={view.dataQuality.missingFacts.paidRecommendationCostUnavailableCount}
          helper="不计算销售后贡献" />
        <Metric label="投诉未关联本人订单" value={view.dataQuality.missingFacts.complaintWithoutOrderLinkCount}
          helper="不归因到推荐商品" />
      </div>
      <AnalyticsSection title="本周建议" empty="当前样本不足，不生成经营建议。" hasData={view.weeklySuggestions.length>0}>
        <div className="ce-analytics__suggestions">
          {view.weeklySuggestions.map((item) => <article className="ce-analytics__suggestion" key={`${item.productId}:${item.kind}`}>
            <div><strong>{item.productName}</strong><span>{suggestionLabel(item.kind)}</span></div>
            <p>{item.recommendation}</p>
            <small>样本 {item.sampleSize} · 支持 {item.supportingEvidence} · 相反 {item.opposingEvidence} · 置信度 {percent(item.confidence)}</small>
          </article>)}
        </div>
      </AnalyticsSection>
      <AnalyticsSection title="推荐效果" empty="所选周期内暂无推荐数据。" hasData={view.recommendation.length>0}>
        <p className="ce-analytics__fact-note">
          “同桌后续付款”和“后续同品复购”只是订单事实，不代表由本次推荐造成；只有明确关联本人订单的投诉才计入。
        </p>
        <div className="ce-analytics__table-wrap"><table className="ce-analytics__recommendation-table"><thead><tr>
          <th>方案</th><th>展示</th><th>选择率</th><th>移除/拒绝</th><th>员工调整</th><th>成交率</th>
          <th>实付</th><th>销售后贡献</th><th>退款</th><th>订单投诉</th><th>同桌后续付款</th><th>后续同品复购</th>
        </tr></thead><tbody>{view.recommendation.map((row) => <tr key={row.productId}>
          <th>{row.productName}</th><td>{row.exposed}</td><td>{row.selected} · {percent(ratioOf(row.selected,row.exposed))}</td>
          <td>{row.ignored}/{row.rejected}</td><td>{row.staffModified}</td>
          <td>{row.ordered} · {percent(ratioOf(row.ordered,row.selected))}</td>
          <td>{money(row.paidAmountMinor,row.currency)}</td>
          <td>{row.contributionAmountMinor===null ? '数据不足' : money(row.contributionAmountMinor,row.currency)}</td>
          <td>{money(row.refundedAmountMinor,row.currency)}</td><td>{row.complaintOrderCount}</td>
          <td>{row.followOnPaidOrderCount}</td><td>{row.repeatPurchaseOrderCount}</td>
        </tr>)}</tbody></table></div>
      </AnalyticsSection>
      <AnalyticsSection title="商品体验" empty="所选周期内暂无可分析商品。" hasData={view.products.length>0}>
        <div className="ce-analytics__cards">{view.products.map((row) => <article key={row.productId}>
          <div className="ce-analytics__card-title"><strong>{row.productName}</strong><span>{row.soldQuantity} 份</span></div>
          <dl><div><dt>实付销售</dt><dd>{money(row.paidRevenueMinor,'CNY')}</dd></div>
            <div><dt>冻结成本</dt><dd>{row.frozenCostMinor===null ? '数据不足' : money(row.frozenCostMinor,'CNY')}</dd></div>
            <div><dt>销售后贡献</dt><dd>{row.contributionAmountMinor===null ? '数据不足' : money(row.contributionAmountMinor,'CNY')}</dd></div>
            <div><dt>成功退款</dt><dd>{money(row.refundedAmountMinor,'CNY')}</dd></div>
            <div><dt>观察</dt><dd>{row.observationCount}</dd></div><div><dt>称赞/投诉</dt><dd>{row.praiseCount}/{row.complaintCount}</dd></div>
            <div><dt>剩余</dt><dd>{row.remainingCount}</dd></div><div><dt>上桌晚</dt><dd>{row.servedLateCount}</dd></div></dl>
        </article>)}</div>
      </AnalyticsSection>
      <AnalyticsSection title="记录质量" empty="所选周期内暂无员工观察记录。" hasData={view.dataQuality.staff.length>0}>
        <div className="ce-analytics__table-wrap"><table><thead><tr>
          <th>员工</th><th>记录</th><th>未匹配</th><th>修订</th><th>正/中/负</th>
        </tr></thead><tbody>{view.dataQuality.staff.map((row) => <tr key={row.employeeId}>
          <th>{row.employeeName}</th><td>{row.inputCount}</td><td>{row.unmatchedInputCount}</td>
          <td>{row.correctedEventCount}</td><td>{row.positiveEventCount}/{row.neutralEventCount}/{row.negativeEventCount}</td>
        </tr>)}</tbody></table></div>
      </AnalyticsSection>
      {canViewRaw ? <AnalyticsSection title="已确认原始记录" empty="所选周期内暂无已确认原始记录。" hasData={evidence.length>0}>
        <div className="ce-analytics__evidence">{evidence.map((item) => <article key={item.eventId}>
          <div><strong>{item.tableCode} · {item.productName ?? '未确认商品'}</strong><span>{new Date(item.occurredAt).toLocaleString('zh-CN')}</span></div>
          <p>{item.rawExcerpt}</p>
          <small>{item.employeeName} · {eventLabel(item.eventType)} · 置信度 {percent(item.confidence)}{item.corrected ? ` · 已追加修订至第${item.revisionNo}版` : ''}</small>
        </article>)}</div>
      </AnalyticsSection> : null}
    </> : busy ? <p className="ce-analytics__empty">正在读取经营事实…</p> : null}
  </section>
}

function Metric({ label, value, helper }: { label: string; value: string | number; helper: string }) {
  return <article><span>{label}</span><strong>{value}</strong><small>{helper}</small></article>
}

function AnalyticsSection({ title, empty, hasData, children }: {
  title: string; empty: string; hasData: boolean; children: ReactNode
}) {
  return <section className="ce-analytics__section"><h3>{title}</h3>{hasData ? children : <p className="ce-analytics__empty">{empty}</p>}</section>
}

function percent(value: number) { return `${Math.round(value*100)}%` }
function ratioOf(numerator: number,denominator: number) { return denominator===0 ? 0 : numerator/denominator }
function money(value: number,currency: string) { return new Intl.NumberFormat('zh-CN',{ style:'currency',currency }).format(value/100) }
function suggestionLabel(kind: string) { return ({
  high_sales_low_experience:'高销量·体验需复核',low_sales_high_praise:'低销量·评价较好',
  frequent_remaining:'剩余较多',likely_service_delay:'可能是出品延迟',
} as Record<string,string>)[kind] ?? '待复核' }
function eventLabel(kind: string) { return ({
  remaining:'剩余',consumed_little:'饮用较少',praise:'称赞',complaint:'投诉',
  too_sweet:'偏甜',too_cold:'偏冷',served_late:'上桌较晚',presentation:'摆盘',portion:'份量',other:'其他',
} as Record<string,string>)[kind] ?? kind }

function mergeOptions(
  current: Array<{ id: string; name: string }>,incoming: Array<{ id: string; name: string }>,
) {
  const merged = new Map(current.map((item) => [item.id,item]))
  for (const item of incoming) merged.set(item.id,item)
  return [...merged.values()].sort((left,right) => left.name.localeCompare(right.name,'zh-CN'))
}
