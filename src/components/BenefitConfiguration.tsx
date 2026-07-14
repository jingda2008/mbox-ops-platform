import { Save, Settings2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { updateBenefitPolicy, updateBenefitTemplate } from '../api'
import type { BenefitKind } from '../shared/benefit-contracts'
import type { BootstrapResponse } from '../shared/contracts'

interface BenefitConfigurationProps {
  data: BootstrapResponse
  onRefresh: () => Promise<void>
  onNotice: (message: string) => void
}

const kindLabels: Record<BenefitKind, string> = {
  product_gift: '商品赠品',
  amount_coupon: '金额券',
  service: '服务权益',
  song: '点歌权益',
}

export function BenefitConfiguration({ data, onRefresh, onNotice }: BenefitConfigurationProps) {
  const [templates, setTemplates] = useState(() => structuredClone(data.benefitTemplates))
  const [policies, setPolicies] = useState(() => structuredClone(data.benefitGrantPolicies))
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (dirty) return
    setTemplates(structuredClone(data.benefitTemplates))
    setPolicies(structuredClone(data.benefitGrantPolicies))
  }, [data.benefitTemplates, data.benefitGrantPolicies, dirty])

  function updateTemplate(index: number, patch: Partial<(typeof templates)[number]>) {
    const next = structuredClone(templates)
    Object.assign(next[index]!, patch)
    setTemplates(next)
    setDirty(true)
  }

  function updatePolicy(index: number, patch: Partial<(typeof policies)[number]>) {
    const next = structuredClone(policies)
    Object.assign(next[index]!, patch)
    setPolicies(next)
    setDirty(true)
  }

  async function save() {
    setBusy(true)
    try {
      for (const template of templates) {
        await updateBenefitTemplate(template.id, {
          name: template.name,
          kind: template.kind,
          description: template.description,
          valueAmount: template.valueAmount,
          costAmount: template.costAmount,
          productId: template.productId,
          validityDays: template.validityDays,
          maxPerMember: template.maxPerMember,
          enabled: template.enabled,
        })
      }
      for (const policy of policies) {
        await updateBenefitPolicy(policy.id, {
          templateIds: policy.templateIds,
          maxCostPerGrantAmount: policy.maxCostPerGrantAmount,
          maxDailyCostAmount: policy.maxDailyCostAmount,
          canApprove: policy.canApprove,
          canLaunchCampaign: policy.canLaunchCampaign,
        })
      }
      setDirty(false)
      onNotice('权益模板和岗位授权配置已保存')
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '权益配置保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="benefit-configuration">
      <div className="benefit-config-heading">
        <div><Settings2 size={18} /><span><strong>权益与岗位授权配置</strong><small>模板、有效期、成本、持有上限、白名单和额度均可调整</small></span></div>
        <button className="primary-button" disabled={busy || !dirty} onClick={() => void save()}><Save size={17} />保存权益配置</button>
      </div>

      <div className="benefit-config-table-wrap">
        <table className="benefit-config-table template-table">
          <thead><tr><th>启用</th><th>权益名称</th><th>类型</th><th>关联商品</th><th>面值/元</th><th>成本/元</th><th>有效天数</th><th>会员持有上限</th></tr></thead>
          <tbody>{templates.map((template, index) => <tr key={template.id}>
            <td><label className="switch"><input type="checkbox" checked={template.enabled} onChange={(event) => updateTemplate(index, { enabled: event.target.checked })} /><span /></label></td>
            <td><input value={template.name} onChange={(event) => updateTemplate(index, { name: event.target.value })} /></td>
            <td><select value={template.kind} onChange={(event) => updateTemplate(index, { kind: event.target.value as BenefitKind, productId: event.target.value === 'product_gift' ? template.productId ?? data.products[0]?.id ?? null : null })}>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td>
            <td><select value={template.productId ?? ''} disabled={template.kind !== 'product_gift'} onChange={(event) => updateTemplate(index, { productId: event.target.value || null })}><option value="">无</option>{data.products.filter((item) => item.enabled).map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></td>
            <td><input type="number" min={0} step="0.01" value={template.valueAmount / 100} onChange={(event) => updateTemplate(index, { valueAmount: Math.round(Number(event.target.value) * 100) })} /></td>
            <td><input type="number" min={0} step="0.01" value={template.costAmount / 100} onChange={(event) => updateTemplate(index, { costAmount: Math.round(Number(event.target.value) * 100) })} /></td>
            <td><input type="number" min={1} max={730} value={template.validityDays} onChange={(event) => updateTemplate(index, { validityDays: Number(event.target.value) })} /></td>
            <td><input type="number" min={1} max={100} value={template.maxPerMember} onChange={(event) => updateTemplate(index, { maxPerMember: Number(event.target.value) })} /></td>
          </tr>)}</tbody>
        </table>
      </div>

      <div className="benefit-config-table-wrap policy-table-wrap">
        <table className="benefit-config-table policy-table">
          <thead><tr><th>岗位</th><th>可直接发放权益</th><th>单次成本/元</th><th>每日成本/元</th><th>可审批</th><th>可发活动</th></tr></thead>
          <tbody>{policies.map((policy, index) => <tr key={policy.id}>
            <td><strong>{data.config.roles.find((role) => role.id === policy.roleId)?.name ?? policy.roleId}</strong></td>
            <td><div className="policy-template-options">{templates.map((template) => <label key={template.id}><input type="checkbox" checked={policy.templateIds.includes(template.id)} onChange={(event) => updatePolicy(index, { templateIds: event.target.checked ? [...policy.templateIds, template.id] : policy.templateIds.filter((id) => id !== template.id) })} />{template.name}</label>)}</div></td>
            <td><input type="number" min={0} step="0.01" value={policy.maxCostPerGrantAmount / 100} onChange={(event) => updatePolicy(index, { maxCostPerGrantAmount: Math.round(Number(event.target.value) * 100) })} /></td>
            <td><input type="number" min={0} step="0.01" value={policy.maxDailyCostAmount / 100} onChange={(event) => updatePolicy(index, { maxDailyCostAmount: Math.round(Number(event.target.value) * 100) })} /></td>
            <td><label className="switch"><input type="checkbox" checked={policy.canApprove} onChange={(event) => updatePolicy(index, { canApprove: event.target.checked })} /><span /></label></td>
            <td><label className="switch"><input type="checkbox" checked={policy.canLaunchCampaign} onChange={(event) => updatePolicy(index, { canLaunchCampaign: event.target.checked })} /><span /></label></td>
          </tr>)}</tbody>
        </table>
      </div>
    </div>
  )
}
