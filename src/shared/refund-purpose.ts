export const REFUND_PURPOSES = ['return_goods','price_adjustment','service_compensation','duplicate_payment'] as const
export type RefundPurpose = typeof REFUND_PURPOSES[number]
export const REFUND_PURPOSE_LABELS: Record<RefundPurpose,string> = {
  return_goods:'退货或取消商品',price_adjustment:'退差价',service_compensation:'服务补偿，商品继续供应',duplicate_payment:'重复收款退回',
}
