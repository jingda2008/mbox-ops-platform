import {
  ArrowLeftRight,
  BadgeCheck,
  Ban,
  BookOpen,
  Boxes,
  Check,
  ClipboardCheck,
  ClipboardList,
  CircleAlert,
  History,
  FlaskConical,
  LoaderCircle,
  PackageOpen,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Wine,
} from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import * as inventoryApi from '../inventory-api'
import type { Employee, MenuProduct, RoleConfig } from '../shared/contracts'
import { chinaDateKey, formatChinaDateTime, shiftDateKey } from '../shared/china-time'
import type {
  BottleOwner,
  BottleStorageBatch,
  InventoryApprovalRequest,
  InventoryDomainState,
  InventoryRecipeLine,
  InventoryRecipeVersion,
  InventoryOperationPolicy,
  InventoryStockAlertRule,
  StockCount,
} from '../shared/inventory-contracts'
import { useRevealPanelScroll } from './use-reveal-panel-scroll'
import './InventoryView.css'

type InventoryTab = 'overview' | 'receipt' | 'count' | 'recipes' | 'remake' | 'bottles' | 'approvals' | 'policy'
type Notice = { tone: 'success' | 'error'; message: string }
type BottleAction = 'use' | 'transfer' | 'void'
type InventoryItemOption = {
  id: string
  name: string
  sku: string
  specification: string
  defaultUnitCode: string
  kind: 'product' | 'ingredient'
}
type InventoryBalanceRow = {
  item: InventoryItemOption
  balance?: InventoryDomainState['balances'][number]
  quantity: number
  unitCode: string
  recipe?: InventoryRecipeVersion
  updatedAt?: string
  alertRule: Pick<InventoryStockAlertRule, 'itemId' | 'enabled' | 'warningQuantity'>
}

const DEFAULT_LOW_STOCK_QUANTITY = 5
const policyLabels: Record<keyof InventoryOperationPolicy, string> = {
  policyAdminRoleIds: '修改库存权限',
  receiptRoleIds: '登记入库',
  stockCountRoleIds: '提交盘点',
  stockCountApprovalRoleIds: '复核盘点差异',
  bottleDepositRoleIds: '登记客存酒',
  bottleUseRoleIds: '取用及发起高风险操作',
  bottleApprovalRoleIds: '复核转赠与作废',
}
const stockCountLabels: Record<StockCount['status'], string> = {
  pending_confirmation: '待复核',
  applied: '已入账',
  rejected: '已驳回',
}
const bottleStatusLabels: Record<BottleStorageBatch['status'], string> = {
  stored: '在库',
  partially_used: '部分取用',
  exhausted: '已取完',
  transferred: '已转赠',
  voided: '已作废',
  expired: '已过期',
}

export function InventoryView() {
  const [workspace, setWorkspace] = useState<inventoryApi.InventoryWorkspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busyAction, setBusyAction] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [tab, setTab] = useState<InventoryTab>('overview')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      setWorkspace(await inventoryApi.getInventoryWorkspace())
    } catch (error) {
      setLoadError(errorMessage(error, '库存数据载入失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function execute(action: string, successMessage: string, operation: () => Promise<unknown>) {
    setBusyAction(action)
    setNotice(null)
    try {
      await operation()
      setWorkspace(await inventoryApi.getInventoryWorkspace())
      setNotice({ tone: 'success', message: successMessage })
    } catch (error) {
      setNotice({ tone: 'error', message: errorMessage(error, '库存操作失败，请重试') })
    } finally {
      setBusyAction('')
    }
  }

  if (loading && !workspace) return <InventoryState loading text="正在载入库存账本" />
  if (!workspace) return <InventoryState text={loadError || '库存数据不可用'} onRetry={load} />

  const { inventory, context } = workspace
  const products = context.products.filter((product) => product.enabled)
  const activeRecipes = inventory.recipeVersions.filter((recipe) => recipe.status === 'active')
  const recipeProductIds = new Set(activeRecipes.map((recipe) => recipe.productId))
  const inventoryItems: InventoryItemOption[] = [
    ...products.filter((product) => !recipeProductIds.has(product.id)).map((product) => ({
      id: product.id,
      name: product.name,
      sku: product.sku,
      specification: product.specification,
      defaultUnitCode: 'unit',
      kind: 'product' as const,
    })),
    ...inventory.ingredientSkus.filter((item) => item.enabled).map((item) => ({
      id: item.id,
      name: item.name,
      sku: item.sku,
      specification: '原料SKU',
      defaultUnitCode: item.baseUnitCode,
      kind: 'ingredient' as const,
    })),
  ]
  const overviewItems: InventoryItemOption[] = [
    ...products.map((product) => ({
      id: product.id,
      name: product.name,
      sku: product.sku,
      specification: product.specification,
      defaultUnitCode: 'unit',
      kind: 'product' as const,
    })),
    ...inventory.ingredientSkus.filter((item) => item.enabled).map((item) => ({
      id: item.id,
      name: item.name,
      sku: item.sku,
      specification: '原料SKU',
      defaultUnitCode: item.baseUnitCode,
      kind: 'ingredient' as const,
    })),
  ]
  const balanceRows: InventoryBalanceRow[] = overviewItems.map((item) => {
    const configuredAlert = inventory.stockAlertRules.find((rule) => rule.itemId === item.id)
    const alertRule = configuredAlert ?? { itemId: item.id, enabled: true, warningQuantity: DEFAULT_LOW_STOCK_QUANTITY }
    const recipe = activeRecipes.find((candidate) => candidate.productId === item.id)
    if (recipe) {
      const ingredientBalances = recipe.lines.map((line) => inventory.balances.find((balance) => balance.productId === line.ingredientSkuId))
      const theoreticalQuantity = recipe.lines.length === 0 ? 0 : Math.min(...recipe.lines.map((line, index) => (
        Math.floor((ingredientBalances[index]?.onHandQuantity ?? 0) / line.standardQuantity)
      )))
      return {
        item,
        quantity: theoreticalQuantity,
        unitCode: '杯（理论）',
        recipe,
        updatedAt: ingredientBalances.map((balance) => balance?.updatedAt).filter((value): value is string => Boolean(value)).sort().at(-1),
        alertRule,
      }
    }
    const balance = inventory.balances.find((balance) => balance.productId === item.id)
    return { item, balance, quantity: balance?.onHandQuantity ?? 0, unitCode: balance?.unitCode ?? item.defaultUnitCode, updatedAt: balance?.updatedAt, alertRule }
  })
  const lowStockCount = balanceRows.filter((row) => row.alertRule.enabled && row.quantity <= row.alertRule.warningQuantity).length
  const pendingCounts = inventory.stockCounts.filter((item) => item.status === 'pending_confirmation')
  const activeBottles = inventory.bottleBatches.filter((item) => ['stored', 'partially_used'].includes(item.status))
  const pendingApprovals = inventory.approvalRequests.filter((item) => item.status === 'pending')

  return (
    <section className="inventory-view">
      <header className="inventory-heading">
        <div><span className="eyebrow">实物库存、盘点与客存酒</span><h2>库存管理</h2></div>
        <button className="secondary-button" type="button" disabled={loading || Boolean(busyAction)} onClick={() => void load()}>
          <RefreshCw className={loading ? 'spin' : ''} size={16} />刷新
        </button>
      </header>

      {notice && (
        <div className={`inventory-notice is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.tone === 'success' ? <BadgeCheck size={17} /> : <CircleAlert size={17} />}
          <span>{notice.message}</span>
        </div>
      )}
      {loadError && workspace && <div className="inventory-notice is-error" role="alert"><CircleAlert size={17} />{loadError}</div>}

      <div className="inventory-metrics" aria-label="库存概览">
        <Metric icon={<Boxes size={19} />} value={String(balanceRows.length)} label="在管商品" />
        <Metric icon={<CircleAlert size={19} />} value={String(lowStockCount)} label="按各项水位关注" warning={lowStockCount > 0} />
        <Metric icon={<ClipboardCheck size={19} />} value={String(pendingCounts.length)} label="待复核盘点" warning={pendingCounts.length > 0} />
        <Metric icon={<Wine size={19} />} value={String(activeBottles.length)} label="有效客存酒" />
        <Metric icon={<ShieldAlert size={19} />} value={String(pendingApprovals.length)} label="待审批单" warning={pendingApprovals.length > 0} />
      </div>

      <nav className="inventory-tabs" aria-label="库存功能">
        <TabButton active={tab === 'overview'} icon={<Boxes size={16} />} label="库存总览" onClick={() => setTab('overview')} />
        <TabButton active={tab === 'receipt'} icon={<PackageOpen size={16} />} label="入库" onClick={() => setTab('receipt')} />
        <TabButton active={tab === 'count'} icon={<ClipboardList size={16} />} label="盘点" badge={pendingCounts.length} onClick={() => setTab('count')} />
        <TabButton active={tab === 'recipes'} icon={<FlaskConical size={16} />} label="原料配方" onClick={() => setTab('recipes')} />
        <TabButton active={tab === 'remake'} icon={<RotateCcw size={16} />} label="补做耗用" onClick={() => setTab('remake')} />
        <TabButton active={tab === 'bottles'} icon={<Wine size={16} />} label="客存酒" onClick={() => setTab('bottles')} />
        <TabButton active={tab === 'approvals'} icon={<ShieldAlert size={16} />} label="待审批" badge={pendingApprovals.length} onClick={() => setTab('approvals')} />
        <TabButton active={tab === 'policy'} icon={<Settings2 size={16} />} label="库存配置" onClick={() => setTab('policy')} />
      </nav>

      {tab === 'overview' && <InventoryOverview inventory={inventory} products={products} rows={balanceRows} />}
      {tab === 'receipt' && <ReceiptPanel inventory={inventory} items={inventoryItems} busy={busyAction} execute={execute} />}
      {tab === 'count' && <StockCountPanel inventory={inventory} items={inventoryItems} employees={context.employees} busy={busyAction} execute={execute} />}
      {tab === 'recipes' && <RecipePanel inventory={inventory} products={products} busy={busyAction} execute={execute} />}
      {tab === 'remake' && <RemakePanel orders={context.orderDomain.orders} busy={busyAction} execute={execute} />}
      {tab === 'bottles' && (
        <BottlePanel
          inventory={inventory}
          products={products}
          employees={context.employees}
          members={context.members}
          tableSessions={context.songState.tableSessions}
          orders={context.orderDomain.orders}
          busy={busyAction}
          execute={execute}
        />
      )}
      {tab === 'approvals' && <ApprovalPanel approvals={inventory.approvalRequests} currentActorId={context.viewer?.actorId ?? currentActor()} busy={busyAction} execute={execute} />}
      {tab === 'policy' && <PolicyPanel inventory={inventory} roles={context.config.roles} employees={context.employees} rows={balanceRows} busy={busyAction} execute={execute} />}
    </section>
  )
}

function InventoryOverview({
  inventory,
  rows,
}: {
  inventory: InventoryDomainState
  products: MenuProduct[]
  rows: InventoryBalanceRow[]
}) {
  const productName = (id: string) => rows.find((row) => row.item.id === id)?.item.name ?? id
  return (
    <div className="inventory-content">
      <section className="inventory-section">
        <SectionHeading icon={<Boxes size={18} />} title="实时库存余额" meta={`${rows.length}项`} />
        <div className="inventory-table-wrap">
          <table className="inventory-table balance-table">
            <thead><tr><th>商品</th><th>SKU / 规格</th><th>可用数量</th><th>单位</th><th>最近更新</th><th>状态</th></tr></thead>
            <tbody>
              {rows.map(({ item, balance, quantity, unitCode, recipe, updatedAt, alertRule }) => {
                const lowStock = alertRule.enabled && quantity <= alertRule.warningQuantity
                return (
                <tr key={item.id} className={lowStock ? 'is-low-stock' : ''}>
                  <td><strong>{item.name}</strong><small>{item.kind === 'ingredient' ? '原料' : recipe ? `配方商品 · v${recipe.version}` : '整件商品'}</small></td>
                  <td>{item.sku}<small>{item.specification}</small></td>
                  <td className="quantity-cell">{quantity}</td>
                  <td>{unitCode}</td>
                  <td>{updatedAt ? formatDateTime(updatedAt) : balance ? formatDateTime(balance.updatedAt) : '尚无流水'}</td>
                  <td><StatusPill tone={!alertRule.enabled ? 'neutral' : quantity === 0 ? 'danger' : lowStock ? 'warning' : 'success'}>{!alertRule.enabled ? '未监控' : quantity === 0 ? '零库存' : lowStock ? `需关注 ≤ ${alertRule.warningQuantity}` : '正常'}</StatusPill></td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="inventory-section">
        <SectionHeading icon={<History size={18} />} title="最近库存流水" meta={`${inventory.movements.length}笔`} />
        <div className="inventory-event-list">
          {inventory.movements.length === 0 && <EmptyState icon={<History size={24} />} text="暂无库存流水" />}
          {inventory.movements.toReversed().slice(0, 30).map((movement) => (
            <div className="inventory-event-row" key={movement.id}>
              <StatusPill tone={movement.direction === 'in' ? 'success' : 'warning'}>{movementLabel(movement.type)}</StatusPill>
              <div><strong>{productName(movement.productId)}</strong><small>{movement.reason}</small></div>
              <b>{movement.direction === 'in' ? '+' : '-'}{movement.quantity} {movement.unitCode}</b>
              <span>余额 {movement.balanceAfter}</span>
              <time>{formatDateTime(movement.occurredAt)}</time>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function ReceiptPanel({
  inventory,
  items,
  busy,
  execute,
}: {
  inventory: InventoryDomainState
  items: InventoryItemOption[]
  busy: string
  execute: ExecuteOperation
}) {
  const [productId, setProductId] = useState(items[0]?.id ?? '')
  const currentBalance = inventory.balances.find((item) => item.productId === productId)
  const selectedItem = items.find((item) => item.id === productId)
  const ingredient = inventory.ingredientSkus.find((item) => item.id === productId)
  const [unitCode, setUnitCode] = useState(currentBalance?.unitCode ?? selectedItem?.defaultUnitCode ?? 'unit')
  const [quantity, setQuantity] = useState(1)
  const [reason, setReason] = useState('供应商到货验收入库')

  function changeProduct(id: string) {
    setProductId(id)
    const next = items.find((item) => item.id === id)
    setUnitCode(inventory.balances.find((item) => item.productId === id)?.unitCode ?? next?.defaultUnitCode ?? 'unit')
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void execute('receipt', '入库已登记并写入不可变库存流水', async () => {
      await inventoryApi.receiveInventory({ productId, unitCode: unitCode.trim(), quantity, reason: reason.trim() })
      setQuantity(1)
    })
  }

  return (
    <div className="inventory-content inventory-two-column">
      <section className="inventory-section">
        <SectionHeading icon={<PackageOpen size={18} />} title="登记入库" meta="到账后立即登记" />
        <form className="inventory-form" onSubmit={submit}>
          <Field label="商品或原料"><select required value={productId} onChange={(event) => changeProduct(event.target.value)}>{items.map((item) => <option key={item.id} value={item.id}>{item.kind === 'ingredient' ? '原料' : '整件'} · {item.name} · {item.sku}</option>)}</select></Field>
          <div className="inventory-form-pair">
            <Field label="数量"><input required type="number" min={1} step={1} value={quantity} onChange={(event) => setQuantity(Math.max(1, Number(event.target.value)))} /></Field>
            <Field label={ingredient ? '到货单位' : '库存单位'}>{ingredient ? <select value={unitCode} onChange={(event) => setUnitCode(event.target.value)}>{ingredient.conversions.map((conversion) => <option key={conversion.unitCode} value={conversion.unitCode}>{conversion.unitCode} = {conversion.baseQuantity} {ingredient.baseUnitCode}</option>)}</select> : <input required pattern="[A-Za-z0-9][A-Za-z0-9_.-]*" value={unitCode} onChange={(event) => setUnitCode(event.target.value)} disabled={Boolean(currentBalance)} />}</Field>
          </div>
          <Field label="入库原因"><textarea required minLength={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
          <button className="primary-button" type="submit" disabled={!productId || Boolean(busy)}>{busy === 'receipt' ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}确认入库</button>
        </form>
      </section>
      <aside className="inventory-guidance">
        <ShieldCheck size={20} />
        <div><strong>入库操作要求</strong><p>只登记已实际验收的货品；同一商品建立库存后不能切换计量单位。每次入库会保留操作人、营业日、原因与入库后余额。</p></div>
      </aside>
    </div>
  )
}

function StockCountPanel({
  inventory,
  items,
  employees,
  busy,
  execute,
}: {
  inventory: InventoryDomainState
  items: InventoryItemOption[]
  employees: Employee[]
  busy: string
  execute: ExecuteOperation
}) {
  const [productId, setProductId] = useState(items[0]?.id ?? '')
  const [countedQuantity, setCountedQuantity] = useState(0)
  const [decisionReasons, setDecisionReasons] = useState<Record<string, string>>({})
  const balance = inventory.balances.find((item) => item.productId === productId)
  const currentActorId = currentActor()
  const productName = (id: string) => items.find((item) => item.id === id)?.name ?? id
  const employeeName = (id: string) => employees.find((item) => item.id === id)?.displayName ?? id

  function submit(event: FormEvent) {
    event.preventDefault()
    const approvalId = `stock-count-approval-${crypto.randomUUID()}`
    void execute('count-submit', '盘点已提交；有差异的记录已进入双人复核', () => inventoryApi.submitStockCount({
      productId,
      unitCode: balance?.unitCode ?? 'unit',
      countedQuantity,
      approvalId,
    }))
  }

  function decide(item: StockCount, decision: 'confirm' | 'reject') {
    const reason = decisionReasons[item.id]?.trim() ?? ''
    if (!reason) return
    void execute(`count-${decision}:${item.id}`, decision === 'confirm' ? '盘点差异已复核入账' : '盘点差异已驳回', () => inventoryApi.decideStockCount(item.id, {
      decision,
      approvalId: item.approvalId ?? '',
      reason,
    }))
  }

  const pending = inventory.stockCounts.filter((item) => item.status === 'pending_confirmation')
  return (
    <div className="inventory-content">
      <section className="inventory-section">
        <SectionHeading icon={<ClipboardList size={18} />} title="提交盘点" meta="差异自动触发复核" />
        <form className="count-submit-band" onSubmit={submit}>
          <Field label="商品或原料"><select value={productId} onChange={(event) => setProductId(event.target.value)}>{items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <div className="count-expected"><span>系统账面</span><strong>{balance?.onHandQuantity ?? 0}</strong><small>{balance?.unitCode ?? 'unit'}</small></div>
          <Field label="实盘数量"><input required type="number" min={0} step={1} value={countedQuantity} onChange={(event) => setCountedQuantity(Math.max(0, Number(event.target.value)))} /></Field>
          <button className="primary-button" type="submit" disabled={!productId || Boolean(busy)}>{busy === 'count-submit' ? <LoaderCircle className="spin" size={16} /> : <ClipboardCheck size={16} />}提交盘点</button>
        </form>
      </section>

      <section className="inventory-section">
        <SectionHeading icon={<ShieldCheck size={18} />} title="差异复核" meta={`${pending.length}笔待处理`} />
        <div className="stock-count-list">
          {pending.length === 0 && <EmptyState icon={<Check size={24} />} text="没有待复核的盘点差异" />}
          {pending.map((item) => {
            const isOwnCount = item.countedBy === currentActorId
            const reason = decisionReasons[item.id] ?? ''
            return (
              <article className="stock-count-row" key={item.id}>
                <div><StatusPill tone={item.differenceQuantity > 0 ? 'success' : 'danger'}>{item.differenceQuantity > 0 ? `盘盈 +${item.differenceQuantity}` : `盘亏 ${item.differenceQuantity}`}</StatusPill><small>{formatDateTime(item.countedAt)}</small></div>
                <div className="stock-count-detail"><strong>{productName(item.productId)}</strong><span>账面 {item.expectedQuantity} · 实盘 {item.countedQuantity} {item.unitCode}</span><small>盘点人：{employeeName(item.countedBy)}</small></div>
                <label className="decision-reason"><span>复核说明</span><input value={reason} maxLength={500} placeholder={isOwnCount ? '本人不能复核自己的盘点' : '必填，写明核查依据'} disabled={isOwnCount || Boolean(busy)} onChange={(event) => setDecisionReasons((current) => ({ ...current, [item.id]: event.target.value }))} /></label>
                <div className="stock-count-actions">
                  <button className="primary-button" type="button" disabled={isOwnCount || !reason.trim() || Boolean(busy)} onClick={() => decide(item, 'confirm')}><Check size={16} />确认入账</button>
                  <button className="secondary-button" type="button" disabled={isOwnCount || !reason.trim() || Boolean(busy)} onClick={() => decide(item, 'reject')}><Ban size={16} />驳回</button>
                </div>
              </article>
            )
          })}
        </div>
      </section>

      <section className="inventory-section">
        <SectionHeading icon={<History size={18} />} title="盘点记录" meta={`${inventory.stockCounts.length}笔`} />
        <div className="compact-record-list">
          {inventory.stockCounts.length === 0 && <EmptyState icon={<ClipboardList size={24} />} text="尚无盘点记录" />}
          {inventory.stockCounts.toReversed().slice(0, 30).map((item) => <div key={item.id}><strong>{productName(item.productId)}</strong><span>账面 {item.expectedQuantity} / 实盘 {item.countedQuantity}</span><StatusPill tone={item.status === 'applied' ? 'success' : item.status === 'rejected' ? 'danger' : 'warning'}>{stockCountLabels[item.status]}</StatusPill><time>{formatDateTime(item.countedAt)}</time></div>)}
        </div>
      </section>
    </div>
  )
}

interface BottlePanelProps {
  inventory: InventoryDomainState
  products: MenuProduct[]
  employees: Employee[]
  members: Array<{ id: string; displayName: string; phoneMasked: string }>
  tableSessions: Array<{ id: string; tableCode: string; status: string }>
  orders: Array<{ id: string; tableSessionId: string; items: Array<{ id: string; name: string }> }>
  busy: string
  execute: ExecuteOperation
}

function BottlePanel(props: BottlePanelProps) {
  const { inventory, products, employees, members, tableSessions, orders, busy, execute } = props
  const [showDeposit, setShowDeposit] = useState(false)
  const [selectedBatchId, setSelectedBatchId] = useState('')
  const [action, setAction] = useState<BottleAction>('use')
  const activeBatches = inventory.bottleBatches.filter((item) => ['stored', 'partially_used'].includes(item.status))
  const selectedBatch = activeBatches.find((item) => item.id === selectedBatchId) ?? null
  const employeeName = (id: string) => employees.find((item) => item.id === id)?.displayName ?? id
  const openSessions = tableSessions.filter((item) => item.status === 'open')
  const depositPanelRef = useRevealPanelScroll<HTMLDivElement>(showDeposit ? 'bottle-deposit' : '')
  const actionPanelRef = useRevealPanelScroll<HTMLDivElement>(selectedBatch ? `${selectedBatch.id}:${action}` : '')

  function openAction(batch: BottleStorageBatch, nextAction: BottleAction) {
    setSelectedBatchId(batch.id)
    setAction(nextAction)
  }

  return (
    <div className="inventory-content">
      <section className="inventory-section">
        <div className="inventory-section-heading">
          <div><Wine size={18} /><span><strong>客存酒台账</strong><small>{activeBatches.length}批有效存酒</small></span></div>
          <button className="primary-button" type="button" onClick={() => setShowDeposit((value) => !value)}><PackageOpen size={16} />{showDeposit ? '收起登记' : '登记存酒'}</button>
        </div>
        {showDeposit && <div className="reveal-panel-target" ref={depositPanelRef}><BottleDepositForm products={products} members={members} sessions={openSessions} orders={orders} busy={busy} execute={execute} onDone={() => setShowDeposit(false)} /></div>}
        {selectedBatch && <div className="reveal-panel-target" ref={actionPanelRef}><BottleActionPanel batch={selectedBatch} action={action} members={members} sessions={openSessions} orders={orders} busy={busy} execute={execute} onClose={() => setSelectedBatchId('')} /></div>}
        <div className="bottle-list">
          {inventory.bottleBatches.length === 0 && <EmptyState icon={<Wine size={24} />} text="暂无客存酒记录" />}
          {inventory.bottleBatches.toReversed().map((batch) => {
            const active = ['stored', 'partially_used'].includes(batch.status)
            return (
              <article className="bottle-row" key={batch.id}>
                <div className="bottle-name"><strong>{batch.productNameSnapshot}</strong><span>{ownerName(batch.owner, members)}</span><small>批次 {shortId(batch.id)}</small></div>
                <div className="bottle-quantity"><strong>{batch.remainingQuantity}</strong><span>/ {batch.capacityQuantity} {batch.unitCode}</span></div>
                <div className="bottle-meta"><span><StatusPill tone={active ? 'success' : batch.status === 'voided' ? 'danger' : 'neutral'}>{bottleStatusLabels[batch.status]}</StatusPill></span><small>存入 {formatDateTime(batch.storedAt)}</small><small>到期 {formatDateTime(batch.expiresAt)}</small><small>经办 {employeeName(batch.storedBy)}</small></div>
                <div className="bottle-actions">
                  <button className="secondary-button" type="button" disabled={!active || Boolean(busy)} onClick={() => openAction(batch, 'use')}><Wine size={15} />取用</button>
                  <button className="secondary-button" type="button" disabled={!active || Boolean(busy)} onClick={() => openAction(batch, 'transfer')}><ArrowLeftRight size={15} />转赠</button>
                  <button className="icon-button" title="作废存酒" type="button" disabled={!active || Boolean(busy)} onClick={() => openAction(batch, 'void')}><Ban size={15} /></button>
                </div>
              </article>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function BottleDepositForm({
  products,
  members,
  sessions,
  orders,
  busy,
  execute,
  onDone,
}: Pick<BottlePanelProps, 'products' | 'members' | 'orders' | 'busy' | 'execute'> & { sessions: BottlePanelProps['tableSessions']; onDone: () => void }) {
  const [productId, setProductId] = useState(products[0]?.id ?? '')
  const [ownerType, setOwnerType] = useState<BottleOwner['kind']>('member')
  const [memberId, setMemberId] = useState(members[0]?.id ?? '')
  const [customerRef, setCustomerRef] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [capacity, setCapacity] = useState(1)
  const [unitCode, setUnitCode] = useState('bottle')
  const [expiresAt, setExpiresAt] = useState(defaultExpiryDate())
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? '')
  const matchingOrders = orders.filter((item) => item.tableSessionId === sessionId)
  const [orderId, setOrderId] = useState('')
  const effectiveOrderId = matchingOrders.some((item) => item.id === orderId) ? orderId : (matchingOrders[0]?.id ?? '')
  const selectedOrder = matchingOrders.find((item) => item.id === effectiveOrderId)
  const [orderItemId, setOrderItemId] = useState('')
  const effectiveItemId = selectedOrder?.items.some((item) => item.id === orderItemId) ? orderItemId : (selectedOrder?.items[0]?.id ?? '')
  const [reason, setReason] = useState('顾客离店前确认剩余酒量并登记存酒')
  const product = products.find((item) => item.id === productId)

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!product || !effectiveOrderId || !effectiveItemId) return
    const owner: BottleOwner = ownerType === 'member'
      ? { kind: 'member', memberId }
      : { kind: 'anonymous', customerRef: customerRef.trim(), displayNameSnapshot: displayName.trim() }
    void execute('bottle-deposit', '客存酒已登记，批次与原订单已绑定', async () => {
      await inventoryApi.depositBottle({
        productId: product.id,
        skuSnapshot: product.sku,
        productNameSnapshot: product.name,
        owner,
        capacityQuantity: capacity,
        unitCode: unitCode.trim(),
        expiresAt: new Date(`${expiresAt}T23:59:59+08:00`).toISOString(),
        tableSessionId: sessionId,
        orderId: effectiveOrderId,
        orderItemId: effectiveItemId,
        reason: reason.trim(),
      })
      onDone()
    })
  }

  return (
    <form className="bottle-form" onSubmit={submit}>
      <div className="bottle-form-title"><div><span className="eyebrow">与原订单绑定</span><h3>登记客存酒</h3></div><StatusPill tone="warning">人工确认余量</StatusPill></div>
      <Field label="商品"><select required value={productId} onChange={(event) => setProductId(event.target.value)}>{products.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.specification}</option>)}</select></Field>
      <div className="inventory-form-pair"><Field label="剩余数量"><input required type="number" min={1} step={1} value={capacity} onChange={(event) => setCapacity(Math.max(1, Number(event.target.value)))} /></Field><Field label="计量单位"><input required value={unitCode} onChange={(event) => setUnitCode(event.target.value)} /></Field></div>
      <Field label="保管到期日"><input required type="date" min={todayDate()} value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></Field>
      <Field label="客户类型"><select value={ownerType} onChange={(event) => setOwnerType(event.target.value as BottleOwner['kind'])}><option value="member">会员</option><option value="anonymous">未注册客户</option></select></Field>
      {ownerType === 'member'
        ? <Field label="会员"><select required value={memberId} onChange={(event) => setMemberId(event.target.value)}>{members.map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.phoneMasked}</option>)}</select></Field>
        : <div className="inventory-form-pair"><Field label="客户识别码"><input required value={customerRef} onChange={(event) => setCustomerRef(event.target.value)} placeholder="禁止填写完整手机号" /></Field><Field label="客户称呼"><input required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field></div>}
      <div className="inventory-form-triplet"><Field label="原桌次"><select required value={sessionId} onChange={(event) => { setSessionId(event.target.value); setOrderId(''); setOrderItemId('') }}>{sessions.map((item) => <option key={item.id} value={item.id}>{item.tableCode}</option>)}</select></Field><Field label="原订单"><select required value={effectiveOrderId} onChange={(event) => { setOrderId(event.target.value); setOrderItemId('') }}><option value="">请选择</option>{matchingOrders.map((item) => <option key={item.id} value={item.id}>{shortId(item.id)}</option>)}</select></Field><Field label="原商品行"><select required value={effectiveItemId} onChange={(event) => setOrderItemId(event.target.value)}><option value="">请选择</option>{selectedOrder?.items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div>
      {!effectiveOrderId && <div className="inventory-inline-warning"><CircleAlert size={16} />该桌次没有订单，需先在营业履约中心完成下单，才能建立可追溯存酒。</div>}
      <Field label="存酒说明"><textarea required minLength={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
      <button className="primary-button" type="submit" disabled={!effectiveOrderId || !effectiveItemId || Boolean(busy)}>{busy === 'bottle-deposit' ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}确认登记</button>
    </form>
  )
}

function BottleActionPanel({
  batch,
  action,
  members,
  sessions,
  orders,
  busy,
  execute,
  onClose,
}: {
  batch: BottleStorageBatch
  action: BottleAction
  members: BottlePanelProps['members']
  sessions: BottlePanelProps['tableSessions']
  orders: BottlePanelProps['orders']
  busy: string
  execute: ExecuteOperation
  onClose: () => void
}) {
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? '')
  const matchingOrders = orders.filter((item) => item.tableSessionId === sessionId)
  const [orderId, setOrderId] = useState('')
  const effectiveOrderId = matchingOrders.some((item) => item.id === orderId) ? orderId : (matchingOrders[0]?.id ?? '')
  const [quantity, setQuantity] = useState(1)
  const [reason, setReason] = useState(action === 'use' ? '顾客到店核验后取用' : action === 'transfer' ? '顾客现场确认转赠' : '存酒异常作废')
  const [ownerType, setOwnerType] = useState<BottleOwner['kind']>('member')
  const [memberId, setMemberId] = useState(members[0]?.id ?? '')
  const [customerRef, setCustomerRef] = useState('')
  const [displayName, setDisplayName] = useState('')

  function submit(event: FormEvent) {
    event.preventDefault()
    if (action === 'use') {
      if (!effectiveOrderId) return
      void execute(`bottle-use:${batch.id}`, '存酒取用已记录，剩余量已更新', async () => {
        await inventoryApi.useBottle(batch.id, { quantity, tableSessionId: sessionId, orderId: effectiveOrderId, reason: reason.trim() })
        onClose()
      })
      return
    }
    if (action === 'transfer') {
      const recipientOwner: BottleOwner = ownerType === 'member'
        ? { kind: 'member', memberId }
        : { kind: 'anonymous', customerRef: customerRef.trim(), displayNameSnapshot: displayName.trim() }
      void execute(`bottle-transfer:${batch.id}`, '转赠申请已进入待审批，第二名有权员工登录后才能执行', async () => {
        await inventoryApi.transferBottle(batch.id, { recipientOwner, tableSessionId: sessionId, orderId: effectiveOrderId || undefined, reason: reason.trim() })
        onClose()
      })
      return
    }
    void execute(`bottle-void:${batch.id}`, '作废申请已进入待审批，第二名有权员工登录后才能执行', async () => {
      await inventoryApi.voidBottle(batch.id, { tableSessionId: sessionId || undefined, orderId: effectiveOrderId || undefined, reason: reason.trim() })
      onClose()
    })
  }

  return (
    <form className="bottle-action-panel" onSubmit={submit}>
      <div className="bottle-action-heading"><div><span className="eyebrow">{batch.productNameSnapshot} · 剩余 {batch.remainingQuantity} {batch.unitCode}</span><h3>{action === 'use' ? '取用存酒' : action === 'transfer' ? '转赠存酒' : '作废存酒'}</h3></div><button className="icon-button" title="关闭" type="button" onClick={onClose}>×</button></div>
      {action === 'use' && <Field label="取用数量"><input required type="number" min={1} max={batch.remainingQuantity} step={1} value={quantity} onChange={(event) => setQuantity(Math.min(batch.remainingQuantity, Math.max(1, Number(event.target.value))))} /></Field>}
      {action === 'transfer' && <><Field label="接收客户类型"><select value={ownerType} onChange={(event) => setOwnerType(event.target.value as BottleOwner['kind'])}><option value="member">会员</option><option value="anonymous">未注册客户</option></select></Field>{ownerType === 'member' ? <Field label="接收会员"><select required value={memberId} onChange={(event) => setMemberId(event.target.value)}>{members.map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.phoneMasked}</option>)}</select></Field> : <div className="inventory-form-pair"><Field label="客户识别码"><input required value={customerRef} onChange={(event) => setCustomerRef(event.target.value)} placeholder="禁止填写完整手机号" /></Field><Field label="客户称呼"><input required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field></div>}</>}
      <div className="inventory-form-pair"><Field label="操作桌次"><select required value={sessionId} onChange={(event) => { setSessionId(event.target.value); setOrderId('') }}>{sessions.map((item) => <option key={item.id} value={item.id}>{item.tableCode}</option>)}</select></Field><Field label={action === 'use' ? '关联订单' : '关联订单（选填）'}><select required={action === 'use'} value={effectiveOrderId} onChange={(event) => setOrderId(event.target.value)}><option value="">请选择</option>{matchingOrders.map((item) => <option key={item.id} value={item.id}>{shortId(item.id)}</option>)}</select></Field></div>
      {action !== 'use' && <div className="inventory-inline-warning"><ShieldAlert size={16} />提交后不会立即改变存酒；请另一名有审批权限的员工使用自己的登录会话在“待审批”中处理。</div>}
      <Field label="操作原因"><textarea required minLength={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
      <button className={action === 'void' ? 'danger-button' : 'primary-button'} type="submit" disabled={Boolean(busy) || (action === 'use' && !effectiveOrderId)}>{busy.startsWith(`bottle-${action}:`) ? <LoaderCircle className="spin" size={16} /> : action === 'use' ? <Wine size={16} /> : action === 'transfer' ? <ArrowLeftRight size={16} /> : <Ban size={16} />}{action === 'use' ? '确认取用' : action === 'transfer' ? '提交转赠审批' : '提交作废审批'}</button>
    </form>
  )
}

function RecipePanel({
  inventory,
  products,
  busy,
  execute,
}: {
  inventory: InventoryDomainState
  products: MenuProduct[]
  busy: string
  execute: ExecuteOperation
}) {
  const ingredients = inventory.ingredientSkus.filter((item) => item.enabled)
  const [sku, setSku] = useState('')
  const [name, setName] = useState('')
  const [baseUnitCode, setBaseUnitCode] = useState('ml')
  const [purchaseUnitCode, setPurchaseUnitCode] = useState('bottle')
  const [baseQuantity, setBaseQuantity] = useState(750)
  const [costAmount, setCostAmount] = useState(0)
  const [ingredientReason, setIngredientReason] = useState('新增原料与采购单位换算')
  const [productId, setProductId] = useState(products[0]?.id ?? '')
  const [lines, setLines] = useState<InventoryRecipeLine[]>([
    { ingredientSkuId: ingredients[0]?.id ?? '', standardQuantity: 1, allowedLossBps: 0 },
  ])
  const [recipeReason, setRecipeReason] = useState('发布新的标准配方版本')

  function submitIngredient(event: FormEvent) {
    event.preventDefault()
    const conversions = [{ unitCode: baseUnitCode.trim(), baseQuantity: 1 }]
    if (purchaseUnitCode.trim() && purchaseUnitCode.trim() !== baseUnitCode.trim()) {
      conversions.push({ unitCode: purchaseUnitCode.trim(), baseQuantity })
    }
    void execute('ingredient-save', '原料SKU与单位换算已保存', async () => {
      await inventoryApi.upsertIngredientSku({
        sku: sku.trim(),
        name: name.trim(),
        baseUnitCode: baseUnitCode.trim(),
        costAmountPerBaseUnit: costAmount,
        conversions,
        enabled: true,
        reason: ingredientReason.trim(),
      })
      setSku('')
      setName('')
    })
  }

  function updateLine(index: number, patch: Partial<InventoryRecipeLine>) {
    setLines((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  function submitRecipe(event: FormEvent) {
    event.preventDefault()
    void execute('recipe-publish', '新配方版本已发布，旧版本已归档', () => inventoryApi.publishRecipeVersion({
      productId,
      lines,
      reason: recipeReason.trim(),
    }))
  }

  const activeRecipes = inventory.recipeVersions.filter((item) => item.status === 'active')
  return (
    <div className="inventory-content recipe-workspace">
      <section className="inventory-section">
        <SectionHeading icon={<FlaskConical size={18} />} title="原料SKU" meta={`${ingredients.length}项启用`} />
        <form className="inventory-form" onSubmit={submitIngredient}>
          <div className="inventory-form-pair"><Field label="原料编码"><input required value={sku} pattern="[A-Za-z0-9][A-Za-z0-9_.-]*" placeholder="GIN-001" onChange={(event) => setSku(event.target.value)} /></Field><Field label="原料名称"><input required value={name} onChange={(event) => setName(event.target.value)} /></Field></div>
          <div className="inventory-form-triplet"><Field label="基础单位"><input required value={baseUnitCode} onChange={(event) => setBaseUnitCode(event.target.value)} /></Field><Field label="采购单位"><input required value={purchaseUnitCode} onChange={(event) => setPurchaseUnitCode(event.target.value)} /></Field><Field label={`每采购单位含基础单位数`}><input required type="number" min={1} step={1} value={baseQuantity} onChange={(event) => setBaseQuantity(Math.max(1, Number(event.target.value)))} /></Field></div>
          <Field label="每基础单位成本（分）"><input required type="number" min={0} step={1} value={costAmount} onChange={(event) => setCostAmount(Math.max(0, Number(event.target.value)))} /></Field>
          <Field label="配置原因"><input required minLength={2} value={ingredientReason} onChange={(event) => setIngredientReason(event.target.value)} /></Field>
          <button className="primary-button" type="submit" disabled={Boolean(busy)}>{busy === 'ingredient-save' ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存原料</button>
        </form>
        <div className="compact-record-list">
          {ingredients.map((item) => <div key={item.id}><strong>{item.name}</strong><span>{item.sku} · 基础单位 {item.baseUnitCode}</span><StatusPill tone="success">v{item.revision}</StatusPill><time>{item.conversions.map((conversion) => `${conversion.unitCode}=${conversion.baseQuantity}`).join(' / ')}</time></div>)}
        </div>
      </section>

      <section className="inventory-section">
        <SectionHeading icon={<BookOpen size={18} />} title="发布配方版本" meta="每份商品的标准原料耗用" />
        <form className="inventory-form recipe-form" onSubmit={submitRecipe}>
          <Field label="菜单商品"><select required value={productId} onChange={(event) => setProductId(event.target.value)}>{products.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.specification}</option>)}</select></Field>
          <div className="recipe-lines">
            {lines.map((line, index) => {
              const ingredient = ingredients.find((item) => item.id === line.ingredientSkuId)
              return <div className="recipe-line" key={`${index}:${line.ingredientSkuId}`}><Field label="原料"><select required value={line.ingredientSkuId} onChange={(event) => updateLine(index, { ingredientSkuId: event.target.value })}><option value="">请选择</option>{ingredients.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label={`标准耗用${ingredient ? `（${ingredient.baseUnitCode}）` : ''}`}><input required type="number" min={1} step={1} value={line.standardQuantity} onChange={(event) => updateLine(index, { standardQuantity: Math.max(1, Number(event.target.value)) })} /></Field><Field label="允许损耗（%）"><input required type="number" min={0} max={100} step={0.01} value={line.allowedLossBps / 100} onChange={(event) => updateLine(index, { allowedLossBps: Math.round(Math.max(0, Math.min(100, Number(event.target.value))) * 100) })} /></Field><button className="icon-button" title="删除原料行" type="button" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((_, lineIndex) => lineIndex !== index))}><Trash2 size={16} /></button></div>
            })}
          </div>
          <button className="secondary-button recipe-add-button" type="button" disabled={!ingredients.length} onClick={() => setLines((current) => [...current, { ingredientSkuId: ingredients.find((item) => !current.some((line) => line.ingredientSkuId === item.id))?.id ?? '', standardQuantity: 1, allowedLossBps: 0 }])}><Plus size={16} />添加原料</button>
          <Field label="发布原因"><input required minLength={2} value={recipeReason} onChange={(event) => setRecipeReason(event.target.value)} /></Field>
          <button className="primary-button" type="submit" disabled={!ingredients.length || lines.some((line) => !line.ingredientSkuId) || Boolean(busy)}>{busy === 'recipe-publish' ? <LoaderCircle className="spin" size={16} /> : <BookOpen size={16} />}发布新版本</button>
        </form>
        <div className="recipe-version-list">
          {activeRecipes.length === 0 && <EmptyState icon={<BookOpen size={24} />} text="尚未发布配方；未配置配方的在管商品仍按整件扣减" />}
          {activeRecipes.map((recipe) => <div key={recipe.id}><strong>{products.find((item) => item.id === recipe.productId)?.name ?? recipe.productId} · v{recipe.version}</strong><span>{recipe.lines.map((line) => { const ingredient = ingredients.find((item) => item.id === line.ingredientSkuId); return `${ingredient?.name ?? line.ingredientSkuId} ${line.standardQuantity}${ingredient?.baseUnitCode ?? ''}（损耗${line.allowedLossBps / 100}%）` }).join('；')}</span><time>{formatDateTime(recipe.publishedAt)}</time></div>)}
        </div>
      </section>
    </div>
  )
}

function RemakePanel({
  orders,
  busy,
  execute,
}: {
  orders: Array<{ id: string; items: Array<{ id: string; name: string; quantity: number }> }>
  busy: string
  execute: ExecuteOperation
}) {
  const [orderId, setOrderId] = useState(orders.at(-1)?.id ?? '')
  const selectedOrder = orders.find((item) => item.id === orderId) ?? orders.at(-1)
  const [orderItemId, setOrderItemId] = useState(selectedOrder?.items[0]?.id ?? '')
  const effectiveItemId = selectedOrder?.items.some((item) => item.id === orderItemId) ? orderItemId : (selectedOrder?.items[0]?.id ?? '')
  const [quantity, setQuantity] = useState(1)
  const [reason, setReason] = useState('现场确认错品或品质问题后补做')

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!selectedOrder || !effectiveItemId) return
    void execute('remake-consume', '补做已按当前生效配方登记原料耗用', () => inventoryApi.recordRemakeConsumption({
      orderId: selectedOrder.id,
      orderItemId: effectiveItemId,
      quantity,
      reason: reason.trim(),
    }))
  }

  return <div className="inventory-content inventory-two-column"><section className="inventory-section"><SectionHeading icon={<RotateCcw size={18} />} title="登记补做耗用" meta="关联原订单明细" /><form className="inventory-form" onSubmit={submit}><Field label="原订单"><select required value={selectedOrder?.id ?? ''} onChange={(event) => { setOrderId(event.target.value); setOrderItemId('') }}><option value="">请选择</option>{orders.toReversed().map((order) => <option key={order.id} value={order.id}>{shortId(order.id)}</option>)}</select></Field><Field label="原商品行"><select required value={effectiveItemId} onChange={(event) => setOrderItemId(event.target.value)}><option value="">请选择</option>{selectedOrder?.items.map((item) => <option key={item.id} value={item.id}>{item.name} · 原数量 {item.quantity}</option>)}</select></Field><Field label="补做数量"><input required type="number" min={1} step={1} value={quantity} onChange={(event) => setQuantity(Math.max(1, Number(event.target.value)))} /></Field><Field label="补做原因"><textarea required minLength={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></Field><button className="primary-button" type="submit" disabled={!effectiveItemId || Boolean(busy)}>{busy === 'remake-consume' ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}登记耗用</button></form></section><aside className="inventory-guidance"><ShieldCheck size={20} /><div><strong>库存记录边界</strong><p>补做只新增一组库存耗用事实，不覆盖原销售、赠送或出品记录。配置配方的商品扣原料，整件商品继续直接扣库存。</p></div></aside></div>
}

function ApprovalPanel({
  approvals,
  currentActorId,
  busy,
  execute,
}: {
  approvals: InventoryApprovalRequest[]
  currentActorId: string
  busy: string
  execute: ExecuteOperation
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const actionLabel = (action: InventoryApprovalRequest['action']) => ({ bottle_transfer: '存酒转赠', bottle_void: '存酒作废', store_import: '整店导入' })[action]
  const decide = (approval: InventoryApprovalRequest, decision: 'approve' | 'reject') => {
    const decisionReason = reasons[approval.id]?.trim()
    if (!decisionReason) return
    void execute(`approval-${decision}:${approval.id}`, decision === 'approve' ? '审批已通过且业务动作已执行' : '审批已驳回，业务数据未改变', () => inventoryApi.decideApproval(approval.id, approval.action, decision, decisionReason))
  }
  return <div className="inventory-content"><section className="inventory-section"><SectionHeading icon={<ShieldAlert size={18} />} title="双人审批单" meta={`${approvals.filter((item) => item.status === 'pending').length}笔待处理`} /><div className="approval-list">{approvals.length === 0 && <EmptyState icon={<ShieldCheck size={24} />} text="暂无高风险审批单" />}{approvals.toReversed().map((approval) => { const own = approval.requestedBy.employeeId === currentActorId; const decisionReason = reasons[approval.id] ?? ''; return <article className="approval-row" key={approval.id}><div><StatusPill tone={approval.status === 'approved' ? 'success' : approval.status === 'rejected' ? 'danger' : 'warning'}>{approval.status === 'pending' ? '待审批' : approval.status === 'approved' ? '已执行' : '已驳回'}</StatusPill><small>{actionLabel(approval.action)}</small></div><div className="approval-detail"><strong>{approval.requestReason}</strong><span>发起：{approval.requestedBy.displayName} · {formatDateTime(approval.requestedAt)}</span><small>{approval.requestedBy.authenticatedBy === 'signed_session' ? '签名会话' : '本地开发身份'} · {shortId(approval.targetId)}</small>{approval.decidedBy && <small>决定：{approval.decidedBy.displayName} · {formatDateTime(approval.decidedAt!)}</small>}</div>{approval.status === 'pending' && <><Field label="审批意见"><input value={decisionReason} disabled={own || Boolean(busy)} placeholder={own ? '发起人不能自批' : '必填，写明核验依据'} onChange={(event) => setReasons((current) => ({ ...current, [approval.id]: event.target.value }))} /></Field><div className="approval-actions"><button className="primary-button" type="button" disabled={own || !decisionReason.trim() || Boolean(busy)} onClick={() => decide(approval, 'approve')}><Check size={16} />批准并执行</button><button className="secondary-button" type="button" disabled={own || !decisionReason.trim() || Boolean(busy)} onClick={() => decide(approval, 'reject')}><Ban size={16} />驳回</button></div></>}</article>})}</div></section></div>
}

function PolicyPanel({ inventory, roles, employees, rows, busy, execute }: { inventory: InventoryDomainState; roles: RoleConfig[]; employees: Employee[]; rows: InventoryBalanceRow[]; busy: string; execute: ExecuteOperation }) {
  const [draft, setDraft] = useState<InventoryOperationPolicy>(() => structuredClone(inventory.policy))
  const [reason, setReason] = useState('按门店库存岗位职责调整')
  const alertDraftSource = JSON.stringify(rows.map((row) => row.alertRule))
  const [alertDraft, setAlertDraft] = useState<Array<Pick<InventoryStockAlertRule, 'itemId' | 'enabled' | 'warningQuantity'>>>(() => JSON.parse(alertDraftSource))
  const [alertReason, setAlertReason] = useState('按实际备货周期调整预警水位')
  const actor = employees.find((employee) => employee.id === currentActor())
  const canEdit = Boolean(actor && inventory.policy.policyAdminRoleIds.includes(actor.roleId))

  useEffect(() => setDraft(structuredClone(inventory.policy)), [inventory.policy])
  useEffect(() => setAlertDraft(JSON.parse(alertDraftSource)), [alertDraftSource])

  function toggle(field: keyof InventoryOperationPolicy, roleId: string) {
    setDraft((current) => ({
      ...current,
      [field]: current[field].includes(roleId) ? current[field].filter((id) => id !== roleId) : [...current[field], roleId],
    }))
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void execute('policy', '库存岗位权限已更新并写入审计记录', () => inventoryApi.updateInventoryPolicy(draft, reason.trim()))
  }

  function submitAlerts(event: FormEvent) {
    event.preventDefault()
    void execute('stock-alerts', '库存预警水位已更新并写入审计记录', () => inventoryApi.updateStockAlertRules(alertDraft, alertReason.trim()))
  }

  return (
    <div className="inventory-content">
      <section className="inventory-section">
        <SectionHeading icon={<Settings2 size={18} />} title="库存岗位权限" meta={canEdit ? '经理可编辑' : '当前只读'} />
        <form onSubmit={submit}>
          <div className="policy-table-wrap">
            <table className="inventory-table policy-table">
              <thead><tr><th>库存动作</th>{roles.map((role) => <th key={role.id}>{role.name}</th>)}</tr></thead>
              <tbody>{(Object.keys(policyLabels) as Array<keyof InventoryOperationPolicy>).map((field) => <tr key={field}><td><strong>{policyLabels[field]}</strong></td>{roles.map((role) => <td key={role.id}><input aria-label={`${policyLabels[field]}：${role.name}`} type="checkbox" checked={draft[field].includes(role.id)} disabled={!canEdit || busy === 'policy'} onChange={() => toggle(field, role.id)} /></td>)}</tr>)}</tbody>
            </table>
          </div>
          <div className="policy-save-band">
            <Field label="调整原因"><input required minLength={2} maxLength={500} value={reason} disabled={!canEdit} onChange={(event) => setReason(event.target.value)} /></Field>
            <button className="primary-button" type="submit" disabled={!canEdit || !reason.trim() || Boolean(busy)}>{busy === 'policy' ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存权限</button>
          </div>
        </form>
      </section>
      <section className="inventory-section">
        <SectionHeading icon={<CircleAlert size={18} />} title="库存预警水位" meta={canEdit ? '每项独立配置' : '当前只读'} />
        <form onSubmit={submitAlerts}>
          <div className="stock-alert-grid">
            {rows.map((row) => {
              const rule = alertDraft.find((item) => item.itemId === row.item.id) ?? row.alertRule
              return <div className="stock-alert-row" key={row.item.id}>
                <div><strong>{row.item.name}</strong><small>{row.item.kind === 'ingredient' ? `原料 · ${row.unitCode}` : row.recipe ? '配方商品 · 理论出品数' : `整件商品 · ${row.unitCode}`}</small></div>
                <label className="switch"><input aria-label={`${row.item.name}启用库存预警`} type="checkbox" checked={rule.enabled} disabled={!canEdit || Boolean(busy)} onChange={(event) => setAlertDraft((current) => current.map((item) => item.itemId === row.item.id ? { ...item, enabled: event.target.checked } : item))} /><span /></label>
                <Field label="预警水位"><input aria-label={`${row.item.name}预警水位`} type="number" min={0} step={1} value={rule.warningQuantity} disabled={!canEdit || !rule.enabled || Boolean(busy)} onChange={(event) => setAlertDraft((current) => current.map((item) => item.itemId === row.item.id ? { ...item, warningQuantity: Math.max(0, Math.floor(Number(event.target.value) || 0)) } : item))} /></Field>
                <span className={rule.enabled && row.quantity <= rule.warningQuantity ? 'stock-alert-current is-warning' : 'stock-alert-current'}>当前 {row.quantity}</span>
              </div>
            })}
          </div>
          <div className="policy-save-band">
            <Field label="调整原因"><input required minLength={2} maxLength={500} value={alertReason} disabled={!canEdit} onChange={(event) => setAlertReason(event.target.value)} /></Field>
            <button className="primary-button" type="submit" disabled={!canEdit || !alertReason.trim() || Boolean(busy)}>{busy === 'stock-alerts' ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存水位</button>
          </div>
        </form>
      </section>
      <div className="inventory-guidance"><ShieldCheck size={20} /><div><strong>权限边界</strong><p>权限按岗位配置，服务员身份由登录会话决定；即使界面被绕过，服务端仍会再次校验岗位。盘点差异复核、存酒转赠和作废还要求另一名具备权限的员工。</p></div></div>
    </div>
  )
}

type ExecuteOperation = (action: string, successMessage: string, operation: () => Promise<unknown>) => Promise<void>

function Metric({ icon, value, label, warning = false }: { icon: ReactNode; value: string; label: string; warning?: boolean }) {
  return <div className={warning ? 'inventory-metric is-warning' : 'inventory-metric'}><span>{icon}</span><div><strong>{value}</strong><small>{label}</small></div></div>
}

function TabButton({ active, icon, label, badge = 0, onClick }: { active: boolean; icon: ReactNode; label: string; badge?: number; onClick: () => void }) {
  return <button type="button" aria-selected={active} onClick={onClick}>{icon}<span>{label}</span>{badge > 0 && <b>{badge}</b>}</button>
}

function SectionHeading({ icon, title, meta }: { icon: ReactNode; title: string; meta: string }) {
  return <div className="inventory-section-heading"><div>{icon}<span><strong>{title}</strong><small>{meta}</small></span></div></div>
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="inventory-field"><span>{label}</span>{children}</label>
}

function StatusPill({ tone, children }: { tone: 'success' | 'warning' | 'danger' | 'neutral'; children: ReactNode }) {
  return <span className={`inventory-status is-${tone}`}>{children}</span>
}

function EmptyState({ icon, text }: { icon: ReactNode; text: string }) {
  return <div className="inventory-empty">{icon}<strong>{text}</strong></div>
}

function InventoryState({ loading = false, text, onRetry }: { loading?: boolean; text: string; onRetry?: () => Promise<void> }) {
  return <section className="inventory-view inventory-state">{loading ? <LoaderCircle className="spin" size={26} /> : <CircleAlert size={26} />}<strong>{text}</strong>{onRetry && <button className="primary-button" type="button" onClick={() => void onRetry()}><RefreshCw size={16} />重新载入</button>}</section>
}

function ownerName(owner: BottleOwner, members: Array<{ id: string; displayName: string }>) {
  return owner.kind === 'member' ? members.find((member) => member.id === owner.memberId)?.displayName ?? owner.memberId : owner.displayNameSnapshot
}

function currentActor() {
  return window.localStorage.getItem('mbox.actor.id') ?? 'emp-chen'
}

function shortId(value: string) {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value
}

function formatDateTime(value: string) {
  return formatChinaDateTime(value, { year: undefined, second: undefined })
}

function todayDate() {
  return chinaDateKey()
}

function defaultExpiryDate() {
  return shiftDateKey(chinaDateKey(), 90)
}

function movementLabel(type: InventoryDomainState['movements'][number]['type']) {
  return ({ receipt: '入库', sale: '销售', gift: '赠送', remake: '补做', refund: '退款回库', stock_count_gain: '盘盈', stock_count_loss: '盘亏' })[type]
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}
