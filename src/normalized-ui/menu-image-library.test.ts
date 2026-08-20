import { describe, expect, it } from 'vitest'
import { menuImageOptions } from './menu-image-library'

describe('menu image library', () => {
  it('publishes one unique first-party image for every approved menu item', () => {
    expect(menuImageOptions).toHaveLength(56)
    expect(new Set(menuImageOptions.map((option) => option.url)).size).toBe(56)
    expect(menuImageOptions.every((option) => /^\/menu\/2026-08\/items\/(?:snack|signature|classic|package)-\d{2}\.jpg$/.test(option.url))).toBe(true)
  })

  it('keeps the four source categories complete', () => {
    expect(menuImageOptions.filter((option) => option.label.startsWith('小食 ·'))).toHaveLength(16)
    expect(menuImageOptions.filter((option) => option.label.startsWith('情绪特调 ·'))).toHaveLength(16)
    expect(menuImageOptions.filter((option) => option.label.startsWith('经典鸡尾酒 ·'))).toHaveLength(12)
    expect(menuImageOptions.filter((option) => option.label.startsWith('情绪套餐 ·'))).toHaveLength(12)
  })
})
