import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')

describe('inventory-to-sale workflow contract', () => {
  it('keeps beverage stock, product setup and sale checks in one guided workspace', () => {
    const staff = read('src/normalized-ui/StaffModulePanel.tsx')
    const catalog = read('src/normalized-ui/CatalogManagementPanel.tsx')
    const css = read('src/normalized-ui/staff-module-panel.css')

    expect(staff).toContain("inventory: { title: '库存与酒水上架'")
    expect(staff).toContain('酒水四步入库发布')
    expect(staff).toContain('扫码或建立物料')
    expect(staff).toContain('选择销售规格')
    expect(staff).toContain('生成完整预览')
    expect(staff).toContain('确认入库并发布')
    expect(staff).toContain('本次收货形成的真实成本与可售结果')
    expect(staff).toContain('<CatalogManagementPanel api={api} auth={auth} placement="inventory" openRequest={catalogOpenRequest} />')
    expect(staff).not.toContain('<CatalogManagementPanel api={api} auth={auth} />')
    expect(catalog).toContain("placement?: 'inventory' | 'settings'")
    expect(catalog).toContain('新建跟踪库存商品请先保存为停用')
    expect(catalog).toContain('库存扣减配方未完成')
    expect(catalog).toContain('当前可售库存不足，请完成入库或盘点')
    expect(catalog).toContain("status: 'inactive'")
    expect(catalog).toContain('保存配方并刷新可售检查')
    expect(css).toContain('.inventory-selling-flow')
    expect(css).toContain('.catalog-sale-readiness')
  })
})
