// Customer pages must never render a backend/WeChat error string directly.
// Error codes are stable contracts; the fallback remains local Chinese copy.
const CODE_MESSAGES = Object.freeze({
  COMMAND_RECOVERY_PENDING: '上次提交的结果还未确认，请先查看办理进度，或联系门店核对',
  COMMAND_RECOVERY_RECORD_INVALID: '暂时查不到上次提交的结果，请联系门店核对，避免重复提交',
  COMMAND_RECOVERY_REVIEW_REQUIRED: '上次提交的结果还未确认，请先查看办理进度，避免重复提交',
  COMMAND_RECOVERY_EXPIRED: '距离上次提交已有一段时间，请联系门店核对结果，避免重复提交',
  COMMAND_RECOVERY_SCOPE_CHANGED: '会员或桌号已变化，请核对当前会员和桌号，再查看上次提交的结果',
  COMMAND_RECOVERY_UNCONFIRMED: '暂时查不到办理结果，请稍后查看，避免重复提交',

  CUSTOMER_AUTHENTICATION_REQUIRED: '请先返回会员中心登录，再查看我的存酒',
  CUSTODY_NOT_FOUND: '这张存酒单不存在或不属于当前会员，请返回存酒列表核对',
  CUSTODY_PHOTO_NOT_FOUND: '本次存酒照片暂不可用，请联系门店核对',
  CUSTODY_CONTACT_UNAVAILABLE: '存酒联系号码暂时无法读取，请稍后重试',
  CHECKOUT_COUPON_RECONFIRM_REQUIRED: '优惠条件已变化，请重新选券或不用券继续，本次没有创建订单',
  COUPON_UPGRADE_REQUOTE_REQUIRED: '套餐已变更，请重新确认商品和优惠报价',
  NETWORK_ERROR: '网络暂时不可用，请检查网络后重试',
  GUEST_SESSION_INVALID: '桌台连接已失效，请重新扫描桌面二维码',
  GUEST_ORDER_ACCESS_FORBIDDEN: '这笔订单不属于当前桌位，请重新扫描当前桌面的二维码',
  TABLE_SESSION_ENDED: '本桌服务已结束，请重新扫描当前桌面的二维码',
  CUSTOMER_AT_OTHER_TABLE: '当前设备已连接到另一桌，请先联系服务人员处理',
  GUEST_SERVICE_RATE_LIMITED: '这次呼叫还未受理，请稍后再试',
  GUEST_AUTH_RATE_LIMITED: '操作有点快，请稍后再试',
  GUEST_SCAN_RATE_LIMITED: '操作有点快，请稍后再试',
  STORE_ACCESS_FORBIDDEN: '当前门店访问入口无效，请从小程序重新进入',
  TABLE_QR_INVALID: '新桌码无效，请扫描本店当前有效桌码',
  INVENTORY_RECIPE_MISSING: '所选商品暂时无法供应，请更换商品或联系服务人员',
  INVENTORY_BALANCE_MISSING: '所选商品暂时无法确认库存，请更换商品或联系服务人员',
  ORDER_NOT_PAYABLE: '所选订单当前无需付款或已结束，请刷新桌账核对',
  PRODUCT_UNAVAILABLE: '有商品暂时无法供应，请返回购物车调整后再试',
  PRODUCT_NOT_AVAILABLE: '有商品刚刚下架或售罄，请返回购物车调整后再试',
  SHARED_CART_VERSION_CONFLICT: '同桌购物车已更新，请刷新后重新确认',
  CART_NOTE_STALE: '菜品份次已变化，请刷新购物车并重新核对每份备注',
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
  MENU_CATALOG_INCOMPLETE: '菜单没有完整加载，请检查网络后重试',
  MENU_CATALOG_RESPONSE_INVALID: '菜单数据暂时异常，请稍后重试',
  MENU_CATALOG_CHANGED: '菜单正在更新，请稍后重新加载',
  DAILY_SNACK_TABLE_REQUIRED: '请入座并连接当前桌台后再申请每日点心',
  DAILY_SNACK_TABLE_AUTH_REQUIRED: '当前桌边连接已失效，请重新扫描桌面二维码',
  DAILY_SNACK_UNAVAILABLE: '当前没有可申请的每日点心，请以门店已发布规则和会员等级为准',
  DAILY_SNACK_RULE_AMBIGUOUS: '每日点心规则待门店确认，请联系服务人员',
  DAILY_SNACK_TABLE_LIMIT_REACHED: '本桌今日每日点心名额已满',
  DAILY_SNACK_MEMBER_LIMIT_INVALID: '暂时无法确认领取次数，本次未提交点心申请，请联系服务人员',
  DAILY_SNACK_PRICE_INVALID: '暂时无法确认点心价格，本次未提交申请，请联系服务人员',
  DAILY_SNACK_ALREADY_CLAIMED: '今日每日点心已经申请过，不能再次申请',
  ACTIVITY_CONTACT_PROTECTION_FAILED: '暂时无法办理报名，请稍后再试',
  ACTIVITY_CONTACT_PROTECTION_UNAVAILABLE: '暂时无法办理报名，请稍后再试',
  ACTIVITY_REGISTRATION_RESULT_UNCONFIRMED: '报名结果确认中，请稍后在“我的活动”查看',
  ACTIVITY_PAYMENT_WECHAT_IDENTITY_REJECTED: '微信付款身份需要刷新，本次没有扣款，请刷新后重新报名',
  ACTIVITY_PAYMENT_NETWORK_REJECTED: '当前网络未通过支付安全验证，本次没有扣款，请切换网络后重新报名',
  ACTIVITY_PAYMENT_CONFIGURATION_UNAVAILABLE: '暂时无法发起活动付款，本次没有扣款，请联系门店处理',
  ACTIVITY_PAYMENT_PROVIDER_REJECTED: '本次付款未受理，本次没有扣款，请稍后重新报名或联系门店',
  ACTIVITY_PAYMENT_RESULT_UNKNOWN: '付款结果确认中，请先查询付款状态，不要重复报名或重复付款',
  AUTH_REQUIRED: '登录状态已失效，请重新进入后重试',
  AUTHENTICATION_REQUIRED: '登录状态已失效，请重新进入后重试',
  PUBLIC_RESERVATION_REQUEST_INVALID: '请刷新预约页面，核对填写的信息后再试',
  PUBLIC_RESERVATION_RATE_LIMITED: '操作有点快，请稍后再试',
  RESERVATION_NOT_FOUND: '找不到这条预约，请刷新后重试',
  RESERVATION_CANCEL_REQUIRES_STAFF: '该预约需要联系门店协助取消',
  RESERVATION_STATE_CONFLICT: '预约状态已变化，请刷新后重试',
  RESERVATION_SESSION_INVALID: '登录状态已失效，请重新进入后重试',
  HTTP_ERROR: '服务暂时未能确认，请稍后重试',
  WECHAT_PHONE_AUTHORIZATION_INVALID: '微信手机号授权无效或已过期，请重新点击授权',
  WECHAT_PHONE_PROVIDER_UNAVAILABLE: '微信手机号服务暂时不可用，请稍后重试',
  WECHAT_PHONE_PROVIDER_CONFIGURATION: '暂时无法通过微信验证手机号，请联系门店',
  MEMBERSHIP_ENROLLMENT_PHONE_NOT_CONFIGURED: '手机号入会尚未接通，请稍后重试或联系门店',
  MEMBERSHIP_ENROLLMENT_CLIENT_UPGRADE_REQUIRED: '请更新小程序后重新授权手机号加入会员',
  MEMBERSHIP_ENROLLMENT_CONFLICT: '本次入会信息与上次不同，请关闭后重新授权手机号',
  MEMBERSHIP_ENROLLMENT_IN_PROGRESS: '入会正在确认中，请稍候再试',
  MEMBERSHIP_ENROLLMENT_RESULT_UNCONFIRMED: '入会结果确认中，请稍后在「我的」查看',
  MEMBERSHIP_IDENTITY_CONFLICT: '会员身份正在同步，请重新授权手机号完成登录',
  MEMBERSHIP_RECOVERY_PHONE_NOT_CONFIGURED: '会员手机号校验暂时不可用，请稍后重试或联系门店',
  MEMBERSHIP_RECOVERY_NOT_CONFIGURED: '历史会员找回尚未启用，请联系门店协助',
  PHONE_AUTHORIZATION_REPLAY_REJECTED: '这次手机号授权已经使用过。请重新点一次授权；如果这是原来的会员，请使用「找回原会员」',
  MEMBERSHIP_PHONE_REVIEW_REQUIRED: '会员资料需要核对，请联系门店并出示原会员号。券和积分保留在原账户。',
  MEMBERSHIP_PHONE_AUTHORIZATION_CONFLICT: '这个手机号已经绑定了其他会员。请使用「找回原会员」完成登录，本次没有重复开卡',
  CUSTOMER_EXPERIENCE_FAILED: '会员服务暂时没有接上，请稍后重试',
  ROUTE_NOT_FOUND: '会员服务暂时不可用，请稍后重试或联系门店',
})

function customerErrorCode(error) {
  const value = error && typeof error.code === 'string' ? error.code.trim() : ''
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(value) ? value : ''
}

function customerErrorMessage(error, fallback) {
  const code = customerErrorCode(error)
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code]
  const serverMessage = String((error && error.message) || '').trim()
  // Preserve short Chinese business notices, but keep platform and service diagnostics out of the UI.
  const diagnostic = /接口|配置|后台|服务端|客户端|原请求|回执|幂等|安全重试|规则快照|数据库|字段|堆栈|异常码|请求格式|凭证域|模拟支付|系统异常|系统错误|技术错误|(?:error|fail|stack|exception|undefined|null|ECONN|ETIMEDOUT|HTTP|SQL|API|TypeError)|[A-Z][A-Z0-9]+_[A-Z0-9_]+|https?:\/\/|[\r\n]/i
  if (/^[\u4e00-\u9fff]/.test(serverMessage) && serverMessage.length <= 96 && !diagnostic.test(serverMessage)) {
    return serverMessage
  }
  return String(fallback || '服务暂时繁忙，请稍后重试').trim()
}

function isWechatCancellation(error) {
  // This is control flow only. The raw platform string is never displayed.
  const raw = String((error && (error.errMsg || error.message)) || '').toLowerCase()
  return raw.includes('cancel')
}

module.exports = { customerErrorCode, customerErrorMessage, isWechatCancellation }
