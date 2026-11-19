import { useId, useState } from 'react'
import type { ChannelDisplayProduct } from '../shared/channel-rule-display'

export function ChannelProductSelector({ label, products, selected, onChange, hint }: {
  label: string; products: ChannelDisplayProduct[]; selected: string[]
  onChange: (ids: string[]) => void; hint?: string
}) {
  const [query, setQuery] = useState(''), [onlySelected, setOnlySelected] = useState(false), id = useId()
  const normalized = query.trim().toLocaleLowerCase('zh-CN')
  const selectedSet = new Set(selected)
  // Keep missing selected IDs visible so filtering or a catalog refresh never silently drops scope.
  const choices = [...products, ...selected.filter(key => !products.some(p => p.id === key)).map(key => ({ id: key, name: `待核对商品（${key.slice(-8)}）` }))]
  const visible = choices.filter(p => (!onlySelected || selectedSet.has(p.id)) && p.name.toLocaleLowerCase('zh-CN').includes(normalized))
  return <section className="channel-product-selector" aria-label={label}>
    <h4>{label}</h4>{hint && <p>{hint}</p>}
    <label htmlFor={id}>搜索{label}</label>
    <div className="channel-product-search"><input id={id} type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="输入商品名称"/>
      {query && <button type="button" onClick={() => setQuery('')}>清除搜索</button>}
    </div>
    <div className="channel-product-toolbar"><span role="status">已选 {selectedSet.size} 款 · 当前显示 {visible.length} 款</span>
      <button type="button" aria-pressed={onlySelected} onClick={() => setOnlySelected(v => !v)}>{onlySelected ? '显示全部商品' : '只看已选'}</button></div>
    {!visible.length && <p>{onlySelected && !selected.length ? '尚未选择商品' : '没有匹配商品；已选范围保持不变'}</p>}
    <div className="gift-options">{visible.map(p => <label key={p.id}><input type="checkbox" checked={selectedSet.has(p.id)} onChange={e => onChange(e.target.checked ? [...selected.filter(key => key !== p.id), p.id] : selected.filter(key => key !== p.id))}/>{p.name}</label>)}</div>
  </section>
}
