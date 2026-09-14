import type { StaffAccessManagementOverview, StaffAccessRoleView } from '../shared/normalized-contracts'
import { refundReviewReadiness, type RefundReviewDraft } from '../shared/refund-review-configuration'

export function RefundReviewConfiguration({ overview, role, draft, onChange, error }: {
  overview: StaffAccessManagementOverview; role: StaffAccessRoleView | null
  draft: RefundReviewDraft | null; onChange(draft: RefundReviewDraft): void; error: string | null
}) {
  const readiness = refundReviewReadiness(overview)
  const readyCount = readiness.filter((item) => item.status === 'ready').length
  return <section className="staff-access-policy staff-access-refund-review" aria-label="退款复核配置">
    <p>按岗位配置退款复核权限及人民币单次额度，一次发布生效。员工例外中的明确禁止优先；发起人不能审核或驳回自己的退款。</p>
    {role && draft && <article className="staff-access-policy-list">
      <label className="staff-access-check"><input type="checkbox" aria-label="允许复核退款" checked={draft.enabled} onChange={(event) => onChange({ ...draft, enabled: event.target.checked })} />允许本岗位审核通过或驳回退款</label>
      <label className="staff-access-money"><span>单次复核上限（元）</span><input aria-label="退款复核单次上限" type="number" inputMode="decimal" min="0.01" step="0.01" max="1000000000" disabled={!draft.enabled} value={draft.amount} onChange={(event) => onChange({ ...draft, amount: event.target.value })} /></label>
      {error && <p role="alert">{error}</p>}
      <p>停用将同时关闭本岗位的复核权限和额度。员工兼任其他岗位或有个人授权时，按最终有效配置判断。</p>
    </article>}
    <h3>已发布的人员配置</h3>
    {readyCount < 2 && <p role="alert">当前仅有{readyCount}人具备完整复核配置；申请人可能是其中一人，请配置另一名负责人并检查额度是否覆盖实际退款。</p>}
    <div className="staff-access-employee-list">{readiness.map((item) => <article key={item.employeeId}>
      <div><strong>{item.name}</strong><small>{item.status === 'ready' ? `可复核他人申请，单次上限 ¥${(item.limitMinor! / 100).toFixed(2)}`
        : item.status === 'denied' ? '员工例外已明确禁止退款复核'
          : item.status === 'missing_permission' ? '缺少退款复核权限' : '有权限，但缺少有效退款复核额度'}</small></div>
    </article>)}</div>
    <p>通过“收银与退款”处理申请；列表显示当前已发布配置，实际操作还会校验申请人、金额和退款状态。</p>
  </section>
}
