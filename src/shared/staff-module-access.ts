export interface StaffModuleAccessDefinition {
  code: string
  label: string
  route: string
  sortOrder: number
  permissionCodes: readonly string[]
}

/**
 * A permission makes its parent module exist. Role navigation may rename or
 * reorder an eligible module, but it must never create or remove authority.
 */
export const staffModuleAccessDefinitions: readonly StaffModuleAccessDefinition[] = Object.freeze([
  {
    code: 'live', label: '现场', route: '/staff/live', sortOrder: 210,
    permissionCodes: ['dashboard.view', 'table.view_all', 'table.open', 'table.close', 'table.transfer', 'table.assignment.manage', 'table.participation.manage'],
  },
  {
    code: 'tasks', label: '任务', route: '/staff/tasks', sortOrder: 220,
    permissionCodes: ['service.view', 'service.execute', 'service.manage', 'complaint.handle'],
  },
  {
    code: 'commerce', label: '出品', route: '/staff/fulfillment', sortOrder: 230,
    permissionCodes: ['order.view', 'order.create', 'kds.prepare', 'kds.deliver', 'kds.exception.manage', 'fulfillment.view_all'],
  },
  {
    code: 'reservations', label: '预约', route: '/staff/reservations', sortOrder: 240,
    permissionCodes: ['reservation.view', 'reservation.view.all', 'reservation.manage', 'reservation.config.manage'],
  },
  {
    code: 'payments', label: '收银与退款', route: '/staff/payments', sortOrder: 250,
    permissionCodes: [
      'payment.initiate.staff', 'payment.manual.cash.record', 'payment.manual.pos.record',
      'payment.collect', 'payment.settlement.view', 'refund.request', 'refund.approve',
      'refund.execute', 'reconciliation.view', 'reconciliation.manage', 'business_day.close',
    ],
  },
  {
    code: 'inventory', label: '库存', route: '/staff/inventory', sortOrder: 260,
    permissionCodes: [
      'inventory.view', 'inventory.manage', 'inventory.cost.view', 'inventory.receive',
      'inventory.count', 'inventory.approve', 'inventory.waste', 'inventory.barcode.bind',
      'inventory.recipe.cost.apply', 'inventory.recipe.publish', 'inventory.recipe.replace',
    ],
  },
  {
    code: 'performance', label: '演出', route: '/staff/performance', sortOrder: 270,
    permissionCodes: ['song.view', 'song.manage', 'performance.phase.manage', 'performance.schedule.revise'],
  },
  {
    code: 'operations', label: '经营数据', route: '/staff/operations', sortOrder: 280,
    permissionCodes: [
      'commercial.sales.view', 'commercial.sales.view_all', 'commercial.profit.view',
      'commercial.cost.manage', 'commercial.cost.create', 'commercial.cost.correct',
      'commercial.sales.attribute', 'commercial.sales.rule.manage',
    ],
  },
  {
    code: 'experience', label: '客户体验与活动', route: '/staff/customer-experience', sortOrder: 285,
    permissionCodes: [
      'community.activity.manage', 'community.activity.contact.reveal',
      'recommendation.staff.modify', 'observation.record',
    ],
  },
  {
    code: 'devices', label: '设备与打印', route: '/staff/devices', sortOrder: 290,
    permissionCodes: [
      'hardware.view', 'hardware.view_all', 'hardware.command', 'hardware.manage',
      'print.view', 'print.view_all', 'print.retry', 'printer.manage',
    ],
  },
  {
    code: 'settings', label: '系统配置', route: '/staff/settings', sortOrder: 300,
    permissionCodes: ['staff.access.configure', 'payment.policy.manage', 'ai.schedule', 'config.manage'],
  },
])

export interface StaffNavigationPresentation {
  code: string
  label: string
  route: string
  icon: string | null
  sortOrder: number
  displayConfig: StaffNavigationJsonObject
}

export type StaffNavigationJsonValue = string | number | boolean | null | StaffNavigationJsonObject | StaffNavigationJsonValue[]
export interface StaffNavigationJsonObject { [key: string]: StaffNavigationJsonValue }

export function staffModulesForPermissions(permissionCodes: readonly string[]): StaffModuleAccessDefinition[] {
  const permissions = new Set(permissionCodes)
  return staffModuleAccessDefinitions.filter((definition) => (
    definition.permissionCodes.some((permission) => permissions.has(permission))
  ))
}

export function staffModuleForPermission(permissionCode: string): StaffModuleAccessDefinition | null {
  return staffModuleAccessDefinitions.find((definition) => definition.permissionCodes.includes(permissionCode)) ?? null
}

export function staffModuleForRoute(route: string): StaffModuleAccessDefinition | null {
  return staffModuleAccessDefinitions.find((definition) => definition.route === route) ?? null
}

export function effectiveStaffNavigation<T extends StaffNavigationPresentation>(
  permissionCodes: readonly string[],
  configured: readonly T[],
): StaffNavigationPresentation[] {
  const configuredByCode = new Map(configured.map((item) => [item.code, item]))
  return staffModulesForPermissions(permissionCodes).map((definition) => {
    const presentation = configuredByCode.get(definition.code)
    return {
      code: definition.code,
      label: presentation?.label.trim() || definition.label,
      route: definition.route,
      icon: presentation?.icon ?? null,
      sortOrder: presentation?.sortOrder ?? definition.sortOrder,
      displayConfig: presentation?.displayConfig ?? {},
    }
  }).toSorted((left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code))
}

export function staffPermissionImpactLabel(permissionCode: string): string | null {
  const module = staffModuleForPermission(permissionCode)
  if (module === null) return null
  const actionLabels: Record<string, string> = {
    'payment.manual.cash.record': '登记现金收款',
    'payment.manual.pos.record': '登记实体POS收款',
    'printer.manage': '配置、检测和维护打印机',
    'print.retry': '重试失败打印任务',
    'hardware.manage': '配置门店设备',
    'refund.request': '发起退款',
    'refund.approve': '复核退款',
    'refund.execute': '执行退款',
  }
  return `${module.label}${actionLabels[permissionCode] === undefined ? '' : ` > ${actionLabels[permissionCode]}`}`
}
