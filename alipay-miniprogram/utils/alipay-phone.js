function extractAuthorizationCode(source, depth) {
  if (!source || (depth || 0) > 4) return ''
  if (typeof source === 'string') {
    const trimmed = source.trim()
    return trimmed.length >= 8 ? trimmed : ''
  }
  if (typeof source !== 'object') return ''
  const detail = source.detail && typeof source.detail === 'object' ? source.detail : source
  const candidates = [
    detail.encryptedData,
    detail.response,
    detail.authCode,
    source.encryptedData,
    source.response,
  ]
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    if (typeof candidate === 'string' && candidate.trim().length >= 8) return candidate.trim()
    if (candidate && typeof candidate === 'object') {
      try {
        const encoded = JSON.stringify(candidate)
        if (encoded.length >= 8 && encoded.indexOf('{') === 0) return encoded
      } catch (_error) {
        // Fall through to nested extraction.
      }
      const nested = extractAuthorizationCode(candidate, (depth || 0) + 1)
      if (nested) return nested
    }
  }
  return ''
}

function looksLikePhoneCipher(value) {
  const code = String(value || '').trim()
  if (!code) return false
  if (code.charAt(0) === '{' && code.indexOf('"response"') >= 0) return code.length > 40
  if (code.charAt(0) === '{' && code.indexOf('"encryptedData"') >= 0) return code.length > 40
  if (code.length > 40 && /^[A-Za-z0-9+/_=-]+$/.test(code.replace(/\s/g, ''))) return true
  return false
}

function packPhonePayload(result) {
  if (!result || typeof result !== 'object') {
    return looksLikePhoneCipher(result) ? String(result).trim() : ''
  }
  const response = result.response
  const encryptedData = result.encryptedData
  const sign = result.sign
  // Official Alipay getPhoneNumber returns { response, sign }. Always keep the
  // wrapper when both exist so the server can extract the AES ciphertext.
  if (typeof response === 'string' && response.trim().length >= 8) {
    if (typeof sign === 'string' && sign.trim()) {
      return JSON.stringify({ response: response.trim(), sign: sign.trim() })
    }
    return response.trim()
  }
  if (response && typeof response === 'object') {
    try {
      const encoded = JSON.stringify(response)
      if (looksLikePhoneCipher(encoded) || encoded.indexOf('mobile') >= 0) {
        return typeof sign === 'string' && sign.trim()
          ? JSON.stringify({ response: encoded, sign: sign.trim() })
          : encoded
      }
    } catch (_error) {
      // Fall through.
    }
  }
  if (typeof encryptedData === 'string' && encryptedData.trim().length >= 8) return encryptedData.trim()
  const code = extractAuthorizationCode(result) || extractAuthorizationCode({ detail: result })
  return looksLikePhoneCipher(code) ? code : ''
}

function authorizationFailureMessage(raw) {
  const errMsg = String(raw || '')
  if (/deny|cancel|拒绝|取消|6001/i.test(errMsg)) {
    return '未授权支付宝手机号，本次不会入会，不影响浏览菜单、预约和点单。'
  }
  if (/40003|无效的授权|auth/i.test(errMsg)) {
    return '请直接点「确定加入并授权手机号」。不要只登录支付宝账号。'
  }
  if (/40001|加密配置|aes/i.test(errMsg)) {
    return '小程序尚未配置接口内容加密，无法取得手机号。请在开放平台设置 AES 密钥后再试。'
  }
  if (/40006|个人小程序|企业/i.test(errMsg)) {
    return '获取手机号仅支持企业小程序，请确认当前 AppID 已开通该能力。'
  }
  if (/not support|不支持|simulator|模拟/i.test(errMsg)) {
    return '模拟器无法完成手机号授权。请用真机调试或真机预览。'
  }
  if (!errMsg) {
    return '未取得支付宝手机号授权，本次不会入会。请再点一次授权按钮。'
  }
  return '未取得支付宝手机号授权，本次不会入会。'
}

function readAlipayPhoneAuthorization(event) {
  const code = packPhonePayload(event && event.detail ? event.detail : event)
  if (code) return { code, message: '' }
  const detail = event && event.detail && typeof event.detail === 'object' ? event.detail : (event || {})
  return {
    code: '',
    message: authorizationFailureMessage(detail.errorMessage || detail.errMsg || detail.error || ''),
  }
}

function obtainAlipayPhoneAuthorization(event) {
  return new Promise((resolve) => {
    const fromEvent = readAlipayPhoneAuthorization(event)
    if (fromEvent.code && looksLikePhoneCipher(fromEvent.code)) {
      resolve(fromEvent)
      return
    }
    if (typeof my === 'undefined' || typeof my.getPhoneNumber !== 'function') {
      resolve({
        code: '',
        message: '当前支付宝版本不支持手机号授权，请升级支付宝后重试。',
      })
      return
    }
    my.getPhoneNumber({
      success(result) {
        const code = packPhonePayload(result)
        if (code) {
          resolve({ code, message: '' })
          return
        }
        resolve({
          code: '',
          message: authorizationFailureMessage(''),
        })
      },
      fail(error) {
        resolve({
          code: '',
          message: authorizationFailureMessage(
            (error && (error.errorMessage || error.errMsg || error.error || error.errorCode)) || '',
          ),
        })
      },
    })
  })
}

export { readAlipayPhoneAuthorization, obtainAlipayPhoneAuthorization }
