import type { PrintAlert } from '../shared/print-alerts'

export function hasNewPrintAlert(previous: readonly PrintAlert[], next: readonly PrintAlert[]): boolean {
  return next.some(alert => {
    const before = previous.find(item => item.station === alert.station)
    if (!before) return true
    const count = alert.failed + alert.stalled, oldCount = before.failed + before.stalled
    return count > oldCount || (count >= oldCount && alert.newestKey !== before.newestKey)
      || alert.failed > before.failed || (alert.escalated && !before.escalated)
  })
}

export function validatePrintAlertSnapshot(value: unknown): value is import('../shared/print-alerts').PrintAlertSnapshot {
  if (!value || typeof value !== 'object') return false
  const data = value as Record<string, unknown>
  if (typeof data.manager !== 'boolean' || typeof data.asOf !== 'string' || !Number.isFinite(Date.parse(data.asOf))
    || !Array.isArray(data.alerts) || data.alerts.length > 5) return false
  const stations = new Set<string>()
  return data.alerts.every((item: unknown) => {
    if (!item || typeof item !== 'object') return false
    const alert = item as Record<string, unknown>
    if (typeof alert.station !== 'string' || !['bar', 'kitchen', 'cashier', 'generation', 'diagnostics'].includes(alert.station) || stations.has(alert.station)) return false
    stations.add(alert.station)
    return typeof alert.failed === 'number' && Number.isSafeInteger(alert.failed) && alert.failed >= 0
      && typeof alert.stalled === 'number' && Number.isSafeInteger(alert.stalled) && alert.stalled >= 0
      && alert.failed + alert.stalled > 0 && typeof alert.escalated === 'boolean'
      && typeof alert.oldestAt === 'string' && Number.isFinite(Date.parse(alert.oldestAt))
      && typeof alert.newestKey === 'string' && /^[a-f0-9-]{36}(?::\d{1,16})?$/i.test(alert.newestKey)
  })
}
