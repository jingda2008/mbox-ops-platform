import { describe, expect, it } from 'vitest'
import { mapRepertoireRows } from './repertoire-file.js'

describe('repertoire file mapping', () => {
  it('maps Chinese headers and applies optional defaults', () => {
    const result = mapRepertoireRows([
      ['歌曲名称', '原唱', '时长秒', '价格元', '是否启用'],
      ['后来', '刘若英', 240, 98, '是'],
      ['海阔天空', 'Beyond', '', '', '停用'],
    ])

    expect(result.errors).toEqual([])
    expect(result.rows).toEqual([
      { title: '后来', artist: '刘若英', durationSeconds: 240, priceAmount: 9800, currency: 'CNY', enabled: true },
      { title: '海阔天空', artist: 'Beyond', durationSeconds: 240, priceAmount: 9800, currency: 'CNY', enabled: false },
    ])
  })

  it('reports missing headers, invalid values and duplicate songs with line numbers', () => {
    expect(mapRepertoireRows([['歌曲', '价格']]).errors[0]).toContain('原唱')

    const result = mapRepertoireRows([
      ['歌曲名称', '原唱', '时长秒', '价格元', '是否启用'],
      ['同一首歌', '原唱', 10, 0, '也许'],
      [' 同一首歌 ', '原唱', 240, 98, '是'],
    ])
    expect(result.rows).toHaveLength(0)
    expect(result.errors[0]).toContain('第2行')
    expect(result.errors[1]).toContain('文件内重复')
  })
})
