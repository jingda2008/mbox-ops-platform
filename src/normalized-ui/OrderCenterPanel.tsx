import {useEffect,useState} from 'react'
import {NormalizedApiError, type NormalizedApiClient} from '../normalized-api'
import type {OperatingHistory} from '../shared/operating-history'
import {OperatingHistoryPanel} from './OperatingHistoryPanel'

export function OrderCenterPanel({api,onLoginRequired,printEmployeeId,inventoryEmployeeId}:{api:NormalizedApiClient;onLoginRequired():void;printEmployeeId?:string;inventoryEmployeeId?:string}) {
  const [initial,setInitial]=useState<OperatingHistory|null>(null)
  const [error,setError]=useState(''),[retry,setRetry]=useState(0)
  useEffect(()=>{
    let active=true
    setError('')
    void api.getEndpoint<{data:OperatingHistory}>('/api/operations/history').then(response=>{
      if(active)setInitial(response.data)
    }).catch(reason=>{
      if(!active)return
      if(reason instanceof NormalizedApiError&&reason.recovery==='login'){onLoginRequired();return}
      setError(reason instanceof Error?reason.message:'订单暂时无法读取')
    })
    return()=>{active=false}
  },[api,retry,onLoginRequired])
  if(error)return <div role="alert">{error}<button onClick={()=>setRetry(value=>value+1)}>重新查询</button></div>
  if(!initial)return <p role="status">正在读取门店营业日及订单…</p>
  return <OperatingHistoryPanel api={api} businessDate={initial.businessDate} standalone initialData={initial} printEmployeeId={printEmployeeId} inventoryEmployeeId={inventoryEmployeeId}/>
}
