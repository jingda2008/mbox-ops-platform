import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, CirclePlus, LoaderCircle, PackageOpen, Pencil } from 'lucide-react'
import { NormalizedApiClient, type StaffAuthView } from '../normalized-api'
import {
  inventoryEmployeeUnit,
  inventoryCategoryLabel,
  inventoryQuantityForEmployee,
  inventoryQuantityForStorage,
  inventoryUnitLabel,
  requiresMillilitreInventoryMigration,
} from './inventory-presentation'
import { MediaAssetPicker } from './MediaAssetPicker'
import { menuImageOptions } from './menu-image-library'
import { NumberInputWithUnit } from './NumberInputWithUnit'
import { sanitizeProductDisplaySnapshot } from '../shared/product-display-snapshot'

type ProductStatus = 'active' | 'sold_out' | 'inactive'
type ProductKind = 'single' | 'bundle'
type FulfillmentStation = 'bar' | 'kitchen' | 'cashier' | 'none'
type InventoryControlMode = 'tracked' | 'not_managed'
type SalesSpecificationType = 'whole_bottle' | 'glass' | 'shot' | 'cocktail' | 'custom'
type PerformancePhaseCode = 'before_show' | 'acoustic' | 'band_live' | 'intermission' | 'after_show'

const performancePhaseOptions: ReadonlyArray<{ code: PerformancePhaseCode; label: string }> = [
  { code: 'before_show', label: '演出前' },
  { code: 'acoustic', label: '不插电' },
  { code: 'band_live', label: '乐队现场' },
  { code: 'intermission', label: '中场' },
  { code: 'after_show', label: '演出后' },
]

const salesSpecificationOptions: ReadonlyArray<{ code: SalesSpecificationType; label: string }> = [
  { code: 'whole_bottle', label: '整瓶' },
  { code: 'glass', label: '单杯' },
  { code: 'shot', label: 'Shot' },
  { code: 'cocktail', label: '鸡尾酒' },
  { code: 'custom', label: '自定义' },
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
  costAmountMinor?: number | null
  status: ProductStatus
  isAvailable: boolean
  inventoryConfigurationComplete: boolean
  inventoryAvailable: boolean
  standardPrice: null | { amountMinor: string | null; currency: string | null }
  updatedAt: string
}

interface MenuCategory {
  id: string
  code: string
  displayName: string
  parentCode: string | null
  sortOrder: number
  guestVisible: boolean
  productCount: number
  createdAt: string
  updatedAt: string
}

interface MenuCategoryDraft {
  id: string | null
  code: string
  displayName: string
  parentCode: string
  sortOrder: string
  guestVisible: boolean
}

interface ProductDraft {
  id: string | null
  code: string
  name: string
  categoryCode: string
  fulfillmentStation: FulfillmentStation
  productKind: ProductKind
  inventoryControlMode: InventoryControlMode
  salesSpecificationType: SalesSpecificationType
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
  costChangeReason: string
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
  categoryCode: string
  packageVolumeMl: string | null
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
  const [menuCategories, setMenuCategories] = useState<MenuCategory[]>([])
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<ProductDraft | null>(null)
  const [categoryDraft, setCategoryDraft] = useState<MenuCategoryDraft | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [categoryBusy, setCategoryBusy] = useState(false)
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
  const [recipeInstructionsSnapshot, setRecipeInstructionsSnapshot] = useState<Record<string, unknown>>({})
  const [recipeCategoryFilter, setRecipeCategoryFilter] = useState('')
  const [recipeBusy, setRecipeBusy] = useState(false)
  const [recipeCost, setRecipeCost] = useState<RecipeCostPreview | null>(null)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const performancePhaseRequest = useRef(0)

  const load = useCallback(async () => {
    setPhase('loading')
    try {
      const [loadedProducts, categoryResponse] = await Promise.all([
        loadAllProducts(api),
        api.getEndpoint<{ data: unknown }>('/api/catalog/menu-categories'),
      ])
      setProducts(loadedProducts)
      setMenuCategories(readMenuCategories(categoryResponse.data))
      setPhase('ready')
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '商品或菜单分类读取失败' })
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

  const menuCategoryOptions = useMemo(() => categorySelectOptions(menuCategories), [menuCategories])

  const singleProducts = useMemo(() => products.filter((product) => (
    product.productKind === 'single' && product.id !== draft?.id
  )), [draft?.id, products])
  const recipeCategories = useMemo(() => [...new Set(inventoryItems.map((item) => item.categoryCode))]
    .sort((left, right) => inventoryCategoryLabel(left).localeCompare(inventoryCategoryLabel(right), 'zh-CN')), [inventoryItems])
  const visibleRecipeItems = recipeCategoryFilter === ''
    ? inventoryItems
    : inventoryItems.filter((item) => item.categoryCode === recipeCategoryFilter)
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
    setRecipeInstructionsSnapshot({})
    setRecipeCategoryFilter('')
    setRecipeBusy(false)
    setRecipeCost(null)
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
      const itemById = new Map(items.map((item) => [item.id, item]))
      setInventoryItems(items)
      setRecipeVersion(recipe?.version ?? null)
      setRecipeYield(recipe === null ? '1' : String(recipe.yieldQuantity))
      setRecipeInstructionsSnapshot(recipe?.instructionsSnapshot ?? {})
      setRecipeComponents(Object.fromEntries((recipe?.components ?? []).map((component) => {
        const item = itemById.get(component.inventoryItemId)
        if (item === undefined) throw new Error('当前配方引用了已不可用的库存物料')
        const quantity = inventoryQuantityForEmployee(
          component.quantity, item.categoryCode, item.baseUnit, item.packageVolumeMl,
        )
        const expectedWasteQuantity = inventoryQuantityForEmployee(
          component.expectedWasteQuantity, item.categoryCode, item.baseUnit, item.packageVolumeMl,
        )
        if (quantity === null || expectedWasteQuantity === null) {
          throw new Error(`“${item.name}”缺少有效的单瓶净含量，无法换算为毫升`)
        }
        return [component.inventoryItemId, { quantity, expectedWasteQuantity }]
      })))
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
    setDraft(emptyDraft(menuCategories))
    setShowAdvanced(false)
    setNotice(null)
  }

  const startCreateCategory = () => {
    setCategoryDraft(emptyMenuCategoryDraft(menuCategories))
    setNotice(null)
  }

  const startEditCategory = (category: MenuCategory) => {
    setCategoryDraft({
      id: category.id,
      code: category.code,
      displayName: category.displayName,
      parentCode: category.parentCode ?? '',
      sortOrder: String(category.sortOrder),
      guestVisible: category.guestVisible,
    })
    setNotice(null)
  }

  const saveMenuCategory = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (categoryDraft === null || categoryBusy) return
    const code = categoryDraft.code.trim()
    const displayName = categoryDraft.displayName.trim()
    const sortOrder = readInteger(categoryDraft.sortOrder, 0, 100000)
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(code) || displayName.length === 0 || displayName.length > 32 || sortOrder === null) {
      setNotice({ kind: 'error', text: '请填写分类编号、顾客显示名称和0至100000的排序数字' })
      return
    }
    setCategoryBusy(true)
    setNotice(null)
    try {
      const payload = {
        ...(categoryDraft.id === null ? { code } : {}),
        displayName,
        parentCode: categoryDraft.parentCode || null,
        sortOrder,
        guestVisible: categoryDraft.guestVisible,
      }
      const saved = categoryDraft.id === null
        ? await api.postEndpoint<MenuCategory>('/api/catalog/menu-categories', payload, { idempotencyKey: operationKey('menu-category-create') })
        : await api.patchEndpoint<MenuCategory>(`/api/catalog/menu-categories/${encodeURIComponent(categoryDraft.code)}`, payload, { idempotencyKey: operationKey('menu-category-update') })
      await load()
      setCategoryDraft(null)
      setNotice({ kind: 'success', text: `${saved.displayName} 已保存；顾客菜单会按新层级显示` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '菜单分类未保存' })
      await load().catch(() => undefined)
    } finally {
      setCategoryBusy(false)
    }
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
      salesSpecificationType: readSalesSpecificationType(product.productSnapshot.salesSpecificationType),
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
      costChangeReason: '',
      priceYuan: minorToYuan(product.standardPrice?.amountMinor ?? null),
      priceReason: '商品配置同步调整标准售价',
      description: typeof product.productSnapshot.description === 'string' ? product.productSnapshot.description : '',
      imageUrl: typeof product.productSnapshot.imageUrl === 'string' ? product.productSnapshot.imageUrl : '',
      snapshot: sanitizeProductDisplaySnapshot(product.productSnapshot),
      componentQuantities: Object.fromEntries(product.bundleComponents.map((component) => [component.productId, String(component.quantity)])),
    })
    setShowAdvanced(false)
    setNotice(null)
    if (canConfigurePerformancePhase) void loadProductPerformancePhases(product.id)
    if (canManageInventory && product.productKind === 'single' && product.inventoryControlMode === 'tracked') {
      void loadRecipeEditor(product.id)
    }
  }

  const startSalesCompanion = (salesSpecificationType: SalesSpecificationType) => {
    if (draft === null || draft.id === null) return
    const label = salesSpecificationLabel(salesSpecificationType)
    setDraft({
      ...draft,
      id: null,
      code: companionProductCode(draft.code, salesSpecificationType, products),
      name: `${draft.name}（${label}）`,
      salesSpecificationType,
      status: 'inactive',
      // A whole bottle and a glass have distinct recipes and yields. Never
      // carry a manual whole-bottle cost into the companion product.
      costYuan: '',
      priceYuan: '',
      priceReason: `新增${label}销售规格`,
      costChangeReason: '',
      componentQuantities: {},
    })
    resetPerformancePhaseEditor()
    resetRecipeEditor()
    setNotice({ kind: 'success', text: `已预填${label}销售商品。商品编号已使用内部编号，避免与库存条码冲突；保存后为它配置售价，并在配方中引用同一库存物料。` })
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
    const storedComponents = components.map((component) => {
      const item = inventoryItems.find((candidate) => candidate.id === component.inventoryItemId)
      if (item === undefined) return null
      const quantity = inventoryQuantityForStorage(
        component.quantity, item.categoryCode, item.baseUnit, item.packageVolumeMl,
      )
      const expectedWasteQuantity = inventoryQuantityForStorage(
        component.expectedWasteQuantity, item.categoryCode, item.baseUnit, item.packageVolumeMl,
      )
      return quantity === null || expectedWasteQuantity === null
        ? null
        : { inventoryItemId: component.inventoryItemId, quantity, expectedWasteQuantity }
    })
    if (storedComponents.some((component) => component === null)) {
      setNotice({ kind: 'error', text: '所选液体物料缺少有效的单瓶净含量，无法把毫升安全换算为历史库存数量；请先补全物料资料' })
      return
    }
    setRecipeBusy(true)
    setNotice(null)
    try {
      await api.putEndpoint(
        `/api/inventory/products/${draft.id}/recipe`,
        { yieldQuantity, instructionsSnapshot: recipeInstructionsSnapshot, components: storedComponents },
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
    const inventoryCostIsAutomatic = draft.inventoryControlMode === 'tracked'
      || draft.productKind === 'bundle'
    const costAmount = canViewInventoryCost && !inventoryCostIsAutomatic
      ? moneyToMinor(draft.costYuan, true) : undefined
    const priceAmount = moneyToMinor(draft.priceYuan, false)
    if (minimum === null || maximum === null || minimum > maximum || priority === null
      || prepMinutes === null || holdMinutes === null || sortOrder === null || maxOrderQuantity === null
      || kdsPriority === null || fulfillmentSlaSeconds === undefined
      || sceneTags === null || intentTags === null || tasteTags === null || dwellTags === null
      || draft.allowedChannels.length === 0 || Boolean(draft.availableFrom) !== Boolean(draft.availableUntil)
      || (draft.availableFrom !== '' && draft.availableFrom === draft.availableUntil)
      || (!inventoryCostIsAutomatic && canViewInventoryCost
        && (costAmount === undefined || (draft.status === 'active' && costAmount === null)))) {
      setNotice({ kind: 'error', text: '请核对推荐、供应时段、渠道、限购和出品时限；非库存商品在售时必须填写成本' })
      return
    }
    if (draft.id === null && draft.status === 'active' && !canViewInventoryCost && !inventoryCostIsAutomatic) {
      setNotice({ kind: 'error', text: '当前岗位不能查看或填写成本，不能直接创建在售商品；请先保存为停用，或由具备成本权限的员工完成上架。' })
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
    const productSnapshot = sanitizeProductDisplaySnapshot({
      ...draft.snapshot,
      description: draft.description.trim(),
      imageUrl: draft.imageUrl.trim(),
      salesSpecificationType: draft.salesSpecificationType,
    })
    const currentPrice = draft.id === null
      ? null
      : products.find((product) => product.id === draft.id)?.standardPrice?.amountMinor ?? null
    const currentCost = draft.id === null
      ? null
      : products.find((product) => product.id === draft.id)?.costAmountMinor
    const costChanged = canViewInventoryCost && !inventoryCostIsAutomatic && costAmount !== undefined
      && (draft.id === null || currentCost === null || currentCost === undefined || currentCost !== costAmount)
    if (costChanged && draft.id !== null && draft.costChangeReason.trim().length < 2) {
      setNotice({ kind: 'error', text: '修改成本时请填写至少2个字的成本变更原因' })
      return
    }
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
      ...(costChanged ? {
        costAmountMinor: costAmount,
        ...(draft.id === null ? {} : { costChangeReason: draft.costChangeReason.trim() }),
      } : {}),
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
        {isInventoryFlow && <section className="catalog-selling-flow" aria-label="酒水上架步骤说明"><header><strong>第 2–4 步：销售规格、配方成本与发布</strong><small>选择整瓶、单杯、Shot、鸡尾酒或自定义规格，保存售价与真实扣减配方，再回到入库卡生成发布预览。</small></header><ol><li><b>2</b><span><strong>销售规格</strong><small>同一库存物料可被多个销售规格共同引用。</small></span></li><li><b>3</b><span><strong>配方与预览</strong><small>配置每份用量、损耗、售价和渠道。</small></span></li><li><b>4</b><span><strong>确认发布</strong><small>按本次收货成本重新核算后原子发布。</small></span></li></ol><p>“在售”仅是商品状态；顾客可点还要通过配方和实时库存校验，系统不会因方便操作而跳过。</p></section>}
        <section className="catalog-menu-categories" aria-label="顾客菜单分类">
          <header><div><strong>顾客菜单分类</strong><small>一级入口和二级分类都在这里配置；小程序只显示名称、顺序和可见性，不再把内部分类编号给顾客看。</small></div><button type="button" onClick={startCreateCategory}><CirclePlus size={16} /> 新增分类</button></header>
          {categoryDraft !== null && <form className="catalog-menu-category-form" onSubmit={(event) => void saveMenuCategory(event)}>
            <strong>{categoryDraft.id === null ? '新增菜单分类' : `编辑 ${categoryDraft.displayName}`}</strong>
            <label>分类编号<input required disabled={categoryDraft.id !== null} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" value={categoryDraft.code} placeholder="例如 cocktail" onChange={(event) => setCategoryDraft((current) => current === null ? null : { ...current, code: event.target.value })} /></label>
            <label>顾客显示名称<input required maxLength={32} value={categoryDraft.displayName} placeholder="例如 鸡尾酒" onChange={(event) => setCategoryDraft((current) => current === null ? null : { ...current, displayName: event.target.value })} /></label>
            <label>上级分类<select value={categoryDraft.parentCode} onChange={(event) => setCategoryDraft((current) => current === null ? null : { ...current, parentCode: event.target.value })}><option value="">作为一级分类</option>{menuCategories.filter((item) => item.parentCode === null && item.code !== categoryDraft.code).map((item) => <option key={item.code} value={item.code}>{item.displayName}</option>)}</select></label>
            <label>菜单排序<NumberInputWithUnit inputMode="numeric" min={0} max={100000} unit="序号" value={categoryDraft.sortOrder} onChange={(event) => setCategoryDraft((current) => current === null ? null : { ...current, sortOrder: event.target.value })} /></label>
            <label className="catalog-check"><input type="checkbox" checked={categoryDraft.guestVisible} onChange={(event) => setCategoryDraft((current) => current === null ? null : { ...current, guestVisible: event.target.checked })} />顾客菜单可见</label>
            <div className="catalog-menu-category-form__actions"><button type="button" onClick={() => setCategoryDraft(null)}>取消</button><button type="submit" disabled={categoryBusy}>{categoryBusy ? '保存中' : '保存分类'}</button></div>
          </form>}
          {menuCategories.length === 0
            ? <p>还没有菜单分类。请先创建一级分类，再为“酒水”等一级分类添加二级分类。</p>
            : <div className="catalog-menu-category-list">{menuCategories.map((category) => <article key={category.id} className={category.parentCode === null ? 'is-root' : 'is-child'}><div><strong>{category.parentCode === null ? category.displayName : `└ ${category.displayName}`}</strong><small>{category.code} · 排序 {category.sortOrder} · {category.productCount} 个商品 · {category.guestVisible ? '顾客可见' : '顾客隐藏'}</small></div><button type="button" onClick={() => startEditCategory(category)}><Pencil size={15} /> 编辑</button></article>)}</div>}
        </section>
        <div className="catalog-management-tools"><input aria-label="搜索配置商品" placeholder="搜索商品名、编号或分类" value={query} onChange={(event) => setQuery(event.target.value)} /><button type="button" onClick={startCreate}><CirclePlus size={17} /> 新增商品</button><button type="button" onClick={() => void load()}>刷新可售状态</button></div>
        {draft !== null && <form className="catalog-management-form" onSubmit={(event) => void save(event)}>
          <header><strong>{draft.id === null ? '新增商品' : `编辑 ${draft.name}`}</strong><span>{draft.id !== null && draft.productKind === 'bundle' && draft.status !== 'inactive' && <button type="button" onClick={() => { updateDraft('status', 'inactive'); setNotice(null) }}>标记停用（尚未保存）</button>}<button type="button" onClick={closeDraft}>取消</button></span></header>
          <div className="catalog-form-grid">
            <label>商品编号<input required disabled={draft.id !== null} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" value={draft.code} onChange={(event) => updateDraft('code', event.target.value)} /></label>
            <label>商品名称<input required maxLength={160} value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} /></label>
            <label>顾客菜单分类<select required value={draft.categoryCode} onChange={(event) => updateCategory(event.target.value)}>{!menuCategoryOptions.some((option) => option.code === draft.categoryCode) && <option value={draft.categoryCode}>当前分类（其他分类）</option>}{menuCategoryOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}</select><small>分类名称、层级、顺序和顾客可见性在上方统一配置。</small></label>
            <label>商品类型<select value={draft.productKind} onChange={(event) => updateDraft('productKind', event.target.value as ProductKind)}><option value="single">单品</option><option value="bundle">组合商品</option></select></label>
            <label>销售规格<select disabled={draft.productKind === 'bundle'} value={draft.salesSpecificationType} onChange={(event) => updateDraft('salesSpecificationType', event.target.value as SalesSpecificationType)}>{salesSpecificationOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}</select><small>规格只描述销售形态；真实库存始终由下方配方引用，不重复建立库存。</small></label>
            {draft.id !== null && draft.productKind === 'single' && draft.inventoryControlMode === 'tracked' && (draft.salesSpecificationType === 'whole_bottle' || draft.salesSpecificationType === 'glass') && <div className="catalog-wide catalog-sales-companion"><strong>整瓶与单杯共用库存</strong><small>两种销售形态必须各自有商品、售价和配方，才能按不同用量正确扣减同一物料。</small><button type="button" onClick={() => startSalesCompanion(draft.salesSpecificationType === 'whole_bottle' ? 'glass' : 'whole_bottle')}>新建{draft.salesSpecificationType === 'whole_bottle' ? '单杯' : '整瓶'}版本</button></div>}
            <label>出品岗位<select disabled={draft.productKind === 'bundle'} value={draft.productKind === 'bundle' ? 'none' : draft.fulfillmentStation} onChange={(event) => updateDraft('fulfillmentStation', event.target.value as FulfillmentStation)}><option value="bar">吧台</option><option value="kitchen">后厨</option><option value="cashier">收银</option><option value="none">无需出品</option></select></label>
            <label>销售状态<select value={draft.status} onChange={(event) => updateDraft('status', event.target.value as ProductStatus)}><option value="active">在售</option><option value="sold_out">售罄</option><option value="inactive">停用</option></select><small>状态更改需点击底部“保存并读回验证”；保存成功后才会影响小程序菜单。</small></label>
            <label>库存方式<select disabled={draft.productKind === 'bundle'} value={draft.productKind === 'bundle' ? 'tracked' : draft.inventoryControlMode} onChange={(event) => updateDraft('inventoryControlMode', event.target.value as InventoryControlMode)}><option value="tracked">跟踪库存（酒水等）</option><option value="not_managed">暂不管理数量（小吃水果）</option></select></label>
            <label>搜索文本<input maxLength={4000} value={draft.searchText} onChange={(event) => updateDraft('searchText', event.target.value)} /></label>
            <label>标准售价<NumberInputWithUnit disabled={!canManagePrice} inputMode="decimal" unit="元" value={draft.priceYuan} onChange={(event) => updateDraft('priceYuan', event.target.value)} />{!canManagePrice && <small>当前岗位不能定价；不会在保存后尝试补写售价。</small>}</label>
            {canViewInventoryCost && (draft.inventoryControlMode === 'tracked' || draft.productKind === 'bundle')
              ? <p className="catalog-permission-note">{draft.productKind === 'bundle' ? '套餐成本由组成商品的当前成本自动汇总；' : '库存成本由已确认收货、库存加权成本和正式配方自动计算；'}日常不在商品页手填。当前状态：{currentProduct?.costAmountMinor == null ? '待补成本' : `¥${minorToYuan(currentProduct.costAmountMinor)}/份`}。</p>
              : canViewInventoryCost
              ? <label>成本金额<NumberInputWithUnit inputMode="decimal" unit="元" value={draft.costYuan} onChange={(event) => updateDraft('costYuan', event.target.value)} /><small>非库存商品可由有权限人员更正成本；修改成本需单独填写原因。</small></label>
              : <p className="catalog-permission-note">成本已受权限保护。你可以保存商品资料，但系统不会读取、显示或改写成本。</p>}
            <label>推荐最少人数<NumberInputWithUnit inputMode="numeric" unit="人" value={draft.recommendationMinGuests} onChange={(event) => updateDraft('recommendationMinGuests', event.target.value)} /></label>
            <label>推荐最多人数<NumberInputWithUnit inputMode="numeric" unit="人" value={draft.recommendationMaxGuests} onChange={(event) => updateDraft('recommendationMaxGuests', event.target.value)} /></label>
            <label>推荐优先级<NumberInputWithUnit inputMode="numeric" unit="级" value={draft.recommendationPriority} onChange={(event) => updateDraft('recommendationPriority', event.target.value)} /></label>
            <label className="catalog-check"><input type="checkbox" checked={draft.guestVisible} onChange={(event) => updateDraft('guestVisible', event.target.checked)} />顾客菜单可见</label>
            <label className="catalog-check"><input type="checkbox" checked={draft.recommendationEnabled} onChange={(event) => updateDraft('recommendationEnabled', event.target.checked)} />参与商品推荐</label>
            {isInventoryFlow && <section className={`catalog-sale-readiness catalog-wide${currentSaleBlockers.length === 0 && currentProduct !== null ? ' is-ready' : ''}`} aria-label="酒水小程序可售检查"><header><div><strong>第 5 步：小程序可售检查</strong><small>{draft.id === null ? '新酒水先保存为停用；保存后可配置配方并读取真实可售状态。' : currentSaleBlockers.length === 0 ? '该商品已通过当前的售价、配方、库存和小程序菜单校验。' : '请按以下提示完成；保存商品状态不等于顾客已经可以下单。'}</small></div><em>{draft.id === null ? '待建档' : currentSaleBlockers.length === 0 ? '小程序可售' : '待完成'}</em></header>{currentProduct !== null && currentSaleBlockers.length > 0 && <ul>{currentSaleBlockers.map((item) => <li key={item}>{item}</li>)}</ul>}</section>}
            {canManagePrice && <label className="catalog-wide">调价原因<input maxLength={500} value={draft.priceReason} onChange={(event) => updateDraft('priceReason', event.target.value)} /></label>}
            {canViewInventoryCost && draft.inventoryControlMode !== 'tracked' && draft.productKind !== 'bundle' && draft.id !== null && currentProduct !== null
              && moneyToMinor(draft.costYuan, true) !== currentProduct.costAmountMinor
              && <label className="catalog-wide">成本变更原因<input required minLength={2} maxLength={500} value={draft.costChangeReason} placeholder="例如：供应商进价调整，按本次采购单更新" onChange={(event) => updateDraft('costChangeReason', event.target.value)} /></label>}
            <button type="button" className="catalog-advanced-toggle catalog-wide" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((value) => !value)}>{showAdvanced ? '收起高级字段' : '显示高级字段（供应、标签与渠道）'}<ChevronDown size={17} /></button>
            {showAdvanced && <>
              <label>菜单排序<NumberInputWithUnit inputMode="numeric" min={0} max={100000} unit="序号" value={draft.sortOrder} onChange={(event) => updateDraft('sortOrder', event.target.value)} /></label>
              <label>单笔最大数量<NumberInputWithUnit inputMode="numeric" min={1} max={9999} unit="份/单" value={draft.maxOrderQuantity} onChange={(event) => updateDraft('maxOrderQuantity', event.target.value)} /></label>
              <label>供应开始<input type="time" value={draft.availableFrom} onChange={(event) => updateDraft('availableFrom', event.target.value)} /></label>
              <label>供应结束<input type="time" value={draft.availableUntil} onChange={(event) => updateDraft('availableUntil', event.target.value)} /></label>
              <label>KDS优先级<NumberInputWithUnit inputMode="numeric" min={0} max={1000} unit="级" value={draft.kdsPriority} onChange={(event) => updateDraft('kdsPriority', event.target.value)} /></label>
              <label>出品时限<NumberInputWithUnit inputMode="numeric" min={30} max={14400} unit="秒" placeholder="按岗位默认" value={draft.fulfillmentSlaSeconds} onChange={(event) => updateDraft('fulfillmentSlaSeconds', event.target.value)} /></label>
              <label>预计准备<NumberInputWithUnit inputMode="numeric" min={0} max={240} unit="分钟" value={draft.recommendationExpectedPrepMinutes} onChange={(event) => updateDraft('recommendationExpectedPrepMinutes', event.target.value)} /></label>
              <label>推荐保留<NumberInputWithUnit inputMode="numeric" min={0} max={240} unit="分钟" value={draft.recommendationHoldMinutes} onChange={(event) => updateDraft('recommendationHoldMinutes', event.target.value)} /></label>
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
                <label>每份配方产出数量<NumberInputWithUnit inputMode="numeric" min={1} max={1000} unit="份" value={recipeYield} onChange={(event) => setRecipeYield(event.target.value)} /></label>
                {inventoryItems.length === 0
                  ? <p>当前还没有库存物料。请先在“库存与瓶存”中扫码或手工建立物料，再回来配置配方。</p>
                  : <><label>先按原料品类筛选<select value={recipeCategoryFilter} onChange={(event) => setRecipeCategoryFilter(event.target.value)}><option value="">全部原料</option>{recipeCategories.map((category) => <option key={category} value={category}>{inventoryCategoryLabel(category)}</option>)}</select><small>已选原料不会因筛选而丢失；可切换品类继续添加。</small></label><div className="catalog-recipe-items">{visibleRecipeItems.map((item) => {
                    const component = recipeComponents[item.id]
                    const requiresMigration = requiresMillilitreInventoryMigration(item.categoryCode, item.baseUnit)
                    return <article key={item.id} className={component === undefined ? '' : 'is-selected'}>
                      <label><input type="checkbox" checked={component !== undefined} onChange={() => toggleRecipeComponent(item.id)} /><span><strong>{item.name}</strong><small>{inventoryCategoryLabel(item.categoryCode)} · {item.sku} · 员工录入 {inventoryUnitLabel(inventoryEmployeeUnit(item.categoryCode, item.baseUnit))}{requiresMigration ? '（历史瓶数自动换算）' : ''}</small></span></label>
                      {component !== undefined && <div><label>每份用量<NumberInputWithUnit inputMode="decimal" unit={inventoryUnitLabel(inventoryEmployeeUnit(item.categoryCode, item.baseUnit))} value={component.quantity} onChange={(event) => updateRecipeComponent(item.id, 'quantity', event.target.value)} /></label><label>预计损耗<NumberInputWithUnit inputMode="decimal" unit={inventoryUnitLabel(inventoryEmployeeUnit(item.categoryCode, item.baseUnit))} value={component.expectedWasteQuantity} onChange={(event) => updateRecipeComponent(item.id, 'expectedWasteQuantity', event.target.value)} /></label></div>}
                    </article>
                  })}</div>{visibleRecipeItems.length === 0 && <p>该品类暂未录入物料。可在“库存与瓶存”先建立或补齐分类。</p>}</>}
                <button type="button" disabled={recipeBusy || inventoryItems.length === 0} onClick={() => void saveRecipe()}>{recipeBusy ? '保存中' : '保存配方并刷新可售检查'}</button>
                {canViewInventoryCost && recipeCost !== null && <section className="catalog-recipe-cost" aria-label="配方成本核算">
                  <header><div><strong>配方成本核算</strong><small>只读取已确认收货形成的移动加权库存成本。保存配方或确认收货后，系统会自动更新当前成本；历史订单不会改写。</small></div><em>{recipeCost.costAmountMinor === null ? '待补成本' : `¥${minorToYuan(recipeCost.costAmountMinor)}/份`}</em></header>
                  {recipeCost.costAmountMinor === null
                    ? <p>以下物料成本待补或待核对：{recipeCost.components.filter((component) => component.componentCostMinor === null).map((component) => component.itemName).join('、')}。销售仍可继续，但毛利会明确显示为不完整。</p>
                    : <div className="catalog-recipe-cost-lines">{recipeCost.components.map((component) => <span key={component.inventoryItemId}>{component.itemName} · {component.componentCostMinor === null ? '待补成本' : `¥${minorToYuan(component.componentCostMinor)}`}</span>)}</div>}
                </section>}
              </>}
            </section>}
            {!canManageInventory && draft.productKind === 'single' && draft.inventoryControlMode === 'tracked' && <section className="catalog-recipe catalog-wide" aria-label="商品库存配方权限说明">
              <header><div><strong>库存扣减配方</strong><small>该商品需要配方才能按真实物料扣减和通过小程序可售校验。</small></div><em>需要授权</em></header>
              <p>当前账号没有“库存管理”权限，因此不能查看或调整配方。请由管理员分配库存管理权限，或请有该权限的同事完成配置；商品资料入口仍可正常使用。</p>
            </section>}
          </div>
          {draft.productKind === 'bundle' && <section className="catalog-components"><strong>组合内容</strong><div>{singleProducts.map((product) => <label key={product.id} className={product.id in draft.componentQuantities ? 'is-selected' : ''}><input type="checkbox" checked={product.id in draft.componentQuantities} onChange={() => toggleComponent(product.id)} /><span>{product.name}</span>{product.id in draft.componentQuantities && <NumberInputWithUnit aria-label={`${product.name}数量`} inputMode="numeric" unit="份" value={draft.componentQuantities[product.id]} onChange={(event) => updateDraft('componentQuantities', { ...draft.componentQuantities, [product.id]: event.target.value })} />}</label>)}</div></section>}
          <button type="submit" className="catalog-save" disabled={busy || performancePhaseDirty}>{busy ? <LoaderCircle className="is-spinning" size={18} /> : <Check size={18} />}{performancePhaseDirty ? '请先处理阶段配置' : '保存并读回验证'}</button>
        </form>}
        <div className="catalog-management-list">{visibleProducts.map((product) => {
          const blockers = sellingBlockers(product)
          const categoryLabel = menuCategoryOptions.find((option) => option.code === product.categoryCode)?.label ?? '其他分类'
          return <article key={product.id}><div><strong>{product.name}</strong><span>{product.code} · {categoryLabel} · {product.productKind === 'bundle' ? '组合' : stationLabel(product.fulfillmentStation)}</span><small>{statusLabel(product.status)} · {product.inventoryControlMode === 'tracked' ? '跟踪库存' : '暂不管理数量'} · {product.guestVisible ? '顾客可见' : '顾客隐藏'} · {product.standardPrice?.amountMinor == null ? '未定价' : `¥${minorToYuan(product.standardPrice.amountMinor)}`}</small>{isInventoryFlow && <small className={blockers.length === 0 ? 'catalog-sale-state is-ready' : 'catalog-sale-state'}>{blockers.length === 0 ? '小程序可售' : `待完成：${blockers[0]}`}</small>}</div><button type="button" onClick={() => startEdit(product)}><Pencil size={16} /> 编辑</button></article>
        })}</div>
      </>}
    </div>}
  </section>
}

async function loadAllProducts(api: NormalizedApiClient): Promise<CatalogProduct[]> {
  const products: CatalogProduct[] = []
  const pageSize = 100
  for (let offset = 0; offset < 10_000; offset += pageSize) {
    const response = await api.getEndpoint<{ data: unknown }>(
      `/api/catalog/products?status=all&limit=${pageSize}&offset=${offset}`,
    )
    const page = readProducts(response.data)
    products.push(...page)
    if (page.length < pageSize) return products
  }
  throw new Error('商品数量超过当前可读取范围，请缩小检索范围后重试')
}

function emptyDraft(categories: readonly MenuCategory[]): ProductDraft {
  const preferred = categories.find((category) => category.code === 'drinks')
    ?? categories.find((category) => category.parentCode === null)
    ?? categories[0]
  return {
    id: null, code: '', name: '', categoryCode: preferred?.code ?? '', fulfillmentStation: 'bar', productKind: 'single', inventoryControlMode: 'tracked',
    salesSpecificationType: 'custom',
    status: 'inactive', guestVisible: true, searchText: '', recommendationEnabled: false,
    recommendationMinGuests: '1', recommendationMaxGuests: '100', recommendationPriority: '100',
    recommendationSceneTags: '', recommendationIntentTags: '', recommendationTasteTags: '',
    recommendationDwellTags: '', recommendationSingleWaveEligible: true,
    recommendationExpectedPrepMinutes: '8', recommendationHoldMinutes: '10',
    recommendationUpgradeProductId: '', sortOrder: '999', availableFrom: '', availableUntil: '',
    allowedChannels: ['guest_qr', 'staff_assisted', 'cashier', 'reservation', 'integration'],
    maxOrderQuantity: '50', kdsPriority: '100', fulfillmentSlaSeconds: '',
    costYuan: '', costChangeReason: '', priceYuan: '', priceReason: '新增商品标准售价', description: '', imageUrl: '', snapshot: {}, componentQuantities: {},
  }
}

function emptyMenuCategoryDraft(categories: readonly MenuCategory[]): MenuCategoryDraft {
  const sortOrder = categories.length === 0
    ? 100
    : Math.min(100000, Math.max(...categories.map((category) => category.sortOrder)) + 10)
  return {
    id: null,
    code: '',
    displayName: '',
    parentCode: '',
    sortOrder: String(sortOrder),
    guestVisible: true,
  }
}

function categorySelectOptions(categories: readonly MenuCategory[]): Array<{ code: string; label: string }> {
  const roots = categories.filter((category) => category.parentCode === null)
  const childrenByParent = new Map<string, MenuCategory[]>()
  categories.filter((category) => category.parentCode !== null).forEach((category) => {
    const parent = category.parentCode!
    childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), category])
  })
  const options: Array<{ code: string; label: string }> = []
  roots.forEach((root) => {
    options.push({ code: root.code, label: root.displayName })
    ;(childrenByParent.get(root.code) ?? []).forEach((child) => {
      options.push({ code: child.code, label: `— ${child.displayName}` })
    })
  })
  categories.filter((category) => category.parentCode !== null && !roots.some((root) => root.code === category.parentCode))
    .forEach((category) => options.push({ code: category.code, label: category.displayName }))
  return options
}

function readSalesSpecificationType(value: unknown): SalesSpecificationType {
  return salesSpecificationOptions.some((option) => option.code === value)
    ? value as SalesSpecificationType
    : 'custom'
}

function salesSpecificationLabel(value: SalesSpecificationType): string {
  return salesSpecificationOptions.find((option) => option.code === value)?.label ?? '自定义'
}

function companionProductCode(
  sourceCode: string,
  specification: SalesSpecificationType,
  products: readonly CatalogProduct[],
): string {
  const suffix = specification === 'glass' ? 'GLASS' : 'BOTTLE'
  const base = `${sourceCode.replace(/-(?:GLASS|BOTTLE)(?:-\d+)?$/i, '')}-${suffix}`.slice(0, 60)
  const existing = new Set(products.map((product) => product.code.toUpperCase()))
  if (!existing.has(base.toUpperCase())) return base
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base.slice(0, 59 - String(index).length)}-${index}`
    if (!existing.has(candidate.toUpperCase())) return candidate
  }
  return `${base.slice(0, 54)}-${Date.now().toString().slice(-5)}`
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

function readMenuCategories(value: unknown): MenuCategory[] {
  if (!Array.isArray(value)) return []
  const categories = value.flatMap((item): MenuCategory[] => (
    isRecord(item)
      && typeof item.id === 'string'
      && typeof item.code === 'string'
      && typeof item.displayName === 'string'
      && (item.parentCode === null || typeof item.parentCode === 'string')
      && Number.isSafeInteger(item.sortOrder)
      && typeof item.guestVisible === 'boolean'
      && Number.isSafeInteger(item.productCount)
      && typeof item.createdAt === 'string'
      && typeof item.updatedAt === 'string'
      ? [item as unknown as MenuCategory]
      : []
  ))
  return categories.sort((left, right) => (
    (left.parentCode === null ? 0 : 1) - (right.parentCode === null ? 0 : 1)
    || left.sortOrder - right.sortOrder
    || left.displayName.localeCompare(right.displayName, 'zh-CN')
  ))
}

function readInventoryItems(value: unknown): InventoryItemOption[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return []
  return value.items.flatMap((item): InventoryItemOption[] => (
    isRecord(item) && typeof item.id === 'string' && typeof item.sku === 'string'
      && typeof item.name === 'string' && typeof item.baseUnit === 'string' && typeof item.categoryCode === 'string'
      && (item.packageVolumeMl === null || typeof item.packageVolumeMl === 'string')
      ? [{ id: item.id, sku: item.sku, name: item.name, baseUnit: item.baseUnit, categoryCode: item.categoryCode,
          packageVolumeMl: item.packageVolumeMl }]
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
  instructionsSnapshot: Record<string, unknown>
  components: Array<RecipeComponentDraft & { inventoryItemId: string }>
} | null {
  if (value === null) return null
  if (!isRecord(value) || !Number.isSafeInteger(value.version) || !Number.isSafeInteger(value.yieldQuantity)
    || !isRecord(value.instructionsSnapshot) || !Array.isArray(value.components)) throw new Error('库存配方返回格式无效')
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
  return {
    version: value.version as number,
    yieldQuantity: value.yieldQuantity as number,
    instructionsSnapshot: value.instructionsSnapshot,
    components,
  }
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
