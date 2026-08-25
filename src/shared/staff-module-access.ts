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
      'payment.manual.cash.record', 'payment.manual.pos.record', 'payment.manual.external.record',
      'payment.settlement.view', 'refund.request', 'refund.approve',
      'refund.execute', 'payment.recollect.authorize', 'community.activity.cashier',
      'reconciliation.view', 'reconciliation.manage', 'business_day.close',
    ],
  },
  {
    code: 'inventory', label: '库存与酒水上架', route: '/staff/inventory', sortOrder: 260,
    permissionCodes: [
      'inventory.view', 'inventory.manage', 'inventory.cost.view', 'inventory.receive',
      'inventory.count', 'inventory.waste', 'inventory.barcode.bind', 'catalog.product.manage',
      'catalog.price.manage', 'media.asset.menu.manage',
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
    code: 'member-fulfillment', label: '会员权益待办', route: '/staff/member-fulfillment', sortOrder: 286,
    permissionCodes: ['loyalty.redemption.fulfill'],
  },
  {
    code: 'member-exceptions', label: '会员权益异常', route: '/staff/member-exceptions', sortOrder: 287,
    permissionCodes: ['loyalty.redemption.exception', 'loyalty.accrual.exception.view'],
  },
  {
    code: 'member-overview', label: '会员等级与权益', route: '/staff/member-overview', sortOrder: 288,
    permissionCodes: ['loyalty.policy.view'],
  },
  {
    code: 'member-rule-drafts', label: '会员规则草稿', route: '/staff/member-rule-drafts', sortOrder: 289,
    permissionCodes: ['loyalty.policy.manage'],
  },
  {
    code: 'member-rule-approvals', label: '待审批会员规则', route: '/staff/member-rule-approvals', sortOrder: 290,
    permissionCodes: ['loyalty.policy.approve'],
  },
  {
    code: 'member-rule-publish', label: '会员规则发布', route: '/staff/member-rule-publish', sortOrder: 291,
    permissionCodes: ['loyalty.policy.publish'],
  },
  {
    code: 'member-accounts', label: '会员账户查询', route: '/staff/member-accounts', sortOrder: 292,
    permissionCodes: ['loyalty.account.view'],
  },
  {
    code: 'member-management', label: '其他会员经营配置', route: '/staff/member-management', sortOrder: 293,
    permissionCodes: [
      'loyalty.operations.view', 'loyalty.operations.control',
      'loyalty.configuration.view', 'loyalty.configuration.edit', 'loyalty.configuration.preview',
      'loyalty.configuration.approve',
      'loyalty.promotion.view', 'loyalty.promotion.manage', 'loyalty.promotion.approve',
      'loyalty.promotion.publish',
      'loyalty.annual-benefit.view', 'loyalty.annual-benefit.manage', 'loyalty.annual-benefit.approve',
      'loyalty.annual-benefit.publish', 'loyalty.annual-benefit.occurrence.confirm',
      'loyalty.redemption.catalog.manage', 'loyalty.redemption.catalog.approve',
      'loyalty.redemption.catalog.publish', 'loyalty.redemption.control',
      'loyalty.accrual.request', 'loyalty.accrual.approve',
      'membership.terms.view', 'membership.terms.manage', 'membership.terms.approve',
      'membership.terms.publish',
      'customer.membership.recovery.verify', 'customer.membership.merge.approve',
    ],
  },
  {
    code: 'devices', label: '设备与打印', route: '/staff/devices', sortOrder: 300,
    permissionCodes: [
      'hardware.view', 'hardware.view_all', 'hardware.command', 'hardware.manage',
      'print.view', 'print.view_all', 'print.retry', 'print.reprint', 'printer.manage',
    ],
  },
  {
    code: 'settings', label: '系统配置', route: '/staff/settings', sortOrder: 310,
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
    'payment.manual.external.record': '登记其他线下收款',
    'loyalty.redemption.fulfill': '确认赠送与履约',
    'loyalty.redemption.exception': '处理核销异常',
    'loyalty.account.view': '查询会员账户与流水',
    'media.asset.menu.manage': '管理商品图片素材',
    'printer.manage': '配置、检测和维护打印机',
    'print.retry': '重试失败打印任务',
    'print.reprint': '补打已完成小票',
    'hardware.manage': '配置门店设备',
    'refund.request': '发起退款',
    'refund.approve': '复核退款',
    'refund.execute': '执行退款',
    'payment.recollect.authorize': '授权退款后重新收款',
    'community.activity.cashier': '处理活动收款、退款和退款后重收',
  }
  return `${module.label}${actionLabels[permissionCode] === undefined ? '' : ` > ${actionLabels[permissionCode]}`}`
}
