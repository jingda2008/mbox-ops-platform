function requireMy() {
  if (typeof my === 'undefined') throw new Error('支付宝小程序运行时不可用')
  return my
}

function getStorageSync(key) {
  try {
    const result = requireMy().getStorageSync({ key })
    return result && Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : undefined
  } catch (_error) {
    return undefined
  }
}

function setStorageSync(key, data) {
  requireMy().setStorageSync({ key, data })
}

function removeStorageSync(key) {
  requireMy().removeStorageSync({ key })
}

function parseRequestData(data) {
  if (data == null || data === '') return {}
  if (typeof data === 'object') return data
  if (typeof data !== 'string') return {}
  const trimmed = data.trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed)
  } catch (_error) {
    return { error: { message: trimmed.slice(0, 180) } }
  }
}

function isAlipayCompletedHttpError(error) {
  const code = Number(error && error.error)
  const message = String((error && (error.errorMessage || error.errMsg || error.message)) || '')
  return code === 19 || /http status error/i.test(message)
}

function normalizeRequestResponse(response) {
  return Object.assign({}, response, {
    statusCode: Number(response && (response.statusCode || response.status) || 0),
    header: response && (response.header || response.headers) || {},
    cookies: response && Array.isArray(response.cookies) ? response.cookies : [],
    data: parseRequestData(response && response.data),
  })
}

function request(options) {
  const input = options || {}
  const headers = input.header || input.headers || {}
  function deliverSuccess(response) {
    if (typeof input.success !== 'function') return
    input.success(normalizeRequestResponse(response))
  }
  return requireMy().request({
    url: input.url,
    method: input.method,
    data: input.data,
    headers,
    header: headers,
    dataType: input.dataType || 'json',
    // 现网会话是 HttpOnly Set-Cookie，且 body 不回 sessionToken。
    // 必须让运行时 cookie jar 接手；禁止再手写 Cookie 请求头。
    enableCookie: true,
    timeout: input.timeout,
    success: deliverSuccess,
    fail(error) {
      // 支付宝把非 200（含入会成功的 201、以及 4xx/5xx）丢进 fail，error=19。
      // 微信则一律走 success。这里转成同一条 HTTP 响应路径，才能入会成功并展示真实业务错误。
      if (isAlipayCompletedHttpError(error)) {
        deliverSuccess({
          status: error && (error.status || error.statusCode),
          statusCode: error && (error.status || error.statusCode),
          headers: (error && (error.headers || error.header)) || {},
          header: (error && (error.headers || error.header)) || {},
          data: error && error.data,
          cookies: error && error.cookies,
        })
        return
      }
      if (typeof input.fail === 'function') input.fail(error)
    },
    complete: input.complete,
  })
}

function showActionSheet(options) {
  const input = options || {}
  return requireMy().showActionSheet(Object.assign({}, input, {
    items: input.items || input.itemList || [],
    success(result) {
      if (typeof input.success === 'function') {
        input.success(Object.assign({}, result, {
          tapIndex: Number(result && result.tapIndex !== undefined ? result.tapIndex : result && result.index),
        }))
      }
    },
  }))
}

function showModal(options) {
  const input = options || {}
  const api = requireMy()
  const common = {
    title: input.title,
    content: input.content,
    buttonText: input.confirmText,
    confirmButtonText: input.confirmText,
    cancelButtonText: input.cancelText,
    success(result) {
      if (typeof input.success === 'function') {
        input.success(Object.assign({ confirm: true, cancel: false }, result || {}))
      }
    },
    fail: input.fail,
    complete: input.complete,
  }
  if (input.showCancel === false && typeof api.alert === 'function') return api.alert(common)
  if (typeof api.confirm === 'function') return api.confirm(common)
  return direct('alert')(common)
}

function showToast(options) {
  const input = options || {}
  return requireMy().showToast({
    content: String(input.content || input.title || ''),
    type: input.type || (input.icon === 'success' ? 'success' : 'none'),
    duration: input.duration,
    success: input.success,
    fail: input.fail,
    complete: input.complete,
  })
}

function makePhoneCall(options) {
  const input = options || {}
  return requireMy().makePhoneCall({
    number: input.number || input.phoneNumber,
    success: input.success,
    fail: input.fail,
    complete: input.complete,
  })
}

function requestPayment(options) {
  const input = options || {}
  const tradeNO = String(input.tradeNO || '').trim()
  if (!tradeNO) {
    const error = { errMsg: 'tradePay:fail 支付宝交易号缺失', code: 'ALIPAY_TRADE_NO_MISSING' }
    if (typeof input.fail === 'function') input.fail(error)
    if (typeof input.complete === 'function') input.complete(error)
    return undefined
  }
  return requireMy().tradePay({
    tradeNO,
    success(result) {
      const resultCode = String(result && result.resultCode || '')
      if (resultCode === '9000') {
        if (typeof input.success === 'function') input.success(result)
      } else if (typeof input.fail === 'function') {
        const cancelled = resultCode === '6001'
        input.fail(Object.assign({
          errMsg: cancelled ? 'tradePay:fail cancel' : 'tradePay:fail 支付未完成',
          code: cancelled ? 'ALIPAY_PAYMENT_CANCELLED' : 'ALIPAY_PAYMENT_FAILED',
        }, result || {}))
      }
    },
    fail: input.fail,
    complete: input.complete,
  })
}

function scanCode(options) {
  const input = options || {}
  return requireMy().scan({
    type: 'qr',
    hideAlbum: true,
    success(result) {
      if (typeof input.success === 'function') {
        input.success(Object.assign({}, result, {
          result: String(result && (result.code || result.qrCode || result.result) || ''),
        }))
      }
    },
    fail: input.fail,
    complete: input.complete,
  })
}

function getAccountInfoSync() {
  const api = requireMy()
  if (typeof api.getAccountInfoSync === 'function') return api.getAccountInfoSync()
  // Missing/old APIs must never unlock development identities, table defaults,
  // or local fallback data on a customer device.
  return { miniProgram: { envVersion: 'release' } }
}

function getLaunchOptionsSync() {
  const api = requireMy()
  return typeof api.getLaunchOptionsSync === 'function' ? api.getLaunchOptionsSync() : {}
}

function getEnterOptionsSync() {
  const api = requireMy()
  if (typeof api.getEnterOptionsSync === 'function') return api.getEnterOptionsSync()
  return getLaunchOptionsSync()
}

function getExtConfigSync() {
  const api = requireMy()
  if (typeof api.getExtConfigSync !== 'function') return {}
  const result = api.getExtConfigSync()
  return result && result.extConfig ? result.extConfig : result || {}
}

function direct(name) {
  return function call(options) {
    const api = requireMy()
    if (typeof api[name] !== 'function') {
      const error = { errMsg: `${name}:fail 当前支付宝客户端不支持此能力` }
      if (options && typeof options.fail === 'function') options.fail(error)
      if (options && typeof options.complete === 'function') options.complete(error)
      return undefined
    }
    return api[name](options || {})
  }
}

const navigateTo = direct('navigateTo')
const navigateBack = direct('navigateBack')
const switchTab = direct('switchTab')
const stopPullDownRefresh = direct('stopPullDownRefresh')
const pageScrollTo = direct('pageScrollTo')
const previewImage = direct('previewImage')
const chooseImage = direct('chooseImage')
const vibrateShort = direct('vibrateShort')

// Appx 2.x treats this source as ESM; keep the adapter surface as named exports.
export {
  getStorageSync,
  setStorageSync,
  removeStorageSync,
  request,
  requestPayment,
  scanCode,
  showActionSheet,
  showModal,
  showToast,
  getAccountInfoSync,
  getLaunchOptionsSync,
  getEnterOptionsSync,
  getExtConfigSync,
  navigateTo,
  navigateBack,
  switchTab,
  stopPullDownRefresh,
  pageScrollTo,
  previewImage,
  makePhoneCall,
  chooseImage,
  vibrateShort,
}
