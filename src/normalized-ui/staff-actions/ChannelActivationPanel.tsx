import { useEffect, useMemo, useRef, useState } from 'react'
import { STAFF_SESSION_BINDING_HEADER } from '../../shared/staff-session-binding'
import { DurableStaffCommand } from '../durable-staff-command'
import type { ChannelRule,ChannelOffer } from '../../shared/channel-distribution'
import { InventoryBarcodeScanner } from '../InventoryBarcodeScanner'

class SupersededChannelRead extends Error { constructor(){super('本桌状态已有更新，请恢复原操作核对最新回执')} }

export function ChannelActivationPanel({ sessionId, staffSessionId }: { sessionId: string; staffSessionId?: string }) {
  const [code, setCode] = useState(''), [member, setMember] = useState(''), [busy, setBusy] = useState(false)
  const [scanner, setScanner] = useState<'offer' | 'member' | null>(null), [notice, setNotice] = useState(''), [error, setError] = useState('')
  const generation = useRef(0), writing = useRef(false), tableReadSequence = useRef(0)
  const identityScope=`${staffSessionId}:${sessionId}`,currentScope=useRef(identityScope);currentScope.current=identityScope
  const [customers, setCustomers] = useState<{ id: string; label: string }[]>([]), [customerId, setCustomerId] = useState('')
  const [activations, setActivations] = useState<{ id: string; claimId: string; title: string; sourceLabel: string; status: string;offer:ChannelOffer;giftOrderId:string|null;arrivalConfirmed:boolean;allowStacking?:boolean;visitDiscountCapMinor?:number|null;usedDiscountMinor?:string }[]>([])
  const [pending, setPending] = useState(false)
  const [selection, setSelection] = useState('auto')
  const [preview, setPreview] = useState<{ fingerprint: string; rule: ChannelRule; claims: { id: string; status: string; currentTable: boolean }[]; hasMoreClaims: boolean } | null>(null)
  const baseInput = { code: code.trim(), ...(customerId ? { customerId } : { memberCode: member.trim() }), tableSessionId: sessionId }
  const fingerprint = JSON.stringify({ ...baseInput, staffSessionId })
  const currentFingerprint = useRef(fingerprint); currentFingerprint.current = fingerprint
  const validPreview = preview?.fingerprint === fingerprint ? preview : null
  useEffect(() => { setSelection('auto') }, [fingerprint])
  const command = useMemo(() => new DurableStaffCommand<{ code: string; memberCode?: string; customerId?: string; tableSessionId: string; claimId?: string; issueNew?: boolean }, { claimId: string; activationId: string; visitId: string }>(`channel:${staffSessionId}:${sessionId}`, async (input, key, context) => {
    const headers = new Headers({ 'content-type': 'application/json', 'idempotency-key': `channel-${key}` })
    if (staffSessionId) headers.set(STAFF_SESSION_BINDING_HEADER, staffSessionId)
    if (context.recovery) headers.set('x-channel-recovery', '1')
    const response = await fetch('/api/staff/channel/activate', { method: 'POST', credentials: 'include', headers, body: JSON.stringify(input), signal: AbortSignal.timeout(15000) })
    const body = await response.json()
    if (!response.ok) throw Object.assign(new Error(body.error?.message ?? '绑定未确认，请恢复原操作'), { status: response.status, code: body.error?.code, commitDisposition: body.error?.commitDisposition })
    if (!body.data?.claimId || !body.data?.activationId) throw new Error('未取得完整回执，请恢复原操作')
    return body.data
  }, undefined, true), [staffSessionId, sessionId])
  async function readCustomers(signal?: AbortSignal) {
    if(currentScope.current!==identityScope) throw new SupersededChannelRead()
    const sequence=++tableReadSequence.current
    const current=()=>sequence===tableReadSequence.current&&currentScope.current===identityScope
    try {
    const headers = new Headers(); if (staffSessionId) headers.set(STAFF_SESSION_BINDING_HEADER, staffSessionId)
    const response = await fetch(`/api/staff/channel/table/${sessionId}`, { credentials: 'include', headers, signal: signal ?? AbortSignal.timeout(15000) })
    const body = await response.json()
    if (!current()) throw new SupersededChannelRead()
    if (!response.ok) throw new Error(body.error?.message ?? '本桌顾客暂时无法读取')
    return body.data as { customers: { id: string; label: string }[]; activations: { id: string; claimId: string; title: string; sourceLabel: string; status: string;offer:ChannelOffer;giftOrderId:string|null;arrivalConfirmed:boolean;allowStacking?:boolean;visitDiscountCapMinor?:number|null;usedDiscountMinor?:string }[] }
    } catch(e) { if(!current()) throw new SupersededChannelRead(); throw e }
  }
  useEffect(() => { generation.current++; setCode(''); setMember(''); setError(''); setNotice(''); setBusy(false); setScanner(null); setPreview(null); return () => { generation.current++ } }, [sessionId, staffSessionId])
  useEffect(() => {
    const ac = new AbortController(); setCustomers([]); setActivations([]); setCustomerId('')
    try { setPending(command.pending() !== null) } catch (e) { setError(e instanceof Error ? e.message : '原操作记录异常') }
    void readCustomers(ac.signal).then(rows => { if (!ac.signal.aborted) { setCustomers(rows.customers); setActivations(rows.activations) } }).catch(e => { if (!ac.signal.aborted && !(e instanceof SupersededChannelRead)) setError(e.message) })
    return () => ac.abort()
    // Identity and table scope are the complete read boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, staffSessionId, command])
  async function loadPreview() {
    if (writing.current) return
    writing.current = true; setBusy(true); setError(''); setPreview(null)
    const current = generation.current, requested = fingerprint
    try {
      const headers = new Headers({ 'content-type': 'application/json' }); if (staffSessionId) headers.set(STAFF_SESSION_BINDING_HEADER, staffSessionId)
      const response = await fetch('/api/staff/channel/preview', { method: 'POST', credentials: 'include', headers, body: JSON.stringify(baseInput), signal: AbortSignal.timeout(15000) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error?.message ?? '优惠暂时无法预览')
      if (current === generation.current && currentFingerprint.current === requested) setPreview({ ...body.data, fingerprint: requested })
    } catch (e) { if (current === generation.current) setError(e instanceof Error ? e.message : '预览失败') }
    finally { writing.current = false; if (current === generation.current) setBusy(false) }
  }
  async function submit(recover = false) {
    if (writing.current || (!recover && !validPreview)) return
    writing.current = true; setBusy(true); setError(''); setNotice('')
    const current = generation.current, input = { ...baseInput, ...(selection === 'new' ? { issueNew: true } : selection !== 'auto' ? { claimId: selection } : {}) }
    try {
      const result = recover ? await command.recover() : await command.submit(input)
      let stillBound = false
      await command.refresh(async () => { const rows = await readCustomers(); stillBound = rows.activations.some(a => a.claimId === result.claimId); if (current === generation.current) { setCustomers(rows.customers); setActivations(rows.activations) } })
      if (current === generation.current) { setPreview(null); setNotice(stillBound ? `本次消费已绑定。券号 ${result.claimId.slice(-8)}。绑定记录不代表商品已出品或订单已付款。` : '原操作回执已核对；该券当前未绑定此桌，请查看最新绑定记录。') }
    } catch (e) { if (current === generation.current) setError(e instanceof Error ? e.message : '请核对原操作') }
    finally { writing.current = false; if (current === generation.current) { setBusy(false); try { setPending(command.pending() !== null) } catch { setPending(true) } } }
  }
  return <details className="table-service-panel"><summary>渠道优惠 · 核验绑定本桌</summary>
    <p>新版推广图请输入图上的优惠号码；官方小程序码由顾客用微信识别。先确认顾客已入座当前桌。已有券自动复用；同一批客人换桌、拆单不增加可用次数。</p>
    {activations[0]?.usedDiscountMinor!==undefined&&<p>本次客组：{activations[0].allowStacking?'允许叠加':'不叠加'} · 已占用优惠 ¥{(Number(activations[0].usedDiscountMinor)/100).toFixed(2)} · {activations[0].visitDiscountCapMinor==null?'未设客组总上限':`总上限 ¥${(activations[0].visitDiscountCapMinor/100).toFixed(2)}`}，换桌不重置。</p>}
    {activations.map(a => <p key={a.id}>当前绑定：{a.sourceLabel} · {a.title} · {a.status === 'fulfilled' ? '已兑现' : '待兑现'}{a.offer?.kind==='gift'&&<ChannelGiftAction claimId={a.claimId} sessionId={sessionId} staffSessionId={staffSessionId} orderId={a.giftOrderId} onRefresh={async()=>{if(currentScope.current!==identityScope)throw new Error('请返回原桌次核对回执');const rows=await readCustomers();if(currentScope.current!==identityScope)throw new Error('请返回原桌次核对回执');setActivations(rows.activations)}}/>}</p>)}
    {activations.some(a=>!a.arrivalConfirmed)&&<ChannelGiftAction arrival claimId={sessionId} sessionId={sessionId} staffSessionId={staffSessionId} orderId={null} onRefresh={async()=>{if(currentScope.current!==identityScope)throw new Error('请返回原桌次核对回执');const rows=await readCustomers();if(currentScope.current!==identityScope)throw new Error('请返回原桌次核对回执');setActivations(rows.activations)}}/>}
    <label>推广图上的优惠号码<input value={code} disabled={busy || pending} maxLength={100} onChange={e => setCode(e.target.value)}/></label>
    <button type="button" disabled={busy || pending} onClick={() => setScanner('offer')}>扫描旧版业务二维码</button>
    <label>本桌已确认身份的顾客<select value={customerId} disabled={busy || pending} onChange={e => setCustomerId(e.target.value)}><option value="">改用会员码识别</option>{customers.map(c => <option value={c.id} key={c.id}>{c.label}</option>)}</select></label>
    <label>顾客会员码或会员号<input value={member} disabled={busy || pending} maxLength={160} onChange={e => setMember(e.target.value)}/></label>
    <button type="button" disabled={busy || pending} onClick={() => setScanner('member')}>扫描顾客会员码</button>
    <button type="button" disabled={busy || pending || code.trim().length < 8 || (!member.trim() && !customerId)} onClick={() => void loadPreview()}>查看优惠与顾客已有券</button>
    {validPreview && <div>
      <p>{validPreview.rule.title} · 每人限领 {validPreview.rule.perCustomerClaims} 次 · 本次客组限用 {validPreview.rule.perVisitUses} 次 · 满 ¥{(validPreview.rule.minimumMinor / 100).toFixed(2)}</p>
      <p>{validPreview.rule.offer.kind === 'gift' ? `${validPreview.rule.offer.productName ?? '指定赠品'} ${validPreview.rule.offer.quantity} 份` : validPreview.rule.offer.kind === 'credit' ? `优惠 ¥${(validPreview.rule.offer.amountMinor / 100).toFixed(2)}` : `减免 ${validPreview.rule.offer.discountBps / 100}%，最多 ¥${(validPreview.rule.offer.maximumMinor / 100).toFixed(2)}`}</p>
      <p>{validPreview.rule.allowStacking ? `允许渠道券叠加 · ${validPreview.rule.visitDiscountCapMinor == null ? '未设置客组总上限' : `客组总优惠最高 ¥${(validPreview.rule.visitDiscountCapMinor/100).toFixed(2)}`}（含赠品售价；不同批次取更严限制，转桌不重置）` : '不允许叠加，本次客组只能使用一张渠道券'}</p>
      <p>适用：{validPreview.rule.eligibleProductNames?.map(p => p.name).join('、') ?? '请核对适用商品'}。截止：{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(validPreview.rule.useUntil))}（北京时间）。</p>
      <label>本次使用方式<select value={selection} disabled={busy || pending} onChange={e => setSelection(e.target.value)}>
        <option value="auto">自动复用已有券，无有效券时领取</option>
        {validPreview.claims.map(c => <option key={c.id} value={c.id} disabled={c.status !== 'available' && !c.currentTable}>券 {c.id.slice(-8)} · {c.currentTable ? '已绑定本次消费' : c.status === 'available' ? '待使用' : '不可用于本桌'}</option>)}
        {validPreview.rule.perCustomerClaims > 1 && <option value="new">明确新增领取一张（占用本批次和个人额度）</option>}
      </select></label>
      {validPreview.hasMoreClaims && <p>仅显示前100张，请优先通过顾客券包选择，不能据此判断剩余额度。</p>}
      <button type="button" disabled={busy || pending} onClick={() => void submit()}>{busy ? '正在确认…' : '确认顾客与本桌并绑定'}</button>
    </div>}
    {pending && <button type="button" disabled={busy} onClick={() => void submit(true)}>恢复上次绑定并核对</button>}
    {error && <p role="alert">{error}。若刚才网络中断，请保留相同内容重试，系统恢复原请求。</p>}{notice && <p role="status">{notice}</p>}
    {scanner && <InventoryBarcodeScanner title={scanner === 'offer' ? '扫描推广图二维码' : '扫描顾客会员码'} cameraLabel="渠道核验摄像头" onClose={() => setScanner(null)} onDetected={value => { if (scanner === 'offer') setCode(value); else setMember(value); setScanner(null) }}/ >}
  </details>
}

function ChannelGiftAction({claimId,sessionId,staffSessionId,orderId,onRefresh,arrival=false}:{arrival?:boolean;claimId:string;sessionId:string;staffSessionId?:string;orderId:string|null;onRefresh:()=>Promise<void>}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState(false)
 const command=useMemo(()=>new DurableStaffCommand<{claimId?:string;tableSessionId:string;action?:'arrival';reason?:string},{orderId?:string;id?:string}>(`channel-gift:${staffSessionId}:${sessionId}:${claimId}`,async(input,key,context)=>{
  const headers=new Headers({'content-type':'application/json','idempotency-key':`channel-${key}`});if(staffSessionId)headers.set(STAFF_SESSION_BINDING_HEADER,staffSessionId)
  if(context.recovery)headers.set('x-channel-recovery','1')
  const response=await fetch(arrival?'/api/staff/channel/operations':'/api/staff/channel/fulfill-gift',{method:'POST',credentials:'include',headers,body:JSON.stringify(input),signal:AbortSignal.timeout(15000)}),body=await response.json()
  if(!response.ok)throw Object.assign(new Error(body.error?.message??'赠品出品未确认'),{status:response.status,code:body.error?.code,commitDisposition:body.error?.commitDisposition})
  if(!body.data?.orderId&&!body.data?.id)throw new Error('未取得完整赠品订单回执');return body.data
 },undefined,true),[staffSessionId,claimId,sessionId,arrival])
 useEffect(()=>{try{setPending(command.pending()!==null)}catch(e){setError(e instanceof Error?e.message:'回执异常')}},[command])
 async function run(){if(busy)return;setBusy(true);setError('');try{if(pending)await command.recover();else await command.submit(arrival?{tableSessionId:sessionId,action:'arrival',reason:'员工现场核对本人已入座'}:{claimId,tableSessionId:sessionId});await command.refresh(onRefresh)}catch(e){setError(e instanceof Error?e.message:'请恢复原出品操作')}finally{setBusy(false);try{setPending(command.pending()!==null)}catch{setPending(true)}}}
 return <span>{orderId?` · 已生成赠品订单 ${orderId.slice(-8)}，制作状态见出品单`:''}{(!orderId||pending)&&<button type="button" disabled={busy} onClick={()=>void run()}>{pending?'恢复原操作':arrival?'现场确认顾客已到店':'核对门槛并下赠品单'}</button>}{error&&<span role="alert">{error}</span>}</span>
}
