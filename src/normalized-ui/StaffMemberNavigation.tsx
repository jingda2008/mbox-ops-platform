import type { StaffBootstrapView } from '../shared/normalized-contracts'

const groups = [
  { label: '查询与办理', codes: ['member-accounts', 'member-fulfillment', 'member-exceptions', 'member-management'] },
  { label: '权益与规则', codes: ['member-overview', 'member-rule-drafts', 'member-rule-approvals', 'member-rule-publish'] },
]
const labels: Record<string, string> = {
  'member-accounts': '查会员', 'member-fulfillment': '待领取', 'member-exceptions': '异常处理',
  'member-management': '会员办理与活动', 'member-overview': '等级与权益',
  'member-rule-drafts': '规则草稿', 'member-rule-approvals': '待审批', 'member-rule-publish': '待发布',
}

export function StaffMemberNavigation({ entries, activeRoute, onNavigate }: {
  entries: StaffBootstrapView['navigation']; activeRoute: string; onNavigate(route: string): void
}) {
  return <nav className="staff-member-workspace" aria-label="会员工作台">
    <strong>会员服务与管理</strong>
    {groups.map(group => {
      const available = group.codes.flatMap(code => entries.filter(entry => entry.code === code))
      return available.length > 0 && <div key={group.label} role="group" aria-label={group.label}>
        <small>{group.label}</small>
        {available.map(entry => <button type="button" key={entry.code} aria-current={entry.route === activeRoute ? 'page' : undefined} onClick={() => onNavigate(entry.route)}>{labels[entry.code]}</button>)}
      </div>
    })}
  </nav>
}
