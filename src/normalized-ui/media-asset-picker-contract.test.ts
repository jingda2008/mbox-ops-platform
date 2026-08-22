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

  it('does not leave a manual external-image bypass in customer-facing publishers', async () => {
    const [activity, home, catalog] = await Promise.all([
      readFile(new URL('./ActivityOperationsPanel.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./HomeContentManagementPanel.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./CatalogManagementPanel.tsx', import.meta.url), 'utf8'),
    ])
    expect(activity).toContain('封面图片（可选）<input readOnly')
    expect(activity).toContain('purpose="community_activity"')
    expect(home).toContain('图片（可选）<input readOnly')
    expect(home).toContain('purpose="home_content"')
    expect(home).toContain('purpose="support_contact"')
    expect(home).not.toContain('也可填写已核对的 HTTPS 地址')
    expect(catalog).toContain('purpose="menu"')
    expect(catalog).toContain('已选图片<input readOnly')
    expect(catalog).not.toContain('也可输入同站安全地址')
  })
})
