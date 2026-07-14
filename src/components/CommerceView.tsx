import { CheckCheck, ChefHat, CircleDollarSign, PackageCheck, Play, Send, ShoppingCart } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { actOnKdsTask, createQuickOrder, getCurrentActorId } from '../api'
import type { BootstrapResponse } from '../shared/contracts'
import type { KdsActionInput, QuickOrderInput } from '../shared/commerce-api'
import type { KdsTask } from '../shared/order-contracts'
import './CommerceView.css'

interface CommerceViewProps {
  data: BootstrapResponse
  onRefresh: () => Promise<void>
  onNotice: (message: string) => void
}

const kdsLabels: Record<KdsTask['status'], string> = {
  queued: '待制作', preparing: '制作中', completed: '待取走', picked_up: '配送中', delivered: '已送达',
}

export function CommerceView({ data, onRefresh, onNotice }: CommerceViewProps) {
  const currentActorId = getCurrentActorId()
  const currentEmployee = data.employees.find((employee) => employee.id === currentActorId && employee.status === 'active')
  const occupiedTables = data.tables.filter((table) => table.status === 'occupied')
  const enabledProducts = data.products.filter((product) => product.enabled)
  const [tableId, setTableId] = useState(occupiedTables[0]?.id ?? '')
  const [productId, setProductId] = useState(enabledProducts[0]?.id ?? '')
  const [quantity, setQuantity] = useState(1)
  const [busy, setBusy] = useState(false)
  const ledgerTotal = data.orderDomain.tableLedgerEntries.reduce((sum, entry) => sum + entry.amount, 0)
  const activeKds = data.orderDomain.kdsTasks.filter((task) => task.status !== 'delivered')

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!currentEmployee) {
      onNotice('当前员工身份无效，请重新登录后下单')
      return
    }
    setBusy(true)
    try {
      const input: QuickOrderInput = {
        tableId, productId, quantity, actorId: currentEmployee.id, idempotencyKey: `quick-${crypto.randomUUID()}`,
      }
      await createQuickOrder(input)
      onNotice('订单已提交并进入KDS')
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '下单失败')
    } finally {
      setBusy(false)
    }
  }

  async function advance(task: KdsTask, action: KdsActionInput['action']) {
    if (!currentEmployee) {
      onNotice('当前员工身份无效，请重新登录后操作KDS')
      return
    }
    setBusy(true)
    try {
      await actOnKdsTask(task.id, { action, actorId: currentEmployee.id, idempotencyKey: `kds-${action}-${crypto.randomUUID()}` })
      onNotice(`${task.itemName}已更新为${nextLabel(action)}`)
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'KDS操作失败')
    } finally {
      setBusy(false)
    }
  }

  const accountRows = useMemo(() => {
    const grouped = new Map<string, number>()
    for (const entry of data.orderDomain.tableLedgerEntries) {
      grouped.set(entry.tableSessionId, (grouped.get(entry.tableSessionId) ?? 0) + entry.amount)
    }
    return Array.from(grouped, ([sessionId, balance]) => ({ sessionId, balance }))
  }, [data.orderDomain.tableLedgerEntries])

  return (
    <section className="commerce-view">
      <div className="section-heading">
        <div><span className="eyebrow">订单、出品与桌账</span><h2>营业履约中心</h2></div>
        <span className="count-chip">{activeKds.length}待履约</span>
      </div>
      <div className="commerce-metrics">
        <div><ShoppingCart size={19} /><strong>{data.orderDomain.orders.length}</strong><span>当日订单</span></div>
        <div><ChefHat size={19} /><strong>{activeKds.length}</strong><span>KDS任务</span></div>
        <div><CircleDollarSign size={19} /><strong>{money(ledgerTotal)}</strong><span>桌账应收</span></div>
      </div>

      <form className="quick-order-band" onSubmit={(event) => void submit(event)}>
        <label><span>桌台</span><select value={tableId} onChange={(event) => setTableId(event.target.value)}>{occupiedTables.map((table) => <option key={table.id} value={table.id}>{table.code} · {table.displayName}</option>)}</select></label>
        <label><span>商品</span><select value={productId} onChange={(event) => setProductId(event.target.value)}>{enabledProducts.map((product) => <option key={product.id} value={product.id}>{product.name} · {money(product.listPriceAmount)}</option>)}</select></label>
        <label><span>数量</span><input type="number" min={1} max={50} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} /></label>
        <button className="primary-button" type="submit" disabled={busy || !currentEmployee || !tableId || !productId}><Send size={17} />提交订单</button>
      </form>

      <div className="commerce-grid">
        <section className="kds-section">
          <div className="commerce-section-title"><ChefHat size={18} /><strong>KDS出品队列</strong><span>当前操作：{currentEmployee?.displayName ?? '身份失效，请重新登录'}</span></div>
          <div className="kds-list">
            {activeKds.length === 0 && <div className="commerce-empty"><CheckCheck size={22} />当前没有待出品商品</div>}
            {activeKds.map((task) => {
              const table = tableFromSession(data, task.tableSessionId)
              const action = nextAction(task.status)
              return (
                <article className={`kds-row kds-${task.status}`} key={task.id}>
                  <div className="kds-status"><span>{kdsLabels[task.status]}</span><small>工位 {task.stationId}</small></div>
                  <div className="kds-product"><strong>{task.itemName} × {task.quantity}</strong><span>{task.specification} · {table?.code ?? '未知桌台'}</span></div>
                  {action && <button className="secondary-button" disabled={busy || !currentEmployee} title={currentEmployee ? `由${currentEmployee.displayName}执行` : '请重新登录'} onClick={() => void advance(task, action)}>{actionIcon(action)}{nextLabel(action)}</button>}
                </article>
              )
            })}
          </div>
        </section>

        <section className="ledger-section">
          <div className="commerce-section-title"><CircleDollarSign size={18} /><strong>桌账余额</strong></div>
          <div className="ledger-list">
            {accountRows.length === 0 && <div className="commerce-empty">暂无桌账流水</div>}
            {accountRows.map((row) => {
              const table = tableFromSession(data, row.sessionId)
              return <div className="ledger-row" key={row.sessionId}><div><strong>{table?.displayName ?? row.sessionId}</strong><span>{table?.code}</span></div><b>{money(row.balance)}</b></div>
            })}
          </div>
        </section>
      </div>
    </section>
  )
}

function tableFromSession(data: BootstrapResponse, sessionId: string) {
  return data.tables.find((table) => sessionId.startsWith(`session:${table.id}:`))
}

function nextAction(status: KdsTask['status']): KdsActionInput['action'] | null {
  return status === 'queued' ? 'start' : status === 'preparing' ? 'complete' : status === 'completed' ? 'pickUp' : status === 'picked_up' ? 'deliver' : null
}

function nextLabel(action: KdsActionInput['action']) {
  return action === 'start' ? '开始制作' : action === 'complete' ? '制作完成' : action === 'pickUp' ? '确认取走' : '确认送达'
}

function actionIcon(action: KdsActionInput['action']) {
  return action === 'start' ? <Play size={16} /> : action === 'complete' ? <PackageCheck size={16} /> : action === 'pickUp' ? <ShoppingCart size={16} /> : <CheckCheck size={16} />
}

function money(amount: number) {
  return `¥${(amount / 100).toFixed(2)}`
}
