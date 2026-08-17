import { useEffect, useMemo, useState } from 'react'
import { LoaderCircle, Sparkles, X } from 'lucide-react'
import type { StaffActionsApiPort } from './staff-actions-api'
import type {
  RecommendationStaffModificationReason,
  StaffRecommendationSession,
} from './types'

const REASONS: Array<{ code: RecommendationStaffModificationReason; label: string }> = [
  { code: 'customer_request',label: '顾客明确提出' },
  { code: 'availability_substitution',label: '现场可售替换' },
  { code: 'service_recovery',label: '服务补救' },
  { code: 'staff_judgement',label: '员工结合现场建议' },
]

export function TableRecommendationSheet({ api,tableCode,tableSessionId,onClose,onSaved }: {
  api: StaffActionsApiPort
  tableCode: string
  tableSessionId: string
  onClose(): void
  onSaved(message: string): void
}) {
  const [session,setSession] = useState<StaffRecommendationSession | null>(null)
  const [loading,setLoading] = useState(true)
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  const [sourceProductId,setSourceProductId] = useState('')
  const [targetProductId,setTargetProductId] = useState('')
  const [reasonCode,setReasonCode] = useState<RecommendationStaffModificationReason>('customer_request')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true);setError('')
    api.loadTableRecommendation(tableSessionId,controller.signal).then((value) => {
      setSession(value)
      setSourceProductId(value?.options[0]?.productId ?? '')
      setTargetProductId(value?.options[1]?.productId ?? '')
    }).catch((cause) => setError(cause instanceof Error ? cause.message : '桌台推荐暂时无法读取'))
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [api,tableSessionId])

  const targetOptions = useMemo(
    () => session?.options.filter((option) => option.productId!==sourceProductId) ?? [],
    [session,sourceProductId],
  )
  useEffect(() => {
    if (targetProductId===sourceProductId || !targetOptions.some((option) => option.productId===targetProductId)) {
      setTargetProductId(targetOptions[0]?.productId ?? '')
    }
  }, [sourceProductId,targetOptions,targetProductId])

  async function submit() {
    if (session===null || !sourceProductId || !targetProductId || sourceProductId===targetProductId || busy) return
    setBusy(true);setError('')
    try {
      const result = await api.modifyTableRecommendation({
        recommendationPublicId: session.recommendationPublicId,sourceProductId,targetProductId,reasonCode,
      })
      onSaved(`已记录从“${result.sourceProductName}”调整为“${result.targetProductName}”`)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '推荐调整未完成，请重试')
    } finally { setBusy(false) }
  }

  return <div className="staff-recommendation-overlay" role="dialog" aria-modal="true" aria-label={`${tableCode}桌台推荐`}>
    <section className="staff-recommendation-sheet">
      <header><div><Sparkles size={20} /><span><small>{tableCode}</small><strong>协助调整推荐</strong></span></div>
        <button type="button" aria-label="关闭推荐调整" onClick={onClose}><X size={20} /></button></header>
      <div className="staff-recommendation-body">
        <p className="staff-recommendation-boundary">只可在系统已经生成的方案间调整；这条记录不会改推荐规则，也不代表顾客已下单。</p>
        {loading ? <p className="staff-recommendation-empty"><LoaderCircle className="is-spinning" size={18} /> 正在读取本桌推荐</p> : null}
        {!loading && session===null && !error ? <p className="staff-recommendation-empty">本桌尚未生成推荐，请让顾客先在点单页获取方案。</p> : null}
        {session!==null ? <div className="staff-recommendation-form">
          <label>系统原方案<select value={sourceProductId} onChange={(event) => setSourceProductId(event.target.value)}>
            {session.options.map((option) => <option value={option.productId} key={option.productId}>
              {option.productName} · {money(option.amountMinor,option.currency)}
            </option>)}</select></label>
          <label>协助调整为<select value={targetProductId} onChange={(event) => setTargetProductId(event.target.value)}>
            {targetOptions.map((option) => <option value={option.productId} key={option.productId}>
              {option.productName} · {money(option.amountMinor,option.currency)}
            </option>)}</select></label>
          <label>调整原因<select value={reasonCode} onChange={(event) => setReasonCode(
            event.target.value as RecommendationStaffModificationReason,
          )}>{REASONS.map((reason) => <option value={reason.code} key={reason.code}>{reason.label}</option>)}</select></label>
          <button type="button" className="staff-primary-action" disabled={busy || !targetProductId}
            onClick={() => void submit()}>{busy ? '正在确认…' : '确认记录调整'}</button>
        </div> : null}
        {error ? <p className="staff-recommendation-error" role="alert">{error}</p> : null}
      </div>
    </section>
  </div>
}

function money(value: number,currency: string) {
  return new Intl.NumberFormat('zh-CN',{ style: 'currency',currency }).format(value/100)
}
