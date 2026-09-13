import {useEffect,useReducer} from 'react'
import type {NormalizedApiClient} from '../normalized-api'
import {pendingStockReturns} from './order-stock-return-recovery'
import {OrderStockReturnForm} from './OrderStockReturnForm'

/** Only unresolved local receipts, including when the last unit's completed
 * order has disappeared from the ordinary historical-work listing. */
export function OrderStockReturnPending({api,employeeId,visibleItemIds,onChanged}:{api:NormalizedApiClient;employeeId:string;visibleItemIds:string[];onChanged():Promise<void>}){
  const [,refresh]=useReducer((value:number)=>value+1,0)
  useEffect(()=>{window.addEventListener('mbox-stock-return-recovery-changed',refresh);return()=>window.removeEventListener('mbox-stock-return-recovery-changed',refresh)},[])
  const pending=pendingStockReturns(employeeId).filter(item=>!visibleItemIds.includes(item.itemId))
  if(!pending.length)return null
  return <section aria-label="原退库结果待核对"><h4>原退库结果待核对</h4><p>原订单可能已离开当前筛选。这里仅恢复上次登记，不另做退库。</p>{pending.map(item=><section key={item.itemId}><strong>{item.label}</strong><OrderStockReturnForm api={api} employeeId={employeeId} itemId={item.itemId} quantity={0} label={item.label} onChanged={onChanged}/></section>)}</section>
}
