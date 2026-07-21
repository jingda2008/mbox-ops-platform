import { BadgeDollarSign, CalendarClock, CheckCircle2, CircleOff, Clock3, EyeOff, GlassWater, MapPinned, Pencil, Plus, RotateCcw, Route, Save, Search, TableProperties, UserRoundCog, X } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  createCommerceAuthority,
  createEmployee as createEmployeeRequest,
  createProduct as createProductRequest,
  createShift as createShiftRequest,
  saveConfigDraft,
  updateArea as updateAreaRequest,
  updateCommerceAuthority,
  updateEmployee as updateEmployeeRequest,
  updateProduct as updateProductRequest,
  updateShift as updateShiftRequest,
  updateTable as updateTableRequest,
} from '../api'
import type {
  Area,
  BootstrapResponse,
  ConfigDraftInput,
  Employee,
  EmployeeWriteInput,
  MenuProduct,
  ProductWriteInput,
  RoleConfig,
  RoleDataScope,
  StaffPermissionId,
  ShiftAssignment,
  ShiftWriteInput,
  SkillConfig,
  Table,
  WorkstationConfig,
} from '../shared/contracts'
import { staffPermissionIds } from '../shared/contracts'
import type { AuthorityWriteInput } from '../shared/commerce-api'
import type { OrderAuthorizationAuthority } from '../shared/order-contracts'
import { productAvailability } from '../shared/product-availability'
import { chinaDateTimeLocalValue, chinaLocalDateTimeToIso, shiftDateKey } from '../shared/china-time'
import './MasterDataView.css'

type MasterView = 'employees' | 'shifts' | 'tables' | 'products' | 'routing' | 'authorities' | 'areas'

interface MasterDataViewProps {
  data: BootstrapResponse
  onRefresh: () => Promise<void>
  onNotice: (message: string) => void
}

const sections: Array<{ id: MasterView; label: string; icon: typeof UserRoundCog }> = [
  { id: 'employees', label: '人员', icon: UserRoundCog },
  { id: 'shifts', label: '班次', icon: CalendarClock },
  { id: 'tables', label: '桌台责任', icon: TableProperties },
  { id: 'products', label: '商品', icon: GlassWater },
  { id: 'routing', label: '工作站/技能', icon: Route },
  { id: 'authorities', label: '经营权限', icon: BadgeDollarSign },
  { id: 'areas', label: '区域', icon: MapPinned },
]

const permissionLabels: Record<StaffPermissionId, string> = {
  'dashboard.view': '现场看板', 'finance.view': '财务数据', 'audit.view': '审计记录',
  'config.manage': '系统配置', 'identity.manage': '账号权限', 'master_data.manage': '主数据',
  'shift.manage': '排班调度', 'table.open': '开台接客', 'table.manage': '桌台管理', 'table.close': '结台清台', 'business_day.close': '营业日关账', 'reservation.view': '查看预约',
  'reservation.manage': '预约接待', 'reservation.config.manage': '预约规则',
  'service.execute': '执行服务', 'complaint.handle': '处理投诉', 'order.create': '创建订单',
  'order.view': '查看订单', 'kds.prepare': '出品制作', 'kds.deliver': '取送确认',
  'payment.collect': '发起收款', 'payment.pos_report': 'POS报送',
  'payment.refund.request': '申请退款', 'payment.refund.approve': '批准退款',
  'commerce.authorization.request': '申请赠送折扣',
  'commerce.authorization.approve': '批准赠送折扣', 'inventory.view': '查看库存',
  'inventory.manage': '库存操作', 'inventory.approve': '库存审批', 'benefit.view': '查看权益',
  'benefit.grant': '发放权益', 'benefit.approve': '审批权益', 'song.view': '查看演出',
  'benefit.manage': '管理权益规则',
  'song.manage': '管理点歌',
  'hardware.view': '查看设备', 'hardware.operate': '执行设备测试', 'hardware.manage': '管理设备配置',
  'store_import.apply': '应用整店导入',
}

const scopeLabels: Record<RoleDataScope, string> = {
  own: '本人任务', assigned_areas: '负责区域', store: '本门店', all_stores: '全部门店',
}

export function MasterDataView({ data, onRefresh, onNotice }: MasterDataViewProps) {
  const [view, setView] = useState<MasterView>('employees')

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action()
      onNotice(`保存成功：${success}`)
      await onRefresh()
      return true
    } catch (error) {
      onNotice(`保存失败：${error instanceof Error ? error.message : '主数据未保存'}`)
      return false
    }
  }

  return (
    <section className="master-view">
      <div className="section-heading">
        <div><span className="eyebrow">门店主数据</span><h2>人员、班次与责任关系</h2></div>
        <span className="count-chip">修订 {data.revision}</span>
      </div>
      <div className="segmented-tabs" role="tablist" aria-label="主数据类型">
        {sections.map((section) => {
          const Icon = section.icon
          return (
            <button key={section.id} role="tab" aria-selected={view === section.id} onClick={() => setView(section.id)}>
              <Icon size={17} />{section.label}
            </button>
          )
        })}
      </div>

      {view === 'employees' && <EmployeeSection data={data} run={run} />}
      {view === 'shifts' && <ShiftSection data={data} run={run} />}
      {view === 'tables' && <TableSection data={data} run={run} />}
      {view === 'products' && <ProductSection data={data} run={run} />}
      {view === 'routing' && <RoutingSection data={data} run={run} />}
      {view === 'authorities' && <AuthoritySection data={data} run={run} />}
      {view === 'areas' && <AreaSection data={data} run={run} />}
    </section>
  )
}

function EmployeeSection({ data, run }: SectionProps) {
  const [name, setName] = useState('')
  const [roleId, setRoleId] = useState(data.config.roles[0]?.id ?? '')
  const [areaId, setAreaId] = useState(data.areas[0]?.id ?? '')

  async function submit(event: FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    await run(() => createEmployeeRequest({
      displayName: trimmed,
      initials: Array.from(trimmed)[0] ?? '员',
      status: 'active', roleId, roleIds: [roleId], permissionIds: [], online: false, paused: false, areaIds: areaId ? [areaId] : [], skillIds: [],
    }), `员工${trimmed}已建立`)
    setName('')
  }

  return (
    <div className="master-section">
      <form className="inline-create" onSubmit={(event) => void submit(event)}>
        <label><span>员工姓名</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} /></label>
        <label><span>默认岗位</span><select value={roleId} onChange={(event) => setRoleId(event.target.value)}>{data.config.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
        <label><span>责任区</span><select value={areaId} onChange={(event) => setAreaId(event.target.value)}>{data.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label>
        <button className="primary-button" type="submit"><Plus size={17} />新增员工</button>
      </form>
      <div className="master-rows">
        {data.employees.map((employee) => <EmployeeRow key={employee.id} employee={employee} data={data} run={run} />)}
      </div>
    </div>
  )
}

function EmployeeRow({ employee, data, run }: { employee: Employee; data: BootstrapResponse; run: RunAction }) {
  const [draft, setDraft] = useState<EmployeeWriteInput>(() => employee)
  useEffect(() => setDraft(employee), [employee])

  return (
    <div className="master-row employee-row">
      <label><span>姓名</span><input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
      <label><span>岗位</span><select value={draft.roleId} onChange={(event) => setDraft({ ...draft, roleId: event.target.value })}>{data.config.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
      <details className="employee-access-details">
        <summary>岗位与权限 <span>{draft.roleIds?.length ?? 0}个兼任 · {draft.permissionIds?.length ?? 0}项个人授权</span></summary>
        <div className="area-selector"><span>兼任岗位</span><div>{data.config.roles.map((role) => <label key={role.id}><input type="checkbox" checked={[draft.roleId, ...(draft.roleIds ?? [])].includes(role.id)} disabled={role.id === draft.roleId} onChange={(event) => setDraft({ ...draft, roleIds: toggleValue(draft.roleIds ?? [], role.id, event.target.checked) })} />{role.name}</label>)}</div></div>
        <div className="area-selector"><span>个人权限</span><div>{staffPermissionIds.map((permissionId) => <label key={permissionId}><input type="checkbox" checked={draft.permissionIds?.includes(permissionId) ?? false} onChange={(event) => setDraft({ ...draft, permissionIds: toggleValue(draft.permissionIds ?? [], permissionId, event.target.checked) as StaffPermissionId[] })} />{permissionLabels[permissionId]}</label>)}</div></div>
      </details>
      <div className="area-selector"><span>责任区</span><div>{data.areas.map((area) => <label key={area.id}><input type="checkbox" checked={draft.areaIds.includes(area.id)} onChange={(event) => setDraft({ ...draft, areaIds: event.target.checked ? [...draft.areaIds, area.id] : draft.areaIds.filter((id) => id !== area.id) })} />{area.shortName}</label>)}</div></div>
      <div className="area-selector"><span>技能</span><div>{effectiveConfig(data).skills.filter((skill) => skill.enabled || draft.skillIds?.includes(skill.id)).map((skill) => <label key={skill.id}><input type="checkbox" checked={draft.skillIds?.includes(skill.id) ?? false} onChange={(event) => setDraft({ ...draft, skillIds: toggleValue(draft.skillIds ?? [], skill.id, event.target.checked) })} />{skill.name}</label>)}</div></div>
      <label><span>状态</span><select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as EmployeeWriteInput['status'] })}><option value="active">在职</option><option value="inactive">停用</option></select></label>
      <label className="binary-field"><span>在线</span><input type="checkbox" checked={draft.online} onChange={(event) => setDraft({ ...draft, online: event.target.checked })} /></label>
      <label className="binary-field"><span>暂停接单</span><input type="checkbox" checked={draft.paused} onChange={(event) => setDraft({ ...draft, paused: event.target.checked })} /></label>
      <button className="icon-button" title={`保存${employee.displayName}`} onClick={() => void run(() => updateEmployeeRequest(employee.id, draft), `${draft.displayName}资料已保存`)}><Save size={17} /></button>
    </div>
  )
}

function ShiftSection({ data, run }: SectionProps) {
  const firstEmployee = data.employees.find((employee) => employee.status === 'active')
  const firstArea = data.areas[0]
  const firstRole = data.config.roles[0]
  const [employeeId, setEmployeeId] = useState(firstEmployee?.id ?? '')
  const [roleId, setRoleId] = useState(firstRole?.id ?? '')
  const [areaId, setAreaId] = useState(firstArea?.id ?? '')
  const [stationId, setStationId] = useState(effectiveConfig(data).workstations.find((station) => station.enabled)?.id ?? '')
  const [startAt, setStartAt] = useState(`${data.store.businessDate}T19:00`)
  const [endAt, setEndAt] = useState(`${shiftDateKey(data.store.businessDate, 1)}T03:00`)

  async function submit(event: FormEvent) {
    event.preventDefault()
    await run(() => createShiftRequest({
      employeeId, businessDate: data.store.businessDate, startAt: chinaLocalDateTimeToIso(startAt),
      endAt: chinaLocalDateTimeToIso(endAt), roleId, roleIds: [roleId], areaIds: [areaId], stationIds: stationId ? [stationId] : [], isPrimary: false, status: 'scheduled',
    }), '新班次已建立')
  }

  return (
    <div className="master-section">
      <form className="inline-create shift-create" onSubmit={(event) => void submit(event)}>
        <label><span>员工</span><select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>{data.employees.filter((employee) => employee.status === 'active').map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label>
        <label><span>岗位</span><select value={roleId} onChange={(event) => setRoleId(event.target.value)}>{data.config.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
        <label><span>区域</span><select value={areaId} onChange={(event) => setAreaId(event.target.value)}>{data.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label>
        <label><span>工作站</span><select value={stationId} onChange={(event) => setStationId(event.target.value)}><option value="">不限工作站</option>{effectiveConfig(data).workstations.filter((station) => station.enabled).map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}</select></label>
        <label><span>开始（北京时间）</span><input type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.target.value)} /></label>
        <label><span>结束（北京时间）</span><input type="datetime-local" value={endAt} onChange={(event) => setEndAt(event.target.value)} /></label>
        <button className="primary-button" type="submit"><Plus size={17} />新增班次</button>
      </form>
      <div className="master-rows">
        {data.shiftAssignments.map((shift) => <ShiftRow key={shift.id} shift={shift} data={data} run={run} />)}
      </div>
    </div>
  )
}

function ShiftRow({ shift, data, run }: { shift: ShiftAssignment; data: BootstrapResponse; run: RunAction }) {
  const [draft, setDraft] = useState<ShiftWriteInput>(() => shift)
  useEffect(() => setDraft(shift), [shift])
  const employee = data.employees.find((item) => item.id === shift.employeeId)
  return (
    <div className="master-row shift-row">
      <div className="row-identity"><strong>{employee?.displayName ?? '未知员工'}</strong><span>{shift.businessDate}</span></div>
      <label><span>岗位</span><select value={draft.roleId} onChange={(event) => setDraft({ ...draft, roleId: event.target.value })}>{data.config.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
      <details className="employee-access-details shift-role-details"><summary>当班兼任 <span>{draft.roleIds?.length ?? 0}个</span></summary><div className="area-selector"><span>当班兼任</span><div>{data.config.roles.map((role) => <label key={role.id}><input type="checkbox" checked={[draft.roleId, ...(draft.roleIds ?? [])].includes(role.id)} disabled={role.id === draft.roleId} onChange={(event) => setDraft({ ...draft, roleIds: toggleValue(draft.roleIds ?? [], role.id, event.target.checked) })} />{role.name}</label>)}</div></div></details>
      <div className="area-selector"><span>工作站</span><div>{effectiveConfig(data).workstations.filter((station) => station.enabled || draft.stationIds?.includes(station.id)).map((station) => <label key={station.id}><input type="checkbox" checked={draft.stationIds?.includes(station.id) ?? false} onChange={(event) => setDraft({ ...draft, stationIds: toggleValue(draft.stationIds ?? [], station.id, event.target.checked) })} />{station.name}</label>)}</div></div>
      <label><span>开始（北京时间）</span><input type="datetime-local" value={toLocalInput(draft.startAt)} onChange={(event) => setDraft({ ...draft, startAt: chinaLocalDateTimeToIso(event.target.value) })} /></label>
      <label><span>结束（北京时间）</span><input type="datetime-local" value={toLocalInput(draft.endAt)} onChange={(event) => setDraft({ ...draft, endAt: chinaLocalDateTimeToIso(event.target.value) })} /></label>
      <label><span>状态</span><select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as ShiftWriteInput['status'] })}><option value="scheduled">已排班</option><option value="active">当班</option><option value="completed">已结束</option><option value="cancelled">已取消</option></select></label>
      <button className="icon-button" title={`保存${employee?.displayName ?? ''}班次`} onClick={() => void run(() => updateShiftRequest(shift.id, draft), '班次已保存')}><Save size={17} /></button>
    </div>
  )
}

function TableSection({ data, run }: SectionProps) {
  return <div className="master-section master-rows">{data.tables.map((table) => <TableRow key={table.id} table={table} data={data} run={run} />)}</div>
}

function TableRow({ table, data, run }: { table: Table; data: BootstrapResponse; run: RunAction }) {
  const [draft, setDraft] = useState(() => ({
    displayName: table.displayName, areaId: table.areaId, capacity: table.capacity, status: table.status,
    primaryEmployeeId: table.primaryEmployeeId, backupEmployeeIds: table.backupEmployeeIds,
  }))
  useEffect(() => setDraft({ displayName: table.displayName, areaId: table.areaId, capacity: table.capacity, status: table.status, primaryEmployeeId: table.primaryEmployeeId, backupEmployeeIds: table.backupEmployeeIds }), [table])
  const activeEmployees = data.employees.filter((employee) => employee.status === 'active')
  return (
    <div className="master-row table-config-row">
      <div className="row-identity"><strong>{table.code}</strong><span>{table.displayName}</span></div>
      <label><span>名称</span><input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
      <label><span>区域</span><select value={draft.areaId} onChange={(event) => setDraft({ ...draft, areaId: event.target.value })}>{data.areas.map((area) => <option key={area.id} value={area.id}>{area.shortName}</option>)}</select></label>
      <label><span>容量</span><input type="number" min={1} max={100} value={draft.capacity} onChange={(event) => setDraft({ ...draft, capacity: Number(event.target.value) })} /></label>
      <label><span>主责</span><select value={draft.primaryEmployeeId} onChange={(event) => setDraft({ ...draft, primaryEmployeeId: event.target.value, backupEmployeeIds: draft.backupEmployeeIds.filter((id) => id !== event.target.value) })}>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label>
      <label><span>第一候补</span><select value={draft.backupEmployeeIds[0] ?? ''} onChange={(event) => setDraft({ ...draft, backupEmployeeIds: event.target.value ? [event.target.value] : [] })}><option value="">无</option>{activeEmployees.filter((employee) => employee.id !== draft.primaryEmployeeId).map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label>
      <button className="icon-button" title={`保存${table.code}`} onClick={() => void run(() => updateTableRequest(table.id, draft), `${table.code}责任关系已保存`)}><Save size={17} /></button>
    </div>
  )
}

function RoutingSection({ data, run }: SectionProps) {
  const source = effectiveConfig(data)
  const [roles, setRoles] = useState<RoleConfig[]>(() => structuredClone(source.roles))
  const [skills, setSkills] = useState<SkillConfig[]>(() => structuredClone(source.skills))
  const [workstations, setWorkstations] = useState<WorkstationConfig[]>(() => structuredClone(source.workstations))
  const [roleId, setRoleId] = useState('')
  const [roleName, setRoleName] = useState('')
  const [skillId, setSkillId] = useState('')
  const [skillName, setSkillName] = useState('')
  const [stationId, setStationId] = useState('')
  const [stationName, setStationName] = useState('')

  useEffect(() => setRoles(structuredClone(source.roles)), [source.roles])
  useEffect(() => setSkills(structuredClone(source.skills)), [source.skills])
  useEffect(() => setWorkstations(structuredClone(source.workstations)), [source.workstations])

  function addRole(event: FormEvent) {
    event.preventDefault()
    const id = roleId.trim()
    const name = roleName.trim()
    if (!id || !name || roles.some((role) => role.id === id)) return
    setRoles([...roles, {
      id, name, maxConcurrentTasks: 3, canReceiveTasks: true, permissionIds: [], dataScope: 'own',
      approvalLimits: { giftAmount: 0, discountAmount: 0, refundRequestAmount: 0, refundApproveAmount: 0, inventoryAdjustmentAmount: 0 },
    }])
    setRoleId('')
    setRoleName('')
  }

  function addSkill(event: FormEvent) {
    event.preventDefault()
    const id = skillId.trim()
    const name = skillName.trim()
    if (!id || !name || skills.some((skill) => skill.id === id)) return
    setSkills([...skills, { id, name, enabled: true }])
    setSkillId('')
    setSkillName('')
  }

  function addWorkstation(event: FormEvent) {
    event.preventDefault()
    const id = stationId.trim()
    const name = stationName.trim()
    if (!id || !name || workstations.some((station) => station.id === id)) return
    const deliveryRoleIds = roles.filter((role) => ['server', 'backup', 'supervisor', 'manager'].includes(role.id)).map((role) => role.id)
    setWorkstations([...workstations, {
      id,
      name,
      kind: 'hybrid',
      enabled: true,
      productionRoleIds: [],
      deliveryRoleIds,
      requiredSkillIds: [],
      productionSlaSeconds: 300,
      pickupSlaSeconds: 90,
      deliveryServiceTypeId: source.serviceTypes.find((type) => type.id === 'fulfillment-delivery')?.id ?? null,
      fallbackStationId: null,
    }])
    setStationId('')
    setStationName('')
  }

  function updateRole(id: string, update: Partial<RoleConfig>) {
    setRoles(roles.map((role) => role.id === id ? { ...role, ...update } : role))
  }

  function updateSkill(id: string, update: Partial<SkillConfig>) {
    setSkills(skills.map((skill) => skill.id === id ? { ...skill, ...update } : skill))
  }

  function updateWorkstation(id: string, update: Partial<WorkstationConfig>) {
    setWorkstations(workstations.map((station) => station.id === id ? { ...station, ...update } : station))
  }

  const incompleteWorkstations = workstations.filter((station) => (
    station.enabled && (station.productionRoleIds.length === 0 || station.deliveryRoleIds.length === 0)
  ))

  return (
    <div className="master-section routing-section">
      <div className="routing-toolbar">
        <form className="routing-create" onSubmit={addRole}>
          <label><span>岗位ID</span><input value={roleId} onChange={(event) => setRoleId(event.target.value)} placeholder="bartender" /></label>
          <label><span>岗位名称</span><input value={roleName} onChange={(event) => setRoleName(event.target.value)} placeholder="鸡尾酒调酒师" /></label>
          <button className="secondary-button" type="submit" disabled={!roleId.trim() || !roleName.trim()}><Plus size={16} />新增岗位</button>
        </form>
        <form className="routing-create" onSubmit={addSkill}>
          <label><span>技能ID</span><input value={skillId} onChange={(event) => setSkillId(event.target.value)} placeholder="skill-name" /></label>
          <label><span>技能名称</span><input value={skillName} onChange={(event) => setSkillName(event.target.value)} /></label>
          <button className="secondary-button" type="submit" disabled={!skillId.trim() || !skillName.trim()}><Plus size={16} />新增技能</button>
        </form>
        <form className="routing-create" onSubmit={addWorkstation}>
          <label><span>工作站ID</span><input value={stationId} onChange={(event) => setStationId(event.target.value)} placeholder="station-id" /></label>
          <label><span>工作站名称</span><input value={stationName} onChange={(event) => setStationName(event.target.value)} /></label>
          <button className="secondary-button" type="submit" disabled={!stationId.trim() || !stationName.trim()}><Plus size={16} />新增工作站</button>
        </form>
      </div>

      <div className="routing-group">
        <div className="routing-group-heading"><strong>岗位</strong><span>{roles.length} 项</span></div>
        <div className="master-rows">
          {roles.map((role) => (
            <div className="master-row role-policy-row" key={role.id}>
              <div className="role-policy-summary">
                <div className="row-identity"><strong>{role.id}</strong><span>权限、范围与额度</span></div>
                <label><span>名称</span><input value={role.name} onChange={(event) => updateRole(role.id, { name: event.target.value })} /></label>
                <label><span>数据范围</span><select value={role.dataScope ?? 'own'} onChange={(event) => updateRole(role.id, { dataScope: event.target.value as RoleDataScope })}>{Object.entries(scopeLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
                <label><span>并发任务</span><input type="number" min={1} max={20} value={role.maxConcurrentTasks} onChange={(event) => updateRole(role.id, { maxConcurrentTasks: Number(event.target.value) })} /></label>
                <label className="binary-field"><span>允许接单</span><input type="checkbox" checked={role.canReceiveTasks} onChange={(event) => updateRole(role.id, { canReceiveTasks: event.target.checked })} /></label>
              </div>
              <ChoiceField label="功能权限" items={staffPermissionIds.map((id) => ({ id, name: permissionLabels[id] }))} selected={role.permissionIds ?? []} onChange={(ids) => updateRole(role.id, { permissionIds: ids as StaffPermissionId[] })} />
              <div className="role-limit-grid">
                <MoneyLimit label="赠送上限" value={role.approvalLimits?.giftAmount ?? 0} onChange={(value) => updateRoleLimit(role, updateRole, 'giftAmount', value)} />
                <MoneyLimit label="折扣上限" value={role.approvalLimits?.discountAmount ?? 0} onChange={(value) => updateRoleLimit(role, updateRole, 'discountAmount', value)} />
                <MoneyLimit label="退款申请" value={role.approvalLimits?.refundRequestAmount ?? 0} onChange={(value) => updateRoleLimit(role, updateRole, 'refundRequestAmount', value)} />
                <MoneyLimit label="退款审批" value={role.approvalLimits?.refundApproveAmount ?? 0} onChange={(value) => updateRoleLimit(role, updateRole, 'refundApproveAmount', value)} />
                <MoneyLimit label="库存调整" value={role.approvalLimits?.inventoryAdjustmentAmount ?? 0} onChange={(value) => updateRoleLimit(role, updateRole, 'inventoryAdjustmentAmount', value)} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="routing-group">
        <div className="routing-group-heading"><strong>技能</strong><span>{skills.length} 项</span></div>
        <div className="master-rows">
          {skills.map((skill) => (
            <div className="master-row skill-row" key={skill.id}>
              <div className="row-identity"><strong>{skill.id}</strong><span>员工能力标签</span></div>
              <label><span>名称</span><input value={skill.name} onChange={(event) => updateSkill(skill.id, { name: event.target.value })} /></label>
              <label className="binary-field"><span>启用</span><input type="checkbox" checked={skill.enabled} onChange={(event) => updateSkill(skill.id, { enabled: event.target.checked })} /></label>
            </div>
          ))}
        </div>
      </div>

      <div className="routing-group">
        <div className="routing-group-heading"><strong>工作站与岗位路由</strong><span>{workstations.length} 个</span></div>
        <div className="master-rows workstation-list">
          {workstations.map((station) => (
            <div className="master-row workstation-row" key={station.id}>
              <div className="workstation-summary">
                <div className="row-identity"><strong>{station.id}</strong><span>{station.enabled ? '参与路由' : '已停用'}</span></div>
                <label><span>名称</span><input value={station.name} onChange={(event) => updateWorkstation(station.id, { name: event.target.value })} /></label>
                <label><span>类型</span><select value={station.kind} onChange={(event) => updateWorkstation(station.id, { kind: event.target.value as WorkstationConfig['kind'] })}><option value="production">出品</option><option value="delivery">取送</option><option value="hybrid">出品+取送</option></select></label>
                <label className="binary-field"><span>启用</span><input type="checkbox" checked={station.enabled} onChange={(event) => updateWorkstation(station.id, { enabled: event.target.checked })} /></label>
              </div>
              <div className="workstation-routing-grid">
                <ChoiceField label="出品岗位" items={roles} selected={station.productionRoleIds} onChange={(ids) => updateWorkstation(station.id, { productionRoleIds: ids })} />
                <ChoiceField label="取送岗位" items={roles} selected={station.deliveryRoleIds} onChange={(ids) => updateWorkstation(station.id, { deliveryRoleIds: ids })} />
                <ChoiceField label="要求技能" items={skills.filter((skill) => skill.enabled || station.requiredSkillIds.includes(skill.id))} selected={station.requiredSkillIds} onChange={(ids) => updateWorkstation(station.id, { requiredSkillIds: ids })} />
                <label><span>出品SLA（秒）</span><input type="number" min={5} max={7200} value={station.productionSlaSeconds} onChange={(event) => updateWorkstation(station.id, { productionSlaSeconds: Number(event.target.value) })} /></label>
                <label><span>取货SLA（秒）</span><input type="number" min={5} max={7200} value={station.pickupSlaSeconds} onChange={(event) => updateWorkstation(station.id, { pickupSlaSeconds: Number(event.target.value) })} /></label>
                <label><span>取送任务类型</span><select value={station.deliveryServiceTypeId ?? ''} onChange={(event) => updateWorkstation(station.id, { deliveryServiceTypeId: event.target.value || null })}><option value="">不自动派单</option>{source.serviceTypes.filter((type) => type.enabled && type.code === 'FULFILLMENT_DELIVERY').map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
                <label><span>候补工作站</span><select value={station.fallbackStationId ?? ''} onChange={(event) => updateWorkstation(station.id, { fallbackStationId: event.target.value || null })}><option value="">无</option>{workstations.filter((item) => item.id !== station.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="routing-savebar">
        <span className={incompleteWorkstations.length > 0 ? 'routing-validation' : undefined}>
          {incompleteWorkstations.length > 0
            ? `${incompleteWorkstations.map((station) => station.name).join('、')}需要明确选择出品岗位和取送岗位`
            : data.draftConfig ? '当前编辑未发布配置草稿' : `基于已发布配置 V${data.config.version}`}
        </span>
        <button className="primary-button" disabled={incompleteWorkstations.length > 0} onClick={() => void run(() => saveConfigDraft(configDraftPayload(source, roles, skills, workstations)), '岗位、工作站与技能已保存到配置草稿')}><Save size={17} />保存配置草稿</button>
      </div>
    </div>
  )
}

function ChoiceField({ label, items, selected, onChange }: { label: string; items: Array<{ id: string; name: string }>; selected: string[]; onChange: (ids: string[]) => void }) {
  return <div className="area-selector"><span>{label}</span><div>{items.map((item) => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => onChange(toggleValue(selected, item.id, event.target.checked))} />{item.name}</label>)}</div></div>
}

function MoneyLimit({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label><span>{label}（元）</span><input type="number" min={0} value={fenToYuan(value)} onChange={(event) => onChange(yuanToFen(Number(event.target.value)))} /></label>
}

function updateRoleLimit(
  role: RoleConfig,
  updateRole: (id: string, update: Partial<RoleConfig>) => void,
  key: keyof NonNullable<RoleConfig['approvalLimits']>,
  value: number,
) {
  updateRole(role.id, {
    approvalLimits: {
      giftAmount: 0, discountAmount: 0, refundRequestAmount: 0, refundApproveAmount: 0,
      inventoryAdjustmentAmount: 0, ...role.approvalLimits, [key]: value,
    },
  })
}

function AreaSection({ data, run }: SectionProps) {
  return <div className="master-section master-rows">{data.areas.map((area) => <AreaRow key={area.id} area={area} run={run} />)}</div>
}

function AuthoritySection({ data, run }: SectionProps) {
  const firstEmployee = data.employees.find((employee) => employee.status === 'active')
  const start = new Date()
  const end = new Date(start.getTime() + 8 * 60 * 60 * 1000)
  const [actorId, setActorId] = useState(firstEmployee?.id ?? '')
  const [kind, setKind] = useState<'gift' | 'discount'>('gift')
  const [maxYuan, setMaxYuan] = useState(100)

  async function submit(event: FormEvent) {
    event.preventDefault()
    await run(() => createCommerceAuthority({
      actorId,
      kinds: [kind],
      maxAmount: yuanToFen(maxYuan),
      allowedSkuIds: null,
      tableSessionIds: null,
      validFrom: start.toISOString(),
      validUntil: end.toISOString(),
    }), '经营授权已建立')
  }

  return (
    <div className="master-section">
      <form className="inline-create authority-create" onSubmit={(event) => void submit(event)}>
        <label><span>授权员工</span><select value={actorId} onChange={(event) => setActorId(event.target.value)}>{data.employees.filter((employee) => employee.status === 'active').map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label>
        <label><span>权限类型</span><select value={kind} onChange={(event) => setKind(event.target.value as 'gift' | 'discount')}><option value="gift">赠送</option><option value="discount">折扣</option></select></label>
        <label><span>单次上限（元）</span><input type="number" min={0} value={maxYuan} onChange={(event) => setMaxYuan(Number(event.target.value))} /></label>
        <button className="primary-button" type="submit" disabled={!actorId}><Plus size={17} />新增授权</button>
      </form>
      <div className="authority-note">权限按员工、类型、金额、商品、桌次和有效时间共同判断；所有修改进入审计。</div>
      <div className="master-rows">
        {data.orderDomain.authorizationAuthorities.map((authority) => <AuthorityRow key={authority.id} authority={authority} data={data} run={run} />)}
      </div>
    </div>
  )
}

function AuthorityRow({ authority, data, run }: { authority: OrderAuthorizationAuthority; data: BootstrapResponse; run: RunAction }) {
  const toDraft = (value: OrderAuthorizationAuthority): AuthorityWriteInput => ({
    actorId: value.actorId,
    kinds: value.kinds,
    maxAmount: value.maxAmount,
    allowedSkuIds: value.allowedSkuIds ?? null,
    tableSessionIds: value.tableSessionIds,
    validFrom: value.validFrom,
    validUntil: value.validUntil,
  })
  const [draft, setDraft] = useState<AuthorityWriteInput>(() => toDraft(authority))
  useEffect(() => setDraft(toDraft(authority)), [authority])
  const employee = data.employees.find((item) => item.id === draft.actorId)

  function toggleKind(kind: 'gift' | 'discount', checked: boolean) {
    setDraft({ ...draft, kinds: checked ? Array.from(new Set([...draft.kinds, kind])) : draft.kinds.filter((item) => item !== kind) })
  }

  function toggleProduct(productId: string, checked: boolean) {
    const current = draft.allowedSkuIds ?? []
    setDraft({ ...draft, allowedSkuIds: checked ? Array.from(new Set([...current, productId])) : current.filter((id) => id !== productId) })
  }

  return (
    <div className="master-row authority-row">
      <div className="row-identity"><strong>{employee?.displayName ?? '未知员工'}</strong><span>{authority.id}</span></div>
      <div className="area-selector"><span>可审批</span><div><label><input type="checkbox" checked={draft.kinds.includes('gift')} onChange={(event) => toggleKind('gift', event.target.checked)} />赠送</label><label><input type="checkbox" checked={draft.kinds.includes('discount')} onChange={(event) => toggleKind('discount', event.target.checked)} />折扣</label></div></div>
      <label><span>单次上限（元）</span><input type="number" min={0} value={fenToYuan(draft.maxAmount)} onChange={(event) => setDraft({ ...draft, maxAmount: yuanToFen(Number(event.target.value)) })} /></label>
      <div className="area-selector product-authority"><span>允许商品</span><div><label><input type="checkbox" checked={draft.allowedSkuIds === null} onChange={(event) => setDraft({ ...draft, allowedSkuIds: event.target.checked ? null : [] })} />全部</label>{data.products.map((product) => <label key={product.id}><input type="checkbox" disabled={draft.allowedSkuIds === null} checked={draft.allowedSkuIds?.includes(product.id) ?? false} onChange={(event) => toggleProduct(product.id, event.target.checked)} />{product.name}</label>)}</div></div>
      <label><span>有效至（北京时间）</span><input type="datetime-local" value={toLocalInput(draft.validUntil)} onChange={(event) => setDraft({ ...draft, validUntil: chinaLocalDateTimeToIso(event.target.value) })} /></label>
      <button className="icon-button" title={`保存${employee?.displayName ?? ''}经营权限`} disabled={draft.kinds.length === 0 || draft.allowedSkuIds?.length === 0} onClick={() => void run(() => updateCommerceAuthority(authority.id, draft), '经营权限已保存')}><Save size={17} /></button>
    </div>
  )
}

function ProductSection({ data, run }: SectionProps) {
  const workstations = effectiveConfig(data).workstations
  const canManageCosts = data.viewer?.permissionIds.includes('finance.view') ?? false
  const categories = useMemo(() => Array.from(new Map(data.products.map((product) => [product.categoryId ?? 'featured', product.categoryName ?? '推荐'])).entries()), [data.products])
  const [sku, setSku] = useState('')
  const [name, setName] = useState('')
  const [price, setPrice] = useState(68)
  const [categoryId, setCategoryId] = useState(categories[0]?.[0] ?? 'featured')
  const [stationId, setStationId] = useState(workstations.find((station) => station.enabled)?.id ?? '')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'available' | 'sold_out' | 'hidden' | 'timed'>('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [stationFilter, setStationFilter] = useState('all')
  const [editingProductId, setEditingProductId] = useState<string | null>(null)

  const productStates = useMemo(() => new Map(data.products.map((product) => [product.id, productAvailability(product, new Date(data.serverNow), data.store.timezone)])), [data.products, data.serverNow, data.store.timezone])
  const sortedProducts = useMemo(() => [...data.products].sort((left, right) => (left.sortOrder ?? 999) - (right.sortOrder ?? 999) || left.name.localeCompare(right.name, 'zh-CN')), [data.products])
  const visibleProducts = useMemo(() => sortedProducts.filter((product) => {
    const keyword = search.trim().toLowerCase()
    const state = productStates.get(product.id)?.state
    if (keyword && ![product.name, product.sku, product.categoryName, product.description, ...(product.tags ?? [])].filter(Boolean).some((value) => String(value).toLowerCase().includes(keyword))) return false
    if (statusFilter === 'timed' && !(product.availableFrom && product.availableUntil)) return false
    if (statusFilter !== 'all' && statusFilter !== 'timed' && state !== statusFilter) return false
    if (categoryFilter !== 'all' && (product.categoryId ?? 'featured') !== categoryFilter) return false
    if (stationFilter !== 'all' && product.stationId !== stationFilter) return false
    return true
  }), [categoryFilter, productStates, search, sortedProducts, stationFilter, statusFilter])

  const counts = useMemo(() => ({
    available: data.products.filter((product) => productStates.get(product.id)?.state === 'available').length,
    soldOut: data.products.filter((product) => productStates.get(product.id)?.state === 'sold_out').length,
    hidden: data.products.filter((product) => productStates.get(product.id)?.state === 'hidden').length,
    timed: data.products.filter((product) => product.availableFrom && product.availableUntil).length,
  }), [data.products, productStates])

  useEffect(() => {
    if (!workstations.some((station) => station.id === stationId && station.enabled)) {
      setStationId(workstations.find((station) => station.enabled)?.id ?? '')
    }
  }, [stationId, workstations])

  async function submit(event: FormEvent) {
    event.preventDefault()
    await run(() => createProductRequest({
      sku, name, specification: '1份', categoryId, categoryName: categories.find(([id]) => id === categoryId)?.[1] ?? '推荐', description: '', imageUrl: '', tags: [], sortOrder: data.products.length + 1, listPriceAmount: yuanToFen(price), costAmount: 0,
      stationId, enabled: true, soldOut: false, soldOutReason: '', availableFrom: null, availableUntil: null,
    }), `${name}已建立`)
    setSku('')
    setName('')
  }

  return (
    <div className="master-section product-operations">
      <div className="product-ops-summary" aria-label="商品经营状态">
        <button type="button" className={statusFilter === 'available' ? 'is-active' : ''} onClick={() => setStatusFilter(statusFilter === 'available' ? 'all' : 'available')}><CheckCircle2 size={18} /><span>当前可售</span><strong>{counts.available}</strong></button>
        <button type="button" className={statusFilter === 'sold_out' ? 'is-active' : ''} onClick={() => setStatusFilter(statusFilter === 'sold_out' ? 'all' : 'sold_out')}><CircleOff size={18} /><span>临时售罄</span><strong>{counts.soldOut}</strong></button>
        <button type="button" className={statusFilter === 'hidden' ? 'is-active' : ''} onClick={() => setStatusFilter(statusFilter === 'hidden' ? 'all' : 'hidden')}><EyeOff size={18} /><span>菜单隐藏</span><strong>{counts.hidden}</strong></button>
        <button type="button" className={statusFilter === 'timed' ? 'is-active' : ''} onClick={() => setStatusFilter(statusFilter === 'timed' ? 'all' : 'timed')}><Clock3 size={18} /><span>限时供应</span><strong>{counts.timed}</strong></button>
      </div>

      <form className="product-create" onSubmit={(event) => void submit(event)}>
        <label><span>SKU</span><input value={sku} onChange={(event) => setSku(event.target.value)} /></label>
        <label><span>商品名称</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label><span>标价（元）</span><input type="number" min={0} value={price} onChange={(event) => setPrice(Number(event.target.value))} /></label>
        <label><span>菜单分类</span><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>{categories.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label><span>出品口</span><select value={stationId} onChange={(event) => setStationId(event.target.value)}>{workstations.filter((station) => station.enabled).map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}</select></label>
        <button className="primary-button" type="submit" disabled={!sku.trim() || !name.trim() || !stationId}><Plus size={17} />新增商品</button>
      </form>

      <div className="product-toolbar">
        <label className="product-search"><Search size={17} /><input aria-label="搜索商品" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、SKU、标签" /></label>
        <select aria-label="按分类筛选" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">全部分类</option>{categories.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        <select aria-label="按出品口筛选" value={stationFilter} onChange={(event) => setStationFilter(event.target.value)}><option value="all">全部出品口</option>{workstations.map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}</select>
        <span className="product-result-count">显示 {visibleProducts.length} / {data.products.length}</span>
      </div>

      {visibleProducts.length > 0 ? <div className="product-control-grid">{visibleProducts.map((product) => <ProductControlCard key={product.id} product={product} availability={productStates.get(product.id)} workstations={workstations} run={run} onEdit={() => setEditingProductId(product.id)} />)}</div> : <div className="product-empty">没有符合当前条件的商品</div>}
      {editingProductId && <ProductEditor product={data.products.find((product) => product.id === editingProductId)!} workstations={workstations} canManageCosts={canManageCosts} run={run} onClose={() => setEditingProductId(null)} />}
    </div>
  )
}

function ProductControlCard({ product, availability, workstations, run, onEdit }: { product: MenuProduct; availability?: ReturnType<typeof productAvailability>; workstations: WorkstationConfig[]; run: RunAction; onEdit: () => void }) {
  const stationName = workstations.find((station) => station.id === product.stationId)?.name ?? product.stationId
  const draft = toProductDraft(product)
  const restore = () => run(() => updateProductRequest(product.id, { ...draft, enabled: true, soldOut: false, soldOutReason: '' }), `${product.name}已恢复供应`)
  const markSoldOut = () => run(() => updateProductRequest(product.id, { ...draft, enabled: true, soldOut: true, soldOutReason: '现场售罄' }), `${product.name}已标记售罄`)
  const hide = () => run(() => updateProductRequest(product.id, { ...draft, enabled: false }), `${product.name}已从菜单隐藏`)

  return (
    <article className={`product-control-card status-${availability?.state ?? 'available'}`}>
      <div className="product-card-media">{product.imageUrl ? <img src={product.imageUrl} alt="" /> : <span>{Array.from(product.name)[0]}</span>}</div>
      <div className="product-card-content">
        <div className="product-card-heading"><strong>{product.name}</strong><span className="product-state-badge">{availability?.label ?? '可下单'}</span></div>
        <span className="product-card-code">{product.sku} · {product.categoryName ?? '推荐'} · 版本 {product.configVersion}</span>
        <div className="product-card-facts"><strong>¥{fenToYuan(product.listPriceAmount).toFixed(2)}</strong><span>{stationName}</span>{product.availableFrom && product.availableUntil ? <span><Clock3 size={13} />{product.availableFrom}-{product.availableUntil}</span> : <span>全时段</span>}</div>
        {(product.tags?.length ?? 0) > 0 && <div className="product-card-tags">{product.tags?.map((tag) => <span key={tag}>{tag}</span>)}</div>}
      </div>
      <div className="product-card-actions">
        {availability?.state === 'available' || availability?.state === 'scheduled' ? <button type="button" className="icon-button danger-action" title="临时售罄" onClick={() => void markSoldOut()}><CircleOff size={17} /></button> : <button type="button" className="icon-button restore-action" title="恢复供应" onClick={() => void restore()}><RotateCcw size={17} /></button>}
        {availability?.state !== 'hidden' && <button type="button" className="icon-button" title="从客人菜单隐藏" onClick={() => void hide()}><EyeOff size={17} /></button>}
        <button type="button" className="icon-button" title="编辑商品" onClick={onEdit}><Pencil size={17} /></button>
      </div>
    </article>
  )
}

function ProductEditor({ product, workstations, canManageCosts, run, onClose }: { product: MenuProduct; workstations: WorkstationConfig[]; canManageCosts: boolean; run: RunAction; onClose: () => void }) {
  const [draft, setDraft] = useState<ProductWriteInput>(() => toProductDraft(product))
  const [tagsText, setTagsText] = useState(() => (product.tags ?? []).join('、'))

  async function save(event: FormEvent) {
    event.preventDefault()
    const tags = tagsText.split(/[、,，]/).map((tag) => tag.trim()).filter(Boolean)
    const saved = await run(() => updateProductRequest(product.id, { ...draft, tags: [...new Set(tags)].slice(0, 8) }), `${draft.name}已保存`)
    if (saved) onClose()
  }

  function setStatus(status: 'available' | 'sold_out' | 'hidden') {
    if (status === 'available') setDraft({ ...draft, enabled: true, soldOut: false, soldOutReason: '' })
    if (status === 'sold_out') setDraft({ ...draft, enabled: true, soldOut: true, soldOutReason: draft.soldOutReason || '暂时售罄' })
    if (status === 'hidden') setDraft({ ...draft, enabled: false })
  }

  const status = !draft.enabled ? 'hidden' : draft.soldOut ? 'sold_out' : 'available'
  return (
    <div className="product-editor-backdrop" role="presentation">
      <form className="product-editor" role="dialog" aria-modal="true" aria-labelledby="product-editor-title" onSubmit={(event) => void save(event)}>
        <header><div><span className="eyebrow">商品配置</span><h3 id="product-editor-title">{product.name}</h3></div><button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button></header>
        <div className="product-editor-status" aria-label="商品状态">
          <button type="button" aria-pressed={status === 'available'} onClick={() => setStatus('available')}><CheckCircle2 size={17} />正常供应</button>
          <button type="button" aria-pressed={status === 'sold_out'} onClick={() => setStatus('sold_out')}><CircleOff size={17} />临时售罄</button>
          <button type="button" aria-pressed={status === 'hidden'} onClick={() => setStatus('hidden')}><EyeOff size={17} />菜单隐藏</button>
        </div>
        <div className="product-editor-body">
          <aside className="product-image-preview">{draft.imageUrl ? <img src={draft.imageUrl} alt={`${draft.name}预览`} /> : <span>{Array.from(draft.name || '商')[0]}</span>}<small>客人菜单图片预览</small></aside>
          <div className="product-editor-fields">
            <label><span>SKU</span><input required value={draft.sku} onChange={(event) => setDraft({ ...draft, sku: event.target.value })} /></label>
            <label><span>商品名称</span><input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label><span>规格</span><input required value={draft.specification} onChange={(event) => setDraft({ ...draft, specification: event.target.value })} /></label>
            <label><span>分类编码</span><input required value={draft.categoryId ?? ''} onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })} /></label>
            <label><span>分类名称</span><input required value={draft.categoryName ?? ''} onChange={(event) => setDraft({ ...draft, categoryName: event.target.value })} /></label>
            <label><span>标价（元）</span><input type="number" min={0} step="0.01" required value={fenToYuan(draft.listPriceAmount)} onChange={(event) => setDraft({ ...draft, listPriceAmount: yuanToFen(Number(event.target.value)) })} /></label>
            {canManageCosts ? <label><span>成本（元）</span><input type="number" min={0} step="0.01" required value={fenToYuan(draft.costAmount)} onChange={(event) => setDraft({ ...draft, costAmount: yuanToFen(Number(event.target.value)) })} /></label> : <label><span>成本（财务权限）</span><input value="已保护，不会修改" disabled /></label>}
            <label><span>出品口</span><select value={draft.stationId} onChange={(event) => setDraft({ ...draft, stationId: event.target.value })}>{!workstations.some((station) => station.id === draft.stationId) && <option value={draft.stationId}>{draft.stationId}（旧配置）</option>}{workstations.map((station) => <option key={station.id} value={station.id}>{station.name}{station.enabled ? '' : '（停用）'}</option>)}</select></label>
            <label><span>菜单排序</span><input type="number" min={0} max={9999} value={draft.sortOrder ?? 999} onChange={(event) => setDraft({ ...draft, sortOrder: Number(event.target.value) })} /></label>
            <label><span>供应开始</span><input type="time" value={draft.availableFrom ?? ''} onChange={(event) => setDraft({ ...draft, availableFrom: event.target.value || null })} /></label>
            <label><span>供应结束</span><input type="time" value={draft.availableUntil ?? ''} onChange={(event) => setDraft({ ...draft, availableUntil: event.target.value || null })} /></label>
            <label className="wide-field"><span>图片地址</span><input value={draft.imageUrl ?? ''} onChange={(event) => setDraft({ ...draft, imageUrl: event.target.value })} placeholder="/menu/product.jpg 或 HTTPS 地址" /></label>
            <label className="wide-field"><span>标签（顿号或逗号分隔，最多8个）</span><input value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="招牌、低度、适合分享" /></label>
            <label className="wide-field"><span>菜单描述</span><textarea maxLength={240} value={draft.description ?? ''} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
            {status === 'sold_out' && <label className="wide-field"><span>售罄原因（客人可见）</span><input maxLength={80} value={draft.soldOutReason ?? ''} onChange={(event) => setDraft({ ...draft, soldOutReason: event.target.value })} placeholder="例如：今晚原料已售完" /></label>}
          </div>
        </div>
        <footer><span>{draft.availableFrom && draft.availableUntil ? `每日 ${draft.availableFrom}-${draft.availableUntil} 供应，支持跨午夜` : canManageCosts ? '未设置时段，营业期间均可供应' : '未设置时段，营业期间均可供应；成本受财务权限保护'}</span><div><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" type="submit"><Save size={17} />保存商品</button></div></footer>
      </form>
    </div>
  )
}

function toProductDraft(product: MenuProduct): ProductWriteInput {
  return {
    sku: product.sku,
    name: product.name,
    specification: product.specification,
    categoryId: product.categoryId ?? 'featured',
    categoryName: product.categoryName ?? '推荐',
    description: product.description ?? '',
    imageUrl: product.imageUrl ?? '',
    tags: product.tags ?? [],
    sortOrder: product.sortOrder ?? 999,
    soldOut: product.soldOut ?? false,
    soldOutReason: product.soldOutReason ?? '',
    availableFrom: product.availableFrom ?? null,
    availableUntil: product.availableUntil ?? null,
    listPriceAmount: product.listPriceAmount,
    costAmount: product.costAmount,
    stationId: product.stationId,
    enabled: product.enabled,
  }
}

function AreaRow({ area, run }: { area: Area; run: RunAction }) {
  const [draft, setDraft] = useState(area)
  useEffect(() => setDraft(area), [area])
  return (
    <div className="master-row area-config-row">
      <label className="color-field"><span>颜色</span><input type="color" value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></label>
      <label><span>区域名称</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label><span>简称</span><input value={draft.shortName} onChange={(event) => setDraft({ ...draft, shortName: event.target.value })} /></label>
      <label><span>排序</span><input type="number" min={1} max={999} value={draft.sortOrder} onChange={(event) => setDraft({ ...draft, sortOrder: Number(event.target.value) })} /></label>
      <button className="icon-button" title={`保存${area.name}`} onClick={() => void run(() => updateAreaRequest(area.id, { name: draft.name, shortName: draft.shortName, color: draft.color, sortOrder: draft.sortOrder }), `${draft.name}已保存`)}><Save size={17} /></button>
    </div>
  )
}

interface SectionProps { data: BootstrapResponse; run: RunAction }
type RunAction = (action: () => Promise<unknown>, success: string) => Promise<boolean>

function effectiveConfig(data: BootstrapResponse) {
  return data.draftConfig ?? data.config
}

function configDraftPayload(
  source: BootstrapResponse['config'],
  roles: RoleConfig[],
  skills: SkillConfig[],
  workstations: WorkstationConfig[],
): ConfigDraftInput {
  return {
    serviceTypes: source.serviceTypes.map((type) => ({
      id: type.id,
      enabled: type.enabled,
      guestVisible: type.guestVisible,
      priority: type.priority,
      dispatchRoleIds: [...type.dispatchRoleIds],
      customerReply: type.customerReply,
      actionScript: [...type.actionScript],
      sla: { ...type.sla },
    })),
    roles: roles.map((role) => ({
      id: role.id,
      name: role.name,
      maxConcurrentTasks: role.maxConcurrentTasks,
      canReceiveTasks: role.canReceiveTasks,
      permissionIds: role.permissionIds,
      dataScope: role.dataScope,
      approvalLimits: role.approvalLimits,
    })),
    skills: structuredClone(skills),
    workstations: structuredClone(workstations),
    proactiveOrderCare: { ...source.proactiveOrderCare },
    guestServiceLimits: { ...source.guestServiceLimits },
    communityBrand: structuredClone(source.communityBrand),
  }
}

function toggleValue(values: string[], value: string, checked: boolean) {
  return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value)
}

function toLocalInput(iso: string) {
  return chinaDateTimeLocalValue(iso)
}

function yuanToFen(amount: number) { return Math.round(amount * 100) }
function fenToYuan(amount: number) { return amount / 100 }
