import { BadgeDollarSign, CalendarClock, GlassWater, MapPinned, Plus, Save, TableProperties, UserRoundCog } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import {
  createCommerceAuthority,
  createEmployee as createEmployeeRequest,
  createProduct as createProductRequest,
  createShift as createShiftRequest,
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
  Employee,
  EmployeeWriteInput,
  MenuProduct,
  ProductWriteInput,
  ShiftAssignment,
  ShiftWriteInput,
  Table,
} from '../shared/contracts'
import type { AuthorityWriteInput } from '../shared/commerce-api'
import type { OrderAuthorizationAuthority } from '../shared/order-contracts'
import './MasterDataView.css'

type MasterView = 'employees' | 'shifts' | 'tables' | 'products' | 'authorities' | 'areas'

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
  { id: 'authorities', label: '经营权限', icon: BadgeDollarSign },
  { id: 'areas', label: '区域', icon: MapPinned },
]

export function MasterDataView({ data, onRefresh, onNotice }: MasterDataViewProps) {
  const [view, setView] = useState<MasterView>('employees')

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action()
      onNotice(success)
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '主数据保存失败')
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
      status: 'active', roleId, online: false, paused: false, areaIds: areaId ? [areaId] : [],
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
      <div className="area-selector"><span>责任区</span><div>{data.areas.map((area) => <label key={area.id}><input type="checkbox" checked={draft.areaIds.includes(area.id)} onChange={(event) => setDraft({ ...draft, areaIds: event.target.checked ? [...draft.areaIds, area.id] : draft.areaIds.filter((id) => id !== area.id) })} />{area.shortName}</label>)}</div></div>
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
  const defaultStart = new Date()
  defaultStart.setHours(19, 0, 0, 0)
  const defaultEnd = new Date(defaultStart)
  defaultEnd.setDate(defaultEnd.getDate() + 1)
  defaultEnd.setHours(3, 0, 0, 0)
  const [employeeId, setEmployeeId] = useState(firstEmployee?.id ?? '')
  const [roleId, setRoleId] = useState(firstRole?.id ?? '')
  const [areaId, setAreaId] = useState(firstArea?.id ?? '')
  const [startAt, setStartAt] = useState(toLocalInput(defaultStart.toISOString()))
  const [endAt, setEndAt] = useState(toLocalInput(defaultEnd.toISOString()))

  async function submit(event: FormEvent) {
    event.preventDefault()
    await run(() => createShiftRequest({
      employeeId, businessDate: data.store.businessDate, startAt: new Date(startAt).toISOString(),
      endAt: new Date(endAt).toISOString(), roleId, areaIds: [areaId], isPrimary: false, status: 'scheduled',
    }), '新班次已建立')
  }

  return (
    <div className="master-section">
      <form className="inline-create shift-create" onSubmit={(event) => void submit(event)}>
        <label><span>员工</span><select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>{data.employees.filter((employee) => employee.status === 'active').map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label>
        <label><span>岗位</span><select value={roleId} onChange={(event) => setRoleId(event.target.value)}>{data.config.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
        <label><span>区域</span><select value={areaId} onChange={(event) => setAreaId(event.target.value)}>{data.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label>
        <label><span>开始</span><input type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.target.value)} /></label>
        <label><span>结束</span><input type="datetime-local" value={endAt} onChange={(event) => setEndAt(event.target.value)} /></label>
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
      <label><span>开始</span><input type="datetime-local" value={toLocalInput(draft.startAt)} onChange={(event) => setDraft({ ...draft, startAt: new Date(event.target.value).toISOString() })} /></label>
      <label><span>结束</span><input type="datetime-local" value={toLocalInput(draft.endAt)} onChange={(event) => setDraft({ ...draft, endAt: new Date(event.target.value).toISOString() })} /></label>
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
      <label><span>有效至</span><input type="datetime-local" value={toLocalInput(draft.validUntil)} onChange={(event) => setDraft({ ...draft, validUntil: new Date(event.target.value).toISOString() })} /></label>
      <button className="icon-button" title={`保存${employee?.displayName ?? ''}经营权限`} disabled={draft.kinds.length === 0 || draft.allowedSkuIds?.length === 0} onClick={() => void run(() => updateCommerceAuthority(authority.id, draft), '经营权限已保存')}><Save size={17} /></button>
    </div>
  )
}

function ProductSection({ data, run }: SectionProps) {
  const [sku, setSku] = useState('')
  const [name, setName] = useState('')
  const [price, setPrice] = useState(68)
  const [stationId, setStationId] = useState('bar-main')

  async function submit(event: FormEvent) {
    event.preventDefault()
    await run(() => createProductRequest({
      sku, name, specification: '1份', listPriceAmount: yuanToFen(price), costAmount: 0,
      stationId, enabled: true,
    }), `${name}已建立`)
    setSku('')
    setName('')
  }

  return (
    <div className="master-section">
      <form className="inline-create" onSubmit={(event) => void submit(event)}>
        <label><span>SKU</span><input value={sku} onChange={(event) => setSku(event.target.value)} /></label>
        <label><span>商品名称</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label><span>标价（元）</span><input type="number" min={0} value={price} onChange={(event) => setPrice(Number(event.target.value))} /></label>
        <label><span>出品口</span><select value={stationId} onChange={(event) => setStationId(event.target.value)}><option value="bar-main">主吧台</option><option value="kitchen-cold">冷菜间</option><option value="kitchen-hot">热厨</option></select></label>
        <button className="primary-button" type="submit" disabled={!sku.trim() || !name.trim()}><Plus size={17} />新增商品</button>
      </form>
      <div className="master-rows">{data.products.map((product) => <ProductRow key={product.id} product={product} run={run} />)}</div>
    </div>
  )
}

function ProductRow({ product, run }: { product: MenuProduct; run: RunAction }) {
  const [draft, setDraft] = useState<ProductWriteInput>(() => product)
  useEffect(() => setDraft(product), [product])
  return (
    <div className="master-row product-row">
      <div className="row-identity"><strong>{product.sku}</strong><span>版本 {product.configVersion}</span></div>
      <label><span>商品名称</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label><span>规格</span><input value={draft.specification} onChange={(event) => setDraft({ ...draft, specification: event.target.value })} /></label>
      <label><span>标价（元）</span><input type="number" min={0} value={fenToYuan(draft.listPriceAmount)} onChange={(event) => setDraft({ ...draft, listPriceAmount: yuanToFen(Number(event.target.value)) })} /></label>
      <label><span>成本（元）</span><input type="number" min={0} value={fenToYuan(draft.costAmount)} onChange={(event) => setDraft({ ...draft, costAmount: yuanToFen(Number(event.target.value)) })} /></label>
      <label><span>出品口</span><select value={draft.stationId} onChange={(event) => setDraft({ ...draft, stationId: event.target.value })}><option value="bar-main">主吧台</option><option value="kitchen-cold">冷菜间</option><option value="kitchen-hot">热厨</option></select></label>
      <label className="binary-field"><span>启用</span><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /></label>
      <button className="icon-button" title={`保存${product.name}`} onClick={() => void run(() => updateProductRequest(product.id, draft), `${draft.name}已保存`)}><Save size={17} /></button>
    </div>
  )
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
type RunAction = (action: () => Promise<unknown>, success: string) => Promise<void>

function toLocalInput(iso: string) {
  const date = new Date(iso)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function yuanToFen(amount: number) { return Math.round(amount * 100) }
function fenToYuan(amount: number) { return amount / 100 }
