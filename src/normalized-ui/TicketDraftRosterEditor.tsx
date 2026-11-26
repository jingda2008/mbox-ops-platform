import {useEffect,useRef,useState} from 'react'
import type {NormalizedApiClient} from '../normalized-api'

interface Roster {
  desks:{id:string;code:string;fixed:boolean;selected:boolean}[]
  revision:string
}
export function TicketDraftRosterEditor({api,areaId,areaName,disabled,onSaved}:{
  api:NormalizedApiClient;areaId:string;areaName:string;disabled:boolean;onSaved:()=>void
}) {
  const path='/api/staff/activity-operations/draft-roster/'+encodeURIComponent(areaId)
  const [open,setOpen]=useState(false)
  const [reload,setReload]=useState(0)
  const [roster,setRoster]=useState<Roster|null>(null)
  const [ids,setIds]=useState<string[]>([])
  const [saving,setSaving]=useState(false)
  const [error,setError]=useState('')
  const pending=useRef<{body:string;key:string}|null>(null)
  const mounted=useRef(true)
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false}},[])
  useEffect(()=>{
    if(!open)return
    let current=true
    setRoster(null);setError('')
    api.getEndpoint<{data:Roster}>(path).then(({data})=>{
      if(!current)return
      setRoster(data);setIds(data.desks.filter(d=>d.selected).map(d=>d.id))
    }).catch(()=>{if(current)setError('桌号读取失败，请重新读取。')})
    return ()=>{current=false}
  },[api,path,open,reload])
  async function save(){
    if(!roster || saving || disabled)return
    const payload={revision:roster.revision,tableIds:ids.slice().sort()}
    const body=JSON.stringify(payload)
    if(pending.current?.body!==body)pending.current={body,key:crypto.randomUUID()}
    setSaving(true);setError('')
    try {
      await api.postEndpoint(path,payload,{idempotencyKey:pending.current.key})
      if(!mounted.current)return
      pending.current=null;setOpen(false);onSaved()
    } catch(e){if(mounted.current)setError(e instanceof Error?e.message:'未能确认保存结果，请重试。')}
    finally{if(mounted.current)setSaving(false)}
  }
  return <div className="ticket-roster-editor">
    <button type="button" disabled={disabled || saving} aria-expanded={open} onClick={()=>setOpen(!open)}>
      {open?'收起名单':'管理可选桌号'}
    </button>
    {open && <fieldset><legend>{areaName} · 可选桌号名单</legend>
      <p>勾选本区目前用于排桌的桌号。保存后，本店其他场次也可从这份名单中选桌。</p>
      {!roster && !error && <p role="status">正在读取本区桌台…</p>}
      {roster && !roster.desks.length && <p>该区域没有可用桌台，请核对桌区和桌台档案。</p>}
      <div className="ticket-roster-grid">{roster?.desks.map(d=><label key={d.id}>
        <input type="checkbox" checked={ids.includes(d.id)} disabled={saving || d.fixed || disabled}
          onChange={e=>{const checked=e.target.checked;setIds(previous=>checked?[...previous,d.id]:previous.filter(id=>id!==d.id))}}/>
        {d.code}{d.fixed?'（已核定）':''}
      </label>)}</div>
      {error && <p role="alert">{error} <button type="button" disabled={saving} onClick={()=>setReload(n=>n+1)}>重新读取</button></p>}
      <button type="button" disabled={saving || disabled || !roster} onClick={()=>void save()}>{saving?'正在保存…':'保存本区名单'}</button>
    </fieldset>}
  </div>
}
