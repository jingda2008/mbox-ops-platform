import {
  ArrowLeftRight,
  BadgeCheck,
  Ban,
  Boxes,
  Check,
  ClipboardCheck,
  ClipboardList,
  CircleAlert,
  History,
  LoaderCircle,
  PackageOpen,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Wine,
} from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import * as inventoryApi from '../inventory-api'
import type { Employee, MenuProduct, RoleConfig } from '../shared/contracts'
import type {
  BottleOwner,
  BottleStorageBatch,
  InventoryDomainState,
  InventoryOperationPolicy,
  StockCount,
} from '../shared/inventory-contracts'
import './InventoryView.css'

type InventoryTab = 'overview' | 'receipt' | 'count' | 'bottles' | 'policy'
type Notice = { tone: 'success' | 'error'; message: string }
type BottleAction = 'use' | 'transfer' | 'void'

const LOW_STOCK_QUANTITY = 5
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
  const balanceRows = products.map((product) => {
    const balance = inventory.balances.find((item) => item.productId === product.id)
    return { product, balance, quantity: balance?.onHandQuantity ?? 0, unitCode: balance?.unitCode ?? 'unit' }
  })
  const lowStockCount = balanceRows.filter((row) => row.quantity <= LOW_STOCK_QUANTITY).length
  const pendingCounts = inventory.stockCounts.filter((item) => item.status === 'pending_confirmation')
  const activeBottles = inventory.bottleBatches.filter((item) => ['stored', 'partially_used'].includes(item.status))

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
        <Metric icon={<CircleAlert size={19} />} value={String(lowStockCount)} label={`关注库存 ≤ ${LOW_STOCK_QUANTITY}`} warning={lowStockCount > 0} />
        <Metric icon={<ClipboardCheck size={19} />} value={String(pendingCounts.length)} label="待复核盘点" warning={pendingCounts.length > 0} />
        <Metric icon={<Wine size={19} />} value={String(activeBottles.length)} label="有效客存酒" />
      </div>

      <nav className="inventory-tabs" aria-label="库存功能">
        <TabButton active={tab === 'overview'} icon={<Boxes size={16} />} label="库存总览" onClick={() => setTab('overview')} />
        <TabButton active={tab === 'receipt'} icon={<PackageOpen size={16} />} label="入库" onClick={() => setTab('receipt')} />
        <TabButton active={tab === 'count'} icon={<ClipboardList size={16} />} label="盘点" badge={pendingCounts.length} onClick={() => setTab('count')} />
        <TabButton active={tab === 'bottles'} icon={<Wine size={16} />} label="客存酒" onClick={() => setTab('bottles')} />
        <TabButton active={tab === 'policy'} icon={<Settings2 size={16} />} label="权限策略" onClick={() => setTab('policy')} />
      </nav>

      {tab === 'overview' && <InventoryOverview inventory={inventory} products={products} rows={balanceRows} />}
      {tab === 'receipt' && <ReceiptPanel inventory={inventory} products={products} busy={busyAction} execute={execute} />}
      {tab === 'count' && <StockCountPanel inventory={inventory} products={products} employees={context.employees} busy={busyAction} execute={execute} />}
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
      {tab === 'policy' && <PolicyPanel inventory={inventory} roles={context.config.roles} employees={context.employees} busy={busyAction} execute={execute} />}
    </section>
  )
}

function InventoryOverview({
  inventory,
  products,
  rows,
}: {
  inventory: InventoryDomainState
  products: MenuProduct[]
  rows: Array<{ product: MenuProduct; balance?: InventoryDomainState['balances'][number]; quantity: number; unitCode: string }>
}) {
  const productName = (id: string) => products.find((item) => item.id === id)?.name ?? id
  return (
    <div className="inventory-content">
      <section className="inventory-section">
        <SectionHeading icon={<Boxes size={18} />} title="实时库存余额" meta={`${rows.length}项`} />
        <div className="inventory-table-wrap">
          <table className="inventory-table balance-table">
            <thead><tr><th>商品</th><th>SKU / 规格</th><th>可用数量</th><th>单位</th><th>最近更新</th><th>状态</th></tr></thead>
            <tbody>
              {rows.map(({ product, balance, quantity, unitCode }) => (
                <tr key={product.id} className={quantity <= LOW_STOCK_QUANTITY ? 'is-low-stock' : ''}>
                  <td><strong>{product.name}</strong></td>
                  <td>{product.sku}<small>{product.specification}</small></td>
                  <td className="quantity-cell">{quantity}</td>
                  <td>{unitCode}</td>
                  <td>{balance ? formatDateTime(balance.updatedAt) : '尚无流水'}</td>
                  <td><StatusPill tone={quantity === 0 ? 'danger' : quantity <= LOW_STOCK_QUANTITY ? 'warning' : 'success'}>{quantity === 0 ? '零库存' : quantity <= LOW_STOCK_QUANTITY ? '需关注' : '正常'}</StatusPill></td>
                </tr>
              ))}
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
  products,
  busy,
  execute,
}: {
  inventory: InventoryDomainState
  products: MenuProduct[]
  busy: string
  execute: ExecuteOperation
}) {
  const [productId, setProductId] = useState(products[0]?.id ?? '')
  const currentBalance = inventory.balances.find((item) => item.productId === productId)
  const [unitCode, setUnitCode] = useState(currentBalance?.unitCode ?? 'unit')
  const [quantity, setQuantity] = useState(1)
  const [reason, setReason] = useState('供应商到货验收入库')

  function changeProduct(id: string) {
    setProductId(id)
    setUnitCode(inventory.balances.find((item) => item.productId === id)?.unitCode ?? 'unit')
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
          <Field label="商品"><select required value={productId} onChange={(event) => changeProduct(event.target.value)}>{products.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.sku}</option>)}</select></Field>
          <div className="inventory-form-pair">
            <Field label="数量"><input required type="number" min={1} step={1} value={quantity} onChange={(event) => setQuantity(Math.max(1, Number(event.target.value)))} /></Field>
            <Field label="库存单位"><input required pattern="[A-Za-z0-9][A-Za-z0-9_.-]*" value={unitCode} onChange={(event) => setUnitCode(event.target.value)} disabled={Boolean(currentBalance)} /></Field>
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
  products,
  employees,
  busy,
  execute,
}: {
  inventory: InventoryDomainState
  products: MenuProduct[]
  employees: Employee[]
  busy: string
  execute: ExecuteOperation
}) {
  const [productId, setProductId] = useState(products[0]?.id ?? '')
  const [countedQuantity, setCountedQuantity] = useState(0)
  const [decisionReasons, setDecisionReasons] = useState<Record<string, string>>({})
  const balance = inventory.balances.find((item) => item.productId === productId)
  const currentActorId = currentActor()
  const productName = (id: string) => products.find((item) => item.id === id)?.name ?? id
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
          <Field label="商品"><select value={productId} onChange={(event) => setProductId(event.target.value)}>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></Field>
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
        {showDeposit && <BottleDepositForm products={products} members={members} sessions={openSessions} orders={orders} busy={busy} execute={execute} onDone={() => setShowDeposit(false)} />}
        {selectedBatch && <BottleActionPanel batch={selectedBatch} action={action} approvalRoleIds={inventory.policy.bottleApprovalRoleIds} employees={employees} members={members} sessions={openSessions} orders={orders} busy={busy} execute={execute} onClose={() => setSelectedBatchId('')} />}
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
  approvalRoleIds,
  employees,
  members,
  sessions,
  orders,
  busy,
  execute,
  onClose,
}: {
  batch: BottleStorageBatch
  action: BottleAction
  approvalRoleIds: string[]
  employees: Employee[]
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
  const currentActorId = currentActor()
  const allowedApprovers = employees.filter((employee) =>
    employee.status === 'active' &&
    employee.online &&
    !employee.paused &&
    employee.id !== currentActorId &&
    approvalRoleIds.includes(employee.roleId),
  )
  const [approvedBy, setApprovedBy] = useState(allowedApprovers[0]?.id ?? '')

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
    if (!approvedBy) return
    if (action === 'transfer') {
      const recipientOwner: BottleOwner = ownerType === 'member'
        ? { kind: 'member', memberId }
        : { kind: 'anonymous', customerRef: customerRef.trim(), displayNameSnapshot: displayName.trim() }
      void execute(`bottle-transfer:${batch.id}`, '存酒已由第二人复核并转赠，新批次已建立', async () => {
        await inventoryApi.transferBottle(batch.id, { recipientOwner, tableSessionId: sessionId, orderId: effectiveOrderId || undefined, approvedBy, reason: reason.trim() })
        onClose()
      })
      return
    }
    void execute(`bottle-void:${batch.id}`, '存酒已由第二人复核并作废', async () => {
      await inventoryApi.voidBottle(batch.id, { tableSessionId: sessionId || undefined, orderId: effectiveOrderId || undefined, approvedBy, reason: reason.trim() })
      onClose()
    })
  }

  return (
    <form className="bottle-action-panel" onSubmit={submit}>
      <div className="bottle-action-heading"><div><span className="eyebrow">{batch.productNameSnapshot} · 剩余 {batch.remainingQuantity} {batch.unitCode}</span><h3>{action === 'use' ? '取用存酒' : action === 'transfer' ? '转赠存酒' : '作废存酒'}</h3></div><button className="icon-button" title="关闭" type="button" onClick={onClose}>×</button></div>
      {action === 'use' && <Field label="取用数量"><input required type="number" min={1} max={batch.remainingQuantity} step={1} value={quantity} onChange={(event) => setQuantity(Math.min(batch.remainingQuantity, Math.max(1, Number(event.target.value))))} /></Field>}
      {action === 'transfer' && <><Field label="接收客户类型"><select value={ownerType} onChange={(event) => setOwnerType(event.target.value as BottleOwner['kind'])}><option value="member">会员</option><option value="anonymous">未注册客户</option></select></Field>{ownerType === 'member' ? <Field label="接收会员"><select required value={memberId} onChange={(event) => setMemberId(event.target.value)}>{members.map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.phoneMasked}</option>)}</select></Field> : <div className="inventory-form-pair"><Field label="客户识别码"><input required value={customerRef} onChange={(event) => setCustomerRef(event.target.value)} placeholder="禁止填写完整手机号" /></Field><Field label="客户称呼"><input required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field></div>}</>}
      <div className="inventory-form-pair"><Field label="操作桌次"><select required value={sessionId} onChange={(event) => { setSessionId(event.target.value); setOrderId('') }}>{sessions.map((item) => <option key={item.id} value={item.id}>{item.tableCode}</option>)}</select></Field><Field label={action === 'use' ? '关联订单' : '关联订单（选填）'}><select required={action === 'use'} value={effectiveOrderId} onChange={(event) => setOrderId(event.target.value)}><option value="">请选择</option>{matchingOrders.map((item) => <option key={item.id} value={item.id}>{shortId(item.id)}</option>)}</select></Field></div>
      {action !== 'use' && <Field label="第二复核人"><select required value={approvedBy} onChange={(event) => setApprovedBy(event.target.value)}><option value="">请选择领班或经理</option>{allowedApprovers.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></Field>}
      {action !== 'use' && !approvedBy && <div className="inventory-inline-warning"><CircleAlert size={16} />当前没有可选的独立复核人，不能执行高风险操作。</div>}
      <Field label="操作原因"><textarea required minLength={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
      <button className={action === 'void' ? 'danger-button' : 'primary-button'} type="submit" disabled={Boolean(busy) || (action === 'use' && !effectiveOrderId) || (action !== 'use' && !approvedBy)}>{busy.startsWith(`bottle-${action}:`) ? <LoaderCircle className="spin" size={16} /> : action === 'use' ? <Wine size={16} /> : action === 'transfer' ? <ArrowLeftRight size={16} /> : <Ban size={16} />}{action === 'use' ? '确认取用' : action === 'transfer' ? '复核并转赠' : '复核并作废'}</button>
    </form>
  )
}

function PolicyPanel({ inventory, roles, employees, busy, execute }: { inventory: InventoryDomainState; roles: RoleConfig[]; employees: Employee[]; busy: string; execute: ExecuteOperation }) {
  const [draft, setDraft] = useState<InventoryOperationPolicy>(() => structuredClone(inventory.policy))
  const [reason, setReason] = useState('按门店库存岗位职责调整')
  const actor = employees.find((employee) => employee.id === currentActor())
  const canEdit = Boolean(actor && inventory.policy.policyAdminRoleIds.includes(actor.roleId))

  useEffect(() => setDraft(structuredClone(inventory.policy)), [inventory.policy])

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
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}

function todayDate() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
}

function defaultExpiryDate() {
  const value = new Date()
  value.setDate(value.getDate() + 90)
  return value.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
}

function movementLabel(type: InventoryDomainState['movements'][number]['type']) {
  return ({ receipt: '入库', sale: '销售', gift: '赠送', refund: '退款回库', stock_count_gain: '盘盈', stock_count_loss: '盘亏' })[type]
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}
