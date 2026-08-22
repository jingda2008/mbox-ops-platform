import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('media asset picker upload limit', () => {
  it('matches the 200KB server and database limit before the browser reads a file', async () => {
    const source = await readFile(new URL('./MediaAssetPicker.tsx', import.meta.url), 'utf8')
    expect(source).toContain('const MAX_IMAGE_BYTES = 200 * 1024')
    expect(source).toContain('file.size > MAX_IMAGE_BYTES')
    expect(source).toContain('200KB 以内再上传')
    expect(source).toContain('最大 200KB')
    expect(source).not.toContain('1MB')
  })
})
