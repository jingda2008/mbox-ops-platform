import { ChannelReportPanel } from './ChannelReportPanel'
import { ChannelOperationsPanel } from './ChannelOperationsPanel'
import { ChannelFinancePanel } from './ChannelFinancePanel'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import { channelRuleSchema, channelManagementSchemas, type ChannelRule } from '../shared/channel-distribution'
import { DurableStaffCommand } from './durable-staff-command'
import { beijingDateTimeIso } from './membership-workflow'
import './member-gift-campaign-panel.css'

type Directory = {
  continuity:{tableSessionId:string;tableName:string;previousVisitId:string;customerId:string}[];claims:{id:string;title:string;status:string}[];employees:{id:string;name:string}[];limits:{claimLimit:number;capacityLimit:number;costLimitMinor:string}|null
  partners: { id: string; name: string; settlementSubject: string; promoterId: string; promoterName: string; linked: boolean }[]
  campaigns: { id: string; title: string; acceptingClaims: boolean }[]
  batches: { id: string; promoterId: string; offerCode: string; rule: ChannelRule; acceptingClaims: boolean }[]
  followups: { id: string; promoterId: string; note: string; kind: string; createdAt: string }[]
  products: { id: string; name: string }[]
}
type Intent = { action: 'partner' | 'campaign' | 'batch' | 'invite' | 'followup'; body: object }
export function ChannelManagementPanel({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  const [data, setData] = useState<Directory | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [pending, setPending] = useState(false)
  const [invitation, setInvitation] = useState(''), [promoterId, setPromoter] = useState(''), [campaignId, setCampaign] = useState(''), [productIds, setProducts] = useState<string[]>([]),[commissionProducts,setCommissionProducts]=useState<string[]>([])
  const [allowStacking,setAllowStacking]=useState(false)
  const epoch = useRef(0), writing = useRef(false)
  const canManage = auth.permissions.includes('channel.manage')
  const command = useMemo(() => new DurableStaffCommand<Intent, { token?: string }>(`channel-management:${auth.session.id}`, (intent, key, context) => api.postEndpoint(`/api/staff/channel/${intent.action}`, intent.body, { idempotencyKey: `channel-${key}`, channelRecovery: context.recovery }), undefined, true), [api, auth.session.id])
  const reload = useCallback(async () => {
    const current = epoch.current, result = await api.getEndpoint<{ data: Directory }>('/api/staff/channel/directory')
    if (current === epoch.current) setData(result.data)
  }, [api])
  useEffect(() => {
    epoch.current++; writing.current=false; setBusy(false); setData(null); setInvitation(''); setError(''); setNotice(''); setPromoter(''); setCampaign(''); setProducts([]); setCommissionProducts([]); setAllowStacking(false)
    if (auth.permissions.includes('channel.view')) void reload().catch(e => setError(e.message))
    try { setPending(command.pending() !== null) } catch (e) { setError(message(e)) }
    return () => { epoch.current++ }
  }, [auth.session.id, auth.permissions, reload, command])
  async function mutate(intent?: Intent) {
    if (writing.current) return
    writing.current = true; setBusy(true); setError(''); setNotice('')
    const current = epoch.current
    try {
      const validated = intent ? { ...intent, body: channelManagementSchemas[intent.action].parse(intent.body) } : undefined
      const result = validated ? await command.submit(validated) : await command.recover()
      if (current !== epoch.current) return
      if (result.token) setInvitation(result.token)
      await command.refresh(async()=>{await reload();if(current!==epoch.current)throw new Error('登录状态已变化，请在原账号核对回执')})
      if (current === epoch.current) setNotice('已保存并重新核对。新活动和新批次默认暂停领取。')
    } catch (e) { if (current === epoch.current) setError(message(e)) }
    finally { if (current === epoch.current) { writing.current=false; setBusy(false); try { setPending(command.pending() !== null) } catch { setPending(true) } } }
  }
  function form(event: React.FormEvent<HTMLFormElement>, action: Intent['action']) {
    event.preventDefault(); const fields = new FormData(event.currentTarget), value = (name: string) => String(fields.get(name) ?? '').trim(), integer = (name: string) => Number(value(name))
    try {
      if (action === 'partner') void mutate({ action, body: { name: value('name'), settlementSubject: value('settlementSubject'), promoterName: value('promoterName'), reason: value('reason') } })
      if (action === 'campaign') void mutate({ action, body: { title: value('title'), claimLimit: integer('claimLimit'), capacityLimit: integer('capacityLimit'), costLimitMinor: Math.round(integer('costYuan') * 100), reason: value('reason') } })
      if (action === 'followup') void mutate({ action, body: { promoterId, batchId: null, kind: value('kind'), note: value('note'), nextContactAt: value('nextContactAt') ? beijingDateTimeIso(value('nextContactAt')) : null } })
      if (action === 'batch') {
        const partner = data?.partners.find(p => p.promoterId === promoterId)
        if (!partner) throw new Error('请选择推荐店长')
        const offer = value('kind') === 'credit' ? { kind: 'credit', amountMinor: Math.round(integer('value') * 100) }
          : value('kind') === 'discount' ? { kind: 'discount', discountBps: Math.round(integer('value') * 100), maximumMinor: Math.round(integer('maximum') * 100) }
            : { kind: 'gift', productId: value('giftProductId'), quantity: integer('quantity'), costMinor: Math.round(integer('cost') * 100) }
        const rule = channelRuleSchema.parse({ title: value('title'), totalClaims: integer('N'), perCustomerClaims: integer('K'), perVisitUses: integer('L'),
          claimFrom: beijingDateTimeIso(value('claimFrom')), claimUntil: beijingDateTimeIso(value('claimUntil')), useFrom: beijingDateTimeIso(value('useFrom')), useUntil: beijingDateTimeIso(value('useUntil')),
          allowStacking, visitDiscountCapMinor:allowStacking&&value('visitDiscountCap')?Math.round(integer('visitDiscountCap')*100):null,
          minimumMinor: Math.round(integer('minimum') * 100), eligibleProductIds: productIds,...(commissionProducts.length?{commissionProductIds:commissionProducts}:{}), offer, commissionBps: Math.round(integer('commission') * 100), observationDays: integer('observationDays') })
        void mutate({ action, body: { campaignId, promoterId, rule, contract: { version: value('contractVersion'), settlementSubject: partner.settlementSubject, terms: value('terms') }, reason: value('reason') } })
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
      setNotice('已请求下载推广图。发送后请另行登记跟进，下载不代表已经发送。')
    } catch (e) { if (current === epoch.current) setError(message(e)) }
    finally { if (current === epoch.current) {writing.current=false;setBusy(false)} }
  }
  if (!auth.permissions.includes('channel.view')) return null
  const disabled = busy || pending || !canManage
  return <section key={auth.session.id} className="member-gift-panel" aria-label="渠道合作与推广"><h3>渠道合作与推广</h3>
    <>{data&&<ChannelOperationsPanel api={api} auth={auth} data={data} onRefresh={reload}/>}</>
    <ChannelReportPanel api={api} sessionId={auth.session.id}/>
    <ChannelFinancePanel api={api} auth={auth} partners={data?.partners??[]}/>
    <p>每个推广批次共用二维码和优惠号码。图片可由店长自行下载，也可下载后逐一发给对方并记录跟进。</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <button type="button" disabled={busy} onClick={() => void reload().catch(e => setError(message(e)))}>刷新渠道记录</button>
    {pending && <button type="button" disabled={busy} onClick={() => void mutate()}>恢复上次操作并核对</button>}
    {invitation && <p>官网合作账号邀请链接（请单独交给对应店长，72 小时有效；再次开通将重置原账号并退出旧登录）：<a href={`https://www.shmbox.com/cooperation/#invite=${encodeURIComponent(invitation)}`} target="_blank" rel="noreferrer">{`https://www.shmbox.com/cooperation/#invite=${invitation}`}</a></p>}
    {canManage && <>
      <details><summary>1. 登记合作店和推荐店长</summary><form onSubmit={e => form(e, 'partner')}><fieldset disabled={disabled} className="gift-form-grid">
        <label>合作店名称<input name="name" required minLength={2} maxLength={100}/></label><label>约定佣金结算主体<input name="settlementSubject" required minLength={2} maxLength={200}/></label><label>店长姓名<input name="promoterName" required maxLength={100}/></label><label>登记依据<input name="reason" required minLength={2}/></label><button>保存合作方</button>
      </fieldset></form></details>
      <details><summary>2. 建立活动总额度</summary><form onSubmit={e => form(e, 'campaign')}><fieldset disabled={disabled} className="gift-form-grid">
        <label>活动名称<input name="title" required minLength={2}/></label><label>活动最多发券数<input name="claimLimit" type="number" min="1" max="1000000" required/></label><label>最多可承诺份数<input name="capacityLimit" type="number" min="1" max="1000000" required/></label><label>优惠成本总上限（元）<input name="costYuan" type="number" min="0" step="0.01" required/></label><label>额度依据<input name="reason" required minLength={2}/></label><button>保存暂停状态的活动</button>
      </fieldset></form></details>
      <label>当前推荐店长<select value={promoterId} disabled={busy} onChange={e => setPromoter(e.target.value)}><option value="">请选择</option>{data?.partners.map(p => <option key={p.promoterId} value={p.promoterId}>{p.name} · {p.promoterName}{p.linked ? '（已绑定）' : '（待邀请）'}</option>)}</select></label>
      <button type="button" disabled={disabled || !promoterId} onClick={() => void mutate({ action: 'invite', body: { promoterId } })}>生成官网开通／重置链接</button>
      <details><summary>3. 生成每日专属推广批次</summary><form onSubmit={e => form(e, 'batch')}><fieldset disabled={disabled}>
        <div className="gift-form-grid"><label>所属活动<select value={campaignId} onChange={e => setCampaign(e.target.value)} required><option value="">请选择</option>{data?.campaigns.map(c => <option value={c.id} key={c.id}>{c.title}</option>)}</select></label><label>图片标题<input name="title" required minLength={2} maxLength={100}/></label>
          <label>本批最多领取 N<input name="N" type="number" min="1" max="1000000" required/></label><label>每人限领 K<input name="K" type="number" min="1" max="1000000" defaultValue="1" required/></label><label>每客组限用 L<input name="L" type="number" min="1" max="100" defaultValue="1" required/></label>
          <label><input name="allowStacking" type="checkbox" checked={allowStacking} onChange={e=>setAllowStacking(e.target.checked)}/>允许同客组渠道优惠叠加（默认关闭）</label>{allowStacking&&<label>本次客组总优惠上限（元，可留空）<input name="visitDiscountCap" type="number" min="0.01" max="10000000" step="0.01"/></label>}
          <label>领取开始（北京）<input name="claimFrom" type="datetime-local" required/></label><label>领取截止（北京）<input name="claimUntil" type="datetime-local" required/></label><label>使用开始（北京）<input name="useFrom" type="datetime-local" required/></label><label>使用截止（北京）<input name="useUntil" type="datetime-local" required/></label>
          <label>优惠类型<select name="kind"><option value="credit">金额优惠</option><option value="discount">百分比减免</option><option value="gift">指定赠品</option></select></label><label>减免金额（元）或百分比<input name="value" type="number" min="0" step="0.01"/></label><label>百分比减免封顶（元）<input name="maximum" type="number" min="0" step="0.01"/></label>
          <p>百分比填写减免比例：九折填10，八五折填15。封顶为每张券上限。关闭叠加时本次客组只能用一张渠道券。开启后，同来源同活动多券按原适用金额累加减免；总上限包含赠品正常售价，转桌不重置。上限留空时仍受每券封顶和次数限制，已绑定客组不能提高上限。</p><label>赠品<select name="giftProductId"><option value="">非赠品可留空</option>{data?.products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>每券赠送份数<input name="quantity" type="number" min="1" max="100" defaultValue="1"/></label><p>赠品成本按商品档案自动读取；成本缺失时不能发行。</p><label>使用门槛（元）<input name="minimum" type="number" min="0" step="0.01" defaultValue="0" required/></label>
          <label>佣金比例（%）<input name="commission" type="number" min="0" max="100" step="0.01" defaultValue="10" required/></label><label>结算观察天数<input name="observationDays" type="number" min="0" max="90" defaultValue="7" required/></label><label>合作条款版本<input name="contractVersion" required/></label><label>合作条款摘要<textarea name="terms" required minLength={2} maxLength={3000}/></label><label>生成原因<input name="reason" required minLength={2}/></label>
        </div><p>选择适用商品：</p><div className="gift-options">{data?.products.map(p => <label key={p.id}><input type="checkbox" checked={productIds.includes(p.id)} onChange={e => setProducts(ids => e.target.checked ? [...ids, p.id] : ids.filter(id => id !== p.id))}/>{p.name}</label>)}</div>
        <p>单独选择计佣商品（不选则与优惠适用商品相同；未列入的充值、票务、服务费不计佣）：</p><div className="gift-options">{data?.products.map(p=><label key={p.id}><input type="checkbox" checked={commissionProducts.includes(p.id)} onChange={e=>setCommissionProducts(ids=>e.target.checked?[...ids,p.id]:ids.filter(id=>id!==p.id))}/>{p.name}</label>)}</div>
        <button disabled={!promoterId || !campaignId || !productIds.length}>生成暂停状态的专属批次</button>
      </fieldset></form></details>
      <details><summary>4. 登记发送与合作跟进</summary><form onSubmit={e => form(e, 'followup')}><fieldset disabled={disabled}><label>进展<select name="kind"><option value="sent">已人工发送</option><option value="received">对方确认收到</option><option value="feedback">客户反馈</option><option value="contact">联系跟进</option></select></label><label>记录<textarea name="note" required minLength={2} maxLength={2000}/></label><label>下次联系（北京）<input name="nextContactAt" type="datetime-local"/></label><button disabled={!promoterId}>保存跟进</button></fieldset></form></details>
    </>}
    {canManage&&<button type="button" disabled={busy||!data?.batches.length} onClick={()=>void (async()=>{const started=epoch.current;for(const b of data?.batches??[]){if(started!==epoch.current)break;if(b.acceptingClaims)await download(b.id)}})()}>依次下载当前开放批次（同批次不增额度）</button>}
    <p>推荐话术：吃完饭还想再坐一会儿，可以去 M-BOX。到店出示专属图，由服务员核对优惠和当次桌号；赠品、门槛与有效时间见图。</p>
    <div className="gift-records">{data?.batches.map(b => <article key={b.id}><strong>{b.rule.title}</strong><p>{data.partners.find(p => p.promoterId === b.promoterId)?.name} · {b.offerCode}</p><p>{b.acceptingClaims ? '领取状态以活动总开关和核验为准' : '暂停新领取'}</p>{canManage && <button type="button" disabled={busy} onClick={() => void download(b.id)}>下载推广图，单独发送</button>}</article>)}</div>
    <details><summary>最近跟进</summary>{data?.followups.map(f => <p key={f.id}>{f.createdAt} · {f.note}</p>)}</details>
  </section>
}
function message(error: unknown) {
  if (error instanceof Error && error.name === 'ZodError') return '请核对领取与使用时间、次数、适用商品及所选优惠金额；个人上限不能超过批次总数。'
  return error instanceof Error ? error.message : '操作未确认，请恢复原操作'
}
