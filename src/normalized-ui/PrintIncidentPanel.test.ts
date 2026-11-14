import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PrintIncidentPanelView } from './PrintIncidentPanel'
import { incidentCanResolve, incidentPermissions, type PrintIncident } from './print-incident-policy'

const row: PrintIncident = {id: 'incident-1', episodeStartedAt: '2026-11-14T02:00:00Z', bridgeId: 'bridge-1', jobId: 'job-1', kind: 'print_result', failureCode: 'ambiguous_print_result', status: 'open', firstSeenAt: '2026-11-14T02:00:00Z', lastSeenAt: '2026-11-14T02:00:00Z', occurrences: 2, claimedBy: null, resolution: null, escalation: 'administrator'}
const props = {rows: [row], employeeId: 'employee-1', permissions: ['print.retry'], busy: false, fresh: true, error: '', notice: '', pending: null, selected: null, onSelect() {}, onAction() {}, onRefresh() {}}
const html = (overrides: Partial<Parameters<typeof PrintIncidentPanelView>[0]> = {}) => renderToStaticMarkup(createElement(PrintIncidentPanelView, {...props, ...overrides}))

describe('print incident frontend policy', () => {
  it('does not expose incident data or controls without print permission', () => {
    expect(incidentPermissions(['order.view'])).toEqual({view: false, claim: false, resolve: false})
    expect(html({permissions: ['order.view']})).toBe('')
  })
  it('allows retry staff to view but not lock or finalize an incident', () => {
    expect(html()).not.toContain('认领处理')
    expect(html()).toContain('当前仅可查看')
    expect(incidentPermissions(['print.retry'])).toEqual({view: true, claim: false, resolve: false})
    expect(html()).not.toContain('确认保存现场核验')
    expect(incidentCanResolve({...row, status: 'claimed', claimedBy: 'employee-1'}, 'employee-1', ['print.retry'])).toBe(false)
  })
  it('only the claimant with resolution permission can resolve, not another manager', () => {
    const claimed = {...row, status: 'claimed' as const, claimedBy: 'employee-1'}
    expect(incidentCanResolve(claimed, 'employee-1', ['print.reprint'])).toBe(true)
    expect(incidentCanResolve(claimed, 'employee-2', ['printer.manage'])).toBe(false)
    expect(incidentCanResolve({...claimed, status: 'resolved'}, 'employee-1', ['printer.manage'])).toBe(false)
  })
  it('states submission uncertainty, blocks automatic reprint and discloses no external notifications', () => {
    const markup = html()
    expect(markup).toContain('Windows 已接收不代表实际出纸')
    expect(markup).toContain('结果不明时禁止自动补打')
    expect(markup).toContain('外发通知尚未接通')
    expect(markup).toContain('需管理员处理')
    expect(markup).not.toContain('测试打印')
  })
  it('does not allow device recovery to close an uncertain physical job', () => {
    const claimed = {...row, status: 'claimed' as const, claimedBy: 'employee-1'}
    const markup = html({rows: [claimed], permissions: ['print.reprint']})
    expect(markup).toContain('现场确认未出纸（不自动补打）')
    expect(markup).not.toContain('value="device_restored"')
    const device = html({rows: [{...claimed, jobId: null}], permissions: ['print.reprint']})
    expect(device).toContain('value="device_restored"')
    expect(device).not.toContain('value="paper_confirmed"')
  })
  it('disables new actions when stale or an uncertain request exists', () => {
    expect(html({fresh: false, permissions: ['print.reprint']})).toContain('disabled="">认领处理')
    const pending = html({pending: {id: row.id, action: 'claim'}, permissions: ['print.reprint']})
    expect(pending).toContain('disabled="">认领处理')
    expect(pending).toContain('核对原请求结果')
  })
  it('shows no false all-clear before the first successful fetch', () => {
    expect(html({rows: [], fresh: false, error: '读取失败'})).not.toContain('当前列表没有未解决故障')
    expect(html({rows: [], fresh: true})).toContain('当前列表没有未解决故障')
  })
  it('retains original-request recovery when a pending incident is absent from the bounded list', () => {
    expect(html({rows: [], pending: {id: row.id, action: 'not_printed'}})).toContain('原请求仍需确认')
    expect(html({rows: [], pending: {id: row.id, action: 'not_printed'}})).toContain('核对原请求结果')
  })
  it('shows resolved missing-paper evidence without claiming a reprint', () => {
    expect(html({rows: [{...row, status: 'resolved', resolution: 'not_printed'}]})).toContain('未出纸已记录，尚未补打')
  })
})
