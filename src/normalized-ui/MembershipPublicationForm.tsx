import {useMemo,useState} from 'react'
import type {NormalizedApiClient,StaffAuthView} from '../normalized-api'
import {DurableStaffCommand} from './durable-staff-command'
import {beijingDateTimeIso,membershipPublicationPath,membershipPublicationPermissions,type MembershipDomain} from './membership-workflow'

type Publication={effectiveFrom:string;effectiveUntil:string|null;reason:string;expectedRevision:number}
export function MembershipPublicationForm({api,auth,draft,summary,onBusy,onPublished}:{api:NormalizedApiClient;auth:StaffAuthView;draft:{domain:MembershipDomain;publicId:string;status:string;revision:number;makerEmployeeIds:readonly string[]};summary:{version:number;approvedByEmployeeId?:string|null};onBusy(value:boolean):void;onPublished():Promise<void>}){
  const command=useMemo(()=>new DurableStaffCommand<Publication,unknown>(`${auth.employee.id}:membership-publish:${draft.domain}:${draft.publicId}`,(body,key)=>api.postEndpoint(membershipPublicationPath(draft.domain,draft.publicId,summary.version),body,{idempotencyKey:key})),[api,auth.employee.id,draft.domain,draft.publicId,summary.version])
  const [pending,setPending]=useState(()=>command.pending()),[start,setStart]=useState(''),[until,setUntil]=useState(''),[reason,setReason]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false)
  if(!auth.permissions.includes(membershipPublicationPermissions[draft.domain]))return draft.status==='approved'?<p>需由具有本类规则发布权限的第三位人员发布。</p>:null
  if(draft.makerEmployeeIds.includes(auth.employee.id)||summary.approvedByEmployeeId===auth.employee.id)return draft.status==='approved'?<p>你参与了本版起草或审批，请交由第三位有发布权限的人员处理。</p>:null
  if(draft.status!=='approved'&&!pending)return notice?<p role="status">{notice}</p>:null
  async function submit(){if(busy)return;setBusy(true);onBusy(true)
    try{
      if(pending)await command.recover()
      else{
        const effectiveFrom=beijingDateTimeIso(start),effectiveUntil=until?beijingDateTimeIso(until):null
        if(Date.parse(effectiveFrom)<=Date.now())throw new Error('请选择未来的生效时间')
        if(effectiveUntil&&Date.parse(effectiveUntil)<=Date.parse(effectiveFrom))throw new Error('结束时间必须晚于生效时间')
        if(reason.trim().length<2)throw new Error('请填写至少两个字的发布说明')
        await command.submit({effectiveFrom,effectiveUntil,reason:reason.trim(),expectedRevision:draft.revision})
      }
      setPending(command.pending());setNotice('排期已保存，将按生效时间执行。')
      try{await command.refresh(onPublished);setPending(null)}catch{setNotice('排期已保存，最新版本暂未读到；请刷新原发布记录。')}
    }catch(error){setPending(command.pending());setNotice(error instanceof Error?error.message:'发布结果暂未确认，请恢复原发布结果')}
    finally{setBusy(false);onBusy(false)}
  }
  return <section aria-label="发布已审批规则"><h4>安排生效时间</h4>{notice&&<p role="status">{notice}</p>}{pending?<><p>原发布内容已保留，请先核对结果。</p><button disabled={busy} type="button" onClick={()=>void submit()}>{pending.result?'刷新原发布记录':'恢复原发布结果'}</button></>:<form onSubmit={event=>{event.preventDefault();void submit()}}><fieldset disabled={busy}><label>生效时间（北京时间）<input type="datetime-local" required value={start} onChange={event=>setStart(event.target.value)}/></label>{draft.domain!=='membership_terms'&&<label>结束时间（选填，北京时间）<input type="datetime-local" value={until} onChange={event=>setUntil(event.target.value)}/></label>}<label>发布说明<input required minLength={2} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/></label><button type="submit">确认排期发布</button></fieldset></form>}</section>
}
