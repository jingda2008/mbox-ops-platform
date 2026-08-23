import { createElement, type FormEvent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { StaffAuthView } from '../normalized-api'
import type { StaffBootstrapView } from '../shared/normalized-contracts'
import {
  StaffSessionMenuView,
} from './NormalizedStaffApp'
import { getOrCreateDeviceKey } from './staff-device'
import { bootstrapForAuthenticatedStaff, staffWorkspaceIdentityKey } from './staff-workspace-identity'

const callbacks = {
  onOpen: vi.fn(),
  onClose: vi.fn(),
  onEmployeeCodeChange: vi.fn(),
  onPinChange: vi.fn(),
  onSwitch: vi.fn((_event: FormEvent) => undefined),
  onLogout: vi.fn(),
}

function render(open: boolean, logoutArmed = false): string {
  return renderToStaticMarkup(createElement(StaffSessionMenuView, {
    currentEmployee: '李艳',
    currentEmployeeCode: 'liyan',
    open,
    employeeCode: '',
    pin: '',
    pending: false,
    logoutArmed,
    error: null,
    ...callbacks,
  }))
}

describe('StaffSessionMenuView', () => {
  it('keeps the current employee and switch entry visible without exposing the PIN form', () => {
    const html = render(false)

    expect(html).toContain('李艳')
    expect(html).toContain('切换员工')
    expect(html).toContain('aria-label="李艳，切换账号"')
    expect(html).not.toContain('下一位员工账号')
  })

  it('requires the next employee account and PIN and explains the device boundary', () => {
    const html = render(true)

    expect(html).toContain('当前员工 · liyan')
    expect(html).toContain('下一位员工账号')
    expect(html).toContain('四位 PIN')
    expect(html).toContain('验证并切换')
    expect(html).toContain('不会清除门店设备验证')
    expect(html).not.toContain('value="1248"')
  })

  it('makes logout a deliberate two-step action', () => {
    expect(render(true)).toContain('退出当前员工')
    expect(render(true, true)).toContain('再次确认退出')
  })
})

describe('normalized staff device identity', () => {
  it('creates one non-secret device key and reuses it', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }
    const first = getOrCreateDeviceKey(storage, () => '01234567-89ab-4def-8123-456789abcdef')

    expect(first).toBe('web-01234567-89ab-4def-8123-456789abcdef')
    expect(getOrCreateDeviceKey(storage, () => 'unused')).toBe(first)
  })
})

describe('normalized staff workspace identity', () => {
  const auth = (employeeId: string): StaffAuthView => ({
    session: {
      id: 'same-browser-session', employeeId, issuedAt: '2026-08-24T00:00:00Z',
      expiresAt: '2026-08-24T06:00:00Z', onlineLeaseUntil: '2026-08-24T00:01:00Z', isOnline: true,
    },
    employee: { id: employeeId, code: employeeId, displayName: employeeId, roleCodes: [] },
    permissions: [], deniedPermissions: [],
  })
  const bootstrap = (employeeId: string) => ({ staff: { id: employeeId } }) as StaffBootstrapView

  it('does not render a previous employee bootstrap after login or employee switching', () => {
    expect(bootstrapForAuthenticatedStaff(bootstrap('liyan'), auth('wuya'))).toBeNull()
    expect(bootstrapForAuthenticatedStaff(bootstrap('wuya'), auth('wuya'))).not.toBeNull()
  })

  it('remounts staff pages when the employee changes inside the same browser session', () => {
    expect(staffWorkspaceIdentityKey(auth('liyan'))).not.toBe(staffWorkspaceIdentityKey(auth('wuya')))
  })
})
