/** Stable capability codes; staff-facing names match the workspace entry. */
export const channelPermissionPresentation: Record<string, { name: string; description: string }> = {
  'channel.view': { name: '查看周边店合作', description: '进入周边店合作，查看合作方、推广批次及报表；不能修改、核验或结算。' },
  'channel.manage': { name: '管理周边店合作', description: '管理合作店、推荐人、活动、推广图及独立审批；后台操作还需“查看周边店合作”。' },
  'channel.activate': { name: '核验周边店合作优惠券', description: '在现场已授权桌台核验顾客并绑定优惠；仍受原有桌台访问权限限制。' },
  'channel.correct': { name: '更正周边店合作来源与权益', description: '按证据处理来源和权益异常；后台操作还需“查看周边店合作”。' },
  'channel.settle': { name: '审核周边店合作结算', description: '核对佣金与结算；后台操作还需“查看周边店合作”，不代替其他付款和审批权限。' },
}

export function staffPermissionCategory(permission: { code: string; category: string }): string {
  return channelPermissionPresentation[permission.code] ? 'channel' : permission.category
}

export function matchesStaffPermissionSearch(permission: { code: string; name: string; description: string | null }, query: string, label: string, description: string): boolean {
  const aliases = channelPermissionPresentation[permission.code] ? '周边店合作 渠道 推广 合作店' : ''
  return `${label} ${description} ${permission.name} ${permission.description ?? ''} ${permission.code} ${aliases}`.toLowerCase().includes(query.trim().toLowerCase())
}
