import { readdirSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('mobile static asset budget', () => {
  it('keeps the complete guest mood set below 64 KiB', () => {
    const directory = new URL('../public/brand/moods-v2/', import.meta.url)
    const moodAssets = readdirSync(directory).filter((name) => name.endsWith('.webp'))
    const totalBytes = moodAssets.reduce((total, name) => total + statSync(new URL(name, directory)).size, 0)

    expect(moodAssets).toHaveLength(6)
    expect(totalBytes).toBeLessThan(64 * 1024)
  })
})
