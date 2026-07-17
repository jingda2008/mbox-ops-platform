import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { StaffPermissionId, RoleDataScope } from '../src/shared/contracts.js'
import { effectiveDataScopeForEmployee, effectivePermissionIdsForEmployee } from '../src/shared/staff-access.js'
import { verifyStaffSession } from './auth-context.js'
import { registerPilotAuthRoutes } from './pilot-auth.js'
import { MemoryRateLimitStore } from './rate-limit.js'
import type { RuntimeRepository } from './repository.js'
import { createSeedState } from './seed.js'

const accessCode = 'store-pilot-code'
const sessionSecret = 's'.repeat(32)

const employeePins = {
  'emp-owner': '1001',
  'emp-operations-director': '1013',
  'emp-admin': '1002',
  'emp-lin': '1003',
  'emp-jie': '1004',
  'emp-wu': '1005',
  'emp-qing': '1006',
  'emp-han': '1007',
  'emp-tao': '1008',
  'emp-mia': '1009',
  'emp-chen': '1010',
  'emp-cashier': '1011',
  'emp-host': '1012',
} as const

interface StaffAccessExpectation {
  employeeId: keyof typeof employeePins
  displayName: string
  roleId: string
  dataScope: RoleDataScope
  allowed: StaffPermissionId[]
  forbidden: StaffPermissionId[]
}

const staffAccessMatrix: StaffAccessExpectation[] = [
  {
    employeeId: 'emp-owner', displayName: '陈方宇', roleId: 'owner', dataScope: 'all_stores',
    allowed: ['config.manage', 'business_day.close', 'payment.refund.approve', 'benefit.manage'],
    forbidden: [],
  },
  {
    employeeId: 'emp-operations-director', displayName: '护古', roleId: 'operations_director', dataScope: 'store',
    allowed: ['config.manage', 'business_day.close', 'payment.refund.approve', 'inventory.approve', 'benefit.manage'],
    forbidden: ['identity.manage'],
  },
  {
    employeeId: 'emp-admin', displayName: '乌鸦', roleId: 'admin', dataScope: 'store',
    allowed: ['config.manage', 'identity.manage', 'master_data.manage', 'shift.manage', 'table.manage', 'store_import.apply', 'benefit.manage'],
    forbidden: ['finance.view', 'service.execute', 'order.create', 'payment.collect'],
  },
  {
    employeeId: 'emp-lin', displayName: 'Tom', roleId: 'server', dataScope: 'assigned_areas',
    allowed: ['service.execute', 'order.create', 'kds.deliver', 'payment.collect', 'payment.refund.request', 'benefit.grant', 'reservation.manage'],
    forbidden: ['kds.prepare', 'payment.refund.approve', 'config.manage'],
  },
  {
    employeeId: 'emp-jie', displayName: 'Tyke', roleId: 'backup', dataScope: 'assigned_areas',
    allowed: ['service.execute', 'order.create', 'kds.deliver', 'payment.collect', 'payment.refund.request', 'benefit.grant', 'reservation.manage'],
    forbidden: ['kds.prepare', 'payment.refund.approve', 'config.manage'],
  },
  {
    employeeId: 'emp-wu', displayName: 'Jerry', roleId: 'server', dataScope: 'assigned_areas',
    allowed: ['service.execute', 'order.create', 'kds.deliver', 'payment.collect', 'payment.refund.request', 'benefit.grant', 'reservation.manage'],
    forbidden: ['kds.prepare', 'payment.refund.approve', 'config.manage'],
  },
  {
    employeeId: 'emp-qing', displayName: '冷言志', roleId: 'bartender', dataScope: 'store',
    allowed: ['service.execute', 'order.create', 'kds.prepare', 'kds.deliver', 'payment.collect', 'reservation.manage', 'benefit.approve'],
    forbidden: ['config.manage', 'identity.manage', 'payment.refund.approve', 'business_day.close'],
  },
  {
    employeeId: 'emp-han', displayName: '申良良', roleId: 'kitchen', dataScope: 'own',
    allowed: ['service.execute', 'order.view', 'kds.prepare', 'inventory.view'],
    forbidden: ['order.create', 'kds.deliver', 'payment.collect', 'inventory.manage'],
  },
  {
    employeeId: 'emp-tao', displayName: '阿金', roleId: 'technical', dataScope: 'store',
    allowed: ['dashboard.view', 'song.view'],
    forbidden: ['service.execute', 'order.create', 'kds.prepare', 'kds.deliver', 'payment.collect', 'inventory.view'],
  },
  {
    employeeId: 'emp-mia', displayName: '付淳羽', roleId: 'specialist', dataScope: 'assigned_areas',
    allowed: ['service.execute', 'order.create', 'kds.prepare', 'kds.deliver', 'benefit.grant', 'song.manage', 'reservation.view'],
    forbidden: ['config.manage', 'payment.collect', 'payment.refund.approve', 'inventory.manage'],
  },
  {
    employeeId: 'emp-chen', displayName: '李艳', roleId: 'manager', dataScope: 'store',
    allowed: ['business_day.close', 'reservation.config.manage', 'complaint.handle', 'payment.refund.approve', 'inventory.approve'],
    forbidden: ['config.manage', 'identity.manage'],
  },
  {
    employeeId: 'emp-cashier', displayName: '三沐', roleId: 'cashier', dataScope: 'store',
    allowed: ['finance.view', 'reservation.view', 'table.close', 'payment.collect', 'payment.pos_report', 'payment.refund.request'],
    forbidden: ['reservation.manage', 'order.create', 'payment.refund.approve', 'business_day.close'],
  },
  {
    employeeId: 'emp-host', displayName: '挞挞', roleId: 'market_design', dataScope: 'store',
    allowed: ['dashboard.view', 'reservation.view', 'benefit.view'],
    forbidden: ['reservation.manage', 'service.execute', 'order.create', 'payment.collect', 'config.manage'],
  },
]

function repository(): RuntimeRepository {
  const state = createSeedState()
  return {
    init: async () => undefined,
    read: async () => structuredClone(state),
    mutate: async (mutation) => mutation(structuredClone(state)),
    reset: async () => structuredClone(state),
    healthCheck: async () => ({ ready: true, repository: 'test', revision: state.revision }),
    close: async () => undefined,
  }
}

async function createLoginApp() {
  const app = Fastify()
  await registerPilotAuthRoutes(app, repository(), {
    accessCode,
    employeePins,
    sessionSecret,
    sessionHours: 12,
    rateLimitStore: new MemoryRateLimitStore({
      usage: 'test', tenantId: 'tenant-test', storeId: 'mbox-lujiazui', hashSecret: 'l'.repeat(32),
    }),
  })
  return app
}

describe('13名员工独立登录验收', () => {
  it('矩阵完整覆盖种子中的13名在职员工，且每人PIN唯一', () => {
    const state = createSeedState()
    const activeEmployeeIds = state.employees
      .filter((employee) => employee.status === 'active')
      .map((employee) => employee.id)
      .sort()
    const matrixEmployeeIds = staffAccessMatrix.map((employee) => employee.employeeId).sort()

    expect(matrixEmployeeIds, '员工验收矩阵必须与种子中的在职员工完全一致').toEqual(activeEmployeeIds)
    expect(new Set(Object.values(employeePins)).size, '13名员工必须使用互不相同的PIN').toBe(staffAccessMatrix.length)
  })

  it.each(staffAccessMatrix)(
    '$displayName [$employeeId/$roleId] 只能用本人PIN签发自己的会话',
    async ({ employeeId, displayName }) => {
      const app = await createLoginApp()
      const rowIndex = staffAccessMatrix.findIndex((item) => item.employeeId === employeeId)
      const foreignEmployee = staffAccessMatrix[(rowIndex + 1) % staffAccessMatrix.length]!
      const failureContext = `${displayName} [${employeeId}]`

      try {
        const sharedCodeOnly = await app.inject({
          method: 'POST',
          url: '/api/auth/pilot-login',
          payload: { accessCode, actorId: employeeId },
        })
        expect(sharedCodeOnly.statusCode, `${failureContext} 不得仅凭共享店码登录`).toBe(401)
        expect(sharedCodeOnly.json().code, `${failureContext} 缺少独立PIN时应明确拒绝`).toBe('PILOT_EMPLOYEE_PIN_DENIED')

        const foreignPin = await app.inject({
          method: 'POST',
          url: '/api/auth/pilot-login',
          payload: { accessCode, actorId: employeeId, employeePin: employeePins[foreignEmployee.employeeId] },
        })
        expect(foreignPin.statusCode, `${failureContext} 不得使用${foreignEmployee.displayName}的PIN冒用身份`).toBe(401)
        expect(foreignPin.json().code, `${failureContext} 使用他人PIN时应明确拒绝`).toBe('PILOT_EMPLOYEE_PIN_DENIED')

        const loggedIn = await app.inject({
          method: 'POST',
          url: '/api/auth/pilot-login',
          payload: { accessCode, actorId: employeeId, employeePin: employeePins[employeeId] },
        })
        expect(loggedIn.statusCode, `${failureContext} 使用本人PIN应登录成功`).toBe(200)

        const body = loggedIn.json() as { token: string; employee: { id: string; displayName: string }; expiresAt: number }
        expect(body.employee, `${failureContext} 登录响应不得返回其他员工`).toMatchObject({ id: employeeId, displayName })
        expect(verifyStaffSession(body.token, sessionSecret), `${failureContext} 的签名会话必须绑定本人actorId`).toMatchObject({
          actorId: employeeId,
          storeId: 'mbox-lujiazui',
        })
        expect(body.expiresAt, `${failureContext} 会话必须处于有效期内`).toBeGreaterThan(Date.now())
      } finally {
        await app.close()
      }
    },
  )
})

describe('13名员工岗位权限矩阵验收', () => {
  it.each(staffAccessMatrix)(
    '$displayName [$employeeId/$roleId] 的岗位、数据范围和核心职责正确',
    ({ employeeId, displayName, roleId, dataScope, allowed, forbidden }) => {
      const state = createSeedState()
      const employee = state.employees.find((item) => item.id === employeeId)
      const activeShift = state.shiftAssignments.find(
        (item) => item.employeeId === employeeId && item.status === 'active',
      )
      const failureContext = `${displayName} [${employeeId}/${roleId}]`

      expect(employee, `${failureContext} 必须存在于员工种子`).toMatchObject({ displayName, roleId, status: 'active' })
      expect(activeShift, `${failureContext} 必须有匹配岗位的有效班次`).toMatchObject({ roleId, status: 'active' })
      expect(effectiveDataScopeForEmployee(state, employeeId), `${failureContext} 数据范围不正确`).toBe(dataScope)
      const effectivePermissions = effectivePermissionIdsForEmployee(state, employeeId)

      for (const permissionId of allowed) {
        expect(effectivePermissions, `${failureContext} 应允许 ${permissionId}`).toContain(permissionId)
      }
      for (const permissionId of forbidden) {
        expect(effectivePermissions, `${failureContext} 应禁止 ${permissionId}`).not.toContain(permissionId)
      }
    },
  )
})
