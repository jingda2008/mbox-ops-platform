import {executeRecoverableCommand} from './recoverable-command'
import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import type {NormalizedApiClient,StaffAuthView} from '../normalized-api'
import {DurableStaffCommand} from './durable-staff-command'
import {wasteTypeLabels,type WasteType,type WasteResult,type WasteRequest} from '../shared/inventory-waste'
import {formatInventoryQuantityWithUnit,inventoryEmployeeUnit,inventoryQuantityForStorage,inventoryUnitLabel} from './inventory-presentation'

type Item={id:string;name:string;baseUnit:string;categoryCode:string;packageVolumeMl:string|null;reasonableWasteQuantity:string}
type Intent={itemId:string;itemName:string;quantity:string;reason:string;wasteType:WasteType}
export function InventoryWastePanel({api,auth,items,onChanged}:{api:NormalizedApiClient;auth:StaffAuthView;items:Item[];onChanged():Promise<void>}){
  const command=useMemo(()=>new DurableStaffCommand<Intent,WasteResult>(`${auth.employee.id}:inventory-waste`,(body,key)=>api.postEndpoint(`/api/inventory/items/${body.itemId}/waste`,{quantity:body.quantity,reason:body.reason,wasteType:body.wasteType,requestApproval:true},{idempotencyKey:key})),[api,auth.employee.id])
  const [pending,setPending]=useState(()=>command.pending())
  const [itemId,setItemId]=useState(''),[quantity,setQuantity]=useState(''),[reason,setReason]=useState(''),[wasteType,setWasteType]=useState<WasteType>('other')
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('')
  const item=items.find(candidate=>candidate.id===itemId)
  async function finish(result:WasteResult){
    setNotice(result.status==='pending'?'损耗申请已提交，等待另一位有库存审批权限的人员处理；尚未扣减库存。':`损耗已登记，库存余量为 ${formatInventoryQuantityWithUnit(result.remainingQuantity,result.baseUnit)}。`)
    setPending(command.pending());window.dispatchEvent(new Event('mbox:inventory-waste-changed'))
    try{await command.refresh(onChanged);setPending(null);setQuantity('');setReason('')}
    catch{setNotice(result.status==='pending'?'申请已提交，列表暂未更新；请只刷新记录。':'损耗已登记，库存列表暂未更新；请只刷新记录。')}
  }
  async function submit(event:React.FormEvent){event.preventDefault();if(busy)return
    if(!item||!/^\d+(?:\.\d{1,6})?$/.test(quantity)||Number(quantity)<=0||!reason.trim()){setNotice('请选择物料，填写大于零的损耗数量和原因');return}
    const stored=inventoryQuantityForStorage(quantity,item.categoryCode,item.baseUnit,item.packageVolumeMl)
    if(stored===null){setNotice('物料的单瓶净含量待补，请先完善物料资料');return}
    setBusy(true);try{await finish(await command.submit({itemId,itemName:item.name,quantity:stored,reason:reason.trim(),wasteType}))}
    catch(error){setPending(command.pending());setNotice(error instanceof Error?error.message:'结果暂未确认，请恢复原登记')}
    finally{setBusy(false)}
  }
  async function recover(){if(busy)return;setBusy(true);try{await finish(await command.recover())}catch(error){setPending(command.pending());setNotice(error instanceof Error?error.message:'暂未确认，请稍后恢复原登记')}finally{setBusy(false)}}
  return <section aria-label="登记损耗">
    {notice&&<p role="status">{notice}</p>}
    {pending?<div role="status"><strong>{pending.body.itemName} · {formatInventoryQuantityWithUnit(pending.body.quantity,items.find(i=>i.id===pending.body.itemId)?.baseUnit??'')}</strong><p>{pending.body.reason} · {pending.result?'原操作已成功，请刷新记录后再登记下一笔。':'原登记结果待确认，数量和原因已保留。'}</p><button type="button" disabled={busy} onClick={()=>void recover()}>{pending.result?'刷新记录':'恢复原登记结果'}</button></div>:<form className="staff-module-form" onSubmit={event=>void submit(event)}>
      <header><strong>登记损耗</strong><small>超出免审批数量的损耗会提交复核；审批通过后才扣库存。液体统一填写毫升。</small></header>
      <fieldset disabled={busy}><label>物料<select required value={itemId} onChange={event=>setItemId(event.target.value)}><option value="">请选择</option>{items.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
      {item&&<p>每笔免审批数量：{formatInventoryQuantityWithUnit(item.reasonableWasteQuantity,item.baseUnit)}；超出后需另一人审批。</p>}
      <label>损耗数量（{inventoryUnitLabel(inventoryEmployeeUnit(item?.categoryCode??'',item?.baseUnit??''))}）<input required inputMode="decimal" value={quantity} onChange={event=>setQuantity(event.target.value)}/></label>
      <label>损耗类型<select value={wasteType} onChange={event=>setWasteType(event.target.value as WasteType)}>{Object.entries(wasteTypeLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label>损耗原因<input required maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/></label><button type="submit">{busy?'正在提交':'确认登记损耗'}</button></fieldset>
    </form>}
  </section>
}

export function InventoryWasteReviewPanel({api,auth,items,onChanged}:{api:NormalizedApiClient;auth:StaffAuthView;items:Item[];onChanged():Promise<void>}){
  const [allowanceItem,setAllowanceItem]=useState(''),[allowance,setAllowance]=useState(''),[allowanceReason,setAllowanceReason]=useState('')
  const [page,setPage]=useState(1),[rows,setRows]=useState<WasteRequest[]>([]),[hasMore,setHasMore]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const readGeneration=useRef(0)
  const load=useCallback(async()=>{const generation=++readGeneration.current;const response=await api.getEndpoint<{data:{items:WasteRequest[];hasMore:boolean}}>(`/api/inventory/waste-requests?page=${page}`);if(generation!==readGeneration.current)return;setRows(response.data.items);setHasMore(response.data.hasMore);setError('')},[api,page])
  useEffect(()=>{const refresh=()=>{void load().catch(()=>setError('损耗申请暂未读到，请重新读取'))};refresh();window.addEventListener('mbox:inventory-waste-changed',refresh);return()=>{readGeneration.current++;window.removeEventListener('mbox:inventory-waste-changed',refresh)}},[load])
  return <section className="staff-module-form" aria-label="损耗复核"><header><strong>损耗申请与复核</strong><small>审批人不能是申请人；通过时按当时库存重新核对，驳回不扣库存。</small><button type="button" disabled={busy} onClick={()=>void load().catch(()=>setError('记录暂未读到，请重试'))}>刷新损耗申请</button></header>
    {auth.permissions.includes('inventory.count.approve')&&<details><summary>设置每笔免审批数量</summary><p>仅影响后续登记；已有待复核申请仍需独立审批。填0表示每笔均需复核。</p><form onSubmit={event=>{event.preventDefault();if(busy)return;setBusy(true);const body={quantity:allowance,reason:allowanceReason.trim()};void executeRecoverableCommand(`${auth.employee.id}:waste-allowance:${allowanceItem}`,body,crypto.randomUUID(),key=>api.postEndpoint(`/api/inventory/items/${allowanceItem}/waste-allowance`,body,{idempotencyKey:key})).then(async()=>{setNotice('免审批数量已保存；已有待复核申请保持不变');await onChanged()}).catch(error=>setNotice(error instanceof Error?error.message:'调整结果暂未确认')).finally(()=>setBusy(false))}}><label>物料<select required value={allowanceItem} onChange={event=>{setAllowanceItem(event.target.value);setAllowance(items.find(item=>item.id===event.target.value)?.reasonableWasteQuantity??'')}}><option value="">请选择</option>{items.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>每笔免审批数量（{inventoryUnitLabel(items.find(item=>item.id===allowanceItem)?.baseUnit??'')}）<input required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,6})?" value={allowance} onChange={event=>setAllowance(event.target.value)}/></label><label>调整原因<input required minLength={2} maxLength={500} value={allowanceReason} onChange={event=>setAllowanceReason(event.target.value)}/></label><button type="submit" disabled={busy}>保存免审批数量</button></form></details>}
    {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
    {rows.map(row=><WasteReview key={row.id} row={row} api={api} employeeId={auth.employee.id} busy={busy} setBusy={setBusy} setNotice={setNotice} refresh={async()=>{await load();await onChanged()}}/>)}
    {rows.length===0&&!error&&<p>暂无损耗申请</p>}
    <div><button type="button" disabled={page===1||busy} onClick={()=>setPage(p=>p-1)}>上一页</button><span>第 {page} 页</span><button type="button" disabled={!hasMore||busy} onClick={()=>setPage(p=>p+1)}>下一页</button></div>
  </section>
}
function WasteReview({row,api,employeeId,busy,setBusy,setNotice,refresh}:{row:WasteRequest;api:NormalizedApiClient;employeeId:string;busy:boolean;setBusy(value:boolean):void;setNotice(value:string):void;refresh():Promise<void>}){
  const command=useMemo(()=>new DurableStaffCommand<{decision:'approve'|'reject';reason:string},{id:string;status:string}>(`${employeeId}:waste-review:${row.id}`,(body,key)=>api.postEndpoint(`/api/inventory/waste-requests/${row.id}/${body.decision}`,{reason:body.reason},{idempotencyKey:key})),[api,employeeId,row.id])
  const [reason,setReason]=useState(''),[pending,setPending]=useState(()=>command.pending())
  async function decide(decision:'approve'|'reject'){
    if(busy)return;if(!pending&&reason.trim().length<2){setNotice('请填写至少两个字的审批说明');return}
    setBusy(true)
    try{const result=pending?await command.recover():await command.submit({decision,reason:reason.trim()});setPending(command.pending());setNotice(result.status==='approved'?'损耗已审批并扣减库存':'损耗已驳回，库存未扣减');try{await command.refresh(refresh);setPending(null)}catch{setNotice('审批已成功，记录暂未读到；请刷新原审批记录')}}
    catch(error){setPending(command.pending());setNotice(error instanceof Error?error.message:'审批结果暂未确认')}
    finally{setBusy(false)}
  }
  return <article><strong>{row.itemName} · {formatInventoryQuantityWithUnit(row.quantity,row.baseUnit)}</strong><p>{row.requestedByName} · {wasteTypeLabels[row.wasteType]??'类型待核对'} · {row.reason}</p><p>{({pending:'待复核',approved:'已通过并扣库存',rejected:'已驳回'} as const)[row.status]??'状态待核对'}{row.decidedByName&&` · ${row.decidedByName}：${row.decisionReason}`}</p>
    {pending?<button type="button" disabled={busy} onClick={()=>void decide(pending.body.decision)}>{pending.result?'刷新原审批记录':'恢复原审批结果'}</button>:row.canReview&&<><label>审批说明<input maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/></label><button type="button" disabled={busy} onClick={()=>void decide('approve')}>通过并扣库存</button><button type="button" disabled={busy} onClick={()=>void decide('reject')}>驳回申请</button></>}
  </article>
}
