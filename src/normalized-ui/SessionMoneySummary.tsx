import './session-money-summary.css'
import type {TableSessionMoney} from '../shared/cashier-workbench-contracts'

type Money = Partial<TableSessionMoney>
const yuan = (minor:number) => '¥'+(minor/100).toFixed(2)

export function SessionMoneySummary({money}: {money:Money}) {
  const {grossCollectedAmountMinor:gross,refundedAmountMinor:refund,outstandingAmountMinor:due} = money
  if (gross === undefined || refund === undefined || due === undefined) return null
  return <span className="session-money-summary" aria-label="本桌次收退款">
    <span>原单累计已收 {yuan(gross)} · 已退 {yuan(refund)}</span>
    <strong>净收 {yuan(gross-refund)} · 待收 {yuan(due)}（{money.unpaidOrderCount} 单）</strong>
    {!!money.prepaidReceivedMinor && <small>预收累计 {yuan(money.prepaidReceivedMinor)} · 可用余额 {yuan(money.prepaidAvailableMinor!)}。已抵扣部分计入原单实收。</small>}
    {!!money.cashPaymentCount && <small>其中现金由收银登记 {money.cashPaymentCount} 笔，共 {yuan(money.cashAmountMinor!)}</small>}
    {!!money.pendingPaymentCount && <small>原付款待确认 {money.pendingPaymentCount} 笔，先查原付款</small>}
  </span>
}
