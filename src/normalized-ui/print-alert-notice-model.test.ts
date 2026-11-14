import { describe, expect, it } from 'vitest'
import { printAlertStations, type PrintAlert } from '../shared/print-alerts'
import { hasNewPrintAlert, validatePrintAlertSnapshot } from './print-alert-notice-model'

const alert: PrintAlert = {station: 'bar', failed: 1, stalled: 0, oldestAt: '2026-11-14T03:00:00Z',
  newestKey: '12345678-1234-4234-8234-123456789012', escalated: false}
describe('print alert audience and announcement', () => {
  it('gives delivery staff anonymous production alarms without cashier access', () => {
    expect(printAlertStations(['work.delivery'])).toEqual(['bar', 'kitchen'])
    expect(printAlertStations(['kds.deliver'])).toEqual(['bar', 'kitchen'])
    expect(printAlertStations(['kds.prepare'], ['kitchen'])).toEqual(['kitchen'])
    expect(printAlertStations(['kds.prepare'], ['bar'])).toEqual(['bar'])
    expect(printAlertStations(['kds.prepare'], [])).toEqual([])
    expect(printAlertStations(['work.bar'])).toEqual(['bar'])
    expect(printAlertStations(['work.cashier'])).toEqual(['cashier'])
    expect(printAlertStations(['printer.manage'])).toEqual(['bar', 'kitchen', 'cashier', 'generation', 'diagnostics'])
    expect(printAlertStations(['member.view', 'notification.view'])).toEqual([])
  })
  it('announces initial, additional, newly failed and escalating incidents', () => {
    expect(hasNewPrintAlert([], [alert])).toBe(true)
    expect(hasNewPrintAlert([alert], [{...alert, failed: 2}])).toBe(true)
    expect(hasNewPrintAlert([{...alert, failed: 0, stalled: 1}], [alert])).toBe(true)
    expect(hasNewPrintAlert([alert], [{...alert, escalated: true}])).toBe(true)
    expect(hasNewPrintAlert([alert], [{...alert, newestKey: '22345678-1234-4234-8234-123456789012'}])).toBe(true)
  })
  it('does not replay alarms on a normal poll, partial recovery or full recovery', () => {
    expect(hasNewPrintAlert([alert], [alert])).toBe(false)
    expect(hasNewPrintAlert([{...alert, failed: 2, newestKey: 'newer'}], [alert])).toBe(false)
    expect(hasNewPrintAlert([alert], [])).toBe(false)
  })
  it('rejects corrupt responses instead of reporting a healthy printer', () => {
    const value = {alerts: [alert], manager: false, asOf: alert.oldestAt}
    expect(validatePrintAlertSnapshot(value)).toBe(true)
    expect(validatePrintAlertSnapshot({...value, alerts: []})).toBe(true)
    for (const patch of [{failed: -1}, {station: 'secret'}, {escalated: 'true'}, {oldestAt: 'bad'}, {failed: 0, stalled: 0}]) {
      expect(validatePrintAlertSnapshot({...value, alerts: [{...alert, ...patch}]})).toBe(false)
    }
    expect(validatePrintAlertSnapshot({...value, alerts: [alert, alert]})).toBe(false)
    expect(validatePrintAlertSnapshot({})).toBe(false)
  })
})
