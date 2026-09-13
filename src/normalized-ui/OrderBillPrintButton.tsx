import {useEffect,useRef,useState} from 'react'
import type {NormalizedApiClient} from '../normalized-api'

type BillProps={api:NormalizedApiClient;orderId:string;employeeId:string;businessDate?:string;endDate?:string;tableSessionId?:string;legacyReport?:boolean;reportMode?:'summary'|'details'|'both';reportGrouping?:'none'|'products'|'categories'|'bundles';recovering?:boolean;pendingPrintKey?:string;onRequestStateChange?:(unknown:boolean,requestKey:string)=>void}
export function OrderBillPrintButton(props:BillProps) {
  if(props.businessDate)return <DailyReportPrintChoices key={`${props.employeeId}:${props.businessDate}:${props.endDate??''}`} {...props}/>
  return <BillPrintAction key={`${props.employeeId}:${props.businessDate??props.tableSessionId??props.orderId}:${props.endDate??''}`} {...props}/>
}
function BillPrintAction({api,orderId,employeeId,businessDate,endDate,tableSessionId,legacyReport=false,reportMode='summary',reportGrouping='none',recovering=false,pendingPrintKey,onRequestStateChange}:BillProps) {
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(recovering?'上次打印回执尚未确认，核对时沿用原格式和请求编号。':''),[queued,setQueued]=useState(false)
  const [receipt,setReceipt]=useState<{requestId:string;jobIds?:string[]}|null>(null)
  const storageKey=`mbox-manual-bill:${employeeId}:${businessDate??tableSessionId??orderId}${endDate&&endDate!==businessDate?`:${endDate}`:''}${businessDate&&!legacyReport?`:v2:${reportMode}:${reportGrouping}`:''}`
  const active=useRef(false),key=useRef<string|null>(pendingPrintKey??null)
  async function request() {
    if(active.current||queued)return
    active.current=true;setBusy(true)
    try {
      if(!key.current){
        try{key.current=sessionStorage.getItem(storageKey)}catch{/* Storage may be disabled. */}
        key.current??=crypto.randomUUID()
        try{sessionStorage.setItem(storageKey,key.current)}catch{/* The in-page key still protects retries. */}
      }
      onRequestStateChange?.(true,key.current)
      const response=await api.postEndpoint<{requestId:string;jobIds?:string[]}>(tableSessionId?`/api/hardware/table-sessions/${encodeURIComponent(tableSessionId)}/bill`:businessDate?`/api/hardware/business-days/${encodeURIComponent(businessDate)}/report`:`/api/hardware/orders/${encodeURIComponent(orderId)}/bill`,businessDate?(legacyReport?{endDate:endDate??businessDate}:{endDate:endDate??businessDate,mode:reportMode,grouping:reportGrouping}):{}, {idempotencyKey:key.current})
      if (!response || typeof response.requestId !== 'string' || !response.requestId.trim()) throw new Error('打印请求回执不完整，请核对同一请求')
      setReceipt(response);setQueued(true);onRequestStateChange?.(false,key.current);setMessage('打印任务已生成，不代表已出纸。未出纸请核对打印任务，不要重复补打。')
      // Retain the key across refreshes: an unknown physical result must not create another task.
    }catch(reason){setMessage(`${reason instanceof Error?reason.message:'打印请求暂未确认'}；再次点击仅核对同一请求，订单和收款不受影响。`)}
    finally{active.current=false;setBusy(false)}
  }
  async function checkProgress(){
    if(!receipt||active.current)return
    active.current=true;setBusy(true)
    try{
      const response=await api.getEndpoint<{data:Array<{id:string;status:string;stationCode:string}>}>(`/api/hardware/print-requests/${receipt.requestId}`)
      const labels:Record<string,string>={pending:'待打印',printing:'正在提交',printed:'已提交打印机',failed:'失败待核对',dead:'需人工处理',cancelled:'已取消'}
      setMessage(response.data.length?response.data.map((job,index)=>`任务${index+1}：${labels[job.status]??'待核对'}`).join('；')+'。系统状态不证明纸张已正常输出。':'暂未读到任务，请保留请求号核对，不要重复打印。')
    }catch{setMessage('任务状态暂未读取，请稍后再核对；原打印请求保留。')}
    finally{active.current=false;setBusy(false)}
  }
  return <div><button type="button" disabled={busy||queued} aria-busy={busy} onClick={()=>void request()}>
    {queued?'已生成打印任务':busy?'正在确认打印任务':message?'核对本次打印请求':tableSessionId?'打印整桌次完整账单':businessDate?'扎账 · 打印所选期间全店账单':'手动打印本单账单'}
  </button>{message&&<p role="status">{message}</p>}{receipt&&<details><summary>本次打印任务</summary><p>请求号：{receipt.requestId}</p>{receipt.jobIds?.map(id=><p key={id}>{id}</p>)}<button type="button" disabled={busy} onClick={()=>void checkProgress()}>核对任务进度</button></details>}{queued&&<button type="button" disabled={busy} onClick={()=>{if(active.current)return;key.current=null;try{sessionStorage.removeItem(storageKey)}catch{/* Optional storage. */}setReceipt(null);setQueued(false);setMessage('下次点击将生成新的金额快照和新票，请先确认上一张打印结果。')}}>按最新金额生成新账单</button>}</div>
}

type ReportSelection={key:string;mode:NonNullable<BillProps['reportMode']>;grouping:NonNullable<BillProps['reportGrouping']>}
const pendingReports=new Map<string,ReportSelection>()
function readPendingReport(storageKey:string):ReportSelection|null {
  try {
    const raw=sessionStorage.getItem(storageKey)
    if(raw){const parsed=JSON.parse(raw)
      if(parsed&&typeof parsed.key==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(parsed.key)&&['summary','details','both'].includes(parsed.mode)&&['none','products','categories','bundles'].includes(parsed.grouping))return {mode:parsed.mode,grouping:parsed.grouping,key:parsed.key}
    }
  }catch{/* Retain the in-page recovery when browser storage is unavailable. */}
  return pendingReports.get(storageKey)??null
}
function savePendingReport(storageKey:string,selection:ReportSelection|null){
  if(selection)pendingReports.set(storageKey,selection);else pendingReports.delete(storageKey)
  try {if(selection)sessionStorage.setItem(storageKey,JSON.stringify(selection));else sessionStorage.removeItem(storageKey)}catch{/* The original action keeps its in-page request key. */}
}

function DailyReportPrintChoices(props: BillProps) {
  const pendingKey=`mbox-daily-print-pending:${props.employeeId}:${props.businessDate}:${props.endDate??props.businessDate}`
  const [pending,setPending]=useState(()=>readPendingReport(pendingKey))
  const pendingRef=useRef(pending)
  const [mode,setMode]=useState<NonNullable<BillProps['reportMode']>>(pending?.mode??'summary')
  const [grouping,setGrouping]=useState<NonNullable<BillProps['reportGrouping']>>(pending?.grouping??'none')
  const [actionSelection,setActionSelection]=useState<string|null>(pending?`${pending.mode}:${pending.grouping}`:null)
  function requestStateChanged(unknown:boolean,requestKey:string){
    const value=unknown?{mode,grouping,key:requestKey}:null
    pendingRef.current=value;savePendingReport(pendingKey,value);setPending(value)
    // Keep the acknowledged original action visible even if a fresh preview failed.
    setActionSelection(`${mode}:${grouping}`)
  }
  const [preview,setPreview]=useState<{selection:string;orderCount:number;logicalRows:number;estimatedPages:number;lines:Array<{name:string;note?:string|null;quantity:number;totalAmountMinor?:number|null}>}|null>(null)
  const [error,setError]=useState(''),[revision,setRevision]=useState(0)
  const selection=`${mode}:${grouping}`
  useEffect(()=>{
    let current=true;setPreview(null);setError('')
    void props.api.postEndpoint<Omit<NonNullable<typeof preview>,'selection'>>(`/api/hardware/business-days/${encodeURIComponent(props.businessDate!)}/report-preview`,
      {endDate:props.endDate??props.businessDate,mode,grouping}).then(result=>{if(!result||!Array.isArray(result.lines)||!Number.isSafeInteger(result.orderCount))throw new Error('打印预览数据不完整，请重新读取');if(current)setPreview({...result,selection})})
      .catch(reason=>{if(current)setError(reason instanceof Error?reason.message:'打印预览暂不可用')})
    return()=>{current=false}
  },[props.api,props.businessDate,props.endDate,mode,grouping,revision])
  const [hasLegacyRequest] = useState(() => {
    try { return !!sessionStorage.getItem(`mbox-manual-bill:${props.employeeId}:${props.businessDate}${props.endDate&&props.endDate!==props.businessDate?`:${props.endDate}`:''}`) } catch { return false }
  })
  const [legacyChecked,setLegacyChecked] = useState(!hasLegacyRequest)
  return <section aria-label="扎账打印内容">
    {!legacyChecked&&<div><p>这个期间保留了一次旧版打印请求。先核对原任务和出纸情况，再生成新版票据。</p><BillPrintAction {...props} legacyReport/><button type="button" onClick={()=>setLegacyChecked(true)}>已核对旧票，准备新版打印</button></div>}
    {pending&&<p role="status">原打印回执尚未确认，先核对这一次；原格式已保留，不影响其他日期或订单打印。</p>}
    <label>打印内容<select value={mode} disabled={pending!==null} onChange={event=>{if(!pendingRef.current)setMode(event.target.value as typeof mode)}}><option value="summary">紧凑汇总（默认）</option><option value="details">逐单明细</option><option value="both">汇总和明细</option></select></label>
    <label>附加汇总<select value={grouping} disabled={pending!==null} onChange={event=>{if(!pendingRef.current)setGrouping(event.target.value as typeof grouping)}}><option value="none">不附加</option><option value="categories">分类</option><option value="products">商品</option><option value="bundles">套餐与套餐内出品</option></select></label>
    {error?<p role="alert">{error}<button type="button" onClick={()=>setRevision(value=>value+1)}>重试预览</button></p>:!preview||preview.selection!==selection?<p role="status">正在准备打印预览</p>:<>
      <p>{props.businessDate} 至 {props.endDate??props.businessDate}，共{preview.orderCount}单，{preview.logicalRows}条内容，预计至少{preview.estimatedPages}页。实际长度随备注和换行变化；打印时重新取数。</p>
      <details><summary>查看票据内容</summary>{preview.lines.map((line,index)=><p key={index}>{line.name}{line.quantity!==1?` ×${line.quantity}`:''}{line.totalAmountMinor!=null?` ¥${(line.totalAmountMinor/100).toFixed(2)}`:''} {line.note}</p>)}</details>
    </>}
    {legacyChecked&&(actionSelection===selection||preview?.selection===selection)&&<BillPrintAction key={selection} {...props} reportMode={mode} reportGrouping={grouping} recovering={pending!==null} pendingPrintKey={pending?.key} onRequestStateChange={requestStateChanged}/>}
  </section>
}
