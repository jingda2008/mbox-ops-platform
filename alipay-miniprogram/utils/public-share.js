const PUBLIC_SHARE_PAGES = new Set([
  '/pages/home/index',
  '/pages/brand-story/index',
  '/pages/performances/index',
  '/pages/community/index',
  '/pages/community-detail/index',
  '/pages/reservations/index',
  '/pages/order/index',
])

const PRIVATE_QUERY_KEY = /(token|table|session|order|member|phone|contact|openid|cart|payment)/i

function text(value, maximum = 96) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, maximum)
}

function safeQuery(value) {
  const raw = String(value || '').replace(/^\?/, '').trim()
  if (!raw || raw.length > 240) return ''
  const pairs = raw.split('&').filter(Boolean)
  if (!pairs.length) return ''
  for (const pair of pairs) {
    const [rawKey, rawValue = ''] = pair.split('=', 2)
    let key = ''
    let item = ''
    try {
      key = decodeURIComponent(rawKey || '')
      item = decodeURIComponent(rawValue || '')
    } catch (_error) {
      return ''
    }
    if (!key || PRIVATE_QUERY_KEY.test(key) || PRIVATE_QUERY_KEY.test(item)) return ''
  }
  return pairs.join('&')
}

function safePath(value) {
  const raw = String(value || '').trim()
  const [page, query = ''] = raw.split('?', 2)
  if (!PUBLIC_SHARE_PAGES.has(page)) return '/pages/home/index'
  const result = safeQuery(query)
  return result ? `${page}?${result}` : page
}

function safeImage(value) {
  const imageUrl = String(value || '').trim()
  return /^https:\/\//i.test(imageUrl) || imageUrl.startsWith('/assets/') ? imageUrl : ''
}

function publicSharePayload(input) {
  const value = input && typeof input === 'object' ? input : {}
  const title = text(value.title) || 'M-BOX · 今晚，刚刚好'
  const path = safePath(value.path)
  const imageUrl = safeImage(value.imageUrl)
  return Object.assign({ title, path }, imageUrl ? { imageUrl } : {})
}

function publicTimelinePayload(input) {
  const payload = publicSharePayload(input)
  const [, query = ''] = payload.path.split('?', 2)
  return Object.assign({ title: payload.title }, query ? { query } : {}, payload.imageUrl ? { imageUrl: payload.imageUrl } : {})
}

function enablePublicShareMenu() {
  // Alipay exposes standard sharing through each page's onShareAppMessage
  // callback. showSharePanel is customer-triggered UI and must not be opened
  // automatically from onShow, so this parity hook deliberately has no side
  // effect on Alipay.
}

export {
  enablePublicShareMenu,
  publicSharePayload,
  publicTimelinePayload,
  safePath,
}
