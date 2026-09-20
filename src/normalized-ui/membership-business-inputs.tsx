import { useEffect, useState } from 'react'

export interface ConfigurationReference { kind: string; id: string; name: string; status: string }

/** Decimal arithmetic: never silently round user money or accept exponent notation. */
export function yuanInputToMinor(input: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(input.trim())) return null
  const [whole, decimals = ''] = input.trim().split('.')
  const minor = BigInt(whole) * 100n + BigInt(decimals.padEnd(2, '0'))
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null
}
export function minorToYuanInput(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return ''
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`
}
export function MoneyField({ label, value, onChange }: { label: string; value: number; onChange(value: number): void }) {
  const [text, setText] = useState(() => minorToYuanInput(value))
  useEffect(() => { setText(previous => yuanInputToMinor(previous) === value ? previous : minorToYuanInput(value)) }, [value])
  return <label>{label}<input inputMode="decimal" required value={text} onChange={event => {
    const input = event.currentTarget
    setText(input.value)
    const minor = yuanInputToMinor(input.value)
    input.setCustomValidity(minor === null ? '请输入金额，最多两位小数' : '')
    if (minor !== null) onChange(minor)
  }} /></label>
}

const referenceLabels: Record<string, string> = { tierPolicyVersionId: '适用等级规则', benefitDefinitionId: '发放权益', productId: '兑换商品', activityId: '关联活动' }
const statusLabels: Record<string, string> = { draft: '草稿', approved: '待发布', published: '已发布', active: '启用', paused: '已暂停', retired: '已停用', inactive: '已下架', sold_out: '已售罄', cancelled: '已取消', completed: '已结束', closed: '已结束', registration_closed: '停止报名' }
export function ReferenceField({ fieldKey, value, references, onChange }: { fieldKey: string; value: unknown; references: ConfigurationReference[] | null; onChange(value: string | null): void }) {
  const options = references?.filter(item => item.kind === fieldKey) ?? []
  const current = options.find(item => item.id === value)
  return <label>{referenceLabels[fieldKey]}<select disabled={references === null} value={typeof value === 'string' ? value : ''} onChange={event => onChange(event.target.value || null)}>
    <option value="">{references === null ? '选项未读取，请重试' : '未关联'}</option>
    {value && !current ? <option value={String(value)} disabled>原关联记录当前不可用，请核对后选择</option> : null}
    {options.map(item => <option key={item.id} value={item.id}>{item.name} · {statusLabels[item.status] ?? '状态待核对'}</option>)}
  </select></label>
}
export function isReferenceField(key: string) { return key in referenceLabels }

export function BusinessRatioFields({ content, onChange }: { content: Record<string, unknown>; onChange(value: Record<string, unknown>): void }) {
  return <>{ratioDefinitions.filter(pair => typeof content[pair.numerator] === 'number' && typeof content[pair.denominator] === 'number').map(pair => <fieldset className="membership-business-ratio" key={pair.numerator}><legend>{pair.label}</legend>
    {pair.money ? <MoneyField label="每消费（元）" value={Number(content[pair.denominator])} onChange={value => onChange({ ...content, [pair.denominator]: value })} /> : <label>每获得基础积分<input type="number" required min={1} step={1} value={Number(content[pair.denominator])} onChange={event => onChange({ ...content, [pair.denominator]: Number(event.target.value) })} /></label>}
    <label>{pair.award}<input type="number" required min={0} step={1} value={Number(content[pair.numerator])} onChange={event => onChange({ ...content, [pair.numerator]: Number(event.target.value) })} /></label>
    <small>{pair.money ? `每消费 ${minorToYuanInput(Number(content[pair.denominator]))} 元，获得 ${content[pair.numerator]} ${pair.unit}。` : `每 ${content[pair.denominator]} 基础积分实际记 ${content[pair.numerator]} 积分，保留原规则精确比例。`}</small>
  </fieldset>)}</>
}
const ratioDefinitions = [
  { numerator: 'pointsNumerator', denominator: 'pointsDenominatorMinor', label: '消费积分', award: '获得积分', unit: '积分', money: true },
  { numerator: 'growthNumerator', denominator: 'growthDenominatorMinor', label: '消费成长值', award: '获得成长值', unit: '成长值', money: true },
  { numerator: 'silverPointsMultiplierNumerator', denominator: 'silverPointsMultiplierDenominator', label: '银卡积分奖励', award: '实际记入积分', unit: '积分', money: false },
  { numerator: 'goldPointsMultiplierNumerator', denominator: 'goldPointsMultiplierDenominator', label: '金卡积分奖励', award: '实际记入积分', unit: '积分', money: false },
]
export function isRatioField(key: string) { return ratioDefinitions.some(pair => pair.numerator === key || pair.denominator === key) }
