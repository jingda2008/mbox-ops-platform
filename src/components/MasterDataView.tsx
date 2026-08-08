/* oxlint-disable react/only-export-components -- scoped workflow helpers stay colocated for direct view tests. */
import { ArrowDown, ArrowUp, BadgeDollarSign, CalendarClock, CheckCircle2, CircleOff, Clock3, EyeOff, GlassWater, ListChecks, MapPinned, Minus, Pencil, Plus, RotateCcw, Route, Save, Search, ShieldAlert, TableProperties, UserRoundCog, X } from 'lucide-react'
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
  MenuBeverageFamily,
  MenuProduct,
  ProductWriteInput,
  RoleConfig,
  RoleDataScope,
  ServiceWorkflowLevel,
  ServiceTypeConfig,
  StaffPermissionId,
  ShiftAssignment,
  ShiftWriteInput,
  SkillConfig,
  Table,
  WorkstationConfig,
} from '../shared/contracts'
import type { StaffNavigationId } from '../shared/staff-navigation'
import {
  menuBeverageFamilies,
  menuRecommendationDwells,
  menuRecommendationIntents,
  menuRecommendationScenes,
  menuRecommendationTastes,
  staffPermissionIds,
} from '../shared/contracts'
import { navigationForStaffPermissions } from '../shared/staff-navigation'
import type { AuthorityWriteInput } from '../shared/commerce-api'
import type { OrderAuthorizationAuthority } from '../shared/order-contracts'
import { productAvailability } from '../shared/product-availability'
import { chinaDateTimeLocalValue, chinaLocalDateTimeToIso, shiftDateKey } from '../shared/china-time'
import './MasterDataView.css'

type MasterView = 'employees' | 'shifts' | 'tables' | 'products' | 'services' | 'routing' | 'authorities' | 'areas'

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
  { id: 'services', label: '服务配置', icon: ListChecks },
  { id: 'routing', label: '岗位/高频入口', icon: Route },
  { id: 'authorities', label: '经营权限', icon: BadgeDollarSign },
  { id: 'areas', label: '区域', icon: MapPinned },
]

const permissionLabels: Record<StaffPermissionId, string> = {
  'dashboard.view': '现场看板', 'finance.view': '财务数据', 'finance.manage': '经营成本管理', 'audit.view': '审计记录',
  'config.manage': '系统配置', 'identity.manage': '账号权限', 'master_data.manage': '主数据',
  'shift.manage': '排班调度', 'table.open': '开台接客', 'table.manage': '桌台管理', 'table.close': '结台清台', 'business_day.close': '营业日关账', 'reservation.view': '查看预约',
  'reservation.manage': '预约接待', 'reservation.config.manage': '预约规则',
  'service.execute': '执行服务', 'complaint.handle': '处理投诉', 'order.create': '创建订单',
  'order.view': '查看订单', 'kds.prepare': '出品制作', 'kds.deliver': '取送确认',
  'payment.collect': '发起收款', 'payment.pos_report': 'POS报送',
  'payment.refund.request': '申请退款', 'payment.refund.approve': '批准退款',
  'commerce.authorization.request': '申请赠送折扣',
  'commerce.authorization.approve': '批准赠送折扣', 'inventory.view': '查看库存',
  'inventory.manage': '岗位库存操作', 'inventory.receive': '个人入库登记',
  'inventory.count': '个人盘点', 'inventory.remake': '个人补做耗用',
  'inventory.bottle': '个人存酒操作', 'inventory.approve': '库存审批', 'benefit.view': '查看权益',
  'benefit.grant': '发放权益', 'benefit.approve': '审批权益', 'song.view': '查看演出',
  'benefit.manage': '管理权益规则',
  'song.manage': '管理点歌',
  'hardware.view': '查看设备', 'hardware.operate': '执行设备测试', 'hardware.manage': '管理设备配置',
  'store_import.apply': '应用整店导入',
}

const scopeLabels: Record<RoleDataScope, string> = {
  own: '本人任务', assigned_areas: '负责区域', store: '本门店', all_stores: '全部门店',
}

const staffNavigationLabels: Record<StaffNavigationId, string> = {
  live: '现场调度',
  tasks: '任务',
  reservations: '预约',
  commerce: '订单与出品',
  inventory: '库存/存酒',
  payments: '收银与退款',
  benefits: '会员权益',
  operations: '经营工具',
  devices: '设备状态',
  songs: '演出与点歌',
  layout: '布局',
  master: '主数据',
  config: '运营配置',
}

export interface WorkflowServiceTypeConfig extends ServiceTypeConfig {
  workflowLevel: ServiceWorkflowLevel
  allowBackupDirectComplete: boolean
  allowCrossAreaComplete: boolean
  requiresCompletionNote: boolean
  duplicateSeconds: number
}

const workflowLevelMeta: Record<ServiceWorkflowLevel, { name: string; summary: string }> = {
  L0: { name: '信息提示', summary: '只展示客情，无需员工操作' },
  L1: { name: '快速服务', summary: '处理后一次点击完成' },
  L2: { name: '责任任务', summary: '接管后完成，保留责任人' },
  L3: { name: '受控事务', summary: '高风险处理，保留说明与审计' },
}

const workflowLevels = Object.keys(workflowLevelMeta) as ServiceWorkflowLevel[]
const lockedHighRiskServiceCodes = new Set(['COMPLAINT', 'REQUEST_BILL'])

export function normalizeWorkflowServiceType(type: ServiceTypeConfig): WorkflowServiceTypeConfig {
  const candidate = type
  const fallbackLevel: ServiceWorkflowLevel = lockedHighRiskServiceCodes.has(type.code)
    ? 'L3'
    : ['ADD_WATER', 'ADD_ICE_LEMON', 'FULFILLMENT_DELIVERY'].includes(type.code) ? 'L1' : 'L2'
  const workflowLevel = workflowLevels.includes(candidate.workflowLevel as ServiceWorkflowLevel)
    ? candidate.workflowLevel as ServiceWorkflowLevel
    : fallbackLevel
  const lockedLevel = lockedHighRiskServiceCodes.has(type.code) ? 'L3' : workflowLevel

  return {
    ...type,
    workflowLevel: lockedLevel,
    allowBackupDirectComplete: lockedLevel === 'L3' || lockedLevel === 'L0'
      ? false
      : candidate.allowBackupDirectComplete ?? lockedLevel === 'L1',
    allowCrossAreaComplete: lockedLevel === 'L3' || lockedLevel === 'L0'
      ? false
      : candidate.allowCrossAreaComplete ?? lockedLevel === 'L1',
    requiresCompletionNote: lockedLevel === 'L3'
      ? true
      : lockedLevel === 'L0' ? false : candidate.requiresCompletionNote ?? false,
    duplicateSeconds: Math.max(0, Math.min(3600, Math.round(candidate.duplicateSeconds ?? 30))),
  }
}

export function isWorkflowLevelOptionDisabled(
  type: WorkflowServiceTypeConfig,
  level: ServiceWorkflowLevel,
  lockedHighRisk = lockedHighRiskServiceCodes.has(type.code),
) {
  return lockedHighRisk && level !== 'L3'
}

export function changeWorkflowLevel(
  type: WorkflowServiceTypeConfig,
  level: ServiceWorkflowLevel,
  lockedHighRisk = lockedHighRiskServiceCodes.has(type.code),
) {
  if (isWorkflowLevelOptionDisabled(type, level, lockedHighRisk)) return type
  return normalizeWorkflowServiceType({ ...type, workflowLevel: level })
}

export function serviceTypeDraftInput(type: WorkflowServiceTypeConfig) {
  return {
    id: type.id,
    enabled: type.enabled,
    guestVisible: type.guestVisible,
    priority: type.priority,
    dispatchRoleIds: [...type.dispatchRoleIds],
    customerReply: type.customerReply,
    actionScript: [...type.actionScript],
    sla: { ...type.sla },
    workflowLevel: type.workflowLevel,
    allowBackupDirectComplete: type.allowBackupDirectComplete,
    allowCrossAreaComplete: type.allowCrossAreaComplete,
    requiresCompletionNote: type.requiresCompletionNote,
    duplicateSeconds: type.duplicateSeconds,
  }
}

type RecommendationDraft = NonNullable<ProductWriteInput['recommendation']>
type RecommendationArrayField = 'sceneTags' | 'intentTags' | 'tasteTags' | 'dwellTags'

const beverageFamilyLabels = {
  none: '非酒水 / 未分类',
  cocktail: '鸡尾酒',
  beer: '啤酒',
  wine: '葡萄酒',
  sparkling: '起泡酒 / 香槟',
  spirits: '洋酒 / 烈酒',
  non_alcoholic: '无酒精',
} satisfies Record<(typeof menuBeverageFamilies)[number], string>

const recommendationSceneLabels = {
  unsure: '还不确定',
  date: '约会',
  brothers: '兄弟',
  besties: '闺蜜',
  friends: '朋友',
  business: '商务',
  celebration: '庆祝',
} satisfies Record<(typeof menuRecommendationScenes)[number], string>

const recommendationIntentLabels = {
  relaxed: '轻松一点',
  energetic: '今晚要嗨',
  ritual: '来点仪式感',
  unsure: '还没想好',
} satisfies Record<(typeof menuRecommendationIntents)[number], string>

const recommendationTasteLabels = {
  refreshing: '清爽',
  layered: '有层次',
  strong: '酒感明显',
  any: '都可以',
} satisfies Record<(typeof menuRecommendationTastes)[number], string>

const recommendationDwellLabels = {
  one_set: '一轮结束',
  stay_longer: '多坐一会',
  no_rush: '不赶时间',
} satisfies Record<(typeof menuRecommendationDwells)[number], string>

function defaultRecommendation(): RecommendationDraft {
  return {
    enabled: false,
    priority: 100,
    badge: '',
    headline: '',
    reason: '',
    minimumPartySize: 1,
    maximumPartySize: 6,
    sceneTags: [],
    intentTags: [],
    tasteTags: [],
    dwellTags: [],
    singleWaveEligible: true,
    expectedPrepMinutes: 8,
    holdMinutes: 10,
    upgradeProductId: null,
  }
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
      {view === 'services' && <ServiceConfigSection data={data} run={run} />}
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
  const availableNavigationIds = employeeNavigationIds(data, draft)

  function updateAccess(update: Partial<EmployeeWriteInput>) {
    const next = { ...draft, ...update }
    const allowed = employeeNavigationIds(data, next)
    const primaryNavigationIds = next.primaryNavigationIds?.filter((id) => allowed.includes(id))
    setDraft({
      ...next,
      primaryNavigationIds: primaryNavigationIds?.length ? primaryNavigationIds : undefined,
    })
  }

  return (
    <div className="master-row employee-row">
      <label><span>姓名</span><input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
      <label><span>岗位</span><select value={draft.roleId} onChange={(event) => updateAccess({ roleId: event.target.value })}>{data.config.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
      <details className="employee-access-details">
        <summary>岗位、权限与入口 <span>{draft.roleIds?.length ?? 0}个兼任 · {draft.primaryNavigationIds?.length ? `${draft.primaryNavigationIds.length}个个人入口` : '跟随岗位'}</span></summary>
        <div className="area-selector"><span>兼任岗位</span><div>{data.config.roles.map((role) => <label key={role.id}><input type="checkbox" checked={[draft.roleId, ...(draft.roleIds ?? [])].includes(role.id)} disabled={role.id === draft.roleId} onChange={(event) => updateAccess({ roleIds: toggleValue(draft.roleIds ?? [], role.id, event.target.checked) })} />{role.name}</label>)}</div></div>
        <div className="area-selector"><span>个人权限</span><div>{staffPermissionIds.map((permissionId) => <label key={permissionId}><input type="checkbox" checked={draft.permissionIds?.includes(permissionId) ?? false} onChange={(event) => updateAccess({ permissionIds: toggleValue(draft.permissionIds ?? [], permissionId, event.target.checked) as StaffPermissionId[] })} />{permissionLabels[permissionId]}</label>)}</div></div>
        <PrimaryNavigationField
          label="个人高频入口"
          availableIds={availableNavigationIds}
          selected={draft.primaryNavigationIds}
          onChange={(primaryNavigationIds) => setDraft({ ...draft, primaryNavigationIds })}
        />
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

function ServiceConfigSection({ data, run }: SectionProps) {
  const source = effectiveConfig(data)
  const lockedHighRiskServiceIds = useMemo(() => new Set(
    source.serviceTypes
      .filter((type) => (
        lockedHighRiskServiceCodes.has(type.code)
        || type.workflowLevel === 'L3'
      ))
      .map((type) => type.id),
  ), [source.serviceTypes])
  const [serviceTypes, setServiceTypes] = useState<WorkflowServiceTypeConfig[]>(
    () => source.serviceTypes.map(normalizeWorkflowServiceType),
  )

  useEffect(() => {
    setServiceTypes(source.serviceTypes.map(normalizeWorkflowServiceType))
  }, [source.serviceTypes])

  function updateServiceType(id: string, update: Partial<WorkflowServiceTypeConfig>) {
    setServiceTypes((current) => current.map((type) => (
      type.id === id ? normalizeWorkflowServiceType({ ...type, ...update }) : type
    )))
  }

  async function saveServiceConfig() {
    await run(
      () => saveConfigDraft(configDraftPayload(
        source,
        source.roles,
        source.skills,
        source.workstations,
        serviceTypes,
      )),
      '服务流程分级已保存到配置草稿',
    )
  }

  return (
    <div className="master-section service-config-section">
      <header className="service-config-intro">
        <div>
          <span className="eyebrow">运营规则 / 服务配置</span>
          <h3>现场服务流程分级</h3>
          <p>按服务风险决定员工点击步骤。快速服务减少操作，高风险事务保留责任与审计。</p>
        </div>
        <span className="count-chip">{serviceTypes.length} 项服务</span>
      </header>

      <div className="workflow-level-guide" aria-label="四级服务流程说明">
        {workflowLevels.map((level) => (
          <div key={level} data-level={level}>
            <strong>{level} · {workflowLevelMeta[level].name}</strong>
            <span>{workflowLevelMeta[level].summary}</span>
          </div>
        ))}
      </div>

      <div className="service-config-list">
        {serviceTypes.map((type) => {
          const lockedHighRisk = lockedHighRiskServiceIds.has(type.id)
          const actionControlsDisabled = type.workflowLevel === 'L0' || type.workflowLevel === 'L3'
          return (
            <article className={`service-config-card workflow-${type.workflowLevel.toLowerCase()}`} key={type.id}>
              <div className="service-config-identity">
                <span className="workflow-level-badge">{type.workflowLevel}</span>
                <div>
                  <strong>{type.name}</strong>
                  <span>{type.code}</span>
                </div>
                {lockedHighRisk && <span className="service-risk-lock"><ShieldAlert size={14} />高风险锁定</span>}
              </div>

              <div className="service-config-controls">
                <label className="service-level-field">
                  <span>流程等级</span>
                  <select
                    aria-label={`${type.name}流程等级`}
                    value={type.workflowLevel}
                    onChange={(event) => {
                      const level = event.target.value as ServiceWorkflowLevel
                      setServiceTypes((current) => current.map((item) => (
                        item.id === type.id ? changeWorkflowLevel(item, level, lockedHighRisk) : item
                      )))
                    }}
                  >
                    {workflowLevels.map((level) => (
                      <option
                        key={level}
                        value={level}
                        disabled={isWorkflowLevelOptionDisabled(type, level, lockedHighRisk)}
                      >
                        {level} · {workflowLevelMeta[level].name}
                      </option>
                    ))}
                  </select>
                  {lockedHighRisk && <small>投诉、买单等受控事务不能降级，避免丢失处理记录。</small>}
                </label>

                <label className="service-number-field">
                  <span>同类合并</span>
                  <span className="number-with-unit">
                    <input
                      aria-label={`${type.name}同类合并秒数`}
                      type="number"
                      min={0}
                      max={3600}
                      step={5}
                      value={type.duplicateSeconds}
                      onChange={(event) => updateServiceType(type.id, { duplicateSeconds: Number(event.target.value) })}
                    />
                    <em>秒</em>
                  </span>
                  <small>0 表示不合并</small>
                </label>

                <div className="service-switches">
                  <label>
                    <input
                      type="checkbox"
                      checked={type.allowBackupDirectComplete}
                      disabled={actionControlsDisabled}
                      onChange={(event) => updateServiceType(type.id, { allowBackupDirectComplete: event.target.checked })}
                    />
                    <span><strong>候补直接完成</strong><small>无需先认领</small></span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={type.allowCrossAreaComplete}
                      disabled={actionControlsDisabled}
                      onChange={(event) => updateServiceType(type.id, { allowCrossAreaComplete: event.target.checked })}
                    />
                    <span><strong>允许跨区处理</strong><small>其他区域可补位</small></span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={type.requiresCompletionNote}
                      disabled={type.workflowLevel === 'L0' || type.workflowLevel === 'L3'}
                      onChange={(event) => updateServiceType(type.id, { requiresCompletionNote: event.target.checked })}
                    />
                    <span><strong>完成需要说明</strong><small>{type.workflowLevel === 'L3' ? '高风险强制留痕' : '完成时填写结果'}</small></span>
                  </label>
                </div>
              </div>
            </article>
          )
        })}
      </div>

      <div className="routing-savebar service-config-savebar">
        <span>{data.draftConfig ? '当前修改将更新未发布配置草稿' : `基于已发布配置 V${data.config.version}`}</span>
        <button className="primary-button" onClick={() => void saveServiceConfig()}>
          <Save size={17} />保存配置草稿
        </button>
      </div>
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
    setRoles(roles.map((role) => {
      if (role.id !== id) return role
      const next = { ...role, ...update }
      if (!update.permissionIds) return next
      const allowed = navigationForStaffPermissions(update.permissionIds)
      const primaryNavigationIds = next.primaryNavigationIds?.filter((navigationId) => allowed.includes(navigationId))
      return { ...next, primaryNavigationIds: primaryNavigationIds?.length ? primaryNavigationIds : undefined }
    }))
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
              <PrimaryNavigationField
                label="岗位高频入口"
                availableIds={navigationForStaffPermissions(role.permissionIds ?? [])}
                selected={role.primaryNavigationIds}
                onChange={(primaryNavigationIds) => updateRole(role.id, { primaryNavigationIds })}
              />
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

function PrimaryNavigationField({
  label,
  availableIds,
  selected,
  onChange,
}: {
  label: string
  availableIds: StaffNavigationId[]
  selected: StaffNavigationId[] | undefined
  onChange: (ids: StaffNavigationId[] | undefined) => void
}) {
  const selectedIds = selected ?? []
  return (
    <div className="primary-navigation-field">
      <div className="primary-navigation-field__heading">
        <span>{label}</span>
        <small>{selected ? `已选${selected.length}/4` : '未覆盖，自动跟随岗位'}</small>
        {selected && <button type="button" onClick={() => onChange(undefined)}><RotateCcw size={13} />恢复默认</button>}
      </div>
      <div>
        {availableIds.map((navigationId) => {
          const checked = selectedIds.includes(navigationId)
          return (
            <label key={navigationId}>
              <input
                type="checkbox"
                checked={checked}
                disabled={!checked && selectedIds.length >= 4}
                onChange={(event) => {
                  const next = toggleValue(selectedIds, navigationId, event.target.checked) as StaffNavigationId[]
                  onChange(next.length > 0 ? next : undefined)
                }}
              />
              {staffNavigationLabels[navigationId]}
            </label>
          )
        })}
        {availableIds.length === 0 && <span className="primary-navigation-field__empty">请先配置该岗位的功能权限</span>}
      </div>
      {selected && (
        <ol className="primary-navigation-order" aria-label={`${label}显示顺序`}>
          {selected.map((navigationId, index) => (
            <li key={navigationId}>
              <b>{index + 1}</b>
              <span>{staffNavigationLabels[navigationId]}</span>
              <button
                type="button"
                title={`${staffNavigationLabels[navigationId]}前移`}
                disabled={index === 0}
                onClick={() => onChange(moveItem(selected, index, index - 1))}
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                title={`${staffNavigationLabels[navigationId]}后移`}
                disabled={index === selected.length - 1}
                onClick={() => onChange(moveItem(selected, index, index + 1))}
              >
                <ArrowDown size={14} />
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
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
      allowedCategoryIds: null,
      tableSessionIds: null,
      maxPerTableAmount: null,
      maxPerShiftAmount: null,
      maxPerBusinessDayAmount: null,
      maxPerMonthAmount: null,
      maxPerBusinessDayCount: null,
      maxQuantityPerOrder: null,
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
      <div className="authority-note">权限按员工、类型、金额、商品、桌次和有效时间共同判断；累计额度与次数用于赠送，所有修改进入审计。</div>
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
    allowedCategoryIds: value.allowedCategoryIds ?? null,
    tableSessionIds: value.tableSessionIds,
    maxPerTableAmount: value.maxPerTableAmount ?? null,
    maxPerShiftAmount: value.maxPerShiftAmount ?? null,
    maxPerBusinessDayAmount: value.maxPerBusinessDayAmount ?? null,
    maxPerMonthAmount: value.maxPerMonthAmount ?? null,
    maxPerBusinessDayCount: value.maxPerBusinessDayCount ?? null,
    maxQuantityPerOrder: value.maxQuantityPerOrder ?? null,
    validFrom: value.validFrom,
    validUntil: value.validUntil,
  })
  const [draft, setDraft] = useState<AuthorityWriteInput>(() => toDraft(authority))
  useEffect(() => setDraft(toDraft(authority)), [authority])
  const employee = data.employees.find((item) => item.id === draft.actorId)
  const categories = Array.from(new Map(data.products.map((product) => [
    product.categoryId ?? 'featured',
    product.categoryName ?? '推荐',
  ])).entries()).map(([id, name]) => ({ id, name }))
  const openSessions = data.songState.tableSessions.filter((session) => session.status === 'open')
  const unrestrictedProducts = draft.allowedSkuIds === null && draft.allowedCategoryIds === null
  const unrestrictedTables = draft.tableSessionIds === null

  function toggleKind(kind: 'gift' | 'discount', checked: boolean) {
    setDraft({ ...draft, kinds: checked ? Array.from(new Set([...draft.kinds, kind])) : draft.kinds.filter((item) => item !== kind) })
  }

  function toggleProduct(productId: string, checked: boolean) {
    const current = draft.allowedSkuIds ?? []
    setDraft({ ...draft, allowedSkuIds: checked ? Array.from(new Set([...current, productId])) : current.filter((id) => id !== productId) })
  }

  function toggleCategory(categoryId: string, checked: boolean) {
    const current = draft.allowedCategoryIds ?? []
    setDraft({ ...draft, allowedCategoryIds: checked ? Array.from(new Set([...current, categoryId])) : current.filter((id) => id !== categoryId) })
  }

  function toggleTableSession(tableSessionId: string, checked: boolean) {
    const current = draft.tableSessionIds ?? []
    setDraft({ ...draft, tableSessionIds: checked ? Array.from(new Set([...current, tableSessionId])) : current.filter((id) => id !== tableSessionId) })
  }

  const productScopeEmpty = draft.allowedSkuIds?.length === 0 && draft.allowedCategoryIds?.length === 0
  const tableScopeEmpty = draft.tableSessionIds?.length === 0

  return (
    <div className="master-row authority-row">
      <div className="authority-row-heading">
        <div className="row-identity"><strong>{employee?.displayName ?? '未知员工'}</strong><span>{authority.id}</span></div>
        <button className="icon-button" title={`保存${employee?.displayName ?? ''}经营权限`} disabled={draft.kinds.length === 0 || productScopeEmpty || tableScopeEmpty} onClick={() => void run(() => updateCommerceAuthority(authority.id, draft), '经营权限已保存')}><Save size={17} /></button>
      </div>
      <div className="authority-policy-grid">
        <div className="area-selector"><span>可操作</span><div><label><input type="checkbox" checked={draft.kinds.includes('gift')} onChange={(event) => toggleKind('gift', event.target.checked)} />赠送</label><label><input type="checkbox" checked={draft.kinds.includes('discount')} onChange={(event) => toggleKind('discount', event.target.checked)} />折扣</label></div></div>
        <MoneyLimit label="单次金额上限" value={draft.maxAmount} onChange={(value) => setDraft({ ...draft, maxAmount: value })} />
        <OptionalMoneyLimit label="单桌累计" value={draft.maxPerTableAmount} onChange={(value) => setDraft({ ...draft, maxPerTableAmount: value })} />
        <OptionalMoneyLimit label="班次累计" value={draft.maxPerShiftAmount} onChange={(value) => setDraft({ ...draft, maxPerShiftAmount: value })} />
        <OptionalMoneyLimit label="营业日累计" value={draft.maxPerBusinessDayAmount} onChange={(value) => setDraft({ ...draft, maxPerBusinessDayAmount: value })} />
        <OptionalMoneyLimit label="月度累计" value={draft.maxPerMonthAmount} onChange={(value) => setDraft({ ...draft, maxPerMonthAmount: value })} />
        <OptionalIntegerLimit label="每日次数" value={draft.maxPerBusinessDayCount} onChange={(value) => setDraft({ ...draft, maxPerBusinessDayCount: value })} />
        <OptionalIntegerLimit label="单次数量" value={draft.maxQuantityPerOrder} onChange={(value) => setDraft({ ...draft, maxQuantityPerOrder: value })} />
        <label><span>生效时间（北京时间）</span><input type="datetime-local" value={toLocalInput(draft.validFrom)} onChange={(event) => setDraft({ ...draft, validFrom: chinaLocalDateTimeToIso(event.target.value) })} /></label>
        <label><span>失效时间（北京时间）</span><input type="datetime-local" value={toLocalInput(draft.validUntil)} onChange={(event) => setDraft({ ...draft, validUntil: chinaLocalDateTimeToIso(event.target.value) })} /></label>
      </div>
      <div className="authority-scope-grid">
        <div className="area-selector product-authority"><span>允许商品分类</span><div><label><input type="checkbox" checked={unrestrictedProducts} onChange={(event) => setDraft({ ...draft, allowedSkuIds: event.target.checked ? null : [], allowedCategoryIds: event.target.checked ? null : [] })} />全部商品</label>{categories.map((category) => <label key={category.id}><input type="checkbox" disabled={unrestrictedProducts} checked={draft.allowedCategoryIds?.includes(category.id) ?? false} onChange={(event) => toggleCategory(category.id, event.target.checked)} />{category.name}</label>)}</div></div>
        <div className="area-selector product-authority"><span>指定商品</span><div>{data.products.map((product) => <label key={product.id}><input type="checkbox" disabled={unrestrictedProducts} checked={draft.allowedSkuIds?.includes(product.id) ?? false} onChange={(event) => toggleProduct(product.id, event.target.checked)} />{product.name}</label>)}</div></div>
        <div className="area-selector product-authority"><span>适用桌次</span><div><label><input type="checkbox" checked={unrestrictedTables} onChange={(event) => setDraft({ ...draft, tableSessionIds: event.target.checked ? null : [] })} />全部桌次</label>{openSessions.map((session) => <label key={session.id}><input type="checkbox" disabled={unrestrictedTables} checked={draft.tableSessionIds?.includes(session.id) ?? false} onChange={(event) => toggleTableSession(session.id, event.target.checked)} />{session.tableCode}</label>)}</div></div>
      </div>
    </div>
  )
}

function OptionalMoneyLimit({ label, value, onChange }: { label: string; value: number | null; onChange: (value: number | null) => void }) {
  return <label><span>{label}（元）</span><input type="number" min={0} placeholder="不限制" value={value == null ? '' : fenToYuan(value)} onChange={(event) => onChange(event.target.value === '' ? null : yuanToFen(Number(event.target.value)))} /></label>
}

function OptionalIntegerLimit({ label, value, onChange }: { label: string; value: number | null; onChange: (value: number | null) => void }) {
  return <label><span>{label}</span><input type="number" min={1} step={1} placeholder="不限制" value={value ?? ''} onChange={(event) => onChange(event.target.value === '' ? null : Math.max(1, Number(event.target.value)))} /></label>
}

function ProductSection({ data, run }: SectionProps) {
  const workstations = effectiveConfig(data).workstations
  const canManageCosts = data.viewer?.permissionIds.includes('finance.manage') ?? false
  const categories = useMemo(() => Array.from(new Map(data.products.map((product) => [product.categoryId ?? 'featured', product.categoryName ?? '推荐'])).entries()), [data.products])
  const [sku, setSku] = useState('')
  const [name, setName] = useState('')
  const [price, setPrice] = useState(68)
  const [categoryId, setCategoryId] = useState(categories[0]?.[0] ?? 'featured')
  const [beverageFamily, setBeverageFamily] = useState<MenuBeverageFamily>('none')
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
      guestVisible: true, requiresFulfillment: true, fulfillmentType: 'made_to_order', maxOrderQuantity: 50,
      productKind: 'single', beverageFamily, bundleComponents: [], substitutionProductIds: [],
      recommendation: defaultRecommendation(),
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
        <label><span>菜单分类</span><select value={categoryId} onChange={(event) => {
          setCategoryId(event.target.value)
          if (event.target.value !== 'drinks') setBeverageFamily('none')
        }}>{categories.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        {categoryId === 'drinks' && <label><span>酒水类型</span><select value={beverageFamily} onChange={(event) => setBeverageFamily(event.target.value as MenuBeverageFamily)}><option value="none">请选择</option>{menuBeverageFamilies.filter((family) => family !== 'none').map((family) => <option key={family} value={family}>{beverageFamilyLabels[family]}</option>)}</select></label>}
        <label><span>出品口</span><select value={stationId} onChange={(event) => setStationId(event.target.value)}>{workstations.filter((station) => station.enabled).map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}</select></label>
        <button className="primary-button" type="submit" disabled={!sku.trim() || !name.trim() || !stationId || (categoryId === 'drinks' && beverageFamily === 'none')}><Plus size={17} />新增商品</button>
      </form>

      <div className="product-toolbar">
        <label className="product-search"><Search size={17} /><input aria-label="搜索商品" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、SKU、标签" /></label>
        <select aria-label="按分类筛选" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">全部分类</option>{categories.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        <select aria-label="按出品口筛选" value={stationFilter} onChange={(event) => setStationFilter(event.target.value)}><option value="all">全部出品口</option>{workstations.map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}</select>
        <span className="product-result-count">显示 {visibleProducts.length} / {data.products.length}</span>
      </div>

      {visibleProducts.length > 0 ? <div className="product-control-grid">{visibleProducts.map((product) => <ProductControlCard key={product.id} product={product} availability={productStates.get(product.id)} workstations={workstations} run={run} onEdit={() => setEditingProductId(product.id)} />)}</div> : <div className="product-empty">没有符合当前条件的商品</div>}
      {editingProductId && <ProductEditor product={data.products.find((product) => product.id === editingProductId)!} products={data.products} workstations={workstations} canManageCosts={canManageCosts} run={run} onClose={() => setEditingProductId(null)} />}
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
        {(product.tags ?? []).some((tag) => !/^V\d+\s*组合$/i.test(tag.trim())) && <div className="product-card-tags">{product.tags?.filter((tag) => !/^V\d+\s*组合$/i.test(tag.trim())).map((tag) => <span key={tag}>{tag}</span>)}</div>}
      </div>
      <div className="product-card-actions">
        {availability?.state === 'available' || availability?.state === 'scheduled' ? <button type="button" className="icon-button danger-action" title="临时售罄" onClick={() => void markSoldOut()}><CircleOff size={17} /></button> : <button type="button" className="icon-button restore-action" title="恢复供应" onClick={() => void restore()}><RotateCcw size={17} /></button>}
        {availability?.state !== 'hidden' && <button type="button" className="icon-button" title="从客人菜单隐藏" onClick={() => void hide()}><EyeOff size={17} /></button>}
        <button type="button" className="icon-button" title="编辑商品" onClick={onEdit}><Pencil size={17} /></button>
      </div>
    </article>
  )
}

function ProductEditor({
  product,
  products,
  workstations,
  canManageCosts,
  run,
  onClose,
}: {
  product: MenuProduct
  products: MenuProduct[]
  workstations: WorkstationConfig[]
  canManageCosts: boolean
  run: RunAction
  onClose: () => void
}) {
  const [draft, setDraft] = useState<ProductWriteInput>(() => toProductDraft(product))
  const [tagsText, setTagsText] = useState(() => (product.tags ?? []).join('、'))
  const recommendation = { ...defaultRecommendation(), ...(draft.recommendation ?? {}) }
  const componentCandidates = useMemo(
    () => products.filter((candidate) => candidate.id !== product.id && (candidate.productKind ?? 'single') !== 'bundle'),
    [product.id, products],
  )
  const relationshipCandidates = useMemo(
    () => products.filter((candidate) => candidate.id !== product.id),
    [product.id, products],
  )
  const bundleComponentTotal = useMemo(() => {
    const byId = new Map(products.map((candidate) => [candidate.id, candidate]))
    return (draft.bundleComponents ?? []).reduce((total, component) => (
      total + (byId.get(component.productId)?.listPriceAmount ?? 0) * component.quantity
    ), 0)
  }, [draft.bundleComponents, products])
  const bundleDifference = bundleComponentTotal - draft.listPriceAmount

  async function save(event: FormEvent) {
    event.preventDefault()
    const tags = tagsText.split(/[、,，]/).map((tag) => tag.trim()).filter(Boolean)
    const saved = await run(() => updateProductRequest(product.id, {
      ...draft,
      productKind: draft.productKind ?? 'single',
      beverageFamily: draft.beverageFamily ?? 'none',
      bundleComponents: draft.productKind === 'bundle' ? [...(draft.bundleComponents ?? [])] : [],
      substitutionProductIds: [...new Set(draft.substitutionProductIds ?? [])],
      recommendation: {
        ...recommendation,
        sceneTags: [...new Set(recommendation.sceneTags)],
        intentTags: [...new Set(recommendation.intentTags)],
        tasteTags: [...new Set(recommendation.tasteTags)],
        dwellTags: [...new Set(recommendation.dwellTags)],
      },
      tags: [...new Set(tags)].slice(0, 8),
    }), `${draft.name}已保存`)
    if (saved) onClose()
  }

  function setStatus(status: 'available' | 'sold_out' | 'hidden') {
    if (status === 'available') setDraft({ ...draft, enabled: true, soldOut: false, soldOutReason: '' })
    if (status === 'sold_out') setDraft({ ...draft, enabled: true, soldOut: true, soldOutReason: draft.soldOutReason || '暂时售罄' })
    if (status === 'hidden') setDraft({ ...draft, enabled: false })
  }

  function setBundleComponent(productId: string, selected: boolean) {
    setDraft((current) => {
      const components = current.bundleComponents ?? []
      return {
        ...current,
        bundleComponents: selected
          ? [...components.filter((component) => component.productId !== productId), { productId, quantity: 1 }]
          : components.filter((component) => component.productId !== productId),
      }
    })
  }

  function setBundleComponentQuantity(productId: string, quantity: number) {
    const normalized = Math.max(1, Math.min(9999, Math.round(quantity || 1)))
    setDraft((current) => ({
      ...current,
      bundleComponents: (current.bundleComponents ?? []).map((component) => (
        component.productId === productId ? { ...component, quantity: normalized } : component
      )),
    }))
  }

  function setSubstitution(productId: string, selected: boolean) {
    setDraft((current) => {
      const substitutions = current.substitutionProductIds ?? []
      return {
        ...current,
        substitutionProductIds: selected
          ? [...new Set([...substitutions, productId])]
          : substitutions.filter((candidateId) => candidateId !== productId),
      }
    })
  }

  function updateRecommendation(patch: Partial<RecommendationDraft>) {
    setDraft((current) => ({
      ...current,
      recommendation: { ...defaultRecommendation(), ...(current.recommendation ?? {}), ...patch },
    }))
  }

  function toggleRecommendationValue(field: RecommendationArrayField, value: string, selected: boolean) {
    setDraft((current) => {
      const currentRecommendation = { ...defaultRecommendation(), ...(current.recommendation ?? {}) }
      const values = currentRecommendation[field] as string[]
      return {
        ...current,
        recommendation: {
          ...currentRecommendation,
          [field]: selected ? [...new Set([...values, value])] : values.filter((candidate) => candidate !== value),
        } as RecommendationDraft,
      }
    })
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
          <div className="product-editor-sections">
            <section className="product-editor-section">
              <div className="product-editor-section-heading"><span>01</span><div><h4>基础与销售</h4><p>客人看到什么，以及订单如何进入现场。</p></div></div>
              <div className="product-editor-fields">
                <label><span>商品类型</span><select value={draft.productKind ?? 'single'} onChange={(event) => setDraft({ ...draft, productKind: event.target.value as 'single' | 'bundle', bundleComponents: event.target.value === 'bundle' ? (draft.bundleComponents ?? []) : [] })}><option value="single">单品</option><option value="bundle">组合商品</option></select></label>
                <label><span>酒水类型</span><select value={draft.beverageFamily ?? 'none'} onChange={(event) => setDraft({ ...draft, beverageFamily: event.target.value as ProductWriteInput['beverageFamily'] })}>{menuBeverageFamilies.map((family) => <option key={family} value={family}>{beverageFamilyLabels[family]}</option>)}</select></label>
                <label><span>SKU</span><input required value={draft.sku} onChange={(event) => setDraft({ ...draft, sku: event.target.value })} /></label>
                <label><span>商品名称</span><input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                <label><span>规格</span><input required value={draft.specification} onChange={(event) => setDraft({ ...draft, specification: event.target.value })} /></label>
                <label><span>标价（元）</span><input type="number" min={0} step="0.01" required value={fenToYuan(draft.listPriceAmount)} onChange={(event) => setDraft({ ...draft, listPriceAmount: yuanToFen(Number(event.target.value)) })} /></label>
                {canManageCosts ? <label><span>成本（元）</span><input type="number" min={0} step="0.01" required value={fenToYuan(draft.costAmount)} onChange={(event) => setDraft({ ...draft, costAmount: yuanToFen(Number(event.target.value)) })} /></label> : <label><span>成本（财务权限）</span><input value="已保护，不会修改" disabled /></label>}
                <label><span>分类编码</span><input required value={draft.categoryId ?? ''} onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })} /></label>
                <label><span>分类名称</span><input required value={draft.categoryName ?? ''} onChange={(event) => setDraft({ ...draft, categoryName: event.target.value })} /></label>
                <label><span>出品方式</span><select
                  value={draft.fulfillmentType ?? (draft.requiresFulfillment === false ? 'no_fulfillment' : 'made_to_order')}
                  disabled={draft.productKind === 'bundle'}
                  onChange={(event) => {
                    const fulfillmentType = event.target.value as NonNullable<ProductWriteInput['fulfillmentType']>
                    setDraft({
                      ...draft,
                      fulfillmentType,
                      requiresFulfillment: fulfillmentType !== 'no_fulfillment',
                      stationId: fulfillmentType === 'no_fulfillment'
                        ? 'non-fulfillment'
                        : (workstations.some((station) => station.id === draft.stationId && station.enabled)
                            ? draft.stationId
                            : workstations.find((station) => station.enabled)?.id ?? draft.stationId),
                    })
                  }}
                >
                  <option value="made_to_order">现场制作后取货</option>
                  <option value="ready_to_serve">现货直接取货</option>
                  <option value="service_only">无需制作，直接服务</option>
                  <option value="no_fulfillment">仅记账，不产生出品</option>
                </select></label>
                {draft.productKind !== 'bundle' && draft.requiresFulfillment !== false && <label><span>出品口</span><select value={draft.stationId} onChange={(event) => setDraft({ ...draft, stationId: event.target.value })}>{!workstations.some((station) => station.id === draft.stationId) && <option value={draft.stationId}>{draft.stationId}（旧配置）</option>}{workstations.map((station) => <option key={station.id} value={station.id}>{station.name}{station.enabled ? '' : '（停用）'}</option>)}</select></label>}
                {draft.productKind === 'bundle' && <div className="product-inline-note">组合本身不直接出品，系统按组成商品分别发送到对应吧台或厨房。</div>}
                <label><span>客人自助菜单</span><select value={draft.guestVisible === false ? 'hidden' : 'visible'} onChange={(event) => setDraft({ ...draft, guestVisible: event.target.value === 'visible' })}><option value="visible">客人可见</option><option value="hidden">仅员工可见</option></select></label>
                <label><span>单笔最大数量</span><input type="number" min={1} max={9999} required value={draft.maxOrderQuantity ?? 50} onChange={(event) => setDraft({ ...draft, maxOrderQuantity: Math.max(1, Math.min(9999, Number(event.target.value))) })} /></label>
                <label><span>菜单排序</span><input type="number" min={0} max={9999} value={draft.sortOrder ?? 999} onChange={(event) => setDraft({ ...draft, sortOrder: Number(event.target.value) })} /></label>
                <label><span>供应开始</span><input type="time" value={draft.availableFrom ?? ''} onChange={(event) => setDraft({ ...draft, availableFrom: event.target.value || null })} /></label>
                <label><span>供应结束</span><input type="time" value={draft.availableUntil ?? ''} onChange={(event) => setDraft({ ...draft, availableUntil: event.target.value || null })} /></label>
                <label className="wide-field"><span>图片地址</span><input value={draft.imageUrl ?? ''} onChange={(event) => setDraft({ ...draft, imageUrl: event.target.value })} placeholder="/menu/product.jpg 或 HTTPS 地址" /></label>
                <label className="wide-field"><span>标签（顿号或逗号分隔，最多8个）</span><input value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="招牌、低度、适合分享" /></label>
                <label className="wide-field"><span>菜单描述</span><textarea maxLength={240} value={draft.description ?? ''} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
                {status === 'sold_out' && <label className="wide-field"><span>售罄原因（客人可见）</span><input maxLength={80} value={draft.soldOutReason ?? ''} onChange={(event) => setDraft({ ...draft, soldOutReason: event.target.value })} placeholder="例如：今晚原料已售完" /></label>}
              </div>
            </section>

            {draft.productKind === 'bundle' && <section className="product-editor-section">
              <div className="product-editor-section-heading"><span>02</span><div><h4>组合内容</h4><p>只可选择普通单品；每个组成商品会独立扣库存、出品和打印。</p></div></div>
              <div className="bundle-product-list">
                {componentCandidates.length === 0 && <p className="product-selection-empty">暂无可加入的普通单品。</p>}
                {componentCandidates.map((candidate) => {
                  const component = (draft.bundleComponents ?? []).find((item) => item.productId === candidate.id)
                  return <div className={component ? 'bundle-product-row is-selected' : 'bundle-product-row'} key={candidate.id}>
                    <label><input type="checkbox" checked={Boolean(component)} onChange={(event) => setBundleComponent(candidate.id, event.target.checked)} /><span><strong>{candidate.name}</strong><small>{candidate.specification} · ¥{fenToYuan(candidate.listPriceAmount).toFixed(2)}</small></span></label>
                    <div className="quantity-stepper" aria-label={`${candidate.name}数量`}>
                      <button type="button" title={`减少${candidate.name}`} disabled={!component || component.quantity <= 1} onClick={() => setBundleComponentQuantity(candidate.id, (component?.quantity ?? 1) - 1)}><Minus size={15} /></button>
                      <input aria-label={`${candidate.name}组成数量`} type="number" min={1} max={9999} disabled={!component} value={component?.quantity ?? 1} onChange={(event) => setBundleComponentQuantity(candidate.id, Number(event.target.value))} />
                      <button type="button" title={`增加${candidate.name}`} disabled={!component} onClick={() => setBundleComponentQuantity(candidate.id, (component?.quantity ?? 1) + 1)}><Plus size={15} /></button>
                    </div>
                  </div>
                })}
              </div>
              <div className="bundle-price-comparison" aria-live="polite">
                <span><small>组成商品单点合计</small><strong>¥{fenToYuan(bundleComponentTotal).toFixed(2)}</strong></span>
                <span><small>当前组合价</small><strong>¥{fenToYuan(draft.listPriceAmount).toFixed(2)}</strong></span>
                <span className={bundleDifference > 0 ? 'has-real-difference' : ''}><small>真实差额</small><strong>{bundleDifference > 0 ? `比单点少 ¥${fenToYuan(bundleDifference).toFixed(2)}` : bundleDifference === 0 ? '与单点同价' : `比单点高 ¥${fenToYuan(Math.abs(bundleDifference)).toFixed(2)}`}</strong></span>
              </div>
              {(draft.bundleComponents?.length ?? 0) === 0 && <p className="product-validation-note">保存前至少选择一个组成商品。</p>}
              {bundleDifference <= 0 && (draft.bundleComponents?.length ?? 0) > 0 && <p className="product-neutral-note">当前没有真实价格优势，客人端不应显示价格优势文案。</p>}
            </section>}

            <section className="product-editor-section">
              <div className="product-editor-section-heading"><span>{draft.productKind === 'bundle' ? '03' : '02'}</span><div><h4>替换与升级</h4><p>替换项供现场协商；升级商品用于推荐更完整的选择。</p></div></div>
              <div className="product-relation-grid">
                <fieldset className="product-choice-field">
                  <legend>可替换商品</legend>
                  <div className="product-choice-list">
                    {relationshipCandidates.map((candidate) => <label key={candidate.id}><input type="checkbox" checked={(draft.substitutionProductIds ?? []).includes(candidate.id)} onChange={(event) => setSubstitution(candidate.id, event.target.checked)} /><span>{candidate.name}<small>{candidate.productKind === 'bundle' ? '组合' : candidate.specification}</small></span></label>)}
                  </div>
                </fieldset>
                <label className="product-upgrade-field"><span>升级商品</span><select value={recommendation.upgradeProductId ?? ''} onChange={(event) => updateRecommendation({ upgradeProductId: event.target.value || null })}><option value="">不设置升级</option>{relationshipCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · ¥{fenToYuan(candidate.listPriceAmount).toFixed(2)}</option>)}</select><small>必须是真实存在、可销售的更高方案。</small></label>
              </div>
            </section>

            <section className="product-editor-section">
              <div className="product-editor-section-heading"><span>{draft.productKind === 'bundle' ? '04' : '03'}</span><div><h4>推荐策略</h4><p>这里只配置候选条件；库存、时段和现场履约仍由系统实时校验。</p></div></div>
              <label className="product-recommendation-switch"><input type="checkbox" checked={recommendation.enabled} onChange={(event) => updateRecommendation({ enabled: event.target.checked })} /><span><strong>参与智能推荐</strong><small>{recommendation.enabled ? '当前可进入推荐排序' : '当前不会主动推荐，但仍可在菜单中销售'}</small></span></label>
              <div className="product-editor-fields recommendation-fields">
                <label><span>优先级</span><input type="number" min={0} max={10000} value={recommendation.priority} onChange={(event) => updateRecommendation({ priority: Math.max(0, Math.min(10000, Number(event.target.value))) })} /></label>
                <label><span>推荐徽标</span><input maxLength={24} value={recommendation.badge} onChange={(event) => updateRecommendation({ badge: event.target.value })} placeholder="今夜特别推荐" /></label>
                <label><span>推荐标题</span><input maxLength={80} value={recommendation.headline} onChange={(event) => updateRecommendation({ headline: event.target.value })} placeholder="两个人，刚刚好" /></label>
                <label className="wide-field"><span>推荐理由</span><input maxLength={160} value={recommendation.reason} onChange={(event) => updateRecommendation({ reason: event.target.value })} placeholder="说明为什么适合，不使用虚假价值表达" /></label>
                <label><span>最少人数</span><input type="number" min={1} max={100} value={recommendation.minimumPartySize} onChange={(event) => updateRecommendation({ minimumPartySize: Math.max(1, Math.min(100, Number(event.target.value))) })} /></label>
                <label><span>最多人数</span><input type="number" min={1} max={100} value={recommendation.maximumPartySize} onChange={(event) => updateRecommendation({ maximumPartySize: Math.max(1, Math.min(100, Number(event.target.value))) })} /></label>
                <label><span>预计制作（分钟）</span><input type="number" min={0} max={240} value={recommendation.expectedPrepMinutes} onChange={(event) => updateRecommendation({ expectedPrepMinutes: Math.max(0, Math.min(240, Number(event.target.value))) })} /></label>
                <label><span>最佳持有（分钟）</span><input type="number" min={0} max={240} value={recommendation.holdMinutes} onChange={(event) => updateRecommendation({ holdMinutes: Math.max(0, Math.min(240, Number(event.target.value))) })} /></label>
                <label className="product-checkbox-field"><input type="checkbox" checked={recommendation.singleWaveEligible} onChange={(event) => updateRecommendation({ singleWaveEligible: event.target.checked })} /><span><strong>适合一次上齐</strong><small>适合三分钟内完成主要销售</small></span></label>
              </div>
              <div className="recommendation-choice-groups">
                <RecommendationChoiceField label="同行场景" values={menuRecommendationScenes} labels={recommendationSceneLabels} selected={recommendation.sceneTags} onToggle={(value, selected) => toggleRecommendationValue('sceneTags', value, selected)} />
                <RecommendationChoiceField label="今晚想要" values={menuRecommendationIntents} labels={recommendationIntentLabels} selected={recommendation.intentTags} onToggle={(value, selected) => toggleRecommendationValue('intentTags', value, selected)} />
                <RecommendationChoiceField label="口味偏好" values={menuRecommendationTastes} labels={recommendationTasteLabels} selected={recommendation.tasteTags} onToggle={(value, selected) => toggleRecommendationValue('tasteTags', value, selected)} />
                <RecommendationChoiceField label="停留时长" values={menuRecommendationDwells} labels={recommendationDwellLabels} selected={recommendation.dwellTags} onToggle={(value, selected) => toggleRecommendationValue('dwellTags', value, selected)} />
              </div>
              {recommendation.minimumPartySize > recommendation.maximumPartySize && <p className="product-validation-note">推荐最少人数不能大于最多人数。</p>}
            </section>
          </div>
        </div>
        <footer><span>{draft.productKind === 'bundle' ? `已选 ${draft.bundleComponents?.length ?? 0} 项组成商品` : draft.availableFrom && draft.availableUntil ? `每日 ${draft.availableFrom}-${draft.availableUntil} 供应，支持跨午夜` : canManageCosts ? '未设置时段，营业期间均可供应' : '成本受财务权限保护'}</span><div><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" type="submit"><Save size={17} />保存商品</button></div></footer>
      </form>
    </div>
  )
}

function RecommendationChoiceField<T extends string>({
  label,
  values,
  labels,
  selected,
  onToggle,
}: {
  label: string
  values: readonly T[]
  labels: Record<T, string>
  selected: readonly T[]
  onToggle: (value: T, selected: boolean) => void
}) {
  return <fieldset className="recommendation-choice-field"><legend>{label}</legend><div>{values.map((value) => <label key={value}><input type="checkbox" checked={selected.includes(value)} onChange={(event) => onToggle(value, event.target.checked)} /><span>{labels[value]}</span></label>)}</div></fieldset>
}

function toProductDraft(product: MenuProduct): ProductWriteInput {
  return {
    sku: product.sku,
    name: product.name,
    specification: product.specification,
    productKind: product.productKind ?? 'single',
    beverageFamily: product.beverageFamily ?? 'none',
    bundleComponents: (product.bundleComponents ?? []).map((component) => ({ ...component })),
    substitutionProductIds: [...(product.substitutionProductIds ?? [])],
    recommendation: {
      ...defaultRecommendation(),
      ...(product.recommendation ?? {}),
      sceneTags: [...(product.recommendation?.sceneTags ?? [])],
      intentTags: [...(product.recommendation?.intentTags ?? [])],
      tasteTags: [...(product.recommendation?.tasteTags ?? [])],
      dwellTags: [...(product.recommendation?.dwellTags ?? [])],
    },
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
    guestVisible: product.guestVisible ?? true,
    requiresFulfillment: product.requiresFulfillment ?? true,
    fulfillmentType: product.fulfillmentType
      ?? (product.requiresFulfillment === false ? 'no_fulfillment' : 'made_to_order'),
    maxOrderQuantity: product.maxOrderQuantity ?? 50,
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
  serviceTypes: WorkflowServiceTypeConfig[] = source.serviceTypes.map(normalizeWorkflowServiceType),
): ConfigDraftInput {
  return {
    serviceTypes: serviceTypes.map(serviceTypeDraftInput),
    roles: roles.map((role) => ({
      id: role.id,
      name: role.name,
      maxConcurrentTasks: role.maxConcurrentTasks,
      canReceiveTasks: role.canReceiveTasks,
      permissionIds: role.permissionIds,
      dataScope: role.dataScope,
      approvalLimits: role.approvalLimits,
      primaryNavigationIds: role.primaryNavigationIds ?? null,
    })),
    skills: structuredClone(skills),
    workstations: structuredClone(workstations),
    proactiveOrderCare: { ...source.proactiveOrderCare },
    guestServiceLimits: { ...source.guestServiceLimits },
    communityBrand: structuredClone(source.communityBrand),
    assistantCapabilities: structuredClone(source.assistantCapabilities ?? []),
  }
}

function employeeNavigationIds(data: BootstrapResponse, employee: Pick<EmployeeWriteInput, 'roleId' | 'roleIds' | 'permissionIds'>) {
  const roleIds = [...new Set([employee.roleId, ...(employee.roleIds ?? [])])]
  const permissionIds = [...new Set([
    ...(employee.permissionIds ?? []),
    ...data.config.roles.filter((role) => roleIds.includes(role.id)).flatMap((role) => role.permissionIds ?? []),
  ])]
  return navigationForStaffPermissions(permissionIds)
}

function toggleValue(values: string[], value: string, checked: boolean) {
  return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value)
}

function moveItem<T>(values: T[], from: number, to: number) {
  if (to < 0 || to >= values.length || from === to) return values
  const next = [...values]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

function toLocalInput(iso: string) {
  return chinaDateTimeLocalValue(iso)
}

function yuanToFen(amount: number) { return Math.round(amount * 100) }
function fenToYuan(amount: number) { return amount / 100 }
