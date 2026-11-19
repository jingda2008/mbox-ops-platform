import type { ChannelRule } from './channel-distribution.js'

export type ChannelDisplayProduct = { id: string; name: string }
export function channelProductLabels(ids: string[], snapshot: ChannelDisplayProduct[] = [], catalog: ChannelDisplayProduct[] = []) {
  return ids.map(id => snapshot.find(p => p.id === id)?.name ?? catalog.find(p => p.id === id)?.name ?? `待核对商品（${id.slice(-8)}）`)
}
export function channelOfferText(rule: ChannelRule, catalog: ChannelDisplayProduct[] = []) {
  const offer = rule.offer
  if (!offer) return '优惠待核对'
  if (offer.kind === 'credit') return `减免 ¥${(offer.amountMinor / 100).toFixed(2)}`
  if (offer.kind === 'gift') return `赠 ${offer.productName ?? catalog.find(p => p.id === offer.productId)?.name ?? '指定商品'} × ${offer.quantity}`
  // Basis points describe the reduction, not the payable percentage.
  const payable = (10_000 - offer.discountBps) / 1000
  return `${payable === 0 ? '全额减免' : `${payable}折`}（减免 ${offer.discountBps / 100}%）· 每券上限 ¥${(offer.maximumMinor / 100).toFixed(2)}`
}
