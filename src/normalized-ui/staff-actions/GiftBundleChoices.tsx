import type { MenuBundleChoiceGroup, MenuBundleUnitSelection } from '../../shared/contracts'

export function giftChoicesComplete(groups: readonly MenuBundleChoiceGroup[], quantity:number, selections:readonly MenuBundleUnitSelection[]) {
  if (!groups.length) return selections.length===0
  return selections.length===quantity && selections.every(unit=>unit.groups.length===groups.length && groups.every(group=>{
    const selected=unit.groups.filter(item=>item.groupId===group.id)
    return selected.length===1 && selected[0]!.productIds.length===group.selectionCount
      && new Set(selected[0]!.productIds).size===group.selectionCount
      && selected[0]!.productIds.every(id=>group.options.some(option=>option.productId===id&&option.available))
  }))
}
export function GiftBundleChoices({groups,quantity,value,disabled,onChange}:{groups:MenuBundleChoiceGroup[];quantity:number;value:MenuBundleUnitSelection[];disabled:boolean;onChange:(value:MenuBundleUnitSelection[])=>void}) {
  return <>{Array.from({length:quantity},(_,unitIndex)=><fieldset key={unitIndex} disabled={disabled}><legend>第 {unitIndex+1} 份选款</legend>
    {groups.map(group=>{
      const selected=value[unitIndex]?.groups.find(item=>item.groupId===group.id)?.productIds??[]
      return <div key={group.id}><strong>{group.name} · 选 {group.selectionCount} 款</strong>{group.options.map(option=><label key={option.productId} style={{display:'block'}}>
        <input type="checkbox" checked={selected.includes(option.productId)} disabled={disabled||!option.available||(!selected.includes(option.productId)&&selected.length>=group.selectionCount)}
          onChange={event=>{const ids=event.target.checked?[...selected,option.productId]:selected.filter(id=>id!==option.productId)
            onChange(Array.from({length:quantity},(_,index)=>({groups:groups.map(g=>({groupId:g.id,productIds:index===unitIndex&&g.id===group.id?ids:value[index]?.groups.find(item=>item.groupId===g.id)?.productIds??[]}))})))}}/>
        {option.name} × {option.quantity}{!option.available?'（当前无法出品）':''}</label>)}</div>
    })}
  </fieldset>)}</>
}
