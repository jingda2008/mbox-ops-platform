import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, CirclePlus, LoaderCircle, PackageOpen, Pencil } from 'lucide-react'
import { NormalizedApiClient, type StaffAuthView } from '../normalized-api'

type ProductStatus = 'active' | 'sold_out' | 'inactive'
type ProductKind = 'single' | 'bundle'
type FulfillmentStation = 'bar' | 'kitchen' | 'cashier' | 'none'

interface CatalogProduct {
  id: string
  code: string
  name: string
  categoryCode: string
  fulfillmentStation: FulfillmentStation
  productKind: ProductKind
  bundleComponents: Array<{ productId: string; quantity: number; sortOrder: number; note: string | null }>
  productSnapshot: Record<string, unknown>
  status: ProductStatus
  standardPrice: null | { amountMinor: string | null; currency: string | null }
  updatedAt: string
}

interface ProductDraft {
  id: string | null
  code: string
  name: string
  categoryCode: string
  fulfillmentStation: FulfillmentStation
  productKind: ProductKind
  status: ProductStatus
  guestVisible: boolean
  searchText: string
  recommendationEnabled: boolean
  recommendationMinGuests: string
  recommendationMaxGuests: string
  recommendationPriority: string
  recommendationSceneTags: string
  recommendationIntentTags: string
  recommendationTasteTags: string
  recommendationDwellTags: string
  recommendationSingleWaveEligible: boolean
  recommendationExpectedPrepMinutes: string
  recommendationHoldMinutes: string
  recommendationUpgradeProductId: string
  sortOrder: string
  availableFrom: string
  availableUntil: string
  allowedChannels: string[]
  maxOrderQuantity: string
  kdsPriority: string
  fulfillmentSlaSeconds: string
  costYuan: string
  priceYuan: string
  priceReason: string
  description: string
  imageUrl: string
  snapshot: Record<string, unknown>
  componentQuantities: Record<string, string>
}

export function CatalogManagementPanel({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  const canManageProduct = auth.permissions.includes('catalog.product.manage')
  const canManagePrice = auth.permissions.includes('catalog.price.manage')
  const [expanded, setExpanded] = useState(false)
  const [products, setProducts] = useState<CatalogProduct[]>([])
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<ProductDraft | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    setPhase('loading')
    try {
      const response = await api.getEndpoint<{ data: unknown }>('/api/catalog/products?status=all&limit=100')
      setProducts(readProducts(response.data))
      setPhase('ready')
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '商品资料读取失败' })
      setPhase('error')
    }
  }, [api])

  useEffect(() => {
    if (expanded && phase === 'idle') void load()
  }, [expanded, load, phase])

  const visibleProducts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    if (normalized === '') return products
    return products.filter((product) => [product.code, product.name, product.categoryCode]
      .some((value) => value.toLocaleLowerCase('zh-CN').includes(normalized)))
  }, [products, query])

  const singleProducts = useMemo(() => products.filter((product) => (
    product.productKind === 'single' && product.id !== draft?.id
  )), [draft?.id, products])

  if (!canManageProduct) return null

  const startCreate = () => {
    setDraft(emptyDraft())
    setShowAdvanced(false)
    setNotice(null)
  }

  const startEdit = (product: CatalogProduct) => {
    const recommendation = objectValue(product.productSnapshot.recommendation)
    setDraft({
      id: product.id,
      code: product.code,
      name: product.name,
      categoryCode: product.categoryCode,
      fulfillmentStation: product.fulfillmentStation,
      productKind: product.productKind,
      status: product.status,
      guestVisible: product.productSnapshot.guestVisible !== false,
      searchText: typeof product.productSnapshot.searchText === 'string' ? product.productSnapshot.searchText : '',
      recommendationEnabled: recommendation.enabled === true,
      recommendationMinGuests: integerText(recommendation.minimumPartySize, '1'),
      recommendationMaxGuests: integerText(recommendation.maximumPartySize, '100'),
      recommendationPriority: integerText(recommendation.priority, '100'),
      recommendationSceneTags: stringList(recommendation.sceneTags),
      recommendationIntentTags: stringList(recommendation.intentTags),
      recommendationTasteTags: stringList(recommendation.tasteTags),
      recommendationDwellTags: stringList(recommendation.dwellTags),
      recommendationSingleWaveEligible: recommendation.singleWaveEligible !== false,
      recommendationExpectedPrepMinutes: integerText(recommendation.expectedPrepMinutes, '8'),
      recommendationHoldMinutes: integerText(recommendation.holdMinutes, '10'),
      recommendationUpgradeProductId: typeof recommendation.upgradeProductId === 'string' ? recommendation.upgradeProductId : '',
      sortOrder: integerText(product.productSnapshot.sortOrder, '999'),
      availableFrom: typeof product.productSnapshot.availableFrom === 'string' ? product.productSnapshot.availableFrom : '',
      availableUntil: typeof product.productSnapshot.availableUntil === 'string' ? product.productSnapshot.availableUntil : '',
      allowedChannels: stringArray(product.productSnapshot.allowedChannels, ['guest_qr', 'staff_assisted', 'cashier', 'reservation', 'integration']),
      maxOrderQuantity: integerText(product.productSnapshot.maxOrderQuantity, '50'),
      kdsPriority: integerText(product.productSnapshot.kdsPriority, '100'),
      fulfillmentSlaSeconds: integerText(product.productSnapshot.fulfillmentSlaSeconds, ''),
      costYuan: minorToYuan(product.productSnapshot.costAmount),
      priceYuan: minorToYuan(product.standardPrice?.amountMinor ?? null),
      priceReason: '商品配置同步调整标准售价',
      description: typeof product.productSnapshot.description === 'string' ? product.productSnapshot.description : '',
      imageUrl: typeof product.productSnapshot.imageUrl === 'string' ? product.productSnapshot.imageUrl : '',
      snapshot: product.productSnapshot,
      componentQuantities: Object.fromEntries(product.bundleComponents.map((component) => [component.productId, String(component.quantity)])),
    })
    setShowAdvanced(false)
    setNotice(null)
  }

  const updateDraft = <Key extends keyof ProductDraft>(key: Key, value: ProductDraft[Key]) => {
    setDraft((current) => current === null ? null : { ...current, [key]: value })
  }

  const toggleComponent = (productId: string) => {
    if (draft === null) return
    const quantities = { ...draft.componentQuantities }
    if (productId in quantities) delete quantities[productId]
    else quantities[productId] = '1'
    updateDraft('componentQuantities', quantities)
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (draft === null || busy) return
    const minimum = readInteger(draft.recommendationMinGuests, 1, 200)
    const maximum = readInteger(draft.recommendationMaxGuests, 1, 200)
    const priority = readInteger(draft.recommendationPriority, 0, 1000)
    const prepMinutes = readInteger(draft.recommendationExpectedPrepMinutes, 0, 240)
    const holdMinutes = readInteger(draft.recommendationHoldMinutes, 0, 240)
    const sortOrder = readInteger(draft.sortOrder, 0, 100_000)
    const maxOrderQuantity = readInteger(draft.maxOrderQuantity, 1, 9_999)
    const kdsPriority = readInteger(draft.kdsPriority, 0, 1_000)
    const fulfillmentSlaSeconds = draft.fulfillmentSlaSeconds.trim() === ''
      ? null : readInteger(draft.fulfillmentSlaSeconds, 30, 14_400)
    const sceneTags = readEnumList(draft.recommendationSceneTags, ['date', 'brothers', 'besties', 'friends', 'business', 'celebration', 'unsure'])
    const intentTags = readEnumList(draft.recommendationIntentTags, ['relaxed', 'energetic', 'ritual', 'unsure'])
    const tasteTags = readEnumList(draft.recommendationTasteTags, ['refreshing', 'layered', 'strong', 'any'])
    const dwellTags = readEnumList(draft.recommendationDwellTags, ['one_set', 'stay_longer', 'no_rush'])
    const costAmount = moneyToMinor(draft.costYuan, true)
    const priceAmount = moneyToMinor(draft.priceYuan, false)
    if (minimum === null || maximum === null || minimum > maximum || priority === null
      || prepMinutes === null || holdMinutes === null || sortOrder === null || maxOrderQuantity === null
      || kdsPriority === null || fulfillmentSlaSeconds === undefined
      || sceneTags === null || intentTags === null || tasteTags === null || dwellTags === null
      || draft.allowedChannels.length === 0 || Boolean(draft.availableFrom) !== Boolean(draft.availableUntil)
      || (draft.availableFrom !== '' && draft.availableFrom === draft.availableUntil) || costAmount === undefined) {
      setNotice({ kind: 'error', text: '请核对推荐、供应时段、渠道、限购、出品时限和成本配置' })
      return
    }
    if (draft.productKind === 'bundle' && Object.keys(draft.componentQuantities).length === 0) {
      setNotice({ kind: 'error', text: '组合商品至少选择一个组成单品' })
      return
    }
    const bundleComponents = Object.entries(draft.componentQuantities).map(([productId, quantity], index) => ({
      productId,
      quantity: readInteger(quantity, 1, 100) ?? 0,
      sortOrder: (index + 1) * 10,
      note: null,
    }))
    if (bundleComponents.some((component) => component.quantity === 0)) {
      setNotice({ kind: 'error', text: '组合商品数量必须为1至100' })
      return
    }
    const oldRecommendation = objectValue(draft.snapshot.recommendation)
    const productSnapshot = {
      ...draft.snapshot,
      description: draft.description.trim(),
      imageUrl: draft.imageUrl.trim(),
      guestVisible: draft.guestVisible,
      searchText: draft.searchText.trim(),
      sortOrder,
      availableFrom: draft.availableFrom || null,
      availableUntil: draft.availableUntil || null,
      allowedChannels: draft.allowedChannels,
      maxOrderQuantity,
      kdsPriority,
      fulfillmentSlaSeconds,
      ...(costAmount === null ? { costAmount: null } : { costAmount }),
      recommendation: {
        ...oldRecommendation,
        enabled: draft.recommendationEnabled,
        minimumPartySize: minimum,
        maximumPartySize: maximum,
        priority,
        sceneTags,
        intentTags,
        tasteTags,
        dwellTags,
        singleWaveEligible: draft.recommendationSingleWaveEligible,
        expectedPrepMinutes: prepMinutes,
        holdMinutes,
        upgradeProductId: draft.recommendationUpgradeProductId || null,
      },
    }
    const payload = {
      ...(draft.id === null ? { code: draft.code.trim() } : {}),
      name: draft.name.trim(),
      categoryCode: draft.categoryCode.trim(),
      fulfillmentStation: draft.productKind === 'bundle' ? 'none' : draft.fulfillmentStation,
      productKind: draft.productKind,
      bundleComponents: draft.productKind === 'bundle' ? bundleComponents : [],
      productSnapshot,
      status: draft.status,
    }

    setBusy(true)
    setNotice(null)
    try {
      const saved = draft.id === null
        ? await api.postEndpoint<CatalogProduct>('/api/catalog/products', payload, { idempotencyKey: operationKey('catalog-create') })
        : await api.patchEndpoint<CatalogProduct>(`/api/catalog/products/${draft.id}`, payload, { idempotencyKey: operationKey('catalog-update') })
      let priceWarning = ''
      if (canManagePrice && priceAmount !== null) {
        const previous = saved.standardPrice?.amountMinor === null || saved.standardPrice === null
          ? null : Number(saved.standardPrice.amountMinor)
        if (previous !== priceAmount) {
          try {
            await api.putEndpoint(`/api/catalog/products/${saved.id}/standard-price`, {
              amountMinor: priceAmount,
              currency: 'CNY',
              reason: draft.priceReason.trim() || '商品配置调整标准售价',
            }, { idempotencyKey: operationKey('catalog-price') })
          } catch (error) {
            priceWarning = `；商品资料已保存，但售价未确认：${error instanceof Error ? error.message : '请重新调整售价'}`
          }
        }
      }
      await load()
      setDraft(null)
      setNotice(priceWarning === ''
        ? { kind: 'success', text: `${saved.name} 已保存并从服务端读回` }
        : { kind: 'error', text: priceWarning.slice(1) })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '商品配置未保存' })
      await load().catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  return <section className={`catalog-management ${expanded ? 'is-expanded' : ''}`} aria-label="商品与推荐配置">
    <button type="button" className="catalog-management-trigger" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <span><PackageOpen size={19} /><strong>商品、售价与推荐</strong><small>上架、搜索、人数范围、优先级、成本和组合</small></span>
      <span>{products.length > 0 ? `${products.length}项` : '经营配置'} <ChevronDown size={17} /></span>
    </button>
    {expanded && <div className="catalog-management-body">
      {phase === 'loading' && <p className="catalog-management-state"><LoaderCircle className="is-spinning" size={18} /> 正在读取商品</p>}
      {notice !== null && <p className={`catalog-management-notice is-${notice.kind}`} role="status">{notice.kind === 'success' && <Check size={17} />}{notice.text}</p>}
      {phase === 'error' && <button type="button" onClick={() => void load()}>重新读取商品</button>}
      {phase === 'ready' && <>
        <div className="catalog-management-tools"><input aria-label="搜索配置商品" placeholder="搜索商品名、编号或分类" value={query} onChange={(event) => setQuery(event.target.value)} /><button type="button" onClick={startCreate}><CirclePlus size={17} /> 新增商品</button></div>
        {draft !== null && <form className="catalog-management-form" onSubmit={(event) => void save(event)}>
          <header><strong>{draft.id === null ? '新增商品' : `编辑 ${draft.name}`}</strong><button type="button" onClick={() => setDraft(null)}>取消</button></header>
          <div className="catalog-form-grid">
            <label>商品编号<input required disabled={draft.id !== null} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" value={draft.code} onChange={(event) => updateDraft('code', event.target.value)} /></label>
            <label>商品名称<input required maxLength={160} value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} /></label>
            <label>分类编号<input required pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" value={draft.categoryCode} onChange={(event) => updateDraft('categoryCode', event.target.value)} /></label>
            <label>商品类型<select value={draft.productKind} onChange={(event) => updateDraft('productKind', event.target.value as ProductKind)}><option value="single">单品</option><option value="bundle">组合商品</option></select></label>
            <label>出品岗位<select disabled={draft.productKind === 'bundle'} value={draft.productKind === 'bundle' ? 'none' : draft.fulfillmentStation} onChange={(event) => updateDraft('fulfillmentStation', event.target.value as FulfillmentStation)}><option value="bar">吧台</option><option value="kitchen">后厨</option><option value="cashier">收银</option><option value="none">无需出品</option></select></label>
            <label>销售状态<select value={draft.status} onChange={(event) => updateDraft('status', event.target.value as ProductStatus)}><option value="active">在售</option><option value="sold_out">售罄</option><option value="inactive">停用</option></select></label>
            <label>搜索文本<input maxLength={4000} value={draft.searchText} onChange={(event) => updateDraft('searchText', event.target.value)} /></label>
            <label>标准售价（元）<input disabled={!canManagePrice} inputMode="decimal" value={draft.priceYuan} onChange={(event) => updateDraft('priceYuan', event.target.value)} /></label>
            <label>成本金额（元）<input inputMode="decimal" value={draft.costYuan} onChange={(event) => updateDraft('costYuan', event.target.value)} /></label>
            <label>推荐最少人数<input inputMode="numeric" value={draft.recommendationMinGuests} onChange={(event) => updateDraft('recommendationMinGuests', event.target.value)} /></label>
            <label>推荐最多人数<input inputMode="numeric" value={draft.recommendationMaxGuests} onChange={(event) => updateDraft('recommendationMaxGuests', event.target.value)} /></label>
            <label>推荐优先级<input inputMode="numeric" value={draft.recommendationPriority} onChange={(event) => updateDraft('recommendationPriority', event.target.value)} /></label>
            <label className="catalog-check"><input type="checkbox" checked={draft.guestVisible} onChange={(event) => updateDraft('guestVisible', event.target.checked)} />顾客菜单可见</label>
            <label className="catalog-check"><input type="checkbox" checked={draft.recommendationEnabled} onChange={(event) => updateDraft('recommendationEnabled', event.target.checked)} />参与商品推荐</label>
            {canManagePrice && <label className="catalog-wide">调价原因<input maxLength={500} value={draft.priceReason} onChange={(event) => updateDraft('priceReason', event.target.value)} /></label>}
            <button type="button" className="catalog-advanced-toggle catalog-wide" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((value) => !value)}>{showAdvanced ? '收起高级字段' : '显示高级字段（供应、标签与渠道）'}<ChevronDown size={17} /></button>
            {showAdvanced && <>
              <label>菜单排序<input type="number" min={0} max={100000} value={draft.sortOrder} onChange={(event) => updateDraft('sortOrder', event.target.value)} /></label>
              <label>单笔最大数量<input type="number" min={1} max={9999} value={draft.maxOrderQuantity} onChange={(event) => updateDraft('maxOrderQuantity', event.target.value)} /></label>
              <label>供应开始<input type="time" value={draft.availableFrom} onChange={(event) => updateDraft('availableFrom', event.target.value)} /></label>
              <label>供应结束<input type="time" value={draft.availableUntil} onChange={(event) => updateDraft('availableUntil', event.target.value)} /></label>
              <label>KDS优先级<input type="number" min={0} max={1000} value={draft.kdsPriority} onChange={(event) => updateDraft('kdsPriority', event.target.value)} /></label>
              <label>出品时限（秒）<input type="number" min={30} max={14400} placeholder="按岗位默认" value={draft.fulfillmentSlaSeconds} onChange={(event) => updateDraft('fulfillmentSlaSeconds', event.target.value)} /></label>
              <label>预计准备（分钟）<input type="number" min={0} max={240} value={draft.recommendationExpectedPrepMinutes} onChange={(event) => updateDraft('recommendationExpectedPrepMinutes', event.target.value)} /></label>
              <label>推荐保留（分钟）<input type="number" min={0} max={240} value={draft.recommendationHoldMinutes} onChange={(event) => updateDraft('recommendationHoldMinutes', event.target.value)} /></label>
              <label>升级推荐商品<select value={draft.recommendationUpgradeProductId} onChange={(event) => updateDraft('recommendationUpgradeProductId', event.target.value)}><option value="">无</option>{products.filter((product) => product.id !== draft.id).map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
              <label className="catalog-wide">场景标签（英文逗号分隔）<input value={draft.recommendationSceneTags} placeholder="date,friends,celebration" onChange={(event) => updateDraft('recommendationSceneTags', event.target.value)} /></label>
              <label>意图标签<input value={draft.recommendationIntentTags} placeholder="relaxed,energetic" onChange={(event) => updateDraft('recommendationIntentTags', event.target.value)} /></label>
              <label>口味标签<input value={draft.recommendationTasteTags} placeholder="refreshing,layered" onChange={(event) => updateDraft('recommendationTasteTags', event.target.value)} /></label>
              <label>停留标签<input value={draft.recommendationDwellTags} placeholder="one_set,stay_longer" onChange={(event) => updateDraft('recommendationDwellTags', event.target.value)} /></label>
              <label className="catalog-wide">商品文案<input maxLength={1000} value={draft.description} onChange={(event) => updateDraft('description', event.target.value)} /></label>
              <label className="catalog-wide">图片地址<input maxLength={2000} value={draft.imageUrl} onChange={(event) => updateDraft('imageUrl', event.target.value)} /></label>
              <label className="catalog-check"><input type="checkbox" checked={draft.recommendationSingleWaveEligible} onChange={(event) => updateDraft('recommendationSingleWaveEligible', event.target.checked)} />可一次出齐</label>
              <fieldset className="catalog-wide"><legend>允许下单渠道</legend>{[['guest_qr', '顾客扫码'], ['staff_assisted', '员工协助'], ['cashier', '收银'], ['reservation', '预约'], ['integration', '系统接入']].map(([value, label]) => <label className="catalog-check" key={value}><input type="checkbox" checked={draft.allowedChannels.includes(value)} onChange={() => updateDraft('allowedChannels', draft.allowedChannels.includes(value) ? draft.allowedChannels.filter((item) => item !== value) : [...draft.allowedChannels, value])} />{label}</label>)}</fieldset>
            </>}
          </div>
          {draft.productKind === 'bundle' && <section className="catalog-components"><strong>组合内容</strong><div>{singleProducts.map((product) => <label key={product.id} className={product.id in draft.componentQuantities ? 'is-selected' : ''}><input type="checkbox" checked={product.id in draft.componentQuantities} onChange={() => toggleComponent(product.id)} /><span>{product.name}</span>{product.id in draft.componentQuantities && <input aria-label={`${product.name}数量`} inputMode="numeric" value={draft.componentQuantities[product.id]} onChange={(event) => updateDraft('componentQuantities', { ...draft.componentQuantities, [product.id]: event.target.value })} />}</label>)}</div></section>}
          <button type="submit" className="catalog-save" disabled={busy}>{busy ? <LoaderCircle className="is-spinning" size={18} /> : <Check size={18} />}保存并读回验证</button>
        </form>}
        <div className="catalog-management-list">{visibleProducts.map((product) => <article key={product.id}><div><strong>{product.name}</strong><span>{product.code} · {product.categoryCode} · {product.productKind === 'bundle' ? '组合' : stationLabel(product.fulfillmentStation)}</span><small>{statusLabel(product.status)} · {product.productSnapshot.guestVisible === false ? '顾客隐藏' : '顾客可见'} · {product.standardPrice?.amountMinor == null ? '未定价' : `¥${minorToYuan(product.standardPrice.amountMinor)}`}</small></div><button type="button" onClick={() => startEdit(product)}><Pencil size={16} /> 编辑</button></article>)}</div>
      </>}
    </div>}
  </section>
}

function emptyDraft(): ProductDraft {
  return {
    id: null, code: '', name: '', categoryCode: 'drinks', fulfillmentStation: 'bar', productKind: 'single',
    status: 'active', guestVisible: true, searchText: '', recommendationEnabled: false,
    recommendationMinGuests: '1', recommendationMaxGuests: '100', recommendationPriority: '100',
    recommendationSceneTags: '', recommendationIntentTags: '', recommendationTasteTags: '',
    recommendationDwellTags: '', recommendationSingleWaveEligible: true,
    recommendationExpectedPrepMinutes: '8', recommendationHoldMinutes: '10',
    recommendationUpgradeProductId: '', sortOrder: '999', availableFrom: '', availableUntil: '',
    allowedChannels: ['guest_qr', 'staff_assisted', 'cashier', 'reservation', 'integration'],
    maxOrderQuantity: '50', kdsPriority: '100', fulfillmentSlaSeconds: '',
    costYuan: '', priceYuan: '', priceReason: '新增商品标准售价', description: '', imageUrl: '', snapshot: {}, componentQuantities: {},
  }
}

function readProducts(value: unknown): CatalogProduct[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => isRecord(item)
    && typeof item.id === 'string' && typeof item.code === 'string' && typeof item.name === 'string'
    && typeof item.categoryCode === 'string' && isRecord(item.productSnapshot)
    && Array.isArray(item.bundleComponents) && typeof item.updatedAt === 'string'
    ? [item as unknown as CatalogProduct] : [])
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function integerText(value: unknown, fallback: string): string {
  return Number.isSafeInteger(value) ? String(value) : fallback
}

function stringList(value: unknown): string {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join(',') : ''
}

function stringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : fallback
}

function readEnumList<const Value extends string>(value: string, allowed: readonly Value[]): Value[] | null {
  const items = value.split(',').map((item) => item.trim()).filter(Boolean)
  if (items.some((item) => !allowed.includes(item as Value))) return null
  return [...new Set(items as Value[])]
}

function readInteger(value: string, minimum: number, maximum: number): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null
}

function moneyToMinor(value: string, allowBlank: boolean): number | null | undefined {
  const normalized = value.trim()
  if (normalized === '') return allowBlank ? null : null
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(normalized)) return undefined
  return Math.round(Number(normalized) * 100)
}

function minorToYuan(value: unknown): string {
  const amount = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(amount) ? (amount / 100).toFixed(2) : ''
}

function operationKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function stationLabel(value: FulfillmentStation): string {
  return value === 'bar' ? '吧台' : value === 'kitchen' ? '后厨' : value === 'cashier' ? '收银' : '无需出品'
}

function statusLabel(value: ProductStatus): string {
  return value === 'active' ? '在售' : value === 'sold_out' ? '售罄' : '停用'
}
