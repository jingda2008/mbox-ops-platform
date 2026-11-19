import type { ChannelRule } from '../shared/channel-distribution'
import { channelOfferText, channelProductLabels, type ChannelDisplayProduct } from '../shared/channel-rule-display'
import { beijingDisplayTime } from './beijing-display-time'

export function ChannelRuleSummary({ rule, contract, products = [], saved = false }: {
  rule: ChannelRule
  contract?: { version: string; terms: string; settlementSubject: string }
  products?: ChannelDisplayProduct[]
  saved?: boolean
}) {
  const eligible = rule.eligibleProductIds ?? [], commission = rule.commissionProductIds ?? eligible
  return <div className="channel-rule-summary" aria-label="完整优惠规则">
    <p><strong>{rule.title}</strong> · {channelOfferText(rule, products)}</p>
    <dl>
      <dt>使用门槛</dt><dd>满 ¥{(rule.minimumMinor / 100).toFixed(2)} 可用</dd>
      <dt>领取及使用次数</dt><dd>本批最多 {rule.totalClaims} 张 · 每人限领 {rule.perCustomerClaims} 张 · 每客组限用 {rule.perVisitUses} 次</dd>
      <dt>领取时间（北京）</dt><dd>{beijingDisplayTime(rule.claimFrom)} 至 {beijingDisplayTime(rule.claimUntil)}</dd>
      <dt>使用时间（北京）</dt><dd>{beijingDisplayTime(rule.useFrom)} 至 {beijingDisplayTime(rule.useUntil)}</dd>
      <dt>叠加规则</dt><dd>{rule.allowStacking ? `允许渠道券叠加；${rule.visitDiscountCapMinor == null ? '未设置客组总优惠上限' : `本次客组总优惠上限 ¥${(rule.visitDiscountCapMinor / 100).toFixed(2)}`}` : '不叠加；本次客组只能使用一张渠道券'}。转桌不重置次数和额度；赠品按正常售价计入总优惠。</dd>
      <dt>适用商品（{eligible.length} 款）</dt><dd>{channelProductLabels(eligible, rule.eligibleProductNames, products).join('、') || '待核对'}</dd>
      <dt>计佣商品（{commission.length} 款）</dt><dd>{!rule.commissionProductIds && '与适用商品相同：'}{channelProductLabels(commission, rule.eligibleProductNames, products).join('、') || '待核对'}</dd>
      <dt>佣金与结算观察期</dt><dd>佣金 {rule.commissionBps / 100}% · 观察 {rule.observationDays} 天</dd>
      {rule.offer?.kind === 'gift' && <><dt>赠品成本</dt><dd>{saved ? `本券核定成本 ¥${(rule.offer.costMinor / 100).toFixed(2)}` : '保存时由服务器按商品档案核定，不能自行填成本'}</dd></>}
      <dt>佣金结算主体</dt><dd>{contract?.settlementSubject ?? '待核对原合作条款'}</dd>
      <dt>合作条款版本</dt><dd>{contract?.version ?? '待核对'}</dd>
      <dt>合作条款摘要</dt><dd>{contract?.terms ?? '待核对原合作条款'}</dd>
    </dl>
  </div>
}
