// Promotional codes are public offer locators, never customer or table credentials.
function channelCode(value) {
  const raw = decodeURIComponent(String(value || '')).trim()
  if (/^CH_[A-Z2-9]{8,16}$/.test(raw)) return raw.slice(3)
  const legacy = raw.replace(/^MBOX_CHANNEL_V1:/, '')
  if (/^[A-Za-z2-9]{8,16}$/.test(legacy)) return legacy.toUpperCase()
  if (/^[A-Za-z0-9_-]{43}$/.test(legacy)) return legacy
  throw new Error('推广码格式不正确，请输入图上的优惠号码')
}
function channelScanCode(result) {
  if (result && result.path) {
    const match = String(result.path).match(/^\/?pages\/channel-coupons\/index\?scene=([^&]+)$/)
    if (!match) throw new Error('这不是推荐优惠码，请扫描推广图上的小程序码')
    return channelCode(match[1])
  }
  return channelCode(result && result.result)
}
module.exports = { channelCode, channelScanCode }
