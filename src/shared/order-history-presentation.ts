import type {OperatingHistory} from './operating-history'

export function groupOrdersBySession(orders:OperatingHistory['orders']) {
  const groups=new Map<string,OperatingHistory['orders']>()
  for(const order of orders){
    const key=order.tableSessionId??order.id
    const rows=groups.get(key)??[]
    rows.push(order)
    groups.set(key,rows)
  }
  return [...groups].map(([key,rows])=>({key,orders:rows}))
}

export function historyItemPriceLabel(item:OperatingHistory['orders'][number]['items'][number]) {
  return item.includedInBundle?'套餐内商品，不另收费':`单价 ¥${(item.unitPriceMinor/100).toFixed(2)} · 小计 ¥${(item.totalMinor/100).toFixed(2)}`
}
