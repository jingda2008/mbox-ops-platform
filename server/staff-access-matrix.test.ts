import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { StaffPermissionId, RoleDataScope } from '../src/shared/contracts.js'
import { roleHasPermission } from '../src/shared/role-policy.js'
import { verifyStaffSession } from './auth-context.js'
import { registerPilotAuthRoutes } from './pilot-auth.js'
import { MemoryRateLimitStore } from './rate-limit.js'
import type { RuntimeRepository } from './repository.js'
import { createSeedState } from './seed.js'

const accessCode = 'store-pilot-code'
const sessionSecret = 's'.repeat(32)

const employeePins = {
  'emp-owner': '100001',
  'emp-admin': '100002',
  'emp-lin': '100003',
  'emp-jie': '100004',
  'emp-wu': '100005',
  'emp-qing': '100006',
  'emp-han': '100007',
  'emp-tao': '100008',
  'emp-mia': '100009',
  'emp-chen': '100010',
  'emp-cashier': '100011',
  'emp-host': '100012',
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
    employeeId: 'emp-owner', displayName: '周总', roleId: 'owner', dataScope: 'all_stores',
    allowed: ['config.manage', 'business_day.close', 'payment.refund.approve', 'benefit.manage'],
    forbidden: [],
  },
  {
    employeeId: 'emp-admin', displayName: '系统管理员', roleId: 'admin', dataScope: 'store',
    allowed: ['config.manage', 'identity.manage', 'master_data.manage', 'shift.manage', 'table.manage', 'store_import.apply'],
    forbidden: ['finance.view', 'service.execute', 'order.create', 'payment.collect'],
  },
  {
    employeeId: 'emp-lin', displayName: '小林', roleId: 'server', dataScope: 'assigned_areas',
    allowed: ['service.execute', 'order.create', 'kds.deliver', 'payment.collect', 'payment.refund.request', 'benefit.grant'],
    forbidden: ['kds.prepare', 'payment.refund.approve', 'reservation.manage', 'config.manage'],
  },
  {
    employeeId: 'emp-jie', displayName: '阿杰', roleId: 'backup', dataScope: 'assigned_areas',
    allowed: ['service.execute', 'order.create', 'kds.deliver', 'payment.collect'],
    forbidden: ['kds.prepare', 'payment.refund.request', 'benefit.grant', 'reservation.manage'],
  },
  {
    employeeId: 'emp-wu', displayName: '小吴', roleId: 'server', dataScope: 'assigned_areas',
    allowed: ['service.execute', 'order.create', 'kds.deliver', 'payment.collect', 'payment.refund.request', 'benefit.grant'],
    forbidden: ['kds.prepare', 'payment.refund.approve', 'reservation.manage', 'config.manage'],
  },
  {
    employeeId: 'emp-qing', displayName: '小青', roleId: 'bartender', dataScope: 'own',
    allowed: ['service.execute', 'order.view', 'kds.prepare', 'inventory.view'],
    forbidden: ['order.create', 'kds.deliver', 'payment.collect', 'inventory.manage'],
  },
  {
    employeeId: 'emp-han', displayName: '韩师傅', roleId: 'kitchen', dataScope: 'own',
    allowed: ['service.execute', 'order.view', 'kds.prepare', 'inventory.view'],
    forbidden: ['order.create', 'kds.deliver', 'payment.collect', 'inventory.manage'],
  },
  {
    employeeId: 'emp-tao', displayName: '小陶', roleId: 'runner', dataScope: 'assigned_areas',
    allowed: ['service.execute', 'order.view', 'kds.deliver'],
    forbidden: ['order.create', 'kds.prepare', 'payment.collect', 'inventory.view'],
  },
  {
    employeeId: 'emp-mia', displayName: 'Mia', roleId: 'supervisor', dataScope: 'store',
    allowed: ['shift.manage', 'reservation.manage', 'complaint.handle', 'order.create', 'payment.collect', 'benefit.approve'],
    forbidden: ['config.manage', 'identity.manage', 'payment.refund.approve', 'business_day.close'],
  },
  {
    employeeId: 'emp-chen', displayName: '陈经理', roleId: 'manager', dataScope: 'store',
    allowed: ['business_day.close', 'reservation.config.manage', 'complaint.handle', 'payment.refund.approve', 'inventory.approve'],
    forbidden: ['config.manage', 'identity.manage'],
  },
  {
    employeeId: 'emp-cashier', displayName: '小薇', roleId: 'cashier', dataScope: 'store',
    allowed: ['finance.view', 'reservation.view', 'table.close', 'payment.collect', 'payment.pos_report', 'payment.refund.request'],
    forbidden: ['reservation.manage', 'order.create', 'payment.refund.approve', 'business_day.close'],
  },
  {
    employeeId: 'emp-host', displayName: '安安', roleId: 'host', dataScope: 'store',
    allowed: ['table.manage', 'reservation.view', 'reservation.manage', 'service.execute', 'benefit.view'],
    forbidden: ['reservation.config.manage', 'order.create', 'payment.collect', 'config.manage'],
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

describe('12名员工独立登录验收', () => {
  it('矩阵完整覆盖种子中的12名在职员工，且每人PIN唯一', () => {
    const state = createSeedState()
    const activeEmployeeIds = state.employees
      .filter((employee) => employee.status === 'active')
      .map((employee) => employee.id)
      .sort()
    const matrixEmployeeIds = staffAccessMatrix.map((employee) => employee.employeeId).sort()

    expect(matrixEmployeeIds, '员工验收矩阵必须与种子中的在职员工完全一致').toEqual(activeEmployeeIds)
    expect(new Set(Object.values(employeePins)).size, '12名员工必须使用互不相同的PIN').toBe(staffAccessMatrix.length)
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

describe('12名员工岗位权限矩阵验收', () => {
  it.each(staffAccessMatrix)(
    '$displayName [$employeeId/$roleId] 的岗位、数据范围和核心职责正确',
    ({ employeeId, displayName, roleId, dataScope, allowed, forbidden }) => {
      const state = createSeedState()
      const employee = state.employees.find((item) => item.id === employeeId)
      const role = state.config.roles.find((item) => item.id === roleId)
      const activeShift = state.shiftAssignments.find(
        (item) => item.employeeId === employeeId && item.status === 'active',
      )
      const failureContext = `${displayName} [${employeeId}/${roleId}]`

      expect(employee, `${failureContext} 必须存在于员工种子`).toMatchObject({ displayName, roleId, status: 'active' })
      expect(activeShift, `${failureContext} 必须有匹配岗位的有效班次`).toMatchObject({ roleId, status: 'active' })
      expect(role?.dataScope, `${failureContext} 数据范围不正确`).toBe(dataScope)

      for (const permissionId of allowed) {
        expect(roleHasPermission(role, permissionId), `${failureContext} 应允许 ${permissionId}`).toBe(true)
      }
      for (const permissionId of forbidden) {
        expect(roleHasPermission(role, permissionId), `${failureContext} 应禁止 ${permissionId}`).toBe(false)
      }
    },
  )
})
