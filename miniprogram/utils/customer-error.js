// Customer pages must never render a backend/WeChat error string directly.
// Error codes are stable contracts; the fallback remains local Chinese copy.
const CODE_MESSAGES = Object.freeze({
  NETWORK_ERROR: '网络暂时不可用，请检查网络后重试',
  GUEST_SESSION_INVALID: '桌台连接已失效，请重新扫描桌面二维码',
  GUEST_ORDER_ACCESS_FORBIDDEN: '这笔订单不属于当前桌位，请重新扫描当前桌面的二维码',
  TABLE_SESSION_ENDED: '本桌服务已结束，请重新扫描当前桌面的二维码',
  CUSTOMER_AT_OTHER_TABLE: '当前设备已连接到另一桌，请先联系服务人员处理',
  GUEST_AUTH_RATE_LIMITED: '操作有点快，请稍后再试',
  GUEST_SCAN_RATE_LIMITED: '操作有点快，请稍后再试',
  STORE_ACCESS_FORBIDDEN: '当前门店访问入口无效，请从小程序重新进入',
  PRODUCT_UNAVAILABLE: '有商品暂时无法供应，请返回购物车调整后再试',
  PRODUCT_NOT_AVAILABLE: '有商品刚刚下架或售罄，请返回购物车调整后再试',
  SHARED_CART_VERSION_CONFLICT: '同桌购物车已更新，请刷新后重新确认',
  SHARED_CART_EMPTY: '本桌共享购物车为空，请先加入商品',
  SHARED_CART_OPERATION_CONFLICT: '本次购物车操作状态异常，请刷新后再试',
  SHARED_CART_LIMIT_EXCEEDED: '本桌购物车已达到数量或金额上限，请先确认现有商品',
  SHARED_CART_RATE_LIMITED: '同桌操作较频繁，请稍候再试',
  SHARED_CART_WRITES_FROZEN: '服务人员正在核对本桌点单，暂时只能查看购物车',
  CART_PROTOCOL_UPGRADE_REQUIRED: '本桌正在完成旧版点单，请在结台后更新小程序再继续点单',
  CHECKOUT_UPGRADE_UNAVAILABLE: '升级内容已经变化，请重新确认后再结账',
  GUEST_CHECKOUT_CONFIGURATION_UNAVAILABLE: '暂时无法发起微信支付，本次没有创建订单，请联系服务员',
  GUEST_CHECKOUT_NOT_FOUND: '本次付款已结束，请重新选购后再支付',
  GUEST_CHECKOUT_CANNOT_BE_CANCELLED: '订单已进入服务流程，请联系工作人员处理',
  GUEST_CHECKOUT_ALREADY_PAID: '付款已成功，本桌会按实际支付状态处理',
  ONLINE_PAYMENT_UNAVAILABLE: '暂时无法发起在线支付，本次没有创建订单，请联系服务员',
  PAYMENT_IN_PROGRESS: '付款正在处理中，请稍后刷新确认结果',
  PAYMENT_STATUS_REVIEW: '付款结果确认中，请勿重复付款',
  WECHAT_IDENTITY_REQUIRED: '微信支付身份需要刷新，请重新扫描当前桌面的二维码或重新进入小程序后再试',
  MEMBERSHIP_SERVICE_UNAVAILABLE: '会员服务暂时无法连接，请稍后重试',
  DAILY_SNACK_TABLE_REQUIRED: '请入座并连接当前桌台后再申请每日点心',
  DAILY_SNACK_TABLE_AUTH_REQUIRED: '当前桌边连接已失效，请重新扫描桌面二维码',
  DAILY_SNACK_UNAVAILABLE: '当前没有可申请的每日点心，请以门店已发布规则和会员等级为准',
  DAILY_SNACK_RULE_AMBIGUOUS: '每日点心规则待门店确认，请联系服务人员',
  DAILY_SNACK_TABLE_LIMIT_REACHED: '本桌今日每日点心名额已满',
  DAILY_SNACK_MEMBER_LIMIT_INVALID: '每日点心暂时无法申请，请联系服务人员',
  DAILY_SNACK_PRICE_INVALID: '每日点心暂时无法申请，请联系服务人员',
  DAILY_SNACK_ALREADY_CLAIMED: '今日每日点心已经申请过，不能再次申请',
  ACTIVITY_CONTACT_PROTECTION_FAILED: '报名服务配置异常，请稍后再试',
  ACTIVITY_CONTACT_PROTECTION_UNAVAILABLE: '报名服务配置异常，请稍后再试',
  ACTIVITY_REGISTRATION_RESULT_UNCONFIRMED: '报名结果确认中，请稍后在“我的活动”查看',
  ACTIVITY_PAYMENT_WECHAT_IDENTITY_REJECTED: '微信付款身份需要刷新，本次没有扣款，请刷新后重新报名',
  ACTIVITY_PAYMENT_NETWORK_REJECTED: '当前网络未通过支付安全验证，本次没有扣款，请切换网络后重新报名',
  ACTIVITY_PAYMENT_CONFIGURATION_UNAVAILABLE: '活动付款服务配置异常，本次没有扣款，请联系门店处理',
  ACTIVITY_PAYMENT_PROVIDER_REJECTED: '支付通道未能受理本次付款，本次没有扣款，请稍后重新报名或联系门店',
  ACTIVITY_PAYMENT_RESULT_UNKNOWN: '付款结果确认中，请先查询付款状态，不要重复报名或重复付款',
  AUTH_REQUIRED: '登录状态已失效，请重新进入后重试',
  PUBLIC_RESERVATION_REQUEST_INVALID: '请求格式有误，请刷新页面后重试',
  RESERVATION_NOT_FOUND: '找不到这条预约，请刷新后重试',
  RESERVATION_CANCEL_REQUIRES_STAFF: '该预约需要联系门店协助取消',
  RESERVATION_STATE_CONFLICT: '预约状态已变化，请刷新后重试',
  RESERVATION_SESSION_INVALID: '登录状态已失效，请重新进入后重试',
  HTTP_ERROR: '服务暂时未能确认，请稍后重试',
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
