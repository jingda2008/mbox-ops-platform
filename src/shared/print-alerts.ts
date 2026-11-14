export type PrintAlertStation = 'bar' | 'kitchen' | 'cashier' | 'generation' | 'diagnostics'
export interface PrintAlert {
  station: PrintAlertStation
  failed: number
  stalled: number
  oldestAt: string
  newestKey: string
  escalated: boolean
}
export interface PrintAlertSnapshot {
  alerts: PrintAlert[]
  asOf: string
  manager: boolean
}

// Delivery staff receive only anonymous bar/kitchen counts, never cashier
// receipts, customer details or permission to retry a print.
export function printAlertStations(permissions: readonly string[]): PrintAlertStation[] {
  if (permissions.some(p => ['print.view_all', 'printer.manage', 'hardware.manage'].includes(p))) return ['bar', 'kitchen', 'cashier', 'generation', 'diagnostics']
  const stations = new Set<PrintAlertStation>()
  if (permissions.includes('work.bar')) stations.add('bar')
  if (permissions.includes('work.kitchen')) stations.add('kitchen')
  if (permissions.includes('work.cashier') || permissions.includes('print.reprint')) stations.add('cashier')
  if (permissions.includes('work.delivery')) { stations.add('bar'); stations.add('kitchen') }
  if (permissions.some(p => ['print.reprint', 'print.retry'].includes(p))) stations.add('diagnostics')
  return [...stations]
}
