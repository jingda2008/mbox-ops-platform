const { getRuntimeConfig } = require('../config/index')

// Content editors save same-site images as paths. A WXML image does not resolve
// those paths against the API host, so convert only our reviewed public route
// at the mini-program boundary. Staff-only routes are never exposed here.
function publicImageUrl(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.startsWith('/api/public/media-assets/')) {
    return `${getRuntimeConfig().apiBaseUrl}${trimmed}`
  }
  return trimmed
}

module.exports = { publicImageUrl }
