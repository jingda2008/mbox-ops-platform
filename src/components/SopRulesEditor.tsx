import { ArrowDown, ArrowUp, Copy, Plus, Trash2, Workflow } from 'lucide-react'
import type { Area, Employee, MenuProduct, RoleConfig, ServiceTypeConfig, Table, WorkstationConfig } from '../shared/contracts'
import type {
  SopCondition,
  SopConditionType,
  SopActionRecord,
  SopExecution,
  SopRule,
  SopStep,
  SopStopCondition,
  SopTriggerEvent,
} from '../shared/sop-contracts'
import './SopRulesEditor.css'

interface SopRulesEditorProps {
  rules: SopRule[]
  executions: SopExecution[]
  actionRecords: SopActionRecord[]
  serviceTypes: ServiceTypeConfig[]
  roles: RoleConfig[]
  areas: Area[]
  tables: Table[]
  products: MenuProduct[]
  employees: Employee[]
  workstations: WorkstationConfig[]
  onChange: (rules: SopRule[]) => void
}

const triggerLabels: Record<SopTriggerEvent, string> = {
  table_opened: '桌台开台',
  order_submitted: '订单提交',
  payment_succeeded: '支付成功',
  service_requested: '产生服务需求',
  fulfillment_started: '开始制作',
  fulfillment_completed: '制作完成',
  fulfillment_delivered: '送达桌台',
  complaint_requested: '客户投诉',
  birthday_requested: '生日需求',
  guest_mood_selected: '客户选择心情',
}

const stopLabels: Record<SopStopCondition, string> = {
  table_closed: '桌次结束',
  order_submitted: '已经点单',
  payment_succeeded: '已经付款',
  fulfillment_delivered: '出品已经送达',
}

export function SopRulesEditor({ rules, executions, actionRecords, serviceTypes, roles, areas, tables, products, employees, workstations, onChange }: SopRulesEditorProps) {
  const categories = [...products.reduce((result, product) => {
    if (product.categoryId && product.categoryName) result.set(product.categoryId, product.categoryName)
    return result
  }, new Map<string, string>()).entries()]
  const activeExecutions = executions.filter((execution) => execution.status === 'active').length
  const blockedExecutions = executions.filter((execution) => execution.status === 'blocked').length
  const pendingEvidence = actionRecords.filter((record) => record.status === 'awaiting_evidence').length
  const unconfiguredActions = actionRecords.filter((record) => record.status === 'unconfigured').length

  function updateRule(index: number, patch: Partial<SopRule>) {
    onChange(rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule))
  }

  function addRule() {
    const serviceType = serviceTypes.find((item) => item.id === 'order-help') ?? serviceTypes[0]
    if (!serviceType) return
    const ruleId = `sop-${crypto.randomUUID()}`
    onChange([...rules, {
      id: ruleId,
      name: '新建桌边关怀SOP',
      description: '按桌次时间与现场状态自动创建服务任务',
      enabled: false,
      trigger: { event: 'table_opened', serviceTypeIds: [], productCategoryIds: [], workstationIds: [] },
      scope: { areaIds: [], tableIds: [] },
      conditions: [],
      stopConditions: ['table_closed'],
      steps: [newStep(serviceType, `${ruleId}-step-1`, 15 * 60)],
    }])
  }

  function duplicateRule(rule: SopRule) {
    const ruleId = `sop-${crypto.randomUUID()}`
    const stepIds = new Map(rule.steps.map((step) => [step.id, `${ruleId}-step-${crypto.randomUUID()}`]))
    onChange([...rules, {
      ...structuredClone(rule),
      id: ruleId,
      name: `${rule.name}（副本）`,
      enabled: false,
      steps: rule.steps.map((step) => ({
        ...structuredClone(step),
        id: stepIds.get(step.id)!,
        routing: step.routing ? {
          ...structuredClone(step.routing),
          dependsOnStepIds: step.routing.dependsOnStepIds.map((stepId) => stepIds.get(stepId)).filter((stepId): stepId is string => Boolean(stepId)),
          compensationStepId: step.routing.compensationStepId ? stepIds.get(step.routing.compensationStepId) ?? null : null,
        } : undefined,
      })),
    }])
  }

  return <div className="config-section sop-editor">
    <div className="config-section-title sop-editor__title">
      <Workflow size={19} />
      <div><strong>复杂SOP规则</strong><span>事件触发、条件判断、多步骤计时、岗位派单和停止条件</span></div>
      <div className="sop-editor__metrics"><span>{rules.filter((rule) => rule.enabled).length}条启用</span><span>{activeExecutions}条运行</span>{pendingEvidence > 0 && <span>{pendingEvidence}条待验证</span>}{blockedExecutions > 0 && <b>{blockedExecutions}条阻塞</b>}{unconfiguredActions > 0 && <b>{unconfiguredActions}条待联调</b>}</div>
      <button className="secondary-button" type="button" onClick={addRule}><Plus size={15} />新增SOP</button>
    </div>

    {rules.length === 0 && <div className="sop-editor__empty"><Workflow size={24} /><strong>尚未配置复杂SOP</strong><span>点击“新增SOP”，先从开台后的桌边关怀开始。</span></div>}

    <div className="sop-rule-list">{rules.map((rule, ruleIndex) => {
      const related = executions.filter((execution) => execution.ruleId === rule.id)
      return <details className="sop-rule" key={rule.id} open={rules.length === 1}>
        <summary>
          <span className={rule.enabled ? 'sop-rule__state is-enabled' : 'sop-rule__state'}>{rule.enabled ? '启用' : '停用'}</span>
          <div><strong>{rule.name}</strong><span>{triggerLabels[rule.trigger.event]} · {rule.steps.length}个步骤 · 运行{related.filter((item) => item.status === 'active').length}</span></div>
          <i>展开配置</i>
        </summary>
        <div className="sop-rule__body">
          <div className="sop-rule__toolbar">
            <div className="switch-field"><span>启用规则</span><label className="switch"><input type="checkbox" checked={rule.enabled} onChange={(event) => updateRule(ruleIndex, { enabled: event.target.checked })} /><span /></label></div>
            <button className="secondary-button" type="button" onClick={() => duplicateRule(rule)}><Copy size={14} />复制</button>
            <button className="icon-button" type="button" title="删除SOP" onClick={() => onChange(rules.filter((_, index) => index !== ruleIndex))}><Trash2 size={16} /></button>
          </div>

          <div className="sop-rule__grid">
            <label><span>规则名称</span><input maxLength={80} value={rule.name} onChange={(event) => updateRule(ruleIndex, { name: event.target.value })} /></label>
            <label><span>触发事件</span><select value={rule.trigger.event} onChange={(event) => updateRule(ruleIndex, { trigger: { event: event.target.value as SopTriggerEvent, serviceTypeIds: [], productCategoryIds: [], workstationIds: [] } })}>{Object.entries(triggerLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="wide"><span>用途说明</span><input maxLength={300} value={rule.description} onChange={(event) => updateRule(ruleIndex, { description: event.target.value })} /></label>
          </div>

          {rule.trigger.event === 'service_requested' && <ChoiceGroup label="触发服务类型（不选代表全部）" items={serviceTypes.map((item) => ({ id: item.id, name: item.name }))} selected={rule.trigger.serviceTypeIds} onChange={(serviceTypeIds) => updateRule(ruleIndex, { trigger: { ...rule.trigger, serviceTypeIds } })} />}
          {rule.trigger.event === 'order_submitted' && <ChoiceGroup label="触发商品品类（不选代表全部）" items={categories.map(([id, name]) => ({ id, name }))} selected={rule.trigger.productCategoryIds} onChange={(productCategoryIds) => updateRule(ruleIndex, { trigger: { ...rule.trigger, productCategoryIds } })} />}
          {rule.trigger.event.startsWith('fulfillment_') && <ChoiceGroup label="触发工作站（不选代表全部）" items={workstations.filter((item) => item.enabled).map((item) => ({ id: item.id, name: item.name }))} selected={rule.trigger.workstationIds ?? []} onChange={(workstationIds) => updateRule(ruleIndex, { trigger: { ...rule.trigger, workstationIds } })} />}

          <ChoiceGroup label="适用区域（不选代表全店）" items={areas.map((item) => ({ id: item.id, name: item.name }))} selected={rule.scope.areaIds} onChange={(areaIds) => updateRule(ruleIndex, { scope: { ...rule.scope, areaIds } })} />
          <ChoiceGroup label="指定桌台（不选代表区域内全部）" items={tables.map((item) => ({ id: item.id, name: `${item.code} ${item.displayName}` }))} selected={rule.scope.tableIds} onChange={(tableIds) => updateRule(ruleIndex, { scope: { ...rule.scope, tableIds } })} />

          <div className="sop-rule__conditions">
            <ConditionToggle label="当时仍未点单" type="no_order" conditions={rule.conditions} onChange={(conditions) => updateRule(ruleIndex, { conditions })} />
            <ConditionToggle label="当时仍未付款" type="no_payment" conditions={rule.conditions} onChange={(conditions) => updateRule(ruleIndex, { conditions })} />
            <NumericCondition label="客人数至少" suffix="人" type="minimum_guest_count" defaultValue={4} max={100} conditions={rule.conditions} onChange={(conditions) => updateRule(ruleIndex, { conditions })} />
            <NumericCondition label="桌次消费至少" suffix="元" type="minimum_session_spend" defaultValue={500} max={1_000_000} multiplier={100} conditions={rule.conditions} onChange={(conditions) => updateRule(ruleIndex, { conditions })} />
            <NumericCondition label="未完成任务至少" suffix="项" type="open_task_count_at_least" defaultValue={2} max={100} conditions={rule.conditions} onChange={(conditions) => updateRule(ruleIndex, { conditions })} />
            <ConditionToggle label="主服务员已经满负荷" type="primary_employee_busy" conditions={rule.conditions} onChange={(conditions) => updateRule(ruleIndex, { conditions })} />
            <ConditionToggle label="仍有出品未制作完成" type="fulfillment_not_completed" conditions={rule.conditions} onChange={(conditions) => updateRule(ruleIndex, { conditions })} />
            <ConditionToggle label="仍有出品未送达" type="fulfillment_not_delivered" conditions={rule.conditions} onChange={(conditions) => updateRule(ruleIndex, { conditions })} />
          </div>

          <div className="sop-choice-group"><span>满足任一条件后停止后续步骤</span><div>{Object.entries(stopLabels).map(([value, label]) => <label key={value}><input type="checkbox" checked={rule.stopConditions.includes(value as SopStopCondition)} onChange={(event) => updateRule(ruleIndex, { stopConditions: toggleId(rule.stopConditions, value as SopStopCondition, event.target.checked) })} />{label}</label>)}</div></div>

          <div className="sop-steps">
            <header><div><strong>执行步骤</strong><span>按顺序处理；可从触发事件计时，也可等待前一步完成后再计时</span></div><button className="secondary-button" type="button" onClick={() => { const serviceType = serviceTypes[0]; if (!serviceType) return; updateRule(ruleIndex, { steps: [...rule.steps, newStep(serviceType, `${rule.id}-step-${crypto.randomUUID()}`, 5 * 60, rule.steps.length > 0)] }) }}><Plus size={14} />添加步骤</button></header>
            {rule.steps.map((step, stepIndex) => <SopStepRow
              key={step.id}
              step={step}
              index={stepIndex}
              total={rule.steps.length}
              roles={roles}
              employees={employees}
              serviceTypes={serviceTypes}
              allSteps={rule.steps}
              onChange={(next) => updateRule(ruleIndex, { steps: rule.steps.map((item, index) => index === stepIndex ? next : item) })}
              onMove={(direction) => updateRule(ruleIndex, { steps: moveItem(rule.steps, stepIndex, direction) })}
              onDelete={() => updateRule(ruleIndex, { steps: removeStep(rule.steps, step.id) })}
            />)}
          </div>

          <div className="sop-preview"><strong>执行预览</strong><span>{rule.steps.map((step, index) => `${index + 1}. ${timingLabel(step)} → ${serviceTypes.find((item) => item.id === step.action.serviceTypeId)?.name ?? step.action.serviceTypeId}`).join('；')}</span></div>
          {rule.enabled && <p className="sop-publish-warning">发布后会立即评估当前仍在营业的桌次；已超过等待时间且条件成立的步骤会马上派单。</p>}
        </div>
      </details>
    })}</div>
  </div>
}

function ChoiceGroup({ label, items, selected, onChange }: { label: string; items: Array<{ id: string; name: string }>; selected: string[]; onChange: (ids: string[]) => void }) {
  return <div className="sop-choice-group"><span>{label}</span><div>{items.map((item) => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => onChange(toggleId(selected, item.id, event.target.checked))} />{item.name}</label>)}</div></div>
}

function ConditionToggle({ label, type, conditions, onChange }: { label: string; type: SopConditionType; conditions: SopCondition[]; onChange: (conditions: SopCondition[]) => void }) {
  const checked = conditions.some((condition) => condition.type === type)
  return <label><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked ? [...conditions, { type, value: null }] : conditions.filter((condition) => condition.type !== type))} />{label}</label>
}

function NumericCondition({ label, suffix, type, defaultValue, max, multiplier = 1, conditions, onChange }: {
  label: string
  suffix: string
  type: 'minimum_guest_count' | 'minimum_session_spend' | 'open_task_count_at_least'
  defaultValue: number
  max: number
  multiplier?: number
  conditions: SopCondition[]
  onChange: (conditions: SopCondition[]) => void
}) {
  const condition = conditions.find((item) => item.type === type)
  return <label className="sop-numeric-condition"><input type="checkbox" checked={Boolean(condition)} onChange={(event) => onChange(event.target.checked ? [...conditions, { type, value: defaultValue * multiplier }] : conditions.filter((item) => item.type !== type))} />{label}<input type="number" min={1} max={max} disabled={!condition} value={(condition?.value ?? defaultValue * multiplier) / multiplier} onChange={(event) => onChange(conditions.map((item) => item.type === type ? { ...item, value: Math.max(1, Math.round(Number(event.target.value) * multiplier)) } : item))} />{suffix}</label>
}

function SopStepRow({ step, index, total, roles, employees, serviceTypes, allSteps, onChange, onMove, onDelete }: { step: SopStep; index: number; total: number; roles: RoleConfig[]; employees: Employee[]; serviceTypes: ServiceTypeConfig[]; allSteps: SopStep[]; onChange: (step: SopStep) => void; onMove: (direction: -1 | 1) => void; onDelete: () => void }) {
  const serviceType = serviceTypes.find((item) => item.id === step.action.serviceTypeId) ?? serviceTypes[0]
  const escalation = step.action.escalation
  const verification = step.action.verification ?? { type: 'staff_completed' as const, roleIds: [] }
  return <div className="sop-step-row">
    <div className="sop-step-row__index"><b>{index + 1}</b><div><button className="icon-button" type="button" title="上移" disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp size={13} /></button><button className="icon-button" type="button" title="下移" disabled={index === total - 1} onClick={() => onMove(1)}><ArrowDown size={13} /></button></div></div>
    <label><span>步骤名称</span><input maxLength={80} value={step.name} onChange={(event) => onChange({ ...step, name: event.target.value })} /></label>
    <label><span>计时基准</span><select disabled={index === 0} value={index === 0 ? 'after_trigger' : step.timing} onChange={(event) => onChange({ ...step, timing: event.target.value as SopStep['timing'] })}><option value="after_trigger">从触发事件计时</option><option value="after_previous_completed">前一步完成后计时</option></select></label>
    <label><span>等待时间（分钟）</span><input type="number" min={0} max={10080} step={0.5} value={step.delaySeconds / 60} onChange={(event) => onChange({ ...step, delaySeconds: Math.max(0, Math.round(Number(event.target.value) * 60)) })} /></label>
    <label><span>创建服务任务</span><select value={step.action.serviceTypeId} onChange={(event) => { const type = serviceTypes.find((item) => item.id === event.target.value); onChange({ ...step, action: { ...step.action, serviceTypeId: event.target.value, dispatchRoleIds: type?.dispatchRoleIds ?? step.action.dispatchRoleIds, escalation: type && escalation ? defaultEscalation(type) : escalation } }) }}>{serviceTypes.filter((item) => item.enabled).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <div className="sop-step-row__roles"><span>执行岗位</span><div>{roles.filter((role) => role.canReceiveTasks).map((role) => <label key={role.id}><input type="checkbox" checked={step.action.dispatchRoleIds.includes(role.id)} onChange={(event) => onChange({ ...step, action: { ...step.action, dispatchRoleIds: toggleId(step.action.dispatchRoleIds, role.id, event.target.checked) } })} />{role.name}</label>)}</div></div>
    <div className="sop-step-row__roles"><span>优先指定员工（不选则按岗位与负荷自动派单）</span><div>{employees.filter((employee) => employee.status === 'active').map((employee) => <label key={employee.id}><input type="checkbox" checked={(step.action.dispatchEmployeeIds ?? []).includes(employee.id)} onChange={(event) => onChange({ ...step, action: { ...step.action, dispatchEmployeeIds: toggleId(step.action.dispatchEmployeeIds ?? [], employee.id, event.target.checked) } })} />{employee.displayName}</label>)}</div></div>
    <div className="sop-step-row__roles"><span>通知终端（系统内任务始终保留）</span><div>
      <label><input type="checkbox" checked disabled />系统内</label>
      <label><input type="checkbox" checked={(step.action.notificationChannels ?? ['in_app']).includes('headset')} onChange={(event) => onChange({ ...step, action: { ...step.action, notificationChannels: toggleId(step.action.notificationChannels ?? ['in_app'], 'headset', event.target.checked) } })} />耳机播报</label>
      <label><input type="checkbox" checked={(step.action.notificationChannels ?? ['in_app']).includes('wecom')} onChange={(event) => onChange({ ...step, action: { ...step.action, notificationChannels: toggleId(step.action.notificationChannels ?? ['in_app'], 'wecom', event.target.checked) } })} />企业微信</label>
    </div></div>
    {(step.action.notificationChannels ?? ['in_app']).some((channel) => channel !== 'in_app') && <p className="sop-step-row__hint">外部终端必须先完成门店运行参数和员工账号绑定；未配置时会明确标记“待联调”，不会伪报送达。</p>}
    <div className="sop-step-row__advanced">
      <label className="sop-step-row__switch"><input type="checkbox" checked={Boolean(step.routing)} onChange={(event) => onChange({ ...step, routing: event.target.checked ? defaultRouting() : undefined })} />高级编排（并行、分支、失败补偿）</label>
      {step.routing && <div className="sop-step-row__orchestration">
        <div className="sop-step-row__roles"><span>等待哪些步骤完成（不选则从触发事件计时）</span><div>{allSteps.map((candidate, candidateIndex) => candidate.id === step.id ? null : <label key={candidate.id}><input type="checkbox" checked={step.routing!.dependsOnStepIds.includes(candidate.id)} onChange={(event) => onChange({ ...step, routing: { ...step.routing!, dependsOnStepIds: toggleId(step.routing!.dependsOnStepIds, candidate.id, event.target.checked) } })} />{candidateIndex + 1}. {candidate.name}</label>)}</div></div>
        {step.routing.dependsOnStepIds.length > 1 && <label><span>依赖关系</span><select value={step.routing.dependencyMode} onChange={(event) => onChange({ ...step, routing: { ...step.routing!, dependencyMode: event.target.value as 'all' | 'any' } })}><option value="all">全部完成后执行</option><option value="any">任一步完成后执行</option></select></label>}
        <div className="sop-rule__conditions">
          <ConditionToggle label="步骤执行时仍未点单" type="no_order" conditions={step.routing.conditions} onChange={(conditions) => onChange({ ...step, routing: { ...step.routing!, conditions } })} />
          <ConditionToggle label="步骤执行时仍未付款" type="no_payment" conditions={step.routing.conditions} onChange={(conditions) => onChange({ ...step, routing: { ...step.routing!, conditions } })} />
          <ConditionToggle label="主服务员已满负荷" type="primary_employee_busy" conditions={step.routing.conditions} onChange={(conditions) => onChange({ ...step, routing: { ...step.routing!, conditions } })} />
          <ConditionToggle label="仍有出品未完成" type="fulfillment_not_completed" conditions={step.routing.conditions} onChange={(conditions) => onChange({ ...step, routing: { ...step.routing!, conditions } })} />
          <ConditionToggle label="仍有出品未送达" type="fulfillment_not_delivered" conditions={step.routing.conditions} onChange={(conditions) => onChange({ ...step, routing: { ...step.routing!, conditions } })} />
        </div>
        {step.routing.conditions.length > 1 && <label><span>步骤条件</span><select value={step.routing.conditionMode} onChange={(event) => onChange({ ...step, routing: { ...step.routing!, conditionMode: event.target.value as 'all' | 'any' } })}><option value="all">全部满足</option><option value="any">满足任一</option></select></label>}
        {step.routing.conditions.length > 0 && <label><span>条件不满足</span><select value={step.routing.onConditionFalse} onChange={(event) => onChange({ ...step, routing: { ...step.routing!, onConditionFalse: event.target.value as 'skip' | 'block' } })}><option value="skip">跳过本步骤，继续后续</option><option value="block">阻塞并按失败策略处理</option></select></label>}
        <label><span>本步骤失败时</span><select value={step.routing.onFailure} onChange={(event) => { const onFailure = event.target.value as 'stop' | 'continue' | 'run_compensation'; onChange({ ...step, routing: { ...step.routing!, onFailure, compensationStepId: onFailure === 'run_compensation' ? step.routing!.compensationStepId : null } }) }}><option value="stop">停止整条SOP</option><option value="continue">记录失败并继续</option><option value="run_compensation">执行补偿步骤后继续</option></select></label>
        {step.routing.onFailure === 'run_compensation' && <label><span>补偿步骤</span><select value={step.routing.compensationStepId ?? ''} onChange={(event) => onChange({ ...step, routing: { ...step.routing!, compensationStepId: event.target.value || null } })}><option value="">请选择</option>{allSteps.filter((candidate) => candidate.id !== step.id && candidate.routing?.compensationOnly).map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name}</option>)}</select></label>}
        <label className="sop-step-row__switch"><input type="checkbox" checked={step.routing.compensationOnly} onChange={(event) => onChange({ ...step, routing: { ...step.routing!, compensationOnly: event.target.checked } })} />仅在其他步骤失败时作为补偿执行</label>
      </div>}
      <label className="sop-step-row__switch"><input type="checkbox" checked={Boolean(escalation)} onChange={(event) => onChange({ ...step, action: { ...step.action, escalation: event.target.checked && serviceType ? defaultEscalation(serviceType) : undefined } })} />单独设置本步骤升级时间</label>
      {escalation && <div className="sop-step-row__sla">
        <label><span>预警（秒）</span><input type="number" min={5} max={7200} value={escalation.warningSeconds} onChange={(event) => onChange({ ...step, action: { ...step.action, escalation: { ...escalation, warningSeconds: Number(event.target.value) } } })} /></label>
        <label><span>候补接管（秒）</span><input type="number" min={10} max={14400} value={escalation.backupAfterSeconds} onChange={(event) => onChange({ ...step, action: { ...step.action, escalation: { ...escalation, backupAfterSeconds: Number(event.target.value) } } })} /></label>
        <label><span>经理接管（秒）</span><input type="number" min={15} max={28800} value={escalation.managerAfterSeconds} onChange={(event) => onChange({ ...step, action: { ...step.action, escalation: { ...escalation, managerAfterSeconds: Number(event.target.value) } } })} /></label>
      </div>}
      {escalation && <ChoiceGroup label="经理接管岗位" items={roles.map((role) => ({ id: role.id, name: role.name }))} selected={escalation.managerRoleIds} onChange={(managerRoleIds) => onChange({ ...step, action: { ...step.action, escalation: { ...escalation, managerRoleIds } } })} />}
    </div>
    <label className="sop-step-row__verification"><span>完成验证</span><select value={verification.type} onChange={(event) => { const type = event.target.value as NonNullable<SopStep['action']['verification']>['type']; onChange({ ...step, action: { ...step.action, verification: { type, roleIds: type === 'staff_completed' ? [] : ['manager'] } } }) }}><option value="staff_completed">责任员工完成即可</option><option value="completed_by_role">必须由指定岗位完成</option><option value="manager_review">经理独立复核</option><option value="table_qr_scan">扫描实体桌码验证到桌</option><option value="camera_snapshot">摄像头抽帧验证</option></select></label>
    {verification.type !== 'staff_completed' && <div className="sop-step-row__roles"><span>{verification.type === 'manager_review' ? '复核岗位' : verification.type === 'table_qr_scan' ? '允许扫码验证岗位' : verification.type === 'camera_snapshot' ? '抽帧异常接管岗位' : '完成验证岗位'}</span><div>{roles.map((role) => <label key={role.id}><input type="checkbox" checked={verification.roleIds.includes(role.id)} onChange={(event) => onChange({ ...step, action: { ...step.action, verification: { ...verification, roleIds: toggleId(verification.roleIds, role.id, event.target.checked) } } })} />{role.name}</label>)}</div></div>}
    {verification.type === 'camera_snapshot' && <p className="sop-step-row__hint">摄像头必须返回任务编号和证据引用才算通过；没有视觉适配器时，本步骤会阻塞并交由所选岗位处理。</p>}
    <label className="wide"><span>任务指令（支持 {'{table}'}、{'{minutes}'}、{'{rule}'}、{'{step}'})</span><textarea rows={2} maxLength={500} value={step.action.noteTemplate} onChange={(event) => onChange({ ...step, action: { ...step.action, noteTemplate: event.target.value } })} /></label>
    <button className="icon-button sop-step-row__delete" type="button" title="删除步骤" disabled={total <= 1} onClick={onDelete}><Trash2 size={15} /></button>
  </div>
}

function defaultRouting(): NonNullable<SopStep['routing']> {
  return {
    dependsOnStepIds: [],
    dependencyMode: 'all',
    conditions: [],
    conditionMode: 'all',
    onConditionFalse: 'skip',
    onFailure: 'stop',
    compensationStepId: null,
    compensationOnly: false,
  }
}

function removeStep(steps: SopStep[], stepId: string) {
  return steps
    .filter((step) => step.id !== stepId)
    .map((step) => step.routing ? {
      ...step,
      routing: {
        ...step.routing,
        dependsOnStepIds: step.routing.dependsOnStepIds.filter((dependencyId) => dependencyId !== stepId),
        onFailure: step.routing.compensationStepId === stepId ? 'stop' as const : step.routing.onFailure,
        compensationStepId: step.routing.compensationStepId === stepId ? null : step.routing.compensationStepId,
      },
    } : step)
}

function newStep(serviceType: ServiceTypeConfig, id: string, delaySeconds: number, afterPrevious = false): SopStep {
  return {
    id,
    name: afterPrevious ? '后续复查' : '首次关怀',
    timing: afterPrevious ? 'after_previous_completed' : 'after_trigger',
    delaySeconds,
    action: {
      type: 'create_service_task',
      serviceTypeId: serviceType.id,
      dispatchRoleIds: [...serviceType.dispatchRoleIds],
      dispatchEmployeeIds: [],
      notificationChannels: ['in_app'],
      noteTemplate: '{table}已到达SOP关怀时间，请按服务剧本主动到桌处理。',
      verification: { type: 'staff_completed', roleIds: [] },
    },
  }
}

function defaultEscalation(serviceType: ServiceTypeConfig): NonNullable<SopStep['action']['escalation']> {
  return {
    warningSeconds: serviceType.sla.warningSeconds,
    backupAfterSeconds: serviceType.sla.escalateSeconds,
    managerAfterSeconds: serviceType.sla.managerSeconds,
    managerRoleIds: ['manager'],
  }
}

function toggleId<T extends string>(values: T[], value: T, checked: boolean) {
  return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value)
}

function moveItem<T>(items: T[], index: number, direction: -1 | 1) {
  const target = index + direction
  if (target < 0 || target >= items.length) return items
  const next = [...items]
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item!)
  return next
}

function timingLabel(step: SopStep) {
  const minutes = step.delaySeconds / 60
  if (step.routing?.compensationOnly) return `失败补偿，等待${minutes}分钟`
  if ((step.routing?.dependsOnStepIds.length ?? 0) > 0) {
    return `${step.routing?.dependencyMode === 'any' ? '任一' : '全部'}前置完成后${minutes}分钟`
  }
  return step.timing === 'after_trigger' ? `触发后${minutes}分钟` : `前一步完成后${minutes}分钟`
}
