function readWechatPhoneAuthorization(event) {
  const detail = event && event.detail && typeof event.detail === 'object' ? event.detail : {}
  const code = typeof detail.code === 'string' ? detail.code.trim() : ''
  if (code.length >= 8) return { code, message: '' }
  const errno = Number(detail.errno)
  const errMsg = String(detail.errMsg || '')
  let message = '未取得微信手机号授权，本次不会入会，不影响浏览菜单、预约和点单。'
  if (errno === 1400001) message = '本小程序手机号次数已用完，请稍后再试。'
  else if (errno === 112) message = '微信公众平台尚未在隐私保护指引中声明手机号，真机无法授权。'
  else if (/privacy permission is not authorized/i.test(errMsg)) {
    message = '请先同意微信弹出的隐私保护指引，再点授权手机号。'
  } else if (/deny|cancel/i.test(errMsg)) {
    message = '未授权微信手机号，本次不会入会，不影响浏览菜单、预约和点单。'
  }
  return { code: '', message }
}

module.exports = { readWechatPhoneAuthorization }
