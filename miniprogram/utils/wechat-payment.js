// `pending` is the online-payment contract's normal state after a provider
// pre-order has produced the JSAPI parameters and before the guest pays.
function isPresentableWechatJsapiAction(action) {
  if (!action || action.status !== 'pending' || action.presentation !== 'jsapi' || !action.payload) return false
  return ['timeStamp', 'nonceStr', 'package', 'signType', 'paySign'].every((key) => (
    typeof action.payload[key] === 'string' && action.payload[key].trim().length > 0
  ))
}

module.exports = { isPresentableWechatJsapiAction }
