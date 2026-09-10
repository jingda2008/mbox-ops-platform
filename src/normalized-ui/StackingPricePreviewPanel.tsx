import { useEffect, useRef, useState } from 'react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import { NumberInputWithUnit } from './NumberInputWithUnit'
import './stacking-price-preview-panel.css'
import { executeRecoverableCommand } from './recoverable-command'
import { createIdempotencyKey } from './cashier-mutation'
import {useConfirmationDialog} from './ConfirmationDialog'

interface Preview {
  payableMinor: number; discountMinor: number; grossProfitMinor: number | null
  steps: Array<{ effectId: string; discountMinor: number; payableMinor: number }>
}
interface Draft { id: string; code: string; version: number; status: 'draft'|'approved'|'published'|'stopped';createdByEmployeeId:string;decisions:Array<{action:string;employeeId:string}>; policy: {
  allowMemberPrice: boolean; allowBundlePrice: boolean; allowOtherCoupons: boolean; allowPoints: boolean
  allowCheckoutUpgrade:boolean
  maxCoupons: number; calculationOrder: string[]; maximumDiscountMinor: number | null; minimumPayableMinor: number
} }
const orders = ['member,coupon,points', 'coupon,member,points', 'member,points,coupon', 'coupon,points,member', 'points,member,coupon', 'points,coupon,member']
const names: Record<string, string> = { member: '会员价', coupon: '优惠券', points: '积分' }
function minor(value: string): number {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value)) throw new Error('金额请输入不超过两位小数的非负数')
  const [whole, fraction = ''] = value.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}
function cash(value: number): string { return `¥${(value / 100).toFixed(2)}` }

export function StackingPricePreviewPanel({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  const [form, setForm] = useState({ price: '68', cost: '', couponValue: '9.9', kind: 'fixed_price',
    member: false, bundle: false, upgrade:false, other: false, points: false, memberRate: '90', second: '0', pointsAmount: '0',
    maxCoupons: '1', maximum: '', minimum: '0', order: orders[0]! })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Preview | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [code, setCode] = useState('DEFAULT')
  const [version, setVersion] = useState(0)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [selected,setSelected]=useState<Draft|null>(null)
  const mutation=useRef(false)
  const {confirmAction}=useConfirmationDialog()
  const generation = useRef(0)
  useEffect(() => () => { generation.current += 1 }, [])
  function change<K extends keyof typeof form>(key: K, value: typeof form[K]) {
    generation.current += 1; setBusy(false); setResult(null); setError('')
    setForm(current => ({ ...current, [key]: value, ...(key === 'other' ? { maxCoupons: value ? '2' : '1' } : {}) }))
  }
  function policy() { return { allowMemberPrice: form.member, allowBundlePrice: form.bundle, allowOtherCoupons: form.other, allowPoints: form.points,
    allowCheckoutUpgrade:form.upgrade,
    maxCoupons: Number(form.maxCoupons), calculationOrder: form.order.split(','), maximumDiscountMinor: form.maximum === '' ? null : minor(form.maximum), minimumPayableMinor: minor(form.minimum) } }
  async function loadDrafts() {
    const current = ++generation.current
    setBusy(true); setError('')
    try {
      const response = await api.getEndpoint<{ data: Draft[] }>('/api/staff/loyalty/stacking-price-drafts')
      if (generation.current === current) setDrafts(response.data)
    } catch (failure) { if (generation.current === current) setError(failure instanceof Error ? failure.message : '草稿读取失败') }
    finally { if (generation.current === current) setBusy(false) }
  }
  function openDraft(draft: Draft) {
    setSelected(draft)
    generation.current += 1; setBusy(false); setError(''); setResult(null); setNotice(''); setCode(draft.code); setVersion(draft.version)
    setForm(current => ({ ...current, member: draft.policy.allowMemberPrice, bundle: draft.policy.allowBundlePrice, other: draft.policy.allowOtherCoupons,
      points: draft.policy.allowPoints,upgrade:draft.policy.allowCheckoutUpgrade===true, maxCoupons: String(draft.policy.maxCoupons), order: draft.policy.calculationOrder.join(','),
      maximum: draft.policy.maximumDiscountMinor === null ? '' : (draft.policy.maximumDiscountMinor / 100).toFixed(2), minimum: (draft.policy.minimumPayableMinor / 100).toFixed(2) }))
  }
  async function saveDraft() {
    if(mutation.current)return
    mutation.current=true
    const current = ++generation.current
    setSaving(true); setBusy(false); setError(''); setNotice('')
    try {
      const body = { code, expectedVersion: version, reason, policy: policy() }
      const path = '/api/staff/loyalty/stacking-price-drafts'
      const saved = await executeRecoverableCommand(`${auth.employee.id}:${path}`, body, createIdempotencyKey('stacking-draft'),
        idempotencyKey => api.postEndpoint<Draft>(path, body, { idempotencyKey }))
      if (generation.current === current) {
        setVersion(saved.version); setDrafts(currentDrafts => [saved, ...currentDrafts.filter(item => item.id !== saved.id)].slice(0, 50))
        setSelected(saved)
        setNotice(`已保存 ${saved.code} 第${saved.version}版草稿，尚未发布，不改变订单价格。`)
      }
    } catch (failure) { if (generation.current === current) setError(failure instanceof Error ? failure.message : '草稿保存结果未确认，请重试核对') }
    finally { mutation.current=false;if (generation.current === current) setSaving(false) }
  }
  async function decide(action:'approve'|'publish'|'stop_issuing'){
    if(!selected||mutation.current||reason.trim().length<2)return
    mutation.current=true;setSaving(true);setError('');setNotice('')
    const current=++generation.current
    try{
      if(!await confirmAction({title:'确认叠加规则操作',description:`${{approve:'审核',publish:'发布',stop_issuing:'停止新发券使用'}[action]} ${selected.code} 第${selected.version}版？以已保存版本为准，当前未保存的表单修改不包含在内。`,confirmLabel:'确认记录'})||generation.current!==current)return
      const path=`/api/staff/loyalty/stacking-price-drafts/${selected.id}/decisions`,body={action,reason:reason.trim()}
      const saved=await executeRecoverableCommand(`${auth.employee.id}:${path}`,body,createIdempotencyKey('stacking-decision'),key=>api.postEndpoint<Draft>(path,body,{idempotencyKey:key}))
      if(generation.current===current){setSelected(saved);setDrafts(previous=>previous.map(row=>row.id===saved.id?saved:row));setNotice('决定已保存；不会改变已发券的原承诺。')}
    }catch(failure){if(generation.current===current)setError(failure instanceof Error?failure.message:'决定结果未确认，请刷新核对')}
    finally{mutation.current=false;if(generation.current===current)setSaving(false)}
  }
  async function preview() {
    const current = ++generation.current
    setBusy(true); setError(''); setResult(null)
    try {
      const couponValue = form.kind === 'free' ? 0 : minor(form.couponValue)
      const effects = [{ id: 'coupon', stage: 'coupon', kind: form.kind, value: couponValue, unitIds: ['portion'], minimumSpendMinor: 0 }]
      if (form.member) effects.push({ id: 'member', stage: 'member', kind: 'rate', value: minor(form.memberRate), unitIds: ['portion'], minimumSpendMinor: 0 })
      if (form.other) effects.push({ id: 'second-coupon', stage: 'coupon', kind: 'amount_off', value: minor(form.second), unitIds: ['portion'], minimumSpendMinor: 0 })
      if (form.points) effects.push({ id: 'points', stage: 'points', kind: 'amount_off', value: minor(form.pointsAmount), unitIds: ['portion'], minimumSpendMinor: 0 })
      const value = await api.postEndpoint<Preview>('/api/staff/loyalty/stacking-price-preview', {
        policy: policy(),
        scenario: { units: [{ id: 'portion', amountMinor: minor(form.price), costMinor: form.cost === '' ? null : minor(form.cost), bundle: form.bundle }], effects },
      })
      if (generation.current === current) setResult(value)
    } catch (reason) {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : '试算失败，请重试')
    } finally { if (generation.current === current) setBusy(false) }
  }
  const amount = (label: string, key: 'price' | 'cost' | 'couponValue' | 'memberRate' | 'second' | 'pointsAmount' | 'maximum' | 'minimum', unit = '元') => <label>{label}<NumberInputWithUnit unit={unit} value={form[key]} inputMode="decimal" onChange={event => change(key, event.target.value)} /></label>
  return <details className="stacking-preview"><summary>优惠叠加规则试算</summary>
    <p>试算使用模拟数据。保存新增不可变草稿；审核和发布由不同授权员工完成。发布规则本身不发券、不改变既有订单。成本为空时不按零成本估算毛利。</p>
    <button type="button" disabled={busy || saving} onClick={() => void loadDrafts()}>读取最近50个草稿版本</button>
    {drafts.length > 0 && <label>选择版本<select disabled={saving} value="" onChange={event => { const draft = drafts.find(item => item.id === event.target.value); if (draft) openDraft(draft) }}><option value="">选择后载入叠加规则</option>{drafts.map(draft => <option key={draft.id} value={draft.id}>{draft.code} · 第{draft.version}版（{{draft:'草稿',approved:'已审核',published:'已发布',stopped:'已停发'}[draft.status]}）</option>)}</select></label>}
    <fieldset disabled={saving}><legend>配置与模拟数据</legend>
    <div className="stacking-preview-grid">
      {amount('一份商品原价', 'price')}{amount('该份实际成本（可留空）', 'cost')}
      <label>券的方式<select value={form.kind} onChange={event => change('kind', event.target.value)}><option value="fixed_price">固定兑换价</option><option value="amount_off">减免金额</option><option value="rate">应付比例折扣</option><option value="free">免费一份</option></select></label>
      {form.kind !== 'free' && amount(form.kind === 'rate' ? '券后应付比例' : form.kind === 'fixed_price' ? '兑换价' : '减免金额', 'couponValue', form.kind === 'rate' ? '%' : '元')}
    </div>
    <fieldset><legend>允许叠加（本次试算同时应用）</legend><div className="stacking-preview-switches">
      {(['member', 'bundle', 'other', 'points'] as const).map(key => <label key={key}><input type="checkbox" checked={form[key]} onChange={event => change(key, event.target.checked)} />{{ member: '会员价', bundle: '套餐价商品', other: '其他券', points: '积分' }[key]}</label>)}
    </div></fieldset>
    <label><input type="checkbox" checked={form.upgrade} onChange={event=>change('upgrade',event.target.checked)}/>允许此券用于已确认升级后的套餐（仍须校验全部叠加规则）</label>
    <div className="stacking-preview-grid">
      {form.member && amount('会员应付比例（九折填90）', 'memberRate', '%')}
      {form.other && <>{amount('第二张券减免', 'second')}<label>最多用券数<NumberInputWithUnit unit="张" inputMode="numeric" min={1} max={10} value={form.maxCoupons} onChange={event => change('maxCoupons', event.target.value)} /></label></>}
      {form.points && amount('积分折算抵扣金额', 'pointsAmount')}
      <label>计算顺序<select value={form.order} onChange={event => change('order', event.target.value)}>{orders.map(order => <option key={order} value={order}>{order.split(',').map(stage => names[stage]).join(' → ')}</option>)}</select></label>
      {amount('优惠上限（空为不设）', 'maximum')}{amount('最低实付', 'minimum')}
    </div>
    <button type="button" disabled={busy || saving} onClick={() => void preview()}>{busy ? '正在读取…' : '服务端试算'}</button>
    {auth.permissions.includes('loyalty.configuration.edit') && <div className="stacking-preview-grid"><label>规则编号<input value={code} maxLength={40} onChange={event => { setCode(event.target.value); setVersion(0); setNotice('') }} /></label><label>修改原因<input value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></label><button type="button" disabled={busy || saving || reason.trim().length < 2} onClick={() => void saveDraft()}>{saving ? '正在保存…' : `保存为第${version + 1}版草稿`}</button></div>}
    </fieldset>
    {selected&&<section aria-label="已保存规则审核"><h4>{selected.code} · 第{selected.version}版（已保存内容）</h4><p>会员价：{selected.policy.allowMemberPrice?'允许':'禁止'}；套餐价：{selected.policy.allowBundlePrice?'允许':'禁止'}；升级：{selected.policy.allowCheckoutUpgrade?'允许':'禁止'}；其他券：{selected.policy.allowOtherCoupons?'允许':'禁止'}；积分：{selected.policy.allowPoints?'允许':'禁止'}。</p><p>最多 {selected.policy.maxCoupons} 张券；顺序：{selected.policy.calculationOrder.map(stage=>names[stage]).join(' → ')}；优惠上限：{selected.policy.maximumDiscountMinor===null?'不设':cash(selected.policy.maximumDiscountMinor)}；最低实付：{cash(selected.policy.minimumPayableMinor)}。</p>
      <label>审核／发布／停发原因<input value={reason} maxLength={500} disabled={saving} onChange={event=>setReason(event.target.value)}/></label>
      {selected.status==='draft'&&selected.createdByEmployeeId!==auth.employee.id&&auth.permissions.includes('loyalty.configuration.approve')&&<button disabled={saving||reason.trim().length<2} onClick={()=>void decide('approve')}>审核已保存版本</button>}
      {selected.status==='approved'&&selected.createdByEmployeeId!==auth.employee.id&&!selected.decisions.some(d=>d.action==='approve'&&d.employeeId===auth.employee.id)&&auth.permissions.includes('loyalty.policy.publish')&&<button disabled={saving||reason.trim().length<2} onClick={()=>void decide('publish')}>发布已审核版本</button>}
      {selected.status==='published'&&auth.permissions.includes('loyalty.policy.publish')&&<button disabled={saving||reason.trim().length<2} onClick={()=>void decide('stop_issuing')}>停止新发券使用</button>}
    </section>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {result && <div role="status"><strong>实付 {cash(result.payableMinor)} · 优惠 {cash(result.discountMinor)}</strong><p>预计毛利：{result.grossProfitMinor === null ? '成本不完整，不能计算' : cash(result.grossProfitMinor)}（未扣房租、人工等费用）</p><ol>{result.steps.map(step => <li key={step.effectId}>{names[step.effectId] ?? '第二张券'}：减 {cash(step.discountMinor)}，剩余 {cash(step.payableMinor)}</li>)}</ol></div>}
  </details>
}
