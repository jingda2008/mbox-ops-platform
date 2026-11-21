import type { ChannelRule } from '../shared/channel-distribution'

// Staff-only estimates; new claims do not reserve stock or consume this budget.
export function ChannelBudgetSummary({rule,campaignLimit,storeLimit,products=[],saved=false}:{
  rule:ChannelRule;campaignLimit?:string;storeLimit?:string;products?:{id:string;costAmountMinor?:string|null}[];saved?:boolean
}) {
  const offer=rule.offer
  if(!offer)return <p role="alert">优惠成本规则未完整读回，请刷新核对。</p>
  const productCost=offer.kind==='gift'?products.find(p=>p.id===offer.productId)?.costAmountMinor:null
  const cost=offer.kind==='credit'?offer.amountMinor:offer.kind==='discount'?offer.maximumMinor:saved?offer.costMinor:productCost==null?null:Number(productCost)*offer.quantity
  const money=(n:number)=>`¥${(n/100).toFixed(2)}`
  if(cost===null)return <p role="alert">赠品成本尚未读回，请核对商品档案后生成。</p>
  const insufficient=(campaignLimit!=null&&cost*rule.totalClaims>Number(campaignLimit))||(storeLimit!=null&&cost*rule.totalClaims>Number(storeLimit))
  return <section aria-label="优惠成本与额度核对">
    <p>每券预计成本 {money(cost)} · 本批 {rule.totalClaims} 张全部兑现估算为 {money(cost*rule.totalClaims)}。</p>
    <p>活动成本预警金额 {campaignLimit==null?'待核对':money(Number(campaignLimit))} · 全店成本预警金额 {storeLimit==null?'待核对':money(Number(storeLimit))}。</p>
    {insufficient&&<p role="alert">预计成本超过预警金额，请关注实际使用情况；不拦截新领取，不自动调整预算。</p>}
    <p>领券和绑定桌号不预占库存、不预留成本，以上估算不是实际支出。赠品实际出品时检查库存并按后台成本记账；折扣按实际减免记录。历史已预留券继续保留原承诺。</p>
  </section>
}
