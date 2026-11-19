import { ChannelRuleSummary } from './ChannelRuleSummary'
import { ChannelProductSelector } from './ChannelProductSelector'
import {channelBatchDraft, type ChannelBatchTemplate} from './channel-batch-template'
import {beijingDisplayTime} from './beijing-display-time'
import { ChannelReportPanel } from './ChannelReportPanel'
import { ChannelOperationsPanel, type ChannelOperationTarget } from './ChannelOperationsPanel'
import { ChannelFinancePanel } from './ChannelFinancePanel'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import { channelRuleSchema, channelManagementSchemas, type ChannelRule } from '../shared/channel-distribution'
import { DurableStaffCommand } from './durable-staff-command'
import { beijingDateTimeIso } from './membership-workflow'
import './member-gift-campaign-panel.css'
import './channel-workflow.css'

type Directory = {
  continuity:{tableSessionId:string;tableName:string;previousVisitId:string;customerId:string}[];claims:{id:string;title:string;status:string}[];employees:{id:string;name:string}[];limits:{claimLimit:number;capacityLimit:number;costLimitMinor:string}|null
  partners: { id: string; name: string; settlementSubject: string; promoterId: string; promoterName: string; linked: boolean;status?:string;canConfirmStatement?:boolean;restaurantScope?:boolean;contactEmployeeId?:string|null;partnerStatus?:string;hasVerifiedAccount?:boolean }[]
  campaigns: { id: string; title: string; acceptingClaims: boolean;staffEntryEnabled?:boolean;selfEntryEnabled?:boolean }[]
  batches: { id: string; promoterId: string; campaignId?:string; offerCode: string; rule: ChannelRule; acceptingClaims: boolean;createdBy?:string|null;approvedAt?:string|null;contract?:{version:string;terms:string;settlementSubject:string} }[]
  followups: { id: string; batchId?:string|null; promoterId: string; note: string; kind: string; createdAt: string }[]
  products: { id: string; name: string }[]
}
type Intent = { action: 'partner' | 'campaign' | 'batch' | 'invite' | 'followup'; body: object }
export function ChannelManagementPanel({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  const [data, setData] = useState<Directory | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [pending, setPending] = useState(false)
  const [invitation, setInvitation] = useState(''), [promoterId, setPromoter] = useState(''), [campaignId, setCampaign] = useState(''), [productIds, setProducts] = useState<string[]>([]),[commissionProducts,setCommissionProducts]=useState<string[]>([])
  const [allowStacking,setAllowStacking]=useState(false)
  const [offerKind,setOfferKind]=useState<ChannelRule['offer']['kind']>('credit'),[batchDraft,setBatchDraft]=useState<ReturnType<typeof channelBatchDraft>|null>(null),[draftVersion,setDraftVersion]=useState(0)
  const [directoryFresh,setDirectoryFresh]=useState(false)
  const [templatePromoterId,setTemplatePromoter]=useState(''),[copiedFrom,setCopiedFrom]=useState('')
  const selectionKey=`mbox.channel-flow.selection:${auth.session.id}`
  const [selectedBatchId,setSelectedBatchId]=useState(''),[review,setReview]=useState<Intent|null>(null),[operationTarget,setOperationTarget]=useState<ChannelOperationTarget>()
  const [financeTarget,setFinanceTarget]=useState<{partnerId:string;sequence:number}>()
  const followSection=useRef<HTMLDetailsElement>(null),reuseSection=useRef<HTMLDetailsElement>(null)
  const selectedBatch=useRef(''),flowSection=useRef<HTMLElement>(null),setupSection=useRef<HTMLDetailsElement>(null),financeSection=useRef<HTMLDetailsElement>(null)
  const batchSection=useRef<HTMLDetailsElement>(null),readSequence=useRef(0),selectedPromoter=useRef(promoterId);selectedPromoter.current=promoterId
  const draftValue=(name:keyof ReturnType<typeof channelBatchDraft>['fields'],fallback='')=>batchDraft?.fields[name]??fallback
  const epoch = useRef(0), writing = useRef(false)
  const canManage = auth.permissions.includes('channel.manage')
  const command = useMemo(() => new DurableStaffCommand<Intent, { token?: string;id?:string;promoterId?:string;offerCode?:string }>(`channel-management:${auth.session.id}`, (intent, key, context) => api.postEndpoint(`/api/staff/channel/${intent.action}`, intent.body, { idempotencyKey: `channel-${key}`, channelRecovery: context.recovery }), undefined, true), [api, auth.session.id])
  const reload = useCallback(async () => {
    setDirectoryFresh(false)
    const current = epoch.current, sequence=++readSequence.current, result = await api.getEndpoint<{ data: Directory }>(`/api/staff/channel/directory${selectedBatch.current?'?batchId='+encodeURIComponent(selectedBatch.current):''}`)
    if (current === epoch.current && sequence===readSequence.current){setData(result.data);setDirectoryFresh(true);const b=result.data.batches.find(b=>b.id===selectedBatch.current);if(b)setPromoter(b.promoterId)}
  }, [api])
  useEffect(() => {
    epoch.current++; writing.current=false; setBusy(false); setData(null); setInvitation(''); setError(''); setNotice(''); setPromoter(''); setCampaign(''); setProducts([]); setCommissionProducts([]); setAllowStacking(false); setOfferKind('credit'); setBatchDraft(null); setDraftVersion(v=>v+1);setReview(null);setSelectedBatchId('');selectedBatch.current='';setOperationTarget(undefined);setFinanceTarget(undefined);setTemplatePromoter('');setCopiedFrom('')
    try{const id=sessionStorage.getItem(selectionKey)??'';if(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)){selectedBatch.current=id;setSelectedBatchId(id)}}catch{/* Selection is a convenience; durable commands remain separately protected. */}
    if (auth.permissions.includes('channel.view')) void reload().catch(e => setError(e.message))
    try { setPending(command.pending() !== null) } catch (e) { setError(message(e)) }
    return () => { epoch.current++ }
  }, [auth.session.id, auth.permissions, reload, command,selectionKey])
  function changePromoter(id:string) {
    setPromoter(id);setCampaign('');setReview(null);selectBatchId('');setBatchDraft(null);setDraftVersion(v=>v+1);setOfferKind('credit');setProducts([]);setCommissionProducts([]);setAllowStacking(false);setNotice('');setError('');setTemplatePromoter('');setCopiedFrom('')
  }
  async function copyPrevious(sourceId=promoterId) {
    if(writing.current||pending||!canManage||!promoterId)return
    const current=epoch.current,owner=promoterId,other=sourceId!==promoterId;writing.current=true;setBusy(true);setError('');setNotice('')
    try {
      const result=await api.getEndpoint<{data:ChannelBatchTemplate|null}>(`/api/staff/channel/batch-template/${sourceId}`)
      if(current!==epoch.current||selectedPromoter.current!==owner)return
      if(!result.data)throw new Error(other?'所选商家还没有优惠方案，请选择已生成过优惠的商家':'这位店长还没有可复制的历史批次，请先填写首次配置，或沿用其他商家的优惠方案')
      const draft=channelBatchDraft(result.data)
      const sourceName=data?.partners.find(p=>p.promoterId===sourceId)?.name??'所选商家'
      if(other)draft.fields.reason='沿用已有优惠方案，核对本商家合作条款'
      const needed=[...draft.productIds,...draft.commissionProducts,...(draft.kind==='gift'?[draft.fields.giftProductId]:[])]
      if(needed.some(id=>!data?.products.some(p=>p.id===id)))throw new Error('原批次有已停用或不在当前列表的商品，请刷新核对后重新配置，不自动删减原适用范围')
      if(!data?.campaigns.some(c=>c.id===draft.campaignId))throw new Error('原活动不在当前列表，请刷新核对后重新配置')
      setCopiedFrom(other?sourceName:'');setReview(null);selectBatchId('');setBatchDraft(draft);setDraftVersion(v=>v+1);setCampaign(draft.campaignId);setProducts(draft.productIds);setCommissionProducts(draft.commissionProducts);setAllowStacking(draft.allowStacking);setOfferKind(draft.kind)
      if(batchSection.current)batchSection.current.open=true
      setNotice(other?`已沿用${sourceName}的优惠方案。请填写本次时间，核对佣金、条款和标题适用于当前商家；专属码和佣金归属将绑定当前推荐店长。`:'已复制这位店长上一批配置。请填写本次领取和使用时间，核对后生成；新批次仍需另一人审批，原图和已用额度不会改变。')
    }catch(e){if(current===epoch.current)setError(message(e))}
    finally{if(current===epoch.current){writing.current=false;setBusy(false)}}
  }
  async function mutate(intent?: Intent) {
    if (writing.current) return
    writing.current = true; setBusy(true); setError(''); setNotice('')
    const current = epoch.current
    try {
      const validated = intent ? { ...intent, body: channelManagementSchemas[intent.action].parse(intent.body) } : undefined
      const original = validated ?? command.pending()?.body
      const result = validated ? await command.submit(validated) : await command.recover()
      if (current !== epoch.current) return
      if (result.token) setInvitation(result.token)
      if(original?.action==='partner'&&result.promoterId){changePromoter(result.promoterId);if(reuseSection.current)reuseSection.current.open=true}
      if(original?.action==='campaign'&&result.id)setCampaign(result.id)
      if(original?.action==='batch'&&result.id){selectBatchId(result.id);setPromoter((original.body as {promoterId:string}).promoterId);setReview(null)}
      await command.refresh(async()=>{await reload();if(current!==epoch.current)throw new Error('登录状态已变化，请在原账号核对回执')})
      if(original?.action==='batch'){if(batchSection.current)batchSection.current.open=false;flowSection.current?.scrollIntoView({block:'nearest'})}
      if (current === epoch.current) setNotice(original?.action==='followup'?'跟进记录已保存。':original?.action==='invite'?'官网开通链接已生成，请单独交给对应店长。':original?.action==='batch'?'本批次已生成，继续在下方核对、审批和下载；请勿重复生成。':'已保存并重新核对。新活动默认暂停领取。')
    } catch (e) { if (current === epoch.current) setError(message(e)) }
    finally { if (current === epoch.current) { writing.current=false; setBusy(false); try { setPending(command.pending() !== null) } catch { setPending(true) } } }
  }
  function form(event: React.FormEvent<HTMLFormElement>, action: Intent['action']) {
    event.preventDefault(); const fields = new FormData(event.currentTarget), value = (name: string) => String(fields.get(name) ?? '').trim(), integer = (name: string) => Number(value(name))
    try {
      if (action === 'partner') void mutate({ action, body: { name: value('name'), settlementSubject: value('settlementSubject'), promoterName: value('promoterName'), reason: value('reason') } })
      if (action === 'campaign') void mutate({ action, body: { title: value('title'), claimLimit: integer('claimLimit'), capacityLimit: integer('capacityLimit'), costLimitMinor: Math.round(integer('costYuan') * 100), reason: value('reason') } })
      if (action === 'followup'&&['sent','received'].includes(value('kind'))&&!currentBatch)throw new Error('请先选择本次推广批次，再登记发送或收到')
      if (action === 'followup') void mutate({ action, body: { promoterId, batchId: selectedBatchId || null, kind: value('kind'), note: value('note'), nextContactAt: value('nextContactAt') ? beijingDateTimeIso(value('nextContactAt')) : null } })
      if (action === 'batch') {
        const partner = data?.partners.find(p => p.promoterId === promoterId)
        if (!partner) throw new Error('请选择推荐店长')
        if(copiedFrom&&fields.get('confirmReusedTerms')!=='on')throw new Error('请核对沿用方案的佣金和合作条款是否适用于当前商家')
        const offer = value('kind') === 'credit' ? { kind: 'credit', amountMinor: Math.round(integer('value') * 100) }
          : value('kind') === 'discount' ? { kind: 'discount', discountBps: Math.round(integer('value') * 100), maximumMinor: Math.round(integer('maximum') * 100) }
            : { kind: 'gift', productId: value('giftProductId'), quantity: integer('quantity'), costMinor: 0 }
        const rule = channelRuleSchema.parse({ title: value('title'), totalClaims: integer('N'), perCustomerClaims: integer('K'), perVisitUses: integer('L'),
          claimFrom: beijingDateTimeIso(value('claimFrom')), claimUntil: beijingDateTimeIso(value('claimUntil')), useFrom: beijingDateTimeIso(value('useFrom')), useUntil: beijingDateTimeIso(value('useUntil')),
          allowStacking, visitDiscountCapMinor:allowStacking&&value('visitDiscountCap')?Math.round(integer('visitDiscountCap')*100):null,
          minimumMinor: Math.round(integer('minimum') * 100), eligibleProductIds: productIds,...(commissionProducts.length?{commissionProductIds:commissionProducts}:{}), offer, commissionBps: Math.round(integer('commission') * 100), observationDays: integer('observationDays') })
        setReview({ action, body: channelManagementSchemas.batch.parse({ campaignId, promoterId, rule, contract: { version: value('contractVersion'), settlementSubject: partner.settlementSubject, terms: value('terms') }, reason: value('reason') }) })
      }
    } catch (e) { setError(message(e)) }
  }
  async function download(id: string) {
    if (writing.current) return
    const current = epoch.current; writing.current = true; setBusy(true); setError('')
    try {
      const result = await api.getEndpoint<{ data: { base64: string; filename: string } }>(`/api/staff/channel/poster/${id}?format=data`)
      if (current !== epoch.current) return
      const bytes = Uint8Array.from(atob(result.data.base64), c => c.charCodeAt(0)), url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
      const a = document.createElement('a'); a.href = url; a.download = result.data.filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice('已请求下载推广图。发送后请另行登记跟进，下载不代表已经发送。');if(followSection.current){followSection.current.open=true;followSection.current.scrollIntoView({block:'nearest'})}
    } catch (e) { if (current === epoch.current) setError(message(e)) }
    finally { if (current === epoch.current) {writing.current=false;setBusy(false)} }
  }
  function selectBatchId(id:string){selectedBatch.current=id;setSelectedBatchId(id);try{if(id)sessionStorage.setItem(selectionKey,id);else sessionStorage.removeItem(selectionKey)}catch{/* Directory lookup and command recovery still work without selection storage. */}}
  function focusOperation(action:string,id=''){setOperationTarget({action,id,sequence:Date.now()})}
  function openSetup(){if(setupSection.current){setupSection.current.open=true;setupSection.current.scrollIntoView({block:'nearest'})}}
  function openFinance(){if(partner)setFinanceTarget({partnerId:partner.id,sequence:Date.now()});if(financeSection.current){financeSection.current.open=true;financeSection.current.scrollIntoView({block:'nearest'})}}
  function continueBatch(id:string){const b=data?.batches.find(x=>x.id===id);if(!b)return;if(b.promoterId!==promoterId)changePromoter(b.promoterId);selectBatchId(id);setReview(null);void reload().catch(e=>setError(message(e)))}
  const currentBatch=data?.batches.find(b=>b.id===selectedBatchId&&b.promoterId===promoterId)
  const partner=data?.partners.find(p=>p.promoterId===promoterId)
  const campaign=data?.campaigns.find(c=>c.id===(currentBatch?.campaignId??campaignId))
  const canDownload=!!currentBatch&&currentBatch.acceptingClaims&&partner?.status==='active'&&partner.partnerStatus==='active'&&campaign?.acceptingClaims===true&&(campaign.selfEntryEnabled===true||campaign.staffEntryEnabled===true)&&Date.parse(currentBatch.rule.claimUntil)>Date.now()
  const reviewBody=review?.body as {rule:ChannelRule;contract:{version:string;terms:string;settlementSubject:string};campaignId:string}|undefined
  const latestSent=data?.followups.find(f=>f.batchId===selectedBatchId&&f.promoterId===promoterId&&f.kind==='sent')
  if (!auth.permissions.includes('channel.view')) return null
  const disabled = busy || pending || !canManage || !directoryFresh
  return <section key={auth.session.id} className="member-gift-panel" aria-label="周边店合作"><h3>周边店合作</h3>
    <p className="channel-flow-heading">选商家 → 配优惠 → 核对并生成 → 独立审批 → 下载发图 → 登记发送</p>
    <p>日常发券沿下方顺序操作；首次配置收在页末，生成后自动保留本批次。审批由另一管理员在自己的账号完成。</p>
    <p>每个推广批次共用二维码和优惠号码。图片可由店长自行下载，也可下载后逐一发给对方并记录跟进。</p>
    {!directoryFresh&&data&&<p role="alert">当前状态尚未刷新成功，请刷新核对后继续，暂不生成或下载。</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <button type="button" disabled={busy} onClick={() => void reload().catch(e => setError(message(e)))}>刷新周边店合作记录</button>
    {pending && <button type="button" disabled={busy} onClick={() => void mutate()}>恢复上次操作并核对</button>}
    {invitation && <p>官网合作账号邀请链接（请单独交给对应店长，72 小时有效；再次开通将重置原账号并退出旧登录）：<a href={`https://www.shmbox.com/cooperation/#invite=${encodeURIComponent(invitation)}`} target="_blank" rel="noreferrer">{`https://www.shmbox.com/cooperation/#invite=${invitation}`}</a></p>}
    {canManage && <>
      <label>当前推荐店长<select value={promoterId} disabled={disabled} onChange={e => changePromoter(e.target.value)}><option value="">请选择</option>{data?.partners.map(p => <option key={p.promoterId} value={p.promoterId}>{p.name} · {p.promoterName}{p.linked ? '（已绑定）' : '（待邀请）'}</option>)}</select></label>
      <button type="button" disabled={disabled||!promoterId} onClick={()=>void copyPrevious()}>复制这位店长上一批配置</button>
      <button type="button" disabled={disabled} onClick={openSetup}>首次合作／补充基础配置</button>
      {partner&&<p>已保存商家：{partner.name} · 店长：{partner.promoterName} · 结算主体：{partner.settlementSubject}。无需重新登记；全店额度和已有活动也可继续使用。</p>}
      <details ref={reuseSection} className="channel-flow-card"><summary>新商家快速配置：沿用已有优惠方案</summary>
        <p>先选择当前推荐店长，再选一家已配好优惠的商家。全店第一家合作商户需要先配置一次。带入优惠、商品、次数、佣金和条款；本次时间重新确认，商家身份、账号、收款账户、审批及已领额度不复制。</p>
        <label>优惠方案来源<select value={templatePromoterId} disabled={disabled||!promoterId} onChange={e=>setTemplatePromoter(e.target.value)}><option value="">选择参考商家（取最近一批）</option>{data?.partners.filter(p=>p.promoterId!==promoterId).map(p=><option key={p.promoterId} value={p.promoterId}>{p.name} · {p.promoterName}</option>)}</select></label>
        <button type="button" disabled={disabled||!promoterId||!templatePromoterId} onClick={()=>void copyPrevious(templatePromoterId)}>沿用方案到当前商家</button>
        <p>沿用原活动时，多家商户共用该活动总额度；不会为新商家自动扩大预算或开通权限。</p>
      </details>
      <details ref={batchSection}><summary>配置本次优惠</summary><form key={draftVersion} onChange={()=>setReview(null)} onSubmit={e => form(e, 'batch')}><fieldset disabled={disabled}>
        <div className="gift-form-grid"><label>所属活动<select value={campaignId} onChange={e => setCampaign(e.target.value)} required><option value="">请选择</option>{data?.campaigns.map(c => <option value={c.id} key={c.id}>{c.title}</option>)}</select></label><label>图片标题<input name="title" defaultValue={draftValue('title')} required minLength={2} maxLength={100}/></label>
          <label>本批最多领取 N<input name="N" defaultValue={draftValue('N')} type="number" min="1" max="1000000" required/></label><label>每人限领 K<input name="K" defaultValue={draftValue('K', '1')} type="number" min="1" max="1000000" required/></label><label>每客组限用 L<input name="L" defaultValue={draftValue('L', '1')} type="number" min="1" max="100" required/></label>
          <label><input name="allowStacking" type="checkbox" checked={allowStacking} onChange={e=>setAllowStacking(e.target.checked)}/>允许同客组渠道优惠叠加（默认关闭）</label>{allowStacking&&<label>本次客组总优惠上限（元，可留空）<input name="visitDiscountCap" defaultValue={draftValue('visitDiscountCap')} type="number" min="0.01" max="10000000" step="0.01"/></label>}
          <label>领取开始（北京）<input name="claimFrom" defaultValue={draftValue('claimFrom')} type="datetime-local" required/></label><label>领取截止（北京）<input name="claimUntil" defaultValue={draftValue('claimUntil')} type="datetime-local" required/></label><label>使用开始（北京）<input name="useFrom" defaultValue={draftValue('useFrom')} type="datetime-local" required/></label><label>使用截止（北京）<input name="useUntil" defaultValue={draftValue('useUntil')} type="datetime-local" required/></label>
          <label>优惠类型<select name="kind" value={offerKind} onChange={e=>setOfferKind(e.target.value as ChannelRule['offer']['kind'])}><option value="credit">金额优惠</option><option value="discount">百分比减免</option><option value="gift">指定赠品</option></select></label>
          {offerKind!=='gift'&&<label>{offerKind==='credit'?'减免金额（元）':'减免百分比（九折填10）'}<input key={offerKind} name="value" type="number" min="0.01" max={offerKind==='discount'?100:10000000} step="0.01" required defaultValue={batchDraft?.kind===offerKind?draftValue('value'):''}/></label>}
          {offerKind==='discount'&&<><label>百分比减免封顶（元）<input name="maximum" type="number" min="0.01" step="0.01" required defaultValue={batchDraft?.kind==='discount'?draftValue('maximum'):''}/></label><p>九折填10，八五折填15。封顶为每张券最多减免金额。</p></>}
          {offerKind==='gift'&&<><label>赠品<select name="giftProductId" required defaultValue={batchDraft?.kind==='gift'?draftValue('giftProductId'):''}><option value="">请选择赠品</option>{data?.products.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>每券赠送份数<input name="quantity" type="number" min="1" max="100" required defaultValue={batchDraft?.kind==='gift'?draftValue('quantity'):'1'}/></label><p>赠品成本按当前商品档案重新核对；缺成本不能发行，领取时校验库存。</p></>}
          <p>不叠加时每客组只能使用一张渠道券；叠加时赠品按正常售价计入客组总优惠，转桌不重置。</p>
          <label>使用门槛（元）<input name="minimum" defaultValue={draftValue('minimum', '0')} type="number" min="0" step="0.01" required/></label>
          <label>佣金比例（%）<input name="commission" defaultValue={draftValue('commission', '10')} type="number" min="0" max="100" step="0.01" required/></label><label>结算观察天数<input name="observationDays" defaultValue={draftValue('observationDays', '7')} type="number" min="0" max="90" required/></label><label>合作条款版本<input name="contractVersion" defaultValue={draftValue('contractVersion')} required/></label><label>合作条款摘要<textarea name="terms" defaultValue={draftValue('terms')} required minLength={2} maxLength={3000}/></label><label>生成原因<input name="reason" defaultValue={draftValue('reason')} required minLength={2}/></label>
        </div><ChannelProductSelector label="适用商品" products={data?.products??[]} selected={productIds} onChange={setProducts}/>
        <ChannelProductSelector label="计佣商品" products={data?.products??[]} selected={commissionProducts} onChange={setCommissionProducts} hint="不选则与适用商品相同；未列入的充值、票务、服务费不计佣。"/>
        {copiedFrom&&<label className="channel-reuse-confirm"><input name="confirmReusedTerms" type="checkbox" required/>已核对来自{copiedFrom}的标题、佣金和条款适用于{partner?.name}；结算主体为{partner?.settlementSubject}</label>}
        <button disabled={!promoterId || !campaignId || !productIds.length}>核对配置，进入下一步</button>
      </fieldset></form></details>
    </>}
    {reviewBody&&<section className="channel-flow-card" aria-label="生成前核对"><h4>核对配置后生成待审批批次</h4>
      <p>{partner?.name} · {partner?.promoterName}</p>
      <ChannelRuleSummary rule={reviewBody.rule} contract={reviewBody.contract} products={data?.products}/>
      <button type="button" disabled={disabled} onClick={()=>void mutate(review!)}>确认生成待审批批次</button>
      <button type="button" disabled={disabled} onClick={()=>{setReview(null);if(batchSection.current)batchSection.current.open=true}}>返回修改</button>
    </section>}
    <section ref={flowSection} className="channel-flow-card" aria-label="本次发券进度"><h4>本次发券进度</h4>
      <label>继续处理已有批次<select value={selectedBatchId} disabled={disabled} onChange={e=>e.target.value?continueBatch(e.target.value):selectBatchId('')}><option value="">请选择，或在上方生成新批次</option>{data?.batches.filter(b=>!promoterId||b.promoterId===promoterId).map(b=><option key={b.id} value={b.id}>{data.partners.find(p=>p.promoterId===b.promoterId)?.name??'合作商户'} · {b.rule.title} · {b.offerCode} · {b.acceptingClaims?'已发布':'待审批或已停发'}</option>)}</select></label>
      {selectedBatchId&&!currentBatch&&<p role="alert">当前批次尚未读回，请刷新核对；不要重新生成，也不会自动改选其他批次。</p>}
      {currentBatch&&<><p><strong>{partner?.name} · {partner?.promoterName} · {currentBatch.offerCode}</strong></p>
        <ChannelRuleSummary rule={currentBatch.rule} contract={currentBatch.contract} products={data?.products} saved/>
        {campaign?.staffEntryEnabled&&!campaign.selfEntryEnabled&&<p>当前仅开放员工代领：请告知顾客到店出示原图，由服务员核验；微信自领尚未开启。</p>}
        <p>{currentBatch.acceptingClaims?'审批发布已完成':'待另一管理员审批，或已暂停领取'}{!currentBatch.createdBy?'；创建人记录缺失，请管理员核查':currentBatch.createdBy===auth.session.employeeId?'；本账号是创建人，不能自行审批':''}。</p>
        {!currentBatch.acceptingClaims&&currentBatch.createdBy!==auth.session.employeeId&&<button type="button" disabled={disabled||!currentBatch.createdBy} onClick={()=>focusOperation('publish',currentBatch.id)}>核对并审批本批次</button>}
        <button type="button" disabled={busy} onClick={()=>void reload().catch(e=>setError(message(e)))}>刷新本批审批状态</button>
        <button type="button" disabled={disabled||!canDownload} onClick={()=>void download(currentBatch.id)}>下载本批推广图</button>
        <p>{latestSent?`已登记发送：${beijingDisplayTime(latestSent.createdAt)}（北京）`:'尚未登记发送。下载成功后用微信发原图，再在下方登记；下载不等于发送。'}</p>
        {Date.parse(currentBatch.rule.claimUntil)<=Date.now()&&<p role="alert">本批领取已截止，请复制配置生成新批次，不要发送旧图。</p>}
      </>}
      {partner&&<><h4>配置检查与补齐</h4>
        {partner.status!=='active'||partner.partnerStatus!=='active'?<p>商家或推荐人未启用／状态待核对。<button type="button" disabled={disabled} onClick={()=>focusOperation('promoter',promoterId)}>核对推荐人设置</button></p>:null}
        {!data?.limits||data.limits.claimLimit<=0||data.limits.capacityLimit<=0?<p>全店发券额度未配置或为零。<button type="button" disabled={disabled} onClick={()=>focusOperation('limits')}>设置全店额度</button></p>:null}
        {!campaign?<p>尚未选择活动。<button type="button" disabled={disabled} onClick={()=>{if(batchSection.current){batchSection.current.open=true;batchSection.current.scrollIntoView({block:'nearest'})}}}>选择活动与优惠</button></p>:!campaign.acceptingClaims||!campaign.selfEntryEnabled||!campaign.staffEntryEnabled?<p>活动或领取入口未全部启用。顾客扫码需要“顾客自行新领取”，员工代领需要“员工代办新领取”。<button type="button" disabled={disabled} onClick={()=>focusOperation('campaign',campaign.id)}>核对本活动入口</button></p>:null}
        {!partner.contactEmployeeId||!partner.canConfirmStatement?<p>联系人或店长确认结算权限未配置。<button type="button" disabled={disabled} onClick={()=>focusOperation('promoter',promoterId)}>补齐推荐人配置</button></p>:null}
        {!partner.linked&&<p>官网账号待开通。<button type="button" disabled={disabled} onClick={openSetup}>开通官网账号</button></p>}
        {partner.hasVerifiedAccount!==true&&<p>佣金收款账户尚未核实／待核对。{auth.permissions.includes('channel.settle')?<button type="button" onClick={openFinance}>登记并复核账户</button>:'请财务在本页完成账户登记和独立复核。'}</p>}
        <p>以上核对配置状态，不预留额度或库存；领取时系统仍会实时检查累计额度、库存和有效时间。</p>
      </>}
    </section>
    {data&&<ChannelOperationsPanel api={api} auth={auth} data={data} onRefresh={reload} target={operationTarget}/>}
    {canManage&&<section className="channel-flow-card" aria-label="发送与跟进">
      <p>当前跟进：{currentBatch?`${partner?.name} · ${currentBatch.offerCode}`:'尚未选定批次；普通联系可登记，发送记录必须选择批次。'}</p>
      <details ref={followSection}><summary>发送与合作跟进</summary><form key={`${auth.session.id}:${promoterId}:${selectedBatchId}`} onSubmit={e => form(e, 'followup')}><fieldset disabled={disabled}><label>进展<select name="kind"><option value="sent">已人工发送</option><option value="received">对方确认收到</option><option value="feedback">客户反馈</option><option value="contact">联系跟进</option></select></label><label>记录<textarea name="note" required minLength={2} maxLength={2000}/></label><label>下次联系（北京）<input name="nextContactAt" type="datetime-local"/></label><button disabled={!promoterId}>保存跟进</button></fieldset></form></details>
    </section>}
    {canManage&&<details ref={setupSection}><summary>首次配置（首次合作或调整时使用）</summary>
      <details><summary>1. 登记合作店和推荐店长（仅新商家填写）</summary><form onSubmit={e => form(e, 'partner')}><fieldset disabled={disabled} className="gift-form-grid">
        <label>合作店名称<input name="name" required minLength={2} maxLength={100}/></label><label>约定佣金结算主体<input name="settlementSubject" required minLength={2} maxLength={200}/></label><label>店长姓名<input name="promoterName" required maxLength={100}/></label><label>登记依据<input name="reason" required minLength={2}/></label><button>保存合作方</button>
      </fieldset></form></details>
      <details><summary>2. 建立活动总额度</summary><form onSubmit={e => form(e, 'campaign')}><fieldset disabled={disabled} className="gift-form-grid">
        <label>活动名称<input name="title" required minLength={2}/></label><label>活动最多发券数<input name="claimLimit" type="number" min="1" max="1000000" required/></label><label>最多可承诺份数<input name="capacityLimit" type="number" min="1" max="1000000" required/></label><label>优惠成本总上限（元）<input name="costYuan" type="number" min="0" step="0.01" required/></label><label>额度依据<input name="reason" required minLength={2}/></label><button>保存暂停状态的活动</button>
      </fieldset></form></details>
      <button type="button" disabled={disabled || !promoterId} onClick={() => void mutate({ action: 'invite', body: { promoterId } })}>生成官网开通／重置链接</button>
      <p>当前推荐店长：{partner?`${partner.name} · ${partner.promoterName}`:'先登记合作方，保存后自动选中。'}。员工授权由管理员在系统配置完成，不会自动扩大权限。</p>
      <button type="button" disabled={disabled} onClick={()=>focusOperation('limits')}>设置全店总上限</button>
      <button type="button" disabled={disabled||!campaignId} onClick={()=>focusOperation('campaign',campaignId)}>配置当前活动入口</button>
      <button type="button" disabled={disabled||!promoterId} onClick={()=>focusOperation('promoter',promoterId)}>配置当前推荐人</button>
    </details>}
    <details ref={financeSection}><summary>财务与合作效果（按岗位操作）</summary><ChannelFinancePanel api={api} auth={auth} partners={data?.partners??[]} target={financeTarget} onChanged={reload}/><ChannelReportPanel api={api} sessionId={auth.session.id}/></details>
    <p>推荐话术：吃完饭还想再坐一会儿，可以去 M-BOX。微信识别专属图领取优惠；门槛、商品和有效时间见图。</p>
    <details><summary>最近跟进</summary>{data?.followups.filter(f=>(!promoterId||f.promoterId===promoterId)&&(!selectedBatchId||f.batchId===selectedBatchId)).map(f => <p key={f.id}>{beijingDisplayTime(f.createdAt)}（北京时间） · {f.note}</p>)}</details>
  </section>
}
function message(error: unknown) {
  if (error instanceof Error && error.name === 'ZodError') return '请核对领取与使用时间、次数、适用商品及所选优惠金额；个人上限不能超过批次总数。'
  return error instanceof Error ? error.message : '操作未确认，请恢复原操作'
}
