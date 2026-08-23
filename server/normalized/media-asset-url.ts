const PUBLIC_MEDIA_ASSET_URL = /^\/api\/public\/media-assets\/MA[0-9A-F]{32}$/
const MENU_PATH_SEGMENT = '[A-Za-z0-9][A-Za-z0-9_.-]*'
const PUBLIC_MENU_IMAGE_URL = new RegExp(`^/menu/(?:${MENU_PATH_SEGMENT}/)*${MENU_PATH_SEGMENT}\\.(?:jpe?g|png|webp)$`, 'i')

// Customer-facing content must reference an immutable asset that was accepted
// by the media library. Arbitrary remote URLs cannot be checked against the
// mini-program image budget and can disappear after a card is published.
export function isPublicMediaAssetUrl(value: string): boolean {
  return PUBLIC_MEDIA_ASSET_URL.test(value.trim())
}

export function publicMediaAssetUrl(value: string | null): string | null {
  if (value === null || value.trim() === '') return null
  const normalized = value.trim()
  return isPublicMediaAssetUrl(normalized) ? normalized : null
}

export function isPublicMenuImageUrl(value: string): boolean {
  return PUBLIC_MENU_IMAGE_URL.test(value.trim())
}

export function isPublicMiniProgramImageUrl(value: string): boolean {
  return isPublicMediaAssetUrl(value) || isPublicMenuImageUrl(value)
}

export function publicMiniProgramImageUrl(value: string | null): string | null {
  if (value === null || value.trim() === '') return null
  const normalized = value.trim()
  return isPublicMiniProgramImageUrl(normalized) ? normalized : null
}
