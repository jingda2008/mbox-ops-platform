import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, CirclePlus, LoaderCircle, PackageOpen, Pencil } from 'lucide-react'
import { NormalizedApiClient, type StaffAuthView } from '../normalized-api'
import { MediaAssetPicker } from './MediaAssetPicker'
import { menuImageOptions } from './menu-image-library'

type ProductStatus = 'active' | 'sold_out' | 'inactive'
type ProductKind = 'single' | 'bundle'
type FulfillmentStation = 'bar' | 'kitchen' | 'cashier' | 'none'
type InventoryControlMode = 'tracked' | 'not_managed'
type PerformancePhaseCode = 'before_show' | 'acoustic' | 'band_live' | 'intermission' | 'after_show'

const performancePhaseOptions: ReadonlyArray<{ code: PerformancePhaseCode; label: string }> = [
  { code: 'before_show', label: '演出前' },
  { code: 'acoustic', label: '不插电' },
  { code: 'band_live', label: '乐队现场' },
  { code: 'intermission', label: '中场' },
  { code: 'after_show', label: '演出后' },
]

interface CatalogProduct {
  id: string
  code: string
  name: string
  categoryCode: string
  fulfillmentStation: FulfillmentStation
  productKind: ProductKind
  inventoryControlMode: InventoryControlMode
  bundleComponents: Array<{ productId: string; quantity: number; sortOrder: number; note: string | null }>
  productSnapshot: Record<string, unknown>
  guestVisible: boolean
  searchText: string
  recommendationEnabled: boolean
  recommendationMinGuests: number
  recommendationMaxGuests: number
  recommendationPriority: number
  recommendationSceneTags: string[]
  recommendationIntentTags: string[]
  recommendationTasteTags: string[]
  recommendationDwellTags: string[]
  recommendationSingleWaveEligible: boolean
  recommendationExpectedPrepMinutes: number
  recommendationHoldMinutes: number
  recommendationUpgradeProductId: string | null
  menuSortOrder: number
  availableFrom: string | null
  availableUntil: string | null
  allowedChannels: string[]
  maxOrderQuantity: number
  kdsPriority: number
  fulfillmentSlaSeconds: number | null
  costAmountMinor: number | null
  status: ProductStatus
  isAvailable: boolean
  inventoryConfigurationComplete: boolean
  inventoryAvailable: boolean
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
  inventoryControlMode: InventoryControlMode
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

interface InventoryItemOption {
  id: string
  sku: string
  name: string
  baseUnit: string
}

interface RecipeComponentDraft {
  quantity: string
  expectedWasteQuantity: string
}

interface RecipeCostPreview {
  id?: string
  productId: string
  recipeId: string
  recipeVersion: number
  yieldQuantity: number
  currency: string
  costAmountMinor: number | null
  appliedAt?: string
  components: Array<{
    inventoryItemId: string
    itemName: string
    baseUnit: string
    componentQuantity: string
    expectedWasteQuantity: string
    sourceReceiptLineId: string | null
    sourceUnitCostMinor: string | null
    componentCostMinor: string | null
  }>
}

export function CatalogManagementPanel({
  api,
  auth,
  placement = 'settings',
  openRequest = 0,
}: {
  api: NormalizedApiClient
  auth: StaffAuthView
  placement?: 'inventory' | 'settings'
  openRequest?: number
}) {
  const canManageProduct = auth.permissions.includes('catalog.product.manage')
  const canManagePrice = auth.permissions.includes('catalog.price.manage')
  const canManageInventory = auth.permissions.includes('inventory.manage')
  const canViewInventoryCost = auth.permissions.includes('inventory.cost.view')
  const canConfigurePerformancePhase = auth.permissions.includes('recommendation.phase.configure')
  const [expanded, setExpanded] = useState(false)
  const [products, setProducts] = useState<CatalogProduct[]>([])
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<ProductDraft | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [performancePhaseState, setPerformancePhaseState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [performancePhaseCodes, setPerformancePhaseCodes] = useState<PerformancePhaseCode[]>([])
  const [savedPerformancePhaseCodes, setSavedPerformancePhaseCodes] = useState<PerformancePhaseCode[]>([])
  const [performancePhaseReason, setPerformancePhaseReason] = useState('')
  const [performancePhaseBusy, setPerformancePhaseBusy] = useState(false)
  const [recipeState, setRecipeState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [inventoryItems, setInventoryItems] = useState<InventoryItemOption[]>([])
  const [recipeVersion, setRecipeVersion] = useState<number | null>(null)
  const [recipeYield, setRecipeYield] = useState('1')
  const [recipeComponents, setRecipeComponents] = useState<Record<string, RecipeComponentDraft>>({})
  const [recipeBusy, setRecipeBusy] = useState(false)
  const [recipeCost, setRecipeCost] = useState<RecipeCostPreview | null>(null)
  const [recipeCostReason, setRecipeCostReason] = useState('按最新已收货物料成本核算配方成本')
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const performancePhaseRequest = useRef(0)

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

  useEffect(() => {
    if (openRequest > 0) setExpanded(true)
  }, [openRequest])

  const visibleProducts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    if (normalized === '') return products
    return products.filter((product) => [product.code, product.name, product.categoryCode]
      .some((value) => value.toLocaleLowerCase('zh-CN').includes(normalized)))
  }, [products, query])

  const singleProducts = useMemo(() => products.filter((product) => (
    product.productKind === 'single' && product.id !== draft?.id
  )), [draft?.id, products])
  const performancePhaseDirty = performancePhaseState === 'ready'
    && !samePerformancePhases(performancePhaseCodes, savedPerformancePhaseCodes)
  const isInventoryFlow = placement === 'inventory'
  const currentProduct = draft?.id === null || draft === null
    ? null
    : products.find((product) => product.id === draft.id) ?? null
  const currentSaleBlockers = currentProduct === null ? [] : sellingBlockers(currentProduct)

  if (!canManageProduct) return null

  const resetPerformancePhaseEditor = () => {
    performancePhaseRequest.current += 1
    setPerformancePhaseState('idle')
    setPerformancePhaseCodes([])
    setSavedPerformancePhaseCodes([])
    setPerformancePhaseReason('')
    setPerformancePhaseBusy(false)
  }

  const resetRecipeEditor = () => {
    setRecipeState('idle')
    setInventoryItems([])
    setRecipeVersion(null)
    setRecipeYield('1')
    setRecipeComponents({})
    setRecipeBusy(false)
    setRecipeCost(null)
    setRecipeCostReason('按最新已收货物料成本核算配方成本')
  }

  const loadRecipeEditor = async (productId: string) => {
    if (!canManageInventory) return
    setRecipeState('loading')
    try {
      const [dashboardResponse, recipeResponse] = await Promise.all([
        api.getEndpoint<{ data: unknown }>('/api/inventory'),
        api.getEndpoint<{ data: unknown }>(`/api/inventory/products/${productId}/recipe`),
      ])
      const items = readInventoryItems(dashboardResponse.data)
      const recipe = readActiveRecipe(recipeResponse.data)
      setInventoryItems(items)
      setRecipeVersion(recipe?.version ?? null)
      setRecipeYield(recipe === null ? '1' : String(recipe.yieldQuantity))
      setRecipeComponents(Object.fromEntries((recipe?.components ?? []).map((component) => [
        component.inventoryItemId,
        { quantity: component.quantity, expectedWasteQuantity: component.expectedWasteQuantity },
      ])))
      if (recipe !== null && canViewInventoryCost) {
        const costResponse = await api.getEndpoint<{ data: unknown }>(`/api/inventory/products/${productId}/recipe-cost`)
        setRecipeCost(readRecipeCostPreview(costResponse.data, productId))
      } else setRecipeCost(null)
      setRecipeState('ready')
    } catch (error) {
      setRecipeState('error')
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '商品库存配方读取失败' })
    }
  }

  const loadProductPerformancePhases = async (productId: string) => {
    if (!canConfigurePerformancePhase) return
    const requestId = performancePhaseRequest.current + 1
    performancePhaseRequest.current = requestId
    setPerformancePhaseState('loading')
    setPerformancePhaseReason('')
    try {
      const response = await api.getEndpoint<{ data: unknown }>(
        `/api/staff/customer-experience/products/${productId}/performance-phases`,
      )
      if (performancePhaseRequest.current !== requestId) return
      const configuration = performancePhaseConfiguration(response.data, productId)
      if (configuration === null) throw new Error('商品演出阶段返回格式无效')
      setPerformancePhaseCodes(configuration.phaseCodes)
      setSavedPerformancePhaseCodes(configuration.phaseCodes)
      setPerformancePhaseState('ready')
    } catch (error) {
      if (performancePhaseRequest.current !== requestId) return
      setPerformancePhaseState('error')
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '商品演出阶段读取失败' })
    }
  }

  const startCreate = () => {
    resetPerformancePhaseEditor()
    resetRecipeEditor()
    setDraft(emptyDraft())
    setShowAdvanced(false)
    setNotice(null)
  }

  const startEdit = (product: CatalogProduct) => {
    resetPerformancePhaseEditor()
    resetRecipeEditor()
    setDraft({
      id: product.id,
      code: product.code,
      name: product.name,
      categoryCode: product.categoryCode,
      fulfillmentStation: product.fulfillmentStation,
      productKind: product.productKind,
      inventoryControlMode: product.inventoryControlMode,
      status: product.status,
      guestVisible: product.guestVisible,
      searchText: product.searchText,
      recommendationEnabled: product.recommendationEnabled,
      recommendationMinGuests: integerText(product.recommendationMinGuests, '1'),
      recommendationMaxGuests: integerText(product.recommendationMaxGuests, '100'),
      recommendationPriority: integerText(product.recommendationPriority, '100'),
      recommendationSceneTags: product.recommendationSceneTags.join(', '),
      recommendationIntentTags: product.recommendationIntentTags.join(', '),
      recommendationTasteTags: product.recommendationTasteTags.join(', '),
      recommendationDwellTags: product.recommendationDwellTags.join(', '),
      recommendationSingleWaveEligible: product.recommendationSingleWaveEligible,
      recommendationExpectedPrepMinutes: integerText(product.recommendationExpectedPrepMinutes, '8'),
      recommendationHoldMinutes: integerText(product.recommendationHoldMinutes, '10'),
      recommendationUpgradeProductId: product.recommendationUpgradeProductId ?? '',
      sortOrder: integerText(product.menuSortOrder, '999'),
      availableFrom: product.availableFrom ?? '',
      availableUntil: product.availableUntil ?? '',
      allowedChannels: product.allowedChannels,
      maxOrderQuantity: integerText(product.maxOrderQuantity, '50'),
      kdsPriority: integerText(product.kdsPriority, '100'),
      fulfillmentSlaSeconds: integerText(product.fulfillmentSlaSeconds, ''),
      costYuan: minorToYuan(product.costAmountMinor),
      priceYuan: minorToYuan(product.standardPrice?.amountMinor ?? null),
      priceReason: '商品配置同步调整标准售价',
      description: typeof product.productSnapshot.description === 'string' ? product.productSnapshot.description : '',
      imageUrl: typeof product.productSnapshot.imageUrl === 'string' ? product.productSnapshot.imageUrl : '',
      snapshot: product.productSnapshot,
      componentQuantities: Object.fromEntries(product.bundleComponents.map((component) => [component.productId, String(component.quantity)])),
    })
    setShowAdvanced(false)
    setNotice(null)
    if (canConfigurePerformancePhase) void loadProductPerformancePhases(product.id)
    if (canManageInventory && product.productKind === 'single' && product.inventoryControlMode === 'tracked') {
      void loadRecipeEditor(product.id)
    }
  }

  const closeDraft = () => {
    resetPerformancePhaseEditor()
    resetRecipeEditor()
    setDraft(null)
  }

  const updateDraft = <Key extends keyof ProductDraft>(key: Key, value: ProductDraft[Key]) => {
    setDraft((current) => current === null ? null : { ...current, [key]: value })
  }

  const updateCategory = (categoryCode: string) => {
    setDraft((current) => current === null ? null : {
      ...current,
      categoryCode,
      inventoryControlMode: categoryCode.trim() === 'food'
        ? 'not_managed'
        : current.categoryCode.trim() === 'food' ? 'tracked' : current.inventoryControlMode,
    })
  }

  const toggleComponent = (productId: string) => {
    if (draft === null) return
    const quantities = { ...draft.componentQuantities }
    if (productId in quantities) delete quantities[productId]
    else quantities[productId] = '1'
    updateDraft('componentQuantities', quantities)
  }

  const toggleRecipeComponent = (inventoryItemId: string) => {
    setRecipeComponents((current) => {
      const next = { ...current }
      if (inventoryItemId in next) delete next[inventoryItemId]
      else next[inventoryItemId] = { quantity: '1', expectedWasteQuantity: '0' }
      return next
    })
  }

  const updateRecipeComponent = (
    inventoryItemId: string,
    key: keyof RecipeComponentDraft,
    value: string,
  ) => {
    setRecipeComponents((current) => ({
      ...current,
      [inventoryItemId]: { ...current[inventoryItemId], [key]: value },
    }))
  }

  const saveRecipe = async () => {
    if (draft?.id == null || recipeBusy || recipeState !== 'ready') return
    const yieldQuantity = readInteger(recipeYield, 1, 1000)
    const components = Object.entries(recipeComponents).map(([inventoryItemId, component]) => ({
      inventoryItemId,
      quantity: component.quantity.trim(),
      expectedWasteQuantity: component.expectedWasteQuantity.trim(),
    }))
    if (yieldQuantity === null || components.length === 0
      || components.some((component) => !isPositiveDecimal(component.quantity)
        || !isNonNegativeDecimal(component.expectedWasteQuantity))) {
      setNotice({ kind: 'error', text: '配方至少选择一项物料；产出量、用量和损耗必须是有效数字' })
      return
    }
    setRecipeBusy(true)
    setNotice(null)
    try {
      await api.putEndpoint(
        `/api/inventory/products/${draft.id}/recipe`,
        { yieldQuantity, instructionsSnapshot: {}, components },
        { idempotencyKey: operationKey('inventory-recipe') },
      )
      await loadRecipeEditor(draft.id)
      await load()
      setNotice({ kind: 'success', text: `${draft.name} 的库存配方已保存并读回核对` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '商品库存配方未保存' })
    } finally {
      setRecipeBusy(false)
    }
  }

  const applyRecipeCost = async () => {
    if (draft?.id === null || draft === null || recipeBusy || recipeCost === null || recipeCost.costAmountMinor === null) return
    const reason = recipeCostReason.trim()
    if (reason.length < 2 || reason.length > 500) {
      setNotice({ kind: 'error', text: '请填写2至500字的成本核算原因' })
      return
    }
    setRecipeBusy(true)
    setNotice(null)
    try {
      const result = await api.postEndpoint<unknown>(
        `/api/inventory/products/${draft.id}/recipe-cost/apply`, { reason },
        { idempotencyKey: operationKey('inventory-recipe-cost') },
      )
      setRecipeCost(readRecipeCostPreview(result, draft.id))
      await load()
      setNotice({ kind: 'success', text: `${draft.name} 的配方成本已按当前收货记录应用；历史订单成本不会被改写` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '配方成本没有应用' })
    } finally {
      setRecipeBusy(false)
    }
  }

  const togglePerformancePhase = (phaseCode: PerformancePhaseCode) => {
    setPerformancePhaseCodes((current) => current.includes(phaseCode)
      ? current.filter((item) => item !== phaseCode)
      : [...current, phaseCode])
  }

  const savePerformancePhases = async () => {
    if (draft?.id === null || draft === null || performancePhaseBusy || performancePhaseState !== 'ready') return
    const reason = performancePhaseReason.trim()
    if (reason.length < 2 || reason.length > 240) {
      setNotice({ kind: 'error', text: '请填写2至240字的阶段配置原因' })
      return
    }
    setPerformancePhaseBusy(true)
    setNotice(null)
    try {
      const response = await api.putEndpoint<unknown>(
        `/api/staff/customer-experience/products/${draft.id}/performance-phases`,
        { phaseCodes: performancePhaseCodes, reason },
        { idempotencyKey: operationKey('catalog-performance-phases') },
      )
      const configuration = performancePhaseConfiguration(response, draft.id)
      if (configuration === null) throw new Error('商品演出阶段保存结果无法确认')
      setPerformancePhaseCodes(configuration.phaseCodes)
      setSavedPerformancePhaseCodes(configuration.phaseCodes)
      setPerformancePhaseReason('')
      setNotice({
        kind: 'success',
        text: performancePhaseCodes.length === 0
          ? `${draft.name} 已取消演出阶段限制`
          : `${draft.name} 的适用演出阶段已保存并读回`,
      })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '商品演出阶段未保存' })
      await loadProductPerformancePhases(draft.id)
    } finally {
      setPerformancePhaseBusy(false)
    }
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
      || (draft.availableFrom !== '' && draft.availableFrom === draft.availableUntil)
      || costAmount === undefined || (draft.status === 'active' && costAmount === null)) {
      setNotice({ kind: 'error', text: '请核对推荐、供应时段、渠道、限购和出品时限；在售商品必须填写成本' })
      return
    }
    if (draft.productKind === 'single' && draft.inventoryControlMode === 'tracked' && draft.status === 'active') {
      if (draft.id === null) {
        setNotice({ kind: 'error', text: '新建跟踪库存商品请先保存为停用；完成配方和入库后，再切换为在售。' })
        return
      }
      if (recipeState === 'ready' && recipeVersion === null) {
        setNotice({ kind: 'error', text: '请先保存库存扣减配方；没有配方的跟踪库存酒水不能切换为在售。' })
        return
      }
    }
    if (draft.productKind === 'bundle' && Object.keys(draft.componentQuantities).length === 0) {
      setNotice({ kind: 'error', text: '组合商品至少选择一个组成单品' })
      return
    }
    if (draft.id === null && draft.status === 'active' && !canManagePrice) {
      setNotice({ kind: 'error', text: '当前岗位没有标准售价权限。新商品请先保存为停用，或由具备定价权限的员工一次完成商品与售价配置。' })
      return
    }
    if (draft.id === null && draft.status === 'active' && priceAmount === null) {
      setNotice({ kind: 'error', text: '在售新商品必须同时填写标准售价；系统不会先创建未定价商品。' })
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
    const productSnapshot = {
      ...draft.snapshot,
      description: draft.description.trim(),
      imageUrl: draft.imageUrl.trim(),
    }
    const currentPrice = draft.id === null
      ? null
      : products.find((product) => product.id === draft.id)?.standardPrice?.amountMinor ?? null
    const standardPrice = canManagePrice && priceAmount !== null
      && (draft.id === null || currentPrice === null || Number(currentPrice) !== priceAmount)
      ? { amountMinor: priceAmount, currency: 'CNY', reason: draft.priceReason.trim() || '商品配置调整标准售价' }
      : undefined
    const payload = {
      ...(draft.id === null ? { code: draft.code.trim() } : {}),
      name: draft.name.trim(),
      categoryCode: draft.categoryCode.trim(),
      fulfillmentStation: draft.productKind === 'bundle' ? 'none' : draft.fulfillmentStation,
      productKind: draft.productKind,
      inventoryControlMode: draft.productKind === 'bundle' ? 'tracked' : draft.inventoryControlMode,
      bundleComponents: draft.productKind === 'bundle' ? bundleComponents : [],
      productSnapshot,
      guestVisible: draft.guestVisible,
      searchText: draft.searchText.trim(),
      recommendationEnabled: draft.recommendationEnabled,
      recommendationMinGuests: minimum,
      recommendationMaxGuests: maximum,
      recommendationPriority: priority,
      recommendationSceneTags: sceneTags,
      recommendationIntentTags: intentTags,
      recommendationTasteTags: tasteTags,
      recommendationDwellTags: dwellTags,
      recommendationSingleWaveEligible: draft.recommendationSingleWaveEligible,
      recommendationExpectedPrepMinutes: prepMinutes,
      recommendationHoldMinutes: holdMinutes,
      recommendationUpgradeProductId: draft.recommendationUpgradeProductId || null,
      menuSortOrder: sortOrder,
      availableFrom: draft.availableFrom || null,
      availableUntil: draft.availableUntil || null,
      allowedChannels: draft.allowedChannels,
      maxOrderQuantity,
      kdsPriority,
      fulfillmentSlaSeconds,
      costAmountMinor: costAmount,
      status: draft.status,
      ...(standardPrice === undefined ? {} : { standardPrice }),
    }

    setBusy(true)
    setNotice(null)
    try {
      const saved = draft.id === null
        ? await api.postEndpoint<CatalogProduct>('/api/catalog/products', payload, { idempotencyKey: operationKey('catalog-create') })
        : await api.patchEndpoint<CatalogProduct>(`/api/catalog/products/${draft.id}`, payload, { idempotencyKey: operationKey('catalog-update') })
      await load()
      closeDraft()
      setNotice({ kind: 'success', text: `${saved.name} 已保存并从服务端读回${standardPrice === undefined ? '' : '，包含标准售价'}` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '商品配置未保存' })
      await load().catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  return <section className={`catalog-management ${isInventoryFlow ? 'is-inventory-flow ' : ''}${expanded ? 'is-expanded' : ''}`} aria-label={isInventoryFlow ? '酒水上架流程' : '商品与推荐配置'}>
    <button type="button" className="catalog-management-trigger" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <span><PackageOpen size={19} /><strong>{isInventoryFlow ? '酒水上架流程' : '商品、售价与推荐'}</strong><small>{isInventoryFlow ? '第 4–5 步：商品、售价、配方与可售校验' : '上架、搜索、人数范围、优先级、成本和组合'}</small></span>
      <span>{products.length > 0 ? `${products.length}项` : '经营配置'} <ChevronDown size={17} /></span>
    </button>
    {expanded && <div className="catalog-management-body">
      {phase === 'loading' && <p className="catalog-management-state"><LoaderCircle className="is-spinning" size={18} /> 正在读取商品</p>}
      {notice !== null && <p className={`catalog-management-notice is-${notice.kind}`} role="status">{notice.kind === 'success' && <Check size={17} />}{notice.text}</p>}
      {phase === 'error' && <button type="button" onClick={() => void load()}>重新读取商品</button>}
      {phase === 'ready' && <>
        {isInventoryFlow && <section className="catalog-selling-flow" aria-label="酒水上架步骤说明"><header><strong>第 4–5 步：建立商品并确认可售</strong><small>先建立停用商品和售价，再保存库存配方；已收货库存充足后，切换为“在售”。</small></header><ol><li><b>4</b><span><strong>商品与售价</strong><small>商品名称、售价、顾客可见与下单渠道。</small></span></li><li><b>5</b><span><strong>配方与开售</strong><small>每份用量、损耗、库存状态和实际可售结果。</small></span></li></ol><p>“在售”仅是商品状态；顾客可点还要通过配方和实时库存校验，系统不会因方便操作而跳过。</p></section>}
        <div className="catalog-management-tools"><input aria-label="搜索配置商品" placeholder="搜索商品名、编号或分类" value={query} onChange={(event) => setQuery(event.target.value)} /><button type="button" onClick={startCreate}><CirclePlus size={17} /> 新增商品</button><button type="button" onClick={() => void load()}>刷新可售状态</button></div>
        {draft !== null && <form className="catalog-management-form" onSubmit={(event) => void save(event)}>
          <header><strong>{draft.id === null ? '新增商品' : `编辑 ${draft.name}`}</strong><button type="button" onClick={closeDraft}>取消</button></header>
          <div className="catalog-form-grid">
            <label>商品编号<input required disabled={draft.id !== null} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" value={draft.code} onChange={(event) => updateDraft('code', event.target.value)} /></label>
            <label>商品名称<input required maxLength={160} value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} /></label>
            <label>分类编号<input required pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" value={draft.categoryCode} onChange={(event) => updateCategory(event.target.value)} /></label>
            <label>商品类型<select value={draft.productKind} onChange={(event) => updateDraft('productKind', event.target.value as ProductKind)}><option value="single">单品</option><option value="bundle">组合商品</option></select></label>
            <label>出品岗位<select disabled={draft.productKind === 'bundle'} value={draft.productKind === 'bundle' ? 'none' : draft.fulfillmentStation} onChange={(event) => updateDraft('fulfillmentStation', event.target.value as FulfillmentStation)}><option value="bar">吧台</option><option value="kitchen">后厨</option><option value="cashier">收银</option><option value="none">无需出品</option></select></label>
            <label>销售状态<select value={draft.status} onChange={(event) => updateDraft('status', event.target.value as ProductStatus)}><option value="active">在售</option><option value="sold_out">售罄</option><option value="inactive">停用</option></select></label>
            <label>库存方式<select disabled={draft.productKind === 'bundle'} value={draft.productKind === 'bundle' ? 'tracked' : draft.inventoryControlMode} onChange={(event) => updateDraft('inventoryControlMode', event.target.value as InventoryControlMode)}><option value="tracked">跟踪库存（酒水等）</option><option value="not_managed">暂不管理数量（小吃水果）</option></select></label>
            <label>搜索文本<input maxLength={4000} value={draft.searchText} onChange={(event) => updateDraft('searchText', event.target.value)} /></label>
            <label>标准售价（元）<input disabled={!canManagePrice} inputMode="decimal" value={draft.priceYuan} onChange={(event) => updateDraft('priceYuan', event.target.value)} />{!canManagePrice && <small>当前岗位不能定价；不会在保存后尝试补写售价。</small>}</label>
            <label>成本金额（元）<input inputMode="decimal" value={draft.costYuan} onChange={(event) => updateDraft('costYuan', event.target.value)} /></label>
            <label>推荐最少人数<input inputMode="numeric" value={draft.recommendationMinGuests} onChange={(event) => updateDraft('recommendationMinGuests', event.target.value)} /></label>
            <label>推荐最多人数<input inputMode="numeric" value={draft.recommendationMaxGuests} onChange={(event) => updateDraft('recommendationMaxGuests', event.target.value)} /></label>
            <label>推荐优先级<input inputMode="numeric" value={draft.recommendationPriority} onChange={(event) => updateDraft('recommendationPriority', event.target.value)} /></label>
            <label className="catalog-check"><input type="checkbox" checked={draft.guestVisible} onChange={(event) => updateDraft('guestVisible', event.target.checked)} />顾客菜单可见</label>
            <label className="catalog-check"><input type="checkbox" checked={draft.recommendationEnabled} onChange={(event) => updateDraft('recommendationEnabled', event.target.checked)} />参与商品推荐</label>
            {isInventoryFlow && <section className={`catalog-sale-readiness catalog-wide${currentSaleBlockers.length === 0 && currentProduct !== null ? ' is-ready' : ''}`} aria-label="酒水小程序可售检查"><header><div><strong>第 5 步：小程序可售检查</strong><small>{draft.id === null ? '新酒水先保存为停用；保存后可配置配方并读取真实可售状态。' : currentSaleBlockers.length === 0 ? '该商品已通过当前的售价、配方、库存和小程序菜单校验。' : '请按以下提示完成；保存商品状态不等于顾客已经可以下单。'}</small></div><em>{draft.id === null ? '待建档' : currentSaleBlockers.length === 0 ? '小程序可售' : '待完成'}</em></header>{currentProduct !== null && currentSaleBlockers.length > 0 && <ul>{currentSaleBlockers.map((item) => <li key={item}>{item}</li>)}</ul>}</section>}
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
              <label className="catalog-wide">菜单图片<select value={menuImageOptions.some((option) => option.url === draft.imageUrl) ? draft.imageUrl : ''} onChange={(event) => updateDraft('imageUrl', event.target.value)}><option value="">从下方图片库选择或暂不设置</option>{menuImageOptions.map((option) => <option value={option.url} key={option.url}>{option.label}</option>)}</select></label>
              <label className="catalog-wide">已选图片<input readOnly value={draft.imageUrl} placeholder="请选择受控菜单素材，或从下方图片库上传（单张不超过 200KB）" /></label>
              <div className="catalog-wide"><MediaAssetPicker api={api} purpose="menu" value={draft.imageUrl} onChange={(imageUrl) => updateDraft('imageUrl', imageUrl)} label="上传或选择菜单图片" /></div>
              {draft.imageUrl !== '' && <figure className="catalog-image-preview catalog-wide"><img src={draft.imageUrl} alt={`${draft.name || '商品'}菜单图预览`} /><figcaption>保存前预览；图片中的“以实物为准”提示不会替代真实配方、品牌和份量核对。</figcaption></figure>}
              <label className="catalog-check"><input type="checkbox" checked={draft.recommendationSingleWaveEligible} onChange={(event) => updateDraft('recommendationSingleWaveEligible', event.target.checked)} />可一次出齐</label>
              <fieldset className="catalog-wide"><legend>允许下单渠道</legend>{[['guest_qr', '顾客扫码'], ['staff_assisted', '员工协助'], ['cashier', '收银'], ['reservation', '预约'], ['integration', '系统接入']].map(([value, label]) => <label className="catalog-check" key={value}><input type="checkbox" checked={draft.allowedChannels.includes(value)} onChange={() => updateDraft('allowedChannels', draft.allowedChannels.includes(value) ? draft.allowedChannels.filter((item) => item !== value) : [...draft.allowedChannels, value])} />{label}</label>)}</fieldset>
            </>}
            {canConfigurePerformancePhase && draft.id === null && <p className="catalog-performance-phase-note catalog-wide">请先创建商品，再配置适用演出阶段；新商品默认不受阶段限制。</p>}
            {canConfigurePerformancePhase && draft.id !== null && <section className="catalog-performance-phase catalog-wide" aria-label="商品适用演出阶段">
              <header><div><strong>适用演出阶段</strong><small>强类型运行门禁；未选择任何阶段表示不受演出阶段限制。</small></div><em>{performancePhaseCodes.length === 0 ? '不限阶段' : `已选 ${performancePhaseCodes.length} 项`}</em></header>
              {performancePhaseState === 'loading' && <p><LoaderCircle className="is-spinning" size={17} /> 正在读取当前配置</p>}
              {performancePhaseState === 'error' && <button type="button" onClick={() => void loadProductPerformancePhases(draft.id!)}>重新读取阶段配置</button>}
              {performancePhaseState === 'ready' && <>
                <div className="catalog-performance-phase-options">{performancePhaseOptions.map((option) => <label key={option.code}><input type="checkbox" checked={performancePhaseCodes.includes(option.code)} onChange={() => togglePerformancePhase(option.code)} /><span>{option.label}</span></label>)}</div>
                {performancePhaseDirty && <p>阶段选择有未保存修改，请先单独保存或恢复后再保存商品资料。</p>}
                <label>配置原因<input minLength={2} maxLength={240} value={performancePhaseReason} placeholder={performancePhaseCodes.length === 0 ? '例如：取消阶段限制，恢复全时段推荐' : '例如：仅在乐队现场与中场推荐'} onChange={(event) => setPerformancePhaseReason(event.target.value)} /></label>
                <button type="button" disabled={performancePhaseBusy || performancePhaseReason.trim().length < 2} onClick={() => void savePerformancePhases()}>{performancePhaseBusy ? '保存中' : '单独保存阶段配置'}</button>
              </>}
            </section>}
            {canManageInventory && draft.productKind === 'single' && draft.inventoryControlMode === 'tracked' && <section className="catalog-recipe catalog-wide" aria-label="商品库存配方">
              <header><div><strong>库存扣减配方</strong><small>订单出品时按此配方扣减真实物料；小吃水果选择“暂不管理数量”即可跳过。</small></div><em>{recipeVersion === null ? '尚未配置' : `第 ${recipeVersion} 版`}</em></header>
              {draft.id === null && <p>请先把商品保存为停用状态，再返回编辑并配置物料配方；配方和真实成本核对完成前不要上架。</p>}
              {draft.id !== null && recipeState === 'loading' && <p><LoaderCircle className="is-spinning" size={17} /> 正在读取库存物料与当前配方</p>}
              {draft.id !== null && recipeState === 'error' && <button type="button" onClick={() => void loadRecipeEditor(draft.id!)}>重新读取库存配方</button>}
              {draft.id !== null && recipeState === 'ready' && <>
                <label>每份配方产出数量<input type="number" min={1} max={1000} value={recipeYield} onChange={(event) => setRecipeYield(event.target.value)} /></label>
                {inventoryItems.length === 0
                  ? <p>当前还没有库存物料。请先在“库存与瓶存”中扫码或手工建立物料，再回来配置配方。</p>
                  : <div className="catalog-recipe-items">{inventoryItems.map((item) => {
                    const component = recipeComponents[item.id]
                    return <article key={item.id} className={component === undefined ? '' : 'is-selected'}>
                      <label><input type="checkbox" checked={component !== undefined} onChange={() => toggleRecipeComponent(item.id)} /><span><strong>{item.name}</strong><small>{item.sku} · {item.baseUnit}</small></span></label>
                      {component !== undefined && <div><label>每份用量<input inputMode="decimal" value={component.quantity} onChange={(event) => updateRecipeComponent(item.id, 'quantity', event.target.value)} /></label><label>预计损耗<input inputMode="decimal" value={component.expectedWasteQuantity} onChange={(event) => updateRecipeComponent(item.id, 'expectedWasteQuantity', event.target.value)} /></label></div>}
                    </article>
                  })}</div>}
                <button type="button" disabled={recipeBusy || inventoryItems.length === 0} onClick={() => void saveRecipe()}>{recipeBusy ? '保存中' : '保存配方并刷新可售检查'}</button>
                {canViewInventoryCost && recipeCost !== null && <section className="catalog-recipe-cost" aria-label="配方成本核算">
                  <header><div><strong>配方成本核算</strong><small>只读取已收货的采购成本。保存配方不会自动改售价或成本，必须由有成本权限的员工明确应用。</small></div><em>{recipeCost.costAmountMinor === null ? '待补成本' : `¥${minorToYuan(recipeCost.costAmountMinor)}/份`}</em></header>
                  {recipeCost.costAmountMinor === null
                    ? <p>以下物料缺少已收货成本：{recipeCost.components.filter((component) => component.sourceReceiptLineId === null).map((component) => component.itemName).join('、')}。请先完成对应采购收货，再重新读取。</p>
                    : <><div className="catalog-recipe-cost-lines">{recipeCost.components.map((component) => <span key={component.inventoryItemId}>{component.itemName} · {component.componentCostMinor === null ? '待补成本' : `¥${minorToYuan(component.componentCostMinor)}`}</span>)}</div>
                      <label>本次核算原因<input minLength={2} maxLength={500} value={recipeCostReason} onChange={(event) => setRecipeCostReason(event.target.value)} /></label>
                      <button type="button" disabled={recipeBusy} onClick={() => void applyRecipeCost()}>{recipeBusy ? '应用中' : '按当前收货成本应用到商品'}</button></>}
                </section>}
              </>}
            </section>}
          </div>
          {draft.productKind === 'bundle' && <section className="catalog-components"><strong>组合内容</strong><div>{singleProducts.map((product) => <label key={product.id} className={product.id in draft.componentQuantities ? 'is-selected' : ''}><input type="checkbox" checked={product.id in draft.componentQuantities} onChange={() => toggleComponent(product.id)} /><span>{product.name}</span>{product.id in draft.componentQuantities && <input aria-label={`${product.name}数量`} inputMode="numeric" value={draft.componentQuantities[product.id]} onChange={(event) => updateDraft('componentQuantities', { ...draft.componentQuantities, [product.id]: event.target.value })} />}</label>)}</div></section>}
          <button type="submit" className="catalog-save" disabled={busy || performancePhaseDirty}>{busy ? <LoaderCircle className="is-spinning" size={18} /> : <Check size={18} />}{performancePhaseDirty ? '请先处理阶段配置' : '保存并读回验证'}</button>
        </form>}
        <div className="catalog-management-list">{visibleProducts.map((product) => {
          const blockers = sellingBlockers(product)
          return <article key={product.id}><div><strong>{product.name}</strong><span>{product.code} · {product.categoryCode} · {product.productKind === 'bundle' ? '组合' : stationLabel(product.fulfillmentStation)}</span><small>{statusLabel(product.status)} · {product.inventoryControlMode === 'tracked' ? '跟踪库存' : '暂不管理数量'} · {product.guestVisible ? '顾客可见' : '顾客隐藏'} · {product.standardPrice?.amountMinor == null ? '未定价' : `¥${minorToYuan(product.standardPrice.amountMinor)}`}</small>{isInventoryFlow && <small className={blockers.length === 0 ? 'catalog-sale-state is-ready' : 'catalog-sale-state'}>{blockers.length === 0 ? '小程序可售' : `待完成：${blockers[0]}`}</small>}</div><button type="button" onClick={() => startEdit(product)}><Pencil size={16} /> 编辑</button></article>
        })}</div>
      </>}
    </div>}
  </section>
}

function emptyDraft(): ProductDraft {
  return {
    id: null, code: '', name: '', categoryCode: 'drinks', fulfillmentStation: 'bar', productKind: 'single', inventoryControlMode: 'tracked',
    status: 'inactive', guestVisible: true, searchText: '', recommendationEnabled: false,
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

function performancePhaseConfiguration(value: unknown, productId: string): {
  productId: string
  phaseCodes: PerformancePhaseCode[]
} | null {
  if (!isRecord(value) || value.productId !== productId || !Array.isArray(value.phaseCodes)) return null
  const phaseCodes = value.phaseCodes.flatMap((phaseCode): PerformancePhaseCode[] => (
    isPerformancePhaseCode(phaseCode) ? [phaseCode] : []
  ))
  if (phaseCodes.length !== value.phaseCodes.length || new Set(phaseCodes).size !== phaseCodes.length) return null
  return { productId, phaseCodes }
}

function isPerformancePhaseCode(value: unknown): value is PerformancePhaseCode {
  return value === 'before_show' || value === 'acoustic' || value === 'band_live'
    || value === 'intermission' || value === 'after_show'
}

function samePerformancePhases(left: readonly PerformancePhaseCode[], right: readonly PerformancePhaseCode[]): boolean {
  return left.length === right.length && left.every((phaseCode) => right.includes(phaseCode))
}

function readProducts(value: unknown): CatalogProduct[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => isRecord(item)
    && typeof item.id === 'string' && typeof item.code === 'string' && typeof item.name === 'string'
    && typeof item.categoryCode === 'string' && (item.inventoryControlMode === 'tracked' || item.inventoryControlMode === 'not_managed') && isRecord(item.productSnapshot)
    && typeof item.guestVisible === 'boolean' && typeof item.searchText === 'string'
    && typeof item.recommendationEnabled === 'boolean'
    && typeof item.isAvailable === 'boolean' && typeof item.inventoryConfigurationComplete === 'boolean'
    && typeof item.inventoryAvailable === 'boolean'
    && Array.isArray(item.allowedChannels)
    && Array.isArray(item.bundleComponents) && typeof item.updatedAt === 'string'
    ? [item as unknown as CatalogProduct] : [])
}

function readInventoryItems(value: unknown): InventoryItemOption[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return []
  return value.items.flatMap((item): InventoryItemOption[] => (
    isRecord(item) && typeof item.id === 'string' && typeof item.sku === 'string'
      && typeof item.name === 'string' && typeof item.baseUnit === 'string'
      ? [{ id: item.id, sku: item.sku, name: item.name, baseUnit: item.baseUnit }]
      : []
  ))
}

function sellingBlockers(product: CatalogProduct): string[] {
  const blockers: string[] = []
  if (product.status !== 'active') blockers.push('销售状态尚未设为“在售”')
  if (product.standardPrice?.amountMinor === null || product.standardPrice === null) blockers.push('尚未设置标准售价')
  if (!product.guestVisible) blockers.push('尚未设为顾客菜单可见')
  if (!product.allowedChannels.includes('guest_qr')) blockers.push('尚未开放顾客扫码点单渠道')
  if (product.inventoryControlMode === 'tracked' && !product.inventoryConfigurationComplete) blockers.push('库存扣减配方未完成')
  if (product.inventoryControlMode === 'tracked' && !product.inventoryAvailable) blockers.push('当前可售库存不足，请完成入库或盘点')
  if (!product.isAvailable && blockers.length === 0) blockers.push('当前供应时段或组合内容未满足')
  return blockers
}

function readActiveRecipe(value: unknown): {
  version: number
  yieldQuantity: number
  components: Array<RecipeComponentDraft & { inventoryItemId: string }>
} | null {
  if (value === null) return null
  if (!isRecord(value) || !Number.isSafeInteger(value.version) || !Number.isSafeInteger(value.yieldQuantity)
    || !Array.isArray(value.components)) throw new Error('库存配方返回格式无效')
  const components = value.components.flatMap((component): Array<RecipeComponentDraft & { inventoryItemId: string }> => (
    isRecord(component) && typeof component.inventoryItemId === 'string'
      && typeof component.quantity === 'string' && typeof component.expectedWasteQuantity === 'string'
      ? [{
          inventoryItemId: component.inventoryItemId,
          quantity: component.quantity,
          expectedWasteQuantity: component.expectedWasteQuantity,
        }]
      : []
  ))
  if (components.length !== value.components.length) throw new Error('库存配方组成返回格式无效')
  return { version: value.version as number, yieldQuantity: value.yieldQuantity as number, components }
}

function readRecipeCostPreview(value: unknown, productId: string): RecipeCostPreview {
  if (!isRecord(value) || value.productId !== productId || typeof value.recipeId !== 'string'
    || !Number.isSafeInteger(value.recipeVersion) || !Number.isSafeInteger(value.yieldQuantity)
    || (value.costAmountMinor !== null && !Number.isSafeInteger(value.costAmountMinor))
    || typeof value.currency !== 'string' || !Array.isArray(value.components)) {
    throw new Error('配方成本返回格式无效')
  }
  const components = value.components.flatMap((component): RecipeCostPreview['components'] => (
    isRecord(component) && typeof component.inventoryItemId === 'string'
      && typeof component.itemName === 'string' && typeof component.baseUnit === 'string'
      && typeof component.componentQuantity === 'string' && typeof component.expectedWasteQuantity === 'string'
      && (component.sourceReceiptLineId === null || typeof component.sourceReceiptLineId === 'string')
      && (component.sourceUnitCostMinor === null || typeof component.sourceUnitCostMinor === 'string')
      && (component.componentCostMinor === null || typeof component.componentCostMinor === 'string')
      ? [{
          inventoryItemId: component.inventoryItemId, itemName: component.itemName, baseUnit: component.baseUnit,
          componentQuantity: component.componentQuantity, expectedWasteQuantity: component.expectedWasteQuantity,
          sourceReceiptLineId: component.sourceReceiptLineId, sourceUnitCostMinor: component.sourceUnitCostMinor,
          componentCostMinor: component.componentCostMinor,
        }]
      : []
  ))
  if (components.length !== value.components.length) throw new Error('配方成本组成返回格式无效')
  return {
    ...(typeof value.id === 'string' ? { id: value.id } : {}), productId, recipeId: value.recipeId as string,
    recipeVersion: value.recipeVersion as number, yieldQuantity: value.yieldQuantity as number, currency: value.currency as string,
    costAmountMinor: value.costAmountMinor as number | null, components,
    ...(typeof value.appliedAt === 'string' ? { appliedAt: value.appliedAt } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function integerText(value: unknown, fallback: string): string {
  return Number.isSafeInteger(value) ? String(value) : fallback
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

function isPositiveDecimal(value: string): boolean {
  return /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value) && Number(value) > 0
}

function isNonNegativeDecimal(value: string): boolean {
  return /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)
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
