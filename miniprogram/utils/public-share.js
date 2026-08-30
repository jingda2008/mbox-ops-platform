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
  if (typeof wx === 'undefined' || typeof wx.showShareMenu !== 'function') return
  try {
    const result = wx.showShareMenu({
      withShareTicket: false,
      menus: ['shareAppMessage', 'shareTimeline'],
    })
    if (result && typeof result.catch === 'function') result.catch(() => undefined)
  } catch (_error) {
    // Older base libraries can omit the timeline menu. The page callbacks still
    // keep friend sharing available when WeChat exposes it.
  }
}

module.exports = {
  enablePublicShareMenu,
  publicSharePayload,
  publicTimelinePayload,
  safePath,
}
