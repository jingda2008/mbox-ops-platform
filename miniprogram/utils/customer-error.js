// Customer pages must never render a backend/WeChat error string directly.
// Error codes are stable contracts; the fallback remains local Chinese copy.
const CODE_MESSAGES = Object.freeze({
  NETWORK_ERROR: '网络暂时不可用，请检查网络后重试',
  GUEST_SESSION_INVALID: '桌台连接已失效，请重新扫描桌面二维码',
  TABLE_SESSION_ENDED: '本桌服务已结束，请重新扫描当前桌面的二维码',
  CUSTOMER_AT_OTHER_TABLE: '当前设备已连接到另一桌，请先联系服务人员处理',
  GUEST_AUTH_RATE_LIMITED: '操作有点快，请稍后再试',
  GUEST_SCAN_RATE_LIMITED: '操作有点快，请稍后再试',
  STORE_ACCESS_FORBIDDEN: '当前门店访问入口无效，请从小程序重新进入',
  PRODUCT_UNAVAILABLE: '有商品暂时无法供应，请返回购物车调整后再试',
  PRODUCT_NOT_AVAILABLE: '有商品刚刚下架或售罄，请返回购物车调整后再试',
  CART_PROTOCOL_UPGRADE_REQUIRED: '本桌正在完成旧版点单，请在结台后更新小程序再继续点单',
  CHECKOUT_UPGRADE_UNAVAILABLE: '升级内容已经变化，请重新确认后再结账',
  PAYMENT_IN_PROGRESS: '付款正在处理中，请稍后刷新确认结果',
  PAYMENT_STATUS_REVIEW: '付款结果确认中，请勿重复付款',
  MEMBERSHIP_SERVICE_UNAVAILABLE: '会员服务暂时无法连接，请稍后重试',
  AUTH_REQUIRED: '登录状态已失效，请重新进入后重试',
})

function customerErrorCode(error) {
  const value = error && typeof error.code === 'string' ? error.code.trim() : ''
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(value) ? value : ''
}

function customerErrorMessage(error, fallback) {
  return CODE_MESSAGES[customerErrorCode(error)] || String(fallback || '服务暂时繁忙，请稍后重试').trim()
}

function isWechatCancellation(error) {
  // This is control flow only. The raw platform string is never displayed.
  const raw = String((error && (error.errMsg || error.message)) || '').toLowerCase()
  return raw.includes('cancel')
}

module.exports = { customerErrorCode, customerErrorMessage, isWechatCancellation }
