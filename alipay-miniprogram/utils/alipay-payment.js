// Alipay only receives a server-created trade number. Another platform's payload
// must never be reinterpreted as an Alipay payment instruction.
function isPresentableAlipayTradeAction(action) {
  if (!action || action.status !== 'pending' || !action.payload) return false
  if (!['alipay_jsapi', 'trade_pay'].includes(String(action.presentation || ''))) return false
  return typeof action.payload.tradeNO === 'string' && action.payload.tradeNO.trim().length > 0
}

export { isPresentableAlipayTradeAction }
