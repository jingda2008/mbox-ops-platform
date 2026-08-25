import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BadgeDollarSign,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Database,
  KeyRound,
  LoaderCircle,
  MonitorSmartphone,
  Search,
  ShieldCheck,
  UsersRound,
} from 'lucide-react'
import { NormalizedApiClient } from '../normalized-api'
import type {
  StaffAccessApprovalLimitView,
  StaffAccessConfigurationDefinitionView,
  StaffAccessDataScopeView,
  StaffAccessManagementOverview,
  StaffAccessNavigationView,
  StaffAccessRoleView,
  StaffPermissionDeploymentChange,
  StaffPermissionDeploymentResult,
} from '../shared/normalized-contracts'
import { staffModuleForPermission, staffPermissionImpactLabel } from '../shared/staff-module-access'
import './staff-access-management.css'

type EditorMode = 'role' | 'employee' | 'policy' | 'navigation'
type PermissionDraftValue = boolean | 'grant' | 'deny' | null
type Notice = { tone: 'success' | 'error'; title: string; detail: string }
type ApprovalDraft = Pick<StaffAccessApprovalLimitView, 'amountMinor' | 'currency' | 'rules' | 'enabled'>
type ScopeDraft = Pick<StaffAccessDataScopeView, 'effect' | 'value' | 'enabled'>
type NavigationDraft = Omit<StaffAccessNavigationView, 'code'>

const beverageLaunchPermissionPackage = Object.freeze([
  'inventory.view', 'inventory.manage', 'inventory.receive', 'inventory.barcode.bind',
  'inventory.cost.view', 'catalog.product.manage', 'catalog.price.manage', 'media.asset.menu.manage',
])

export function StaffAccessManagementPanel({ api }: { api: NormalizedApiClient }) {
  const [overview, setOverview] = useState<StaffAccessManagementOverview | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [mode, setMode] = useState<EditorMode>('role')
  const [targetId, setTargetId] = useState('')
  const [permissionDraft, setPermissionDraft] = useState<Record<string, PermissionDraftValue>>({})
  const [approvalDraft, setApprovalDraft] = useState<Record<string, ApprovalDraft>>({})
  const [scopeDraft, setScopeDraft] = useState<Record<string, ScopeDraft>>({})
  const [navigationDraft, setNavigationDraft] = useState<Record<string, NavigationDraft>>({})
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [reason, setReason] = useState('调整岗位与员工实际职责')
  const [publishing, setPublishing] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  const load = useCallback(async () => {
    setPhase('loading'); setNotice(null)
    try {
      const next = await api.getEndpoint<{ data: StaffAccessManagementOverview }>('/api/staff-access/overview')
      setOverview(next.data); setPhase('ready')
    } catch (error) {
      setPhase('error'); setNotice({ tone: 'error', title: '权限状态没有读取成功', detail: message(error) })
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  const roles = overview?.roles.filter((role) => role.status === 'active') ?? []
  const employees = overview?.employees.filter((employee) => employee.status === 'active') ?? []
  const selectedRole = roles.find((role) => role.id === targetId) ?? null
  const selectedEmployee = employees.find((employee) => employee.id === targetId) ?? null
  const selectedTarget = mode === 'employee' ? selectedEmployee : selectedRole
  const categories = [...new Set((overview?.permissions ?? []).map((permission) => permission.category))]
  const visiblePermissions = useMemo(() => (overview?.permissions ?? []).filter((permission) => {
    const normalizedQuery = query.trim().toLowerCase()
    return (category === 'all' || permission.category === category)
      && (normalizedQuery === '' || `${permissionLabel(permission.code, permission.name)} ${permissionDescription(permission.code, permission.description)}`.toLowerCase().includes(normalizedQuery))
  }), [category, overview, query])

  const pendingChanges = useMemo<StaffPermissionDeploymentChange[]>(() => {
    if (selectedTarget === null) return []
    if (mode === 'role') return permissionChanges(selectedRole!, permissionDraft)
    if (mode === 'employee') return employeeChanges(selectedEmployee!, permissionDraft)
    if (mode === 'policy') return [
      ...approvalChanges(selectedRole!, approvalDraft),
      ...scopeChanges(selectedRole!, scopeDraft),
    ]
    return navigationChanges(selectedRole!, navigationDraft)
  }, [approvalDraft, mode, navigationDraft, permissionDraft, scopeDraft, selectedEmployee, selectedRole, selectedTarget])

  const chooseMode = (nextMode: EditorMode) => {
    setMode(nextMode); setTargetId(''); resetDrafts(); setNotice(null)
  }
  const chooseTarget = (nextTargetId: string) => {
    setTargetId(nextTargetId); resetDrafts(); setNotice(null); setCategory('all'); setQuery('')
  }
  const resetDrafts = () => {
    setPermissionDraft({}); setApprovalDraft({}); setScopeDraft({}); setNavigationDraft({})
  }

  const applyBeverageLaunchPackage = () => {
    if (selectedEmployee === null) return
    const rolePermissions = new Set(roles
      .filter((role) => selectedEmployee.roleCodes.includes(role.code))
      .flatMap((role) => role.permissionCodes))
    const denied = new Set(selectedEmployee.overrides
      .filter((override) => override.effect === 'deny')
      .map((override) => override.permissionCode))
    setPermissionDraft((current) => ({
      ...current,
      ...Object.fromEntries(beverageLaunchPermissionPackage.flatMap((permissionCode) => (
        denied.has(permissionCode) || rolePermissions.has(permissionCode)
          || selectedEmployee.overrides.some((override) => override.permissionCode === permissionCode && override.effect === 'grant')
          ? [] : [[permissionCode, 'grant' as const]]
      ))),
    }))
    const blocked = beverageLaunchPermissionPackage.filter((permissionCode) => denied.has(permissionCode)).length
    setNotice({
      tone: 'success',
      title: '已预览“酒水上架管理员”权限包',
      detail: `已组合扫码入库、库存成本、商品、配方、定价、渠道、图片和发布能力；${blocked > 0 ? `${blocked}项个人明确拒绝保持不变，` : ''}点击下方发布后才会生效。高风险盘点审批、异常增库和自批权限未包含。`,
    })
  }

  const deploy = async () => {
    if (pendingChanges.length === 0 || reason.trim().length < 2 || publishing) return
    setPublishing(true); setNotice(null)
    try {
      const result = await api.postEndpoint<StaffPermissionDeploymentResult>('/api/staff-access/deploy', {
        reason: reason.trim(), changes: pendingChanges,
      }, { idempotencyKey: `staff-access-${crypto.randomUUID()}`, timeoutMs: 20_000 })
      const failed = result.changes.filter((change) => !change.applied)
      if (failed.length > 0) throw new Error(`${failed.length}项配置写入后复核不一致`)
      setOverview(result.overview); resetDrafts()
      const effective = result.changes.reduce((sum, change) => sum + change.effectiveEmployeeCount, 0)
      const affectedModules = [...new Set(result.changes.flatMap((change) => {
        const module = staffModuleForPermission(change.configurationCode)
        return module === null ? [] : [module.label]
      }))]
      setNotice({
        tone: 'success', title: `${result.changes.length}项配置已发布并复核生效`,
        detail: `服务端已重新读取数据库；涉及${effective}人次当前有效配置${affectedModules.length === 0 ? '' : `，入口联动：${affectedModules.join('、')}`}，发布记录已留痕。`,
      })
    } catch (error) {
      setNotice({ tone: 'error', title: '配置没有发布成功', detail: `${message(error)}；原配置保持不变，请核对后重试。` })
    } finally { setPublishing(false) }
  }

  if (phase === 'loading' && overview === null) return <div className="staff-access-state" role="status"><LoaderCircle className="is-spinning" /><strong>正在核对人员与权限</strong></div>
  if (phase === 'error' && overview === null) return <div className="staff-access-state is-error" role="alert"><CircleAlert /><strong>{notice?.title}</strong><span>{notice?.detail}</span><button type="button" onClick={() => void load()}>重新读取</button></div>
  if (overview === null) return null

  return <div className="staff-access-management">
    {notice && <div className={`staff-access-notice is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'} data-action-reveal>
      {notice.tone === 'success' ? <CheckCircle2 /> : <CircleAlert />}
      <div><strong>{notice.title}</strong><span>{notice.detail}</span></div>
    </div>}

    <div className="staff-access-overview" aria-label="权限管理摘要">
      <article><UsersRound /><span><strong>{employees.length}</strong><small>在岗员工</small></span></article>
      <article><ShieldCheck /><span><strong>{roles.length}</strong><small>岗位模板</small></span></article>
      <article><KeyRound /><span><strong>{overview.permissions.length}</strong><small>权限能力</small></span></article>
    </div>

    <section className="staff-access-map" aria-labelledby="staff-access-map-title">
      <header><div><small>按职责分区，修改后统一发布</small><h3 id="staff-access-map-title">管理员控制中心</h3></div></header>
      <div>
        <ModeButton active={mode === 'role'} icon={<ShieldCheck />} title="岗位权限" detail="批量调整岗位可做什么" onClick={() => chooseMode('role')} />
        <ModeButton active={mode === 'employee'} icon={<UsersRound />} title="员工例外" detail="临时增加或明确禁止" onClick={() => chooseMode('employee')} />
        <ModeButton active={mode === 'policy'} icon={<BadgeDollarSign />} title="审批与范围" detail="金额边界和可查看数据" onClick={() => chooseMode('policy')} />
        <ModeButton active={mode === 'navigation'} icon={<MonitorSmartphone />} title="入口与设备" detail="岗位入口和设备管理权" onClick={() => chooseMode('navigation')} />
      </div>
    </section>

    <section className="staff-access-editor" id="staff-access-editor" data-action-reveal aria-labelledby="staff-access-editor-title">
      <header><div><small>{modeHint(mode)}</small><h3 id="staff-access-editor-title">{modeTitle(mode)}</h3></div></header>
      <label className="staff-access-target"><span>{mode === 'employee' ? '选择员工' : '选择岗位'}</span><select aria-label={mode === 'employee' ? '选择员工' : '选择岗位'} value={targetId} onChange={(event) => chooseTarget(event.target.value)}>
        <option value="">请选择</option>
        {mode === 'employee'
          ? employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}（{employee.roleCodes.map(roleCodeLabel).join(' / ') || '未分岗'}）</option>)
          : roles.map((role) => <option key={role.id} value={role.id}>{roleLabel(role.code, role.name)}（{role.memberCount}人）</option>)}
      </select></label>

      {selectedTarget !== null && <>
        {mode === 'employee' && selectedEmployee !== null && <div className="staff-access-advisory"><ShieldCheck /><div><strong>中文权限包：酒水上架管理员</strong><span>批量预览扫码入库、商品、配方、定价、渠道、受控图片和发布；个人明确拒绝优先，高风险审批不打包。</span></div><button type="button" onClick={applyBeverageLaunchPackage}>套用并预览</button></div>}
        {(mode === 'role' || mode === 'employee') && <PermissionEditor
          mode={mode} role={selectedRole} employee={selectedEmployee}
          draft={permissionDraft} setDraft={setPermissionDraft} query={query} setQuery={setQuery}
          category={category} setCategory={setCategory} categories={categories} permissions={visiblePermissions}
        />}
        {mode === 'policy' && selectedRole !== null && <PolicyEditor
          overview={overview} role={selectedRole} approvalDraft={approvalDraft} setApprovalDraft={setApprovalDraft}
          scopeDraft={scopeDraft} setScopeDraft={setScopeDraft}
        />}
        {mode === 'navigation' && selectedRole !== null && <NavigationEditor
          definitions={overview.configurationDefinitions.filter((definition) => definition.kind === 'navigation')}
          role={selectedRole} draft={navigationDraft} setDraft={setNavigationDraft}
        />}
        <div className="staff-access-publish">
          <label><span>发布原因</span><input aria-label="发布原因" value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} /></label>
          <button type="button" disabled={pendingChanges.length === 0 || reason.trim().length < 2 || publishing} onClick={() => void deploy()}>
            {publishing ? <LoaderCircle className="is-spinning" /> : <ShieldCheck />}{publishing ? '正在发布并复核' : `发布${pendingChanges.length}项修改`}
          </button>
          <small>未发布不会改变员工权限；服务端整批写入、重新读取并留痕，任何一项失败都会全部回滚。</small>
        </div>
      </>}
    </section>
  </div>
}

function ModeButton({ active, icon, title, detail, onClick }: { active: boolean; icon: React.ReactNode; title: string; detail: string; onClick(): void }) {
  return <button type="button" className={active ? 'is-active' : ''} aria-controls="staff-access-editor" onClick={onClick}>
    <span>{icon}</span><strong>{title}</strong><small>{detail}</small><ChevronRight />
  </button>
}

function PermissionEditor({ mode, role, employee, draft, setDraft, query, setQuery, category, setCategory, categories, permissions }: {
  mode: 'role' | 'employee'; role: StaffAccessRoleView | null
  employee: StaffAccessManagementOverview['employees'][number] | null
  draft: Record<string, PermissionDraftValue>; setDraft(value: React.SetStateAction<Record<string, PermissionDraftValue>>): void
  query: string; setQuery(value: string): void; category: string; setCategory(value: string): void
  categories: string[]; permissions: StaffAccessManagementOverview['permissions']
}) {
  return <>
    <div className="staff-access-tools">
      <label><Search /><input type="search" value={query} placeholder="搜索权限名称" onChange={(event) => setQuery(event.target.value)} /></label>
      <select aria-label="权限类别" value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">全部类别</option>{categories.map((item) => <option key={item} value={item}>{categoryLabel(item)}</option>)}</select>
    </div>
    <div className="staff-access-permissions">
      {permissions.map((permission) => {
        const roleEnabled = role?.permissionCodes.includes(permission.code) ?? false
        const employeeEffect = employee?.overrides.find((item) => item.permissionCode === permission.code)?.effect ?? null
        const value = draft[permission.code] ?? (mode === 'role' ? roleEnabled : employeeEffect)
        return <article key={permission.code}>
          <div><strong>{permissionLabel(permission.code, permission.name)}</strong><small>{permissionDescription(permission.code, permission.description)}</small>{staffPermissionImpactLabel(permission.code) !== null && <small>授权后显示：{staffPermissionImpactLabel(permission.code)}</small>}</div>
          {mode === 'role'
            ? <label className="staff-access-switch"><input type="checkbox" checked={value === true} onChange={(event) => setDraft((current) => ({ ...current, [permission.code]: event.target.checked }))} /><span>{value === true ? '允许' : '不允许'}</span></label>
            : <select aria-label={`${permissionLabel(permission.code, permission.name)}员工例外`} value={value === true || value === false ? '' : value ?? ''} onChange={(event) => setDraft((current) => ({ ...current, [permission.code]: event.target.value === '' ? null : event.target.value as 'grant' | 'deny' }))}><option value="">随岗位</option><option value="grant">额外允许</option><option value="deny">明确禁止</option></select>}
        </article>
      })}
      {permissions.length === 0 && <p>没有匹配的权限。</p>}
    </div>
  </>
}

function PolicyEditor({ overview, role, approvalDraft, setApprovalDraft, scopeDraft, setScopeDraft }: {
  overview: StaffAccessManagementOverview; role: StaffAccessRoleView
  approvalDraft: Record<string, ApprovalDraft>; setApprovalDraft(value: React.SetStateAction<Record<string, ApprovalDraft>>): void
  scopeDraft: Record<string, ScopeDraft>; setScopeDraft(value: React.SetStateAction<Record<string, ScopeDraft>>): void
}) {
  const approvalDefinitions = overview.configurationDefinitions.filter((definition) => definition.kind === 'approval_limit')
  const scopeDefinitions = overview.configurationDefinitions.filter((definition) => definition.kind === 'data_scope')
  const updateApproval = (definition: StaffAccessConfigurationDefinitionView, patch: Partial<ApprovalDraft>) => setApprovalDraft((current) => ({
    ...current, [definition.code]: { ...approvalValue(role, definition), ...current[definition.code], ...patch },
  }))
  const updateScope = (definition: StaffAccessConfigurationDefinitionView, patch: Partial<ScopeDraft>) => setScopeDraft((current) => ({
    ...current, [definition.code]: { ...scopeDefault(definition), ...current[definition.code], ...patch },
  }))

  return <div className="staff-access-policy">
    <section><header><BadgeDollarSign /><div><strong>资金操作额度</strong><small>岗位、发起和复核额度可配置；退款发起人与复核人必须分离。</small></div></header>
      <div className="staff-access-policy-list">{approvalDefinitions.map((definition) => {
        const value = approvalDraft[definition.code] ?? approvalValue(role, definition)
        const allowed = definitionAllowed(role, definition)
        const controls = configStrings(definition.config, 'controls')
        return <article key={definition.code} className={!allowed ? 'is-disabled' : ''}>
          <label className="staff-access-switch"><input aria-label={`${definition.label}启用`} type="checkbox" checked={value.enabled} disabled={!allowed} onChange={(event) => updateApproval(definition, { enabled: event.target.checked })} /><span>{value.enabled ? '启用' : '停用'}</span></label>
          <div><strong>{definition.label}</strong><small>{allowed ? definition.description : '请先在岗位权限中授予对应能力'}</small></div>
          <label className="staff-access-money"><span>单次上限</span><span>¥</span><input aria-label={`${definition.label}单次上限`} type="number" min="0" step="1" disabled={!allowed} value={value.amountMinor === null ? '' : value.amountMinor / 100} onChange={(event) => updateApproval(definition, { amountMinor: moneyMinor(event.target.value) })} /></label>
          {controls.includes('discount_percent') && <label className="staff-access-money"><span>最高折扣</span><input aria-label={`${definition.label}最高折扣`} type="number" min="0" max="100" step="1" disabled={!allowed} value={discountPercent(value.rules)} onChange={(event) => updateApproval(definition, { rules: { ...value.rules, discountBasisPoints: Math.round(Number(event.target.value || 0) * 100), requiresReason: true } })} /><span>%</span></label>}
          {controls.includes('second_actor') && <label className="staff-access-check"><input type="checkbox" disabled checked />强制不同员工复核（不可关闭）</label>}
        </article>
      })}</div>
    </section>

    <section><header><Database /><div><strong>数据范围</strong><small>只设置岗位确需处理的数据；全店权限可能覆盖范围限制。</small></div></header>
      <div className="staff-access-scope-list">{scopeDefinitions.map((definition) => {
        const editor = configString(definition.config, 'editor')
        const fallback = scopeDefault(definition)
        const value = scopeDraft[definition.code] ?? role.dataScopes.find((scope) => scope.key === definition.code && scope.effect === fallback.effect) ?? fallback
        const values = scopeStringValues(value.value)
        const blockedBy = configStrings(definition.config, 'disabledWhenAnyPermission')
        const allowed = definitionAllowed(role, definition) && !hasAny(role, blockedBy)
        const options = editor === 'area_multi' ? overview.areas.map((area) => ({ value: area.id, label: area.name }))
          : editor === 'employee_multi' ? overview.employees.filter((employee) => employee.status === 'active').map((employee) => ({ value: employee.id, label: employee.displayName }))
            : configStrings(definition.config, 'options').map((option) => ({ value: option, label: stationLabel(option) }))
        return <fieldset key={definition.code} disabled={!allowed}>
          <legend>{definition.label}</legend>
          {editor === 'boolean' && <label><input type="checkbox" checked={value.enabled} onChange={(event) => updateScope(definition, { value: definition.config.enabledValue ?? true, enabled: event.target.checked })} />{definition.description}</label>}
          {['multi_choice', 'area_multi', 'employee_multi'].includes(editor ?? '') && <div className="staff-access-choice-grid">{options.map((option) => <label key={option.value}><input type="checkbox" checked={values.includes(option.value)} onChange={(event) => {
            const next = toggleValue(values, option.value, event.target.checked)
            updateScope(definition, { value: next, enabled: next.length > 0 })
          }} />{option.label}</label>)}</div>}
          {!['boolean', 'multi_choice', 'area_multi', 'employee_multi'].includes(editor ?? '') && <small>当前页面版本不支持此编辑器，原配置保持不变。</small>}
          {!allowed && <small>请先授予对应权限，或取消覆盖本范围的全店权限。</small>}
        </fieldset>
      })}</div>
      {role.dataScopes.some((scope) => !scopeDefinitions.some((definition) => definition.code === scope.key)) && <p className="staff-access-advisory">此岗位还有高级数据范围，当前保持原值，不会被本页覆盖。</p>}
    </section>
  </div>
}

function NavigationEditor({ definitions, role, draft, setDraft }: {
  definitions: StaffAccessConfigurationDefinitionView[]
  role: StaffAccessRoleView; draft: Record<string, NavigationDraft>
  setDraft(value: React.SetStateAction<Record<string, NavigationDraft>>): void
}) {
  const update = (definition: StaffAccessConfigurationDefinitionView, patch: Partial<NavigationDraft>) => setDraft((current) => ({
    ...current, [definition.code]: { ...navigationValue(role, definition), ...current[definition.code], ...patch },
  }))
  const highFrequencyCount = definitions.filter((definition) => {
    const value = draft[definition.code] ?? navigationValue(role, definition)
    return value.enabled && value.displayConfig.highFrequency === true
  }).length
  return <div className="staff-access-navigation">
    <div className="staff-access-advisory"><MonitorSmartphone /><div><strong>手机高频入口最多4个</strong><span>入口只决定工作台显示；实际操作仍由岗位权限控制，不能通过隐藏或显示入口越权。</span></div></div>
    <div className="staff-access-navigation-list">{definitions.map((definition) => {
      const value = draft[definition.code] ?? navigationValue(role, definition)
      const allowed = definitionAllowed(role, definition) && configString(definition.config, 'route') !== undefined
      return <article key={definition.code} className={!allowed ? 'is-disabled' : ''}>
        <label className="staff-access-switch"><input aria-label={`${definition.label}入口`} type="checkbox" checked={value.enabled} disabled={!allowed} onChange={(event) => update(definition, { enabled: event.target.checked })} /><span>{value.enabled ? '显示' : '隐藏'}</span></label>
        <div><strong>{value.label}</strong><small>{allowed ? configString(definition.config, 'route') : '请先在岗位权限中授予对应能力'}</small></div>
        <label className="staff-access-check"><input aria-label={`${definition.label}高频入口`} type="checkbox" checked={value.displayConfig.highFrequency === true} disabled={!value.enabled || (!value.displayConfig.highFrequency && highFrequencyCount >= 4)} onChange={(event) => update(definition, { displayConfig: { ...value.displayConfig, highFrequency: event.target.checked }, sortOrder: definition.sortOrder })} />高频</label>
      </article>
    })}</div>
    <div className="staff-access-device-note"><MonitorSmartphone /><div><strong>设备本体独立管理</strong><span>这里配置谁能进入设备页面；打印机、耳机和摄像头的连接参数继续在“设备与打印”维护，避免人员权限和硬件配置互相覆盖。</span></div><a href="/staff/devices">打开设备与打印</a></div>
  </div>
}

function permissionChanges(role: StaffAccessRoleView, draft: Record<string, PermissionDraftValue>): StaffPermissionDeploymentChange[] {
  return Object.entries(draft).flatMap(([permissionCode, value]) => typeof value === 'boolean' && value !== role.permissionCodes.includes(permissionCode)
    ? [{ kind: 'role_permission' as const, roleId: role.id, permissionCode, enabled: value }] : [])
}

function employeeChanges(employee: StaffAccessManagementOverview['employees'][number], draft: Record<string, PermissionDraftValue>): StaffPermissionDeploymentChange[] {
  return Object.entries(draft).flatMap(([permissionCode, value]) => {
    if (value !== 'grant' && value !== 'deny' && value !== null) return []
    const original = employee.overrides.find((item) => item.permissionCode === permissionCode)?.effect ?? null
    return value === original ? [] : [{ kind: 'employee_override' as const, employeeId: employee.id, permissionCode, effect: value }]
  })
}

function approvalChanges(role: StaffAccessRoleView, draft: Record<string, ApprovalDraft>): StaffPermissionDeploymentChange[] {
  return Object.entries(draft).flatMap(([approvalCode, value]) => {
    const original = role.approvalLimits.find((item) => item.code === approvalCode && item.currency === value.currency)
    if (original !== undefined && original.enabled === value.enabled && original.amountMinor === value.amountMinor && sameJson(original.rules, value.rules)) return []
    if (original === undefined && !value.enabled) return []
    return [{ kind: 'role_approval_limit' as const, roleId: role.id, approvalCode, ...value }]
  })
}

function scopeChanges(role: StaffAccessRoleView, draft: Record<string, ScopeDraft>): StaffPermissionDeploymentChange[] {
  return Object.entries(draft).flatMap(([scopeKey, value]) => {
    const original = role.dataScopes.find((item) => item.key === scopeKey && item.effect === value.effect)
    if (original !== undefined && original.enabled === value.enabled && sameJson(original.value, value.value)) return []
    if (original === undefined && !value.enabled) return []
    return [{ kind: 'role_data_scope' as const, roleId: role.id, scopeKey, effect: value.effect, scopeValue: value.value, enabled: value.enabled }]
  })
}

function navigationChanges(role: StaffAccessRoleView, draft: Record<string, NavigationDraft>): StaffPermissionDeploymentChange[] {
  return Object.entries(draft).flatMap(([navigationCode, value]) => {
    const original = role.navigation.find((item) => item.code === navigationCode)
    if (original !== undefined && original.label === value.label && original.route === value.route && original.icon === value.icon
      && original.sortOrder === value.sortOrder && original.enabled === value.enabled && sameJson(original.displayConfig, value.displayConfig)) return []
    if (original === undefined && !value.enabled) return []
    return [{ kind: 'role_navigation' as const, roleId: role.id, navigationCode, ...value }]
  })
}

function approvalValue(role: StaffAccessRoleView, definition: StaffAccessConfigurationDefinitionView): ApprovalDraft {
  const currency = configString(definition.config, 'currency') ?? 'CNY'
  const current = role.approvalLimits.find((item) => item.code === definition.code && item.currency === currency)
  return current ?? {
    amountMinor: 0,
    currency,
    rules: { ...configObject(definition.config, 'defaultRules'), requiresReason: true },
    enabled: false,
  }
}

function navigationValue(role: StaffAccessRoleView, definition: StaffAccessConfigurationDefinitionView): NavigationDraft {
  const current = role.navigation.find((item) => item.code === definition.code)
  return current ?? {
    label: definition.label,
    route: configString(definition.config, 'route') ?? '',
    icon: configString(definition.config, 'icon') ?? null,
    sortOrder: definition.sortOrder,
    enabled: false,
    displayConfig: { highFrequency: false },
  }
}

function scopeDefault(definition: StaffAccessConfigurationDefinitionView): ScopeDraft {
  const effect = configString(definition.config, 'effect') === 'exclude' ? 'exclude' : 'include'
  const editor = configString(definition.config, 'editor')
  const value = editor === 'boolean' ? definition.config.enabledValue ?? true : []
  return { effect, value, enabled: false }
}

function definitionAllowed(role: StaffAccessRoleView, definition: StaffAccessConfigurationDefinitionView) {
  return definition.requiredPermissionCodes.length === 0 || hasAny(role, definition.requiredPermissionCodes)
}

function configString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key]
  return typeof value === 'string' ? value : undefined
}

function configStrings(config: Record<string, unknown>, key: string): string[] {
  const value = config[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function configObject(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = config[key]
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function scopeStringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? [value] : []
}

function toggleValue(values: string[], value: string, checked: boolean) {
  return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value)
}

function moneyMinor(value: string) {
  if (value.trim() === '') return null
  const amount = Number(value)
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : 0
}

function discountPercent(rules: Record<string, unknown>) {
  return typeof rules.discountBasisPoints === 'number' ? rules.discountBasisPoints / 100 : 0
}

function hasAny(role: StaffAccessRoleView, permissions: string[]) { return permissions.some((permission) => role.permissionCodes.includes(permission)) }
function stationLabel(value: string) { return ({ bar: '吧台', kitchen: '后厨', cashier: '收银台' } as Record<string, string>)[value] ?? value }
function modeTitle(mode: EditorMode) { return ({ role: '岗位权限', employee: '员工例外', policy: '审批与数据范围', navigation: '岗位入口与设备权限' })[mode] }
function modeHint(mode: EditorMode) { return ({ role: '先选岗位，再勾选允许能力', employee: '个人例外优先于岗位权限', policy: '高风险额度和数据边界分开设置', navigation: '控制工作台显示，不代替操作权限' })[mode] }

function categoryLabel(category: string): string {
  const labels: Record<string, string> = {
    operations: '现场运营', table: '桌台', service: '服务', order: '订单与出品', reservation: '预约',
    payment: '收银退款', inventory: '库存', hardware: '设备', staff: '人员权限', ai: 'AI执行', commercial: '经营数据',
  }
  return labels[category] ?? category
}

const permissionLabels: Record<string, string> = {
  'ai.execute': '执行AI命令', 'ai.schedule': '创建定时AI任务', 'business_day.close': '结束营业日', 'business_day.view': '查看营业日',
  'commercial.cost.manage': '维护经营成本', 'commercial.profit.view': '查看利润', 'commercial.sales.view': '查看本人销售', 'commercial.sales.view_all': '查看全员销售',
  'dashboard.view': '查看工作台', 'fulfillment.view_all': '查看全店出品', 'hardware.manage': '管理设备', 'hardware.view_all': '查看全部设备', 'printer.manage': '配置与维护打印机',
  'inventory.cost.view': '查看库存成本', 'inventory.manage': '管理库存', 'inventory.view': '查看库存', 'kds.deliver': '配送并确认送达',
  'kds.exception.manage': '处理出品异常', 'kds.prepare': '制作并完成出品', 'order.create': '创建订单', 'order.discount': '订单折扣',
  'order.gift': '赠送商品', 'order.view': '查看订单', 'payment.initiate.staff': '发起员工协助收款', 'payment.manual.cash.record': '登记现金收款',
  'payment.manual.pos.record': '登记POS收款', 'payment.manual.external.record': '登记其他线下收款', 'print.view_all': '查看全部打印任务', 'reconciliation.view': '查看对账', 'refund.approve': '审批退款',
  'refund.execute': '执行退款', 'refund.request': '发起退款', 'reservation.config.manage': '管理预约规则', 'reservation.manage': '处理预约',
  'reservation.view': '查看本人预约', 'reservation.view.all': '查看全部预约', 'service.execute': '处理服务需求', 'service.manage': '调度服务任务',
  'service.view': '查看服务需求', 'song.manage': '管理演出与点歌', 'song.view': '查看演出与点歌', 'staff.access.configure': '配置员工权限',
  'table.assignment.manage': '分配责任桌台', 'table.close': '结台', 'table.open': '开台', 'table.transfer': '转台', 'table.view_all': '查看全店桌台',
  'table.participation.manage': '管理桌台顾客拆并', 'kds.priority.override': '调整出品优先级', 'order.cancel_unpaid': '取消未付款订单', 'order.settle_exception': '登记异常结清',
  'payment.collect': '收款', 'payment.initiate': '发起收款', 'payment.policy.manage': '管理收款规则', 'payment.settlement.view': '查看收款结算',
  'reconciliation.manage': '管理对账', 'commercial.config.update': '配置经营数据', 'commercial.cost.correct': '更正经营成本', 'commercial.cost.create': '录入经营成本',
  'commercial.sales.attribute': '归因销售业绩', 'commercial.sales.rule.manage': '管理销售归因规则', 'commercial.voucher.redeem': '核销经营券', 'commercial.voucher.view': '查看经营券',
  'inventory.approve': '审批库存操作', 'inventory.barcode.bind': '绑定库存条码', 'inventory.count': '盘点库存', 'inventory.receive': '确认入库',
  'inventory.recipe.cost.apply': '应用配方成本', 'inventory.recipe.publish': '发布库存配方', 'inventory.recipe.replace': '调整库存配方', 'inventory.waste': '登记库存损耗',
  'media.asset.menu.manage': '管理商品图片素材',
  'checkout.upgrade.rule.view': '查看结账推荐规则', 'checkout.upgrade.rule.draft': '起草结账推荐规则', 'checkout.upgrade.rule.approve': '审批结账推荐规则', 'checkout.upgrade.rule.publish': '发布结账推荐规则',
  'fulfillment.capacity.view': '查看出品容量', 'fulfillment.capacity.draft': '起草出品容量', 'fulfillment.capacity.approve': '审批出品容量', 'fulfillment.capacity.publish': '发布出品容量',
  'recommendation.rule.view': '查看智能推荐规则', 'recommendation.rule.draft': '起草智能推荐规则', 'recommendation.rule.approve': '审批智能推荐规则', 'recommendation.rule.publish': '发布智能推荐规则',
  'recommendation.staff.modify': '调整桌台推荐', 'observation.record': '记录桌台情况', 'loyalty.operations.view': '查看会员运营', 'loyalty.operations.control': '管理会员运营',
  'loyalty.promotion.view': '查看会员促销', 'loyalty.promotion.manage': '管理会员促销', 'loyalty.promotion.approve': '审批会员促销', 'loyalty.promotion.publish': '发布会员促销',
  'loyalty.annual-benefit.view': '查看年度会员礼遇', 'loyalty.annual-benefit.manage': '起草年度会员礼遇', 'loyalty.annual-benefit.approve': '审批年度会员礼遇', 'loyalty.annual-benefit.publish': '发布年度会员礼遇', 'loyalty.annual-benefit.occurrence.confirm': '确认节日礼遇日期',
  'membership.terms.view': '查看会员条款', 'membership.terms.manage': '管理会员条款', 'membership.terms.approve': '审批会员条款', 'membership.terms.publish': '发布会员条款',
  'customer.membership.recovery.verify': '核验会员找回', 'customer.membership.merge.approve': '审批会员合并',
}

const permissionDescriptions: Record<string, string> = {
  'kds.prepare': '允许在所属出品站点确认制作完成。',
  'kds.deliver': '允许在实际送达后确认送达。',
  'table.close': '仅在本桌订单、出品与服务已处理完毕后可结台。',
  'table.open': '允许登记顾客到店并开启新的桌台服务。',
  'table.transfer': '允许保留订单与责任记录后转至其他桌台。',
  'fulfillment.view_all': '可查看全店出品进度；不代表可以确认制作或送达。',
  'staff.access.configure': '可调整岗位和员工的权限配置，发布后立即生效并留痕。',
}

function permissionLabel(code: string, configuredName: string): string {
  return permissionLabels[code] ?? (containsChinese(configuredName) ? configuredName : generatedPermissionLabel(code))
}

function permissionDescription(code: string, configuredDescription: string | null): string {
  if (permissionDescriptions[code] !== undefined) return permissionDescriptions[code]
  if (configuredDescription !== null && containsChinese(configuredDescription)) return configuredDescription
  return '按岗位配置此项操作权限。'
}

function generatedPermissionLabel(code: string): string {
  const parts = code.split('.')
  const domain = permissionDomainLabels[parts[0] ?? ''] ?? '其他功能'
  const action = permissionActionLabels[parts.at(-1) ?? ''] ?? '相关操作'
  return `${domain}${action}`
}

const permissionDomainLabels: Record<string, string> = {
  ai: '智能助手', business_day: '营业日', checkout: '结账推荐', commercial: '经营数据', customer: '顾客会员', dashboard: '工作台',
  fulfillment: '出品', hardware: '设备', inventory: '库存', kds: '出品', loyalty: '会员运营', membership: '会员',
  observation: '桌台记录', order: '订单', payment: '收款', print: '打印', printer: '打印设备', recommendation: '智能推荐',
  reconciliation: '对账', refund: '退款', reservation: '预约', service: '服务', song: '演出点歌', staff: '员工', table: '桌台',
}

const permissionActionLabels: Record<string, string> = {
  view: '查看', view_all: '查看全部', manage: '管理', configure: '配置', create: '新增', update: '更新', delete: '删除',
  draft: '起草', approve: '审批', publish: '发布', execute: '执行', open: '开台', close: '结台', transfer: '转台',
  prepare: '制作', deliver: '确认送达', receive: '确认入库', bind: '绑定', record: '登记', request: '发起', redeem: '核销',
}

function containsChinese(value: string): boolean { return /[\u3400-\u9fff]/.test(value) }
function roleLabel(code: string, name: string): string { return containsChinese(name) ? name : roleCodeLabel(code) }
function roleCodeLabel(code: string): string {
  return ({
    OWNER: '店主', ADMIN: '系统管理员', MANAGER: '店长', STORE_MANAGER: '门店经理', OPERATIONS_MANAGER: '运营经理',
    DEPUTY_MANAGER: '副店长', OPS_LEAD: '运营主管', SERVER: '服务员', CASHIER: '收银员', BARTENDER: '调酒师',
    KITCHEN: '后厨', HOST: '门迎', PERFORMER: '演出人员',
  } as Record<string, string>)[code] ?? '已分配岗位'
}
function message(error: unknown) { return error instanceof Error && error.message.trim() ? error.message : '系统暂时无法确认结果' }
function sameJson(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right) }
