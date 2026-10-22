import type { StaffBootstrapView } from '../shared/normalized-contracts'
export type StaffWorkMode = 'service' | 'production' | 'cashier' | 'management'
export const staffWorkModes: { id: StaffWorkMode; label: string; codes: string[] }[] = [
  { id: 'service', label: '现场服务', codes: ['live', 'tasks', 'commerce', 'reservations'] },
  { id: 'production', label: '制作与传菜', codes: ['commerce', 'tasks', 'live', 'inventory'] },
  { id: 'cashier', label: '收银', codes: ['payments', 'live', 'orders', 'member-fulfillment'] },
  { id: 'management', label: '管理', codes: ['operations', 'live', 'payments', 'inventory'] },
]
export function defaultStaffWorkMode(roleCodes: readonly string[]): StaffWorkMode {
  if (roleCodes.some(code => ['STORE_MANAGER', 'MANAGER', 'OWNER', 'ADMIN'].includes(code))) return 'management'
  if (roleCodes.includes('CASHIER')) return 'cashier'
  if (roleCodes.some(code => ['BARTENDER', 'CHEF', 'KITCHEN', 'RUNNER', 'DELIVERY'].includes(code))) return 'production'
  return 'service'
}
export function quickStaffEntries(entries: StaffBootstrapView['navigation'], mode: StaffWorkMode) {
  const codes = staffWorkModes.find(item => item.id === mode)!.codes
  const sorted = entries.filter(entry => entry.code !== 'scan').sort((a, b) => {
    const rank = (code: string) => codes.includes(code) ? codes.indexOf(code) : 100
    return rank(a.code) - rank(b.code)
  })
  return sorted.slice(0, 4)
}

/** Default entry is only a suggestion for an ordinary, targetless login. */
export function ownerDashboardEntry(input: { location: string; hash?: string; roleCodes: readonly string[]; permissions: readonly string[]; navigation: StaffBootstrapView['navigation']; returningInSession?: boolean }): string | null {
  if (input.location !== '/' || input.hash || input.returningInSession) return null
  if (!input.roleCodes.some(code => ['OWNER', 'ADMIN', 'MANAGER', 'STORE_MANAGER'].includes(code))) return null
  if (!input.permissions.includes('commercial.profit.view')) return null
  return input.navigation.some(item => item.code === 'operations' && item.route === '/staff/operations') ? '/staff/operations' : null
}
