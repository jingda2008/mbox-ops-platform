import { describe, expect, it } from 'vitest'
import {
  isPublicMediaAssetUrl,
  isPublicMiniProgramImageUrl,
  isPublicMenuImageUrl,
  publicMediaAssetUrl,
  publicMiniProgramImageUrl,
} from './media-asset-url.js'

describe('public media asset URL boundary', () => {
  const url = '/api/public/media-assets/MA00000000000000000000000000000001'

  it('accepts only immutable image-library URLs', () => {
    expect(isPublicMediaAssetUrl(url)).toBe(true)
    expect(isPublicMediaAssetUrl(` ${url} `)).toBe(true)
    expect(isPublicMediaAssetUrl('/assets/brand/mbox-logo-badge.png')).toBe(false)
    expect(isPublicMediaAssetUrl('https://example.com/image.png')).toBe(false)
  })

  it('safely hides historical external images without deleting their stored value', () => {
    expect(publicMediaAssetUrl(url)).toBe(url)
    expect(publicMediaAssetUrl('https://example.com/old-image.png')).toBeNull()
    expect(publicMediaAssetUrl('')).toBeNull()
  })

  it('allows only controlled local menu paths alongside image-library assets', () => {
    expect(isPublicMenuImageUrl('/menu/2026-08/items/classic-01.jpg')).toBe(true)
    expect(isPublicMenuImageUrl('/menu/../secret.jpg')).toBe(false)
    expect(isPublicMenuImageUrl('https://example.com/menu.jpg')).toBe(false)
    expect(isPublicMiniProgramImageUrl(url)).toBe(true)
    expect(publicMiniProgramImageUrl('/menu/2026-08/items/classic-01.jpg')).toBe('/menu/2026-08/items/classic-01.jpg')
    expect(publicMiniProgramImageUrl('https://example.com/menu.jpg')).toBeNull()
  })
})
