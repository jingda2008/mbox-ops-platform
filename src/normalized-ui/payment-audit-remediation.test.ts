import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { StaffActionsApi } from './staff-actions/staff-actions-api'

// Execute the real handlers with persistent hook slots; no channel or production calls.
function mount(seed: unknown[]) {
  const states = [...seed], refs: Array<{ current: unknown }> = []
  let stateIndex = 0, refIndex = 0
  const jsx = (type: unknown, props: unknown) => ({ type, props })
  const module = { exports: {} as Record<string, (props: unknown) => unknown> }
  const source = ts.transpileModule(readFileSync('src/normalized-ui/staff-actions/TablePaymentSheet.tsx', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(source, { module, exports: module.exports, Intl, AbortController,
    require(name: string) {
      if (name === 'react') return {
        useState(initial: unknown) { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], (value: unknown) => { states[index] = typeof value === 'function' ? value(states[index]) : value }] },
        useRef(initial: unknown) { const index = refIndex++; return refs[index] ??= { current: initial } },
        useEffect() {}, useCallback: (fn: unknown) => fn,
      }
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name.includes('ConfirmationDialog')) return { useConfirmationDialog: () => ({ confirmAction: async () => true }) }
      if (name.includes('table-payment-model')) return { shortPaymentOrderLabel: (id: string) => id }
      return new Proxy({}, { get: (_, key) => String(key) })
    },
  })
  return (props: unknown) => { stateIndex = 0; refIndex = 0; return module.exports.TablePaymentSheet(props) }
}
type Element = { type?: { name?: string } | string; props?: Record<string, any> }
function elements(tree: any): Element[] { return !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(elements) : [tree, ...elements(tree.props?.children)] }
function text(tree: any): string { return tree == null ? '' : Array.isArray(tree) ? tree.map(text).join(' ') : typeof tree === 'object' ? text(tree.props?.children) : String(tree) }
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('payment audit remediation', () => {
  it('keeps a new QR with its order, exposes release immediately, and ignores a query returning after switching orders', async () => {
    const access = { canInitiatePayment: true, canQueryOnlinePayment: true, onlinePaymentProvider: 'simulation', manualCollection: { canRecordCash: true } }
    const orders = ['A', 'B'].map(id => ({ id, publicId: id, outstandingAmountMinor: 1000, currency: 'CNY', unresolvedOnlinePaymentId: null, paymentStatus: 'unpaid' }))
    const render = mount([access, orders, 'A', ['A'], '', null, 'pending', false, false, false, false, null, 0])
    let completeCreate!: (value: unknown) => void, completeQuery!: (value: string) => void
    const props = { api: { createOnlinePayment: () => new Promise(resolve => { completeCreate = resolve }), queryOnlinePayment: () => new Promise(resolve => { completeQuery = resolve }) }, table: { code: 'W01', activeSession: { id: 'isolated' } }, onClose() {}, onUpdated() {} }
    let nodes = elements(render(props))
    nodes.find(node => typeof node.type === 'function' && (node.type as { name: string }).name === 'PaymentButtons')!.props!.onQr()
    nodes = elements(render(props))
    const switchDuringWrite = nodes.find(node => node.type === 'button' && text(node).includes('B '))!
    expect(switchDuringWrite.props!.disabled).toBe(true)
    switchDuringWrite.props!.onClick() // stale event must also be guarded, not only CSS-disabled.
    completeCreate({ paymentId: 'payment-A', presentation: 'qr', status: 'pending', payload: { qrCodeUrl: 'isolated-qr-A' } })
    await settle(); nodes = elements(render(props))
    expect(text(nodes.find(node => node.props?.className === 'staff-payment-summary'))).toMatch(/已选\s+1\s+单/)
    expect(nodes.find(node => typeof node.type === 'function' && (node.type as {name:string}).name==='PaymentButtons')!.props!.busy).toBe(false)
    nodes.find(node => node.type === 'button' && node.props?.className === 'staff-payment-query')!.props!.onClick()
    nodes = elements(render(props))
    const switchDuringQuery = nodes.find(node => node.type === 'button' && text(node).includes('B '))!
    expect(switchDuringQuery.props!.disabled).toBe(false)
    switchDuringQuery.props!.onClick()
    completeQuery('succeeded'); await settle(); nodes = elements(render(props))
    expect(text(nodes.find(node => node.props?.className === 'staff-payment-summary'))).toMatch(/已选\s+2\s+单/)
    expect(nodes.some(node => node.props?.value === 'isolated-qr-A')).toBe(false)
    expect(text(nodes)).not.toContain('支付成功，订单余额已刷新')
  })

  it('retries an assisted order with the same command key after refreshing its proof', async () => {
    const keys: string[] = []
    let sequence = 0
    const api = new StaffActionsApi({ createIdempotencyKey: () => `audit-${++sequence}`, fetch: async (_url, init) => { keys.push(new Headers(init?.headers).get('idempotency-key')!); throw new TypeError('lost response') } })
    const body = { tableSessionId: 'retry-test-table', assistedOrderContextToken: 'old-proof', orderMode: 'paid' as const, items: [{ productId: 'item-one', quantity: 1 }], settlementMode: 'table_tab' as const }
    await expect(api.submitAssistedOrder(body)).rejects.toThrow()
    await expect(api.submitAssistedOrder({ ...body, assistedOrderContextToken: 'refreshed-proof' })).rejects.toThrow()
    expect(keys[0]).toBe(keys[1])
    await expect(api.submitAssistedOrder({ ...body, tableSessionId: 'different-table' })).rejects.toThrow()
    expect(keys[2]).not.toBe(keys[0])
  })
})
