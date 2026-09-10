import {useRef,useState} from 'react'
import type {NormalizedApiClient} from '../normalized-api'

export function OrderBillPrintButton({api,orderId,employeeId}:{api:NormalizedApiClient;orderId:string;employeeId:string}) {
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[queued,setQueued]=useState(false)
  const active=useRef(false),key=useRef<string|null>(null)
  async function request() {
    if(active.current||queued)return
    active.current=true;setBusy(true)
    const storageKey=`mbox-manual-bill:${employeeId}:${orderId}`
    try {
      if(!key.current){
        try{key.current=sessionStorage.getItem(storageKey)}catch{/* Storage may be disabled. */}
        key.current??=crypto.randomUUID()
        try{sessionStorage.setItem(storageKey,key.current)}catch{/* The in-page key still protects retries. */}
      }
      await api.postEndpoint(`/api/hardware/orders/${encodeURIComponent(orderId)}/bill`,{}, {idempotencyKey:key.current})
      setQueued(true);setMessage('打印任务已生成，不代表已出纸。未出纸请核对打印任务，不要重复补打。')
      // Retain the key across refreshes: an unknown physical result must not create another task.
    }catch(reason){setMessage(`${reason instanceof Error?reason.message:'打印请求暂未确认'}；再次点击仅核对同一请求，订单和收款不受影响。`)}
    finally{active.current=false;setBusy(false)}
  }
  return <div><button type="button" disabled={busy||queued} aria-busy={busy} onClick={()=>void request()}>
    {queued?'已生成打印任务':busy?'正在确认打印任务':message?'核对本次打印请求':'手动打印本单账单'}
  </button>{message&&<p role="status">{message}</p>}</div>
}
