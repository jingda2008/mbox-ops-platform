import {useEffect,useRef,useState} from 'react'
import type {StaffActionsApiPort} from './staff-actions-api'
import type {ParticipantMovementHistory} from '../../shared/participant-movement-history'
import {formatChinaDateTime} from '../../shared/china-time'

export function ParticipantMovementHistoryPanel({api,ownerKey='',onVerified,onInvalidated}:Readonly<{api:StaffActionsApiPort;ownerKey?:string;onVerified?():void;onInvalidated?():void}>){
  const [opened,setOpened]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const [page,setPage]=useState<{api:StaffActionsApiPort;ownerKey:string;data:ParticipantMovementHistory}|null>(null)
  const identity=useRef({api,ownerKey});identity.current={api,ownerKey}
  const pending=useRef(false),mounted=useRef(true)
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
  const shown=page?.api===api&&page.ownerKey===ownerKey?page.data:null
  async function read(more=false){
    if(pending.current)return
    onInvalidated?.()
    pending.current=true;setOpened(true);setBusy(true);setError('')
    const current=()=>mounted.current&&identity.current.api===api&&identity.current.ownerKey===ownerKey
    if(!more)setPage(null)
    try{
      if(!api.loadParticipantMovementHistory)throw new Error('请刷新页面后核对服务端移动记录')
      const data=await api.loadParticipantMovementHistory(more?shown?.nextCursor??undefined:undefined)
      if(current()){
        const items=more?[...(shown?.items??[]),...data.items]:data.items
        setPage({api,ownerKey,data:{...data,items:items.filter((item,index)=>items.findIndex(other=>other.id===item.id)===index)}})
        onVerified?.()
      }
    }catch(e){if(current())setError(e instanceof Error?e.message:'历史记录暂时无法读取')}
    finally{pending.current=false;if(mounted.current)setBusy(false)}
  }
  return <section className="table-service-panel" aria-label="核对历史拆并桌">
    <button type="button" disabled={busy} onClick={()=>void read()}>核对历史拆并桌（服务端）</button>
    {opened&&<>
      <p>只查询当前员工已完成的转桌、拆桌和并桌；关闭标签页、重新登录或换设备后仍可核对。此处不会再次执行操作。</p>
      <p>列表只证明所列操作已完成；没有匹配记录不能判定原请求未执行，也不能阻止迟到请求。请核对现场后重新预检。</p>
      {shown?.items.map(row=><p key={row.id}>{formatChinaDateTime(row.occurredAt,{second:'2-digit'})}（北京时间） · 记录 {row.id.slice(-8)} · {row.employeeName} · {({whole_table_transfer:'整桌转桌',participant_split:'拆桌',participant_merge:'并桌'})[row.kind]} · {row.sourceTableCode} → {row.targetTableCode} · {row.movedGuestCount}人 · 已完成；目标原桌次{row.targetSessionStatus==='closed'?'已结束':`现在位于 ${row.targetCurrentTableCode}`}</p>)}
      {shown?.items.length===0&&<p>未查到已完成记录，不代表原请求未到达或未执行；请先核对现场，再重新预检。</p>}
      {shown?.nextCursor&&<button type="button" disabled={busy} onClick={()=>void read(true)}>更早的记录</button>}
      {error&&<p role="alert">{error}</p>}
    </>}
  </section>
}
