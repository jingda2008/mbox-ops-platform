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
    permissionCodes: [
      'dashboard.view', 'table.view_all', 'table.open', 'table.close', 'table.transfer',
      'table.assignment.manage', 'table.participation.manage',
      'recommendation.staff.modify', 'observation.record',
    ],
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
      'payment.manual.cash.record', 'payment.manual.pos.record',
      'payment.settlement.view', 'refund.request', 'refund.approve',
      'refund.execute', 'reconciliation.view', 'reconciliation.manage', 'business_day.close',
    ],
  },
  {
    code: 'inventory', label: '库存', route: '/staff/inventory', sortOrder: 260,
    permissionCodes: [
      'inventory.view', 'inventory.manage', 'inventory.cost.view', 'inventory.receive',
      'inventory.count', 'inventory.waste', 'inventory.barcode.bind', 'catalog.product.manage',
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
    ],
  },
  {
    code: 'experience', label: '客户体验与活动', route: '/staff/customer-experience', sortOrder: 285,
    permissionCodes: [
      'customer.experience.view', 'customer.experience.manage', 'customer.experience.feature.manage',
      'community.activity.view', 'community.activity.manage', 'community.activity.publish',
      'recommendation.analytics.view', 'product.observation.analytics.view', 'observation.view.raw',
      'recommendation.rule.view', 'recommendation.rule.draft', 'recommendation.rule.approve',
      'recommendation.rule.publish',
      'loyalty.operations.view', 'loyalty.operations.control',
      'loyalty.configuration.view', 'loyalty.configuration.edit', 'loyalty.configuration.preview',
      'loyalty.configuration.approve',
      'loyalty.promotion.view', 'loyalty.promotion.manage', 'loyalty.promotion.approve',
      'loyalty.promotion.publish',
      'loyalty.policy.view', 'loyalty.policy.manage', 'loyalty.policy.approve', 'loyalty.policy.publish',
      'loyalty.redemption.catalog.manage', 'loyalty.redemption.catalog.approve',
      'loyalty.redemption.catalog.publish', 'loyalty.redemption.control',
      'loyalty.redemption.fulfill', 'loyalty.redemption.exception',
      'loyalty.accrual.exception.view', 'loyalty.accrual.request', 'loyalty.accrual.approve',
      'membership.terms.view', 'membership.terms.manage', 'membership.terms.approve',
      'membership.terms.publish',
      'customer.membership.recovery.verify', 'customer.membership.merge.approve',
      'checkout.upgrade.rule.view', 'checkout.upgrade.rule.draft',
      'checkout.upgrade.rule.approve', 'checkout.upgrade.rule.publish',
      'fulfillment.capacity.view', 'fulfillment.capacity.draft',
      'fulfillment.capacity.approve', 'fulfillment.capacity.publish',
      'privacy.contact.retention.view', 'privacy.contact.retention.draft',
      'privacy.contact.retention.approve', 'privacy.contact.retention.publish',
      'privacy.contact.legal_hold',
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
    permissionCodes: [
      'staff.access.configure', 'payment.policy.manage', 'table.manage',
      'customer.public-profile.manage', 'customer.public-profile.publish',
      'privacy.policy.view', 'privacy.policy.manage', 'privacy.policy.publish',
    ],
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
