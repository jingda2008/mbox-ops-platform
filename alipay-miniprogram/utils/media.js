const { getRuntimeConfig } = require('../config/index')

// Content editors save same-site images as paths. A WXML image does not resolve
// those paths against the API host, so convert only our reviewed public route
// at the mini-program boundary. Staff-only routes are never exposed here.
function publicImageUrl(value, variant) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (variant === 'menu') {
    const base = getRuntimeConfig().apiBaseUrl
    const path = trimmed.startsWith(base + '/') ? trimmed.slice(base.length) : trimmed
    if (/^\/api\/public\/media-assets\/MA[0-9A-F]{32}$/.test(path)) return `${base}${path}?variant=menu320`
    if (/^\/menu\/[^?#%]+\.(?:jpe?g|png|webp)$/i.test(path)) return `${base}/api/public/menu-thumbnail?path=${encodeURIComponent(path)}`
  }
  if (trimmed.startsWith('/api/public/media-assets/') || trimmed.startsWith('/menu/')) {
    return `${getRuntimeConfig().apiBaseUrl}${trimmed}`
  }
  return trimmed
}

export { publicImageUrl }
