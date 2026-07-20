import {
  Camera,
  CheckCircle2,
  CircleAlert,
  Cpu,
  Headphones,
  Plus,
  Printer,
  Radio,
  RefreshCw,
  Save,
  ScanLine,
  Settings2,
  ShieldAlert,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import * as hardwareApi from '../hardware-api'
import { formatChinaDateTime } from '../shared/china-time'
import type { BootstrapResponse } from '../shared/contracts'
import {
  hardwareAdapterKinds,
  hardwareDeviceKinds,
  type HardwareAdapterKind,
  type HardwareCommandKind,
  type HardwareDevice,
  type HardwareDeviceKind,
  type HardwareWorkspace,
} from '../shared/hardware-contracts'
import './HardwareCenterView.css'

interface HardwareCenterViewProps {
  data: BootstrapResponse
  onRefresh: () => Promise<void>
}

const deviceKindLabels: Record<HardwareDeviceKind, string> = {
  camera: '摄像头',
  headset_gateway: '耳机网关',
  printer_bridge: '打印桥',
  scanner: '扫码设备',
  edge_gateway: '边缘节点',
}

const adapterLabels: Record<HardwareAdapterKind, string> = {
  simulator: '模拟器',
  rtsp: 'RTSP摄像头',
  nvr: 'NVR录像机',
  webhook: 'Webhook',
  network: '网络设备',
  android_bridge: '安卓桥接',
  usb: 'USB设备',
  vendor_sdk: '厂商SDK',
}

const statusLabels: Record<HardwareDevice['status'], string> = {
  disabled: '停用',
  online: '在线',
  degraded: '异常',
  offline: '离线',
  unconfigured: '待配置',
}

const commandByDevice: Record<HardwareDeviceKind, { kind: HardwareCommandKind; label: string; content: string }> = {
  camera: { kind: 'camera_capture', label: '抽取60秒', content: '人工验证关键时点前后30秒画面链路' },
  headset_gateway: { kind: 'headset_test', label: '试播提醒', content: 'L01需要关注，请确认耳机提醒链路' },
  printer_bridge: { kind: 'printer_test', label: '试打出品单', content: '设备联调测试单，不计入真实订单' },
  scanner: { kind: 'scanner_test', label: '试扫货品码', content: '设备联调扫码测试' },
  edge_gateway: { kind: 'edge_health_check', label: '健康检查', content: '检查边缘节点事件中继与推理服务状态' },
}

const capabilitiesByDevice: Record<HardwareDeviceKind, HardwareDevice['capabilities']> = {
  camera: ['capture_image', 'capture_clip'],
  headset_gateway: ['audio_notify', 'staff_acknowledge'],
  printer_bridge: ['print_receipt'],
  scanner: ['scan_code'],
  edge_gateway: ['vision_inference', 'event_relay'],
}

function DeviceIcon({ kind, size = 18 }: { kind: HardwareDeviceKind; size?: number }) {
  const icons: Record<HardwareDeviceKind, ReactNode> = {
    camera: <Camera size={size} />,
    headset_gateway: <Headphones size={size} />,
    printer_bridge: <Printer size={size} />,
    scanner: <ScanLine size={size} />,
    edge_gateway: <Cpu size={size} />,
  }
  return icons[kind]
}

function deviceDraft(device: HardwareDevice): HardwareDevice {
  return structuredClone(device)
}

function configDevice(device: HardwareDevice) {
  const {
    status: _status,
    lastHeartbeatAt: _lastHeartbeatAt,
    lastStatusChangeAt: _lastStatusChangeAt,
    diagnostics: _diagnostics,
    updatedAt: _updatedAt,
    updatedBy: _updatedBy,
    ...editable
  } = device
  return editable
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '设备操作失败'
}

function MultiReferencePicker({
  label,
  values,
  options,
  onChange,
}: {
  label: string
  values: string[]
  options: Array<{ id: string; label: string }>
  onChange: (values: string[]) => void
}) {
  const remaining = options.filter((option) => !values.includes(option.id))
  return <label className="hardware-reference-field">
    <span>{label}</span>
    <select
      value=""
      onChange={(event) => {
        if (event.target.value) onChange([...values, event.target.value])
      }}
    >
      <option value="">添加绑定</option>
      {remaining.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
    {values.length > 0 && <div>{values.map((value) => {
      const labelValue = options.find((option) => option.id === value)?.label ?? value
      return <button type="button" key={value} title={`移除${labelValue}`} onClick={() => onChange(values.filter((item) => item !== value))}>{labelValue}<X size={12} /></button>
    })}</div>}
  </label>
}

export function HardwareCenterView({ data, onRefresh }: HardwareCenterViewProps) {
  const [workspace, setWorkspace] = useState<HardwareWorkspace | null>(null)
  const [devices, setDevices] = useState<HardwareDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null)
  const [editing, setEditing] = useState(false)
  const [reason, setReason] = useState('更新门店设备、区域绑定与降级规则')

  const areaOptions = useMemo(() => data.areas.map((area) => ({ id: area.id, label: area.shortName || area.name })), [data.areas])
  const tableOptions = useMemo(() => data.tables.map((table) => ({ id: table.id, label: table.code })), [data.tables])
  const workstationOptions = useMemo(() => data.config.workstations.map((station) => ({ id: station.id, label: station.name })), [data.config.workstations])

  async function load() {
    setLoading(true)
    try {
      const next = await hardwareApi.getHardwareWorkspace()
      setWorkspace(next)
      setDevices(next.state.devices.map(deviceDraft))
    } catch (error) {
      setNotice({ tone: 'error', message: errorMessage(error) })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(null), 4500)
    return () => window.clearTimeout(timeout)
  }, [notice])

  function updateDevice(index: number, patch: Partial<HardwareDevice>) {
    setDevices((current) => current.map((device, itemIndex) => itemIndex === index ? { ...device, ...patch } : device))
  }

  async function runCommand(device: HardwareDevice) {
    const command = commandByDevice[device.kind]
    setBusy(`command:${device.id}`)
    try {
      const result = await hardwareApi.requestHardwareCommand({
        kind: command.kind,
        deviceId: device.id,
        source: 'manual',
        content: command.content,
        ...(device.kind === 'camera' ? { captureBeforeSeconds: 30, captureAfterSeconds: 30 } : {}),
      })
      setNotice({ tone: result.status === 'unconfigured' ? 'error' : 'success', message: result.resultMessage })
      await load()
      await onRefresh()
    } catch (error) {
      setNotice({ tone: 'error', message: errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  async function simulate(device: HardwareDevice, status: 'online' | 'degraded' | 'offline') {
    setBusy(`simulate:${device.id}`)
    try {
      await hardwareApi.simulateHardwareDevice(device.id, {
        status,
        message: status === 'online' ? '模拟设备联调正常' : status === 'degraded' ? '模拟高延迟，用于验证异常接管' : '模拟离线，用于验证降级通知',
      })
      setNotice({ tone: 'success', message: `${device.name}已切换为${statusLabels[status]}模拟状态` })
      await load()
      await onRefresh()
    } catch (error) {
      setNotice({ tone: 'error', message: errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  function addDevice() {
    const now = new Date().toISOString()
    const suffix = crypto.randomUUID().slice(0, 8)
    setDevices((current) => [...current, {
      id: `device-${suffix}`,
      name: '新摄像头',
      kind: 'camera',
      adapter: 'simulator',
      enabled: false,
      status: 'disabled',
      connectionReference: 'simulator',
      areaIds: [],
      tableIds: [],
      workstationIds: [],
      capabilities: capabilitiesByDevice.camera,
      lastHeartbeatAt: null,
      lastStatusChangeAt: now,
      diagnostics: { latencyMs: null, firmwareVersion: '', message: '' },
      updatedAt: now,
      updatedBy: 'draft',
    }])
  }

  async function saveConfig() {
    if (!workspace || reason.trim().length < 2) return
    setBusy('save')
    try {
      await hardwareApi.updateHardwareConfig({
        heartbeatWarningSeconds: workspace.state.config.heartbeatWarningSeconds,
        offlineAfterSeconds: workspace.state.config.offlineAfterSeconds,
        evidenceRetentionHours: workspace.state.config.evidenceRetentionHours,
        captureBeforeSeconds: workspace.state.config.captureBeforeSeconds,
        captureAfterSeconds: workspace.state.config.captureAfterSeconds,
        fallbackChannels: workspace.state.config.fallbackChannels,
        devices: devices.map(configDevice),
        reason: reason.trim(),
      })
      setEditing(false)
      setNotice({ tone: 'success', message: '设备配置已发布，新命令将按最新绑定执行' })
      await load()
      await onRefresh()
    } catch (error) {
      setNotice({ tone: 'error', message: errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  if (loading && !workspace) return <div className="hardware-loading"><RefreshCw className="is-spinning" size={20} />正在读取设备状态</div>
  if (!workspace) return <div className="hardware-loading"><WifiOff size={22} />设备中心暂时不可用<button className="secondary-button" onClick={() => void load()}>重试</button></div>

  const { summary, state } = workspace
  return <section className="hardware-view">
    <header className="hardware-heading">
      <div><span className="eyebrow">第四阶段 · 设备中台</span><h2>设备与边缘验证</h2></div>
      <div className="hardware-heading-actions">
        <span className="hardware-mode"><ShieldAlert size={15} />{summary.simulated > 0 ? '模拟验证' : '硬件待接入'}</span>
        <button className="secondary-button" disabled={loading} onClick={() => void load()}><RefreshCw size={16} />刷新</button>
        {workspace.canManage && <button className={editing ? 'primary-button' : 'secondary-button'} onClick={() => setEditing((value) => !value)}><Settings2 size={16} />{editing ? '返回状态' : '设备配置'}</button>}
      </div>
    </header>

    {notice && <div className={`hardware-notice is-${notice.tone}`} role="status"><span>{notice.tone === 'success' ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}{notice.message}</span><button title="关闭" onClick={() => setNotice(null)}><X size={15} /></button></div>}

    <div className="hardware-simulation-warning"><ShieldAlert size={18} /><strong>模拟设备只验证流程</strong><span>不会触达真实耳机、打印机或摄像头，也不能作为现场视觉证据。</span></div>

    {!editing && <>
      <div className="hardware-metrics">
        <div><strong>{summary.online}</strong><span>在线设备</span></div>
        <div className={summary.degraded > 0 ? 'is-warning' : ''}><strong>{summary.degraded}</strong><span>状态异常</span></div>
        <div className={summary.offline + summary.unconfigured > 0 ? 'is-danger' : ''}><strong>{summary.offline + summary.unconfigured}</strong><span>离线/待配置</span></div>
        <div><strong>{summary.simulated}</strong><span>模拟设备</span></div>
        <div><strong>{state.commands.length}</strong><span>联调命令</span></div>
      </div>

      <div className="hardware-main-grid">
        <section className="hardware-section">
          <header><Radio size={18} /><strong>设备状态</strong><span>{summary.enabled}/{summary.total}已启用</span></header>
          <div className="hardware-device-list">
            {state.devices.map((device) => {
              const action = commandByDevice[device.kind]
              return <article key={device.id} className={`status-${device.status}`}>
                <span className="hardware-device-icon"><DeviceIcon kind={device.kind} /></span>
                <div className="hardware-device-info"><strong>{device.name}</strong><span>{deviceKindLabels[device.kind]} · {adapterLabels[device.adapter]}</span><small>{device.diagnostics.message || '暂无设备诊断信息'}</small></div>
                <div className="hardware-device-binding"><span>{device.areaIds.length ? `${device.areaIds.length}个区域` : ''}{device.tableIds.length ? ` · ${device.tableIds.length}桌` : ''}{device.workstationIds.length ? ` · ${device.workstationIds.length}工作站` : ''}</span><small>{device.lastHeartbeatAt ? formatChinaDateTime(device.lastHeartbeatAt) : '没有心跳'}</small></div>
                <b>{statusLabels[device.status]}</b>
                {workspace.canOperate && <button className="secondary-button" disabled={!device.enabled || Boolean(busy)} onClick={() => void runCommand(device)}>{busy === `command:${device.id}` ? <RefreshCw className="is-spinning" size={15} /> : <DeviceIcon kind={device.kind} size={15} />}{action.label}</button>}
                {workspace.canManage && device.adapter === 'simulator' && device.enabled && <div className="hardware-sim-control" aria-label={`${device.name}模拟状态`}><button disabled={Boolean(busy)} className={device.status === 'online' ? 'is-active' : ''} onClick={() => void simulate(device, 'online')}>正常</button><button disabled={Boolean(busy)} className={device.status === 'degraded' ? 'is-active' : ''} onClick={() => void simulate(device, 'degraded')}>异常</button><button disabled={Boolean(busy)} className={device.status === 'offline' ? 'is-active' : ''} onClick={() => void simulate(device, 'offline')}>离线</button></div>}
              </article>
            })}
          </div>
        </section>

        <section className="hardware-section hardware-command-section">
          <header><Cpu size={18} /><strong>最近命令</strong><span>{summary.pendingCommands}条待回执</span></header>
          <div className="hardware-command-list">
            {state.commands.length === 0 && <div className="hardware-empty">尚未执行设备联调</div>}
            {state.commands.toReversed().slice(0, 12).map((command) => <div key={command.id}>
              <span className={`command-status is-${command.status}`} />
              <span><strong>{commandByKindLabel(command.kind)}</strong><small>{command.resultMessage}</small></span>
              <time>{formatChinaDateTime(command.requestedAt)}</time>
              {command.simulation && <b>模拟</b>}
            </div>)}
          </div>
        </section>
      </div>
    </>}

    {editing && <div className="hardware-config">
      <section className="hardware-section">
        <header><Settings2 size={18} /><strong>心跳、取证与降级</strong><span>配置V{state.config.version}</span></header>
        <div className="hardware-config-grid">
          <label><span>心跳预警（秒）</span><input type="number" min={10} max={3600} value={state.config.heartbeatWarningSeconds} onChange={(event) => setWorkspace({ ...workspace, state: { ...state, config: { ...state.config, heartbeatWarningSeconds: Number(event.target.value) } } })} /></label>
          <label><span>判定离线（秒）</span><input type="number" min={30} max={7200} value={state.config.offlineAfterSeconds} onChange={(event) => setWorkspace({ ...workspace, state: { ...state, config: { ...state.config, offlineAfterSeconds: Number(event.target.value) } } })} /></label>
          <label><span>证据保留（小时）</span><input type="number" min={1} max={168} value={state.config.evidenceRetentionHours} onChange={(event) => setWorkspace({ ...workspace, state: { ...state, config: { ...state.config, evidenceRetentionHours: Number(event.target.value) } } })} /></label>
          <label><span>事件前画面（秒）</span><input type="number" min={5} max={60} value={state.config.captureBeforeSeconds} onChange={(event) => setWorkspace({ ...workspace, state: { ...state, config: { ...state.config, captureBeforeSeconds: Number(event.target.value) } } })} /></label>
          <label><span>事件后画面（秒）</span><input type="number" min={5} max={60} value={state.config.captureAfterSeconds} onChange={(event) => setWorkspace({ ...workspace, state: { ...state, config: { ...state.config, captureAfterSeconds: Number(event.target.value) } } })} /></label>
          <label className="hardware-checkbox"><input type="checkbox" checked={state.config.fallbackChannels.includes('wecom')} onChange={(event) => setWorkspace({ ...workspace, state: { ...state, config: { ...state.config, fallbackChannels: event.target.checked ? ['in_app', 'wecom'] : ['in_app'] } } })} /><span>设备失败同时通知企业微信</span></label>
        </div>
      </section>

      <section className="hardware-section">
        <header><Radio size={18} /><strong>设备、适配器与现场绑定</strong><button className="secondary-button" type="button" onClick={addDevice}><Plus size={15} />新增设备</button></header>
        <div className="hardware-device-editor-list">
          {devices.map((device, index) => <article key={device.id}>
            <div className="hardware-editor-title"><DeviceIcon kind={device.kind} /><strong>{device.name || '未命名设备'}</strong><label><input type="checkbox" checked={device.enabled} onChange={(event) => updateDevice(index, { enabled: event.target.checked })} />启用</label><button type="button" title="删除设备" onClick={() => setDevices((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={16} /></button></div>
            <div className="hardware-editor-fields">
              <label><span>设备名称</span><input value={device.name} maxLength={80} onChange={(event) => updateDevice(index, { name: event.target.value })} /></label>
              <label><span>设备类型</span><select value={device.kind} onChange={(event) => { const kind = event.target.value as HardwareDeviceKind; updateDevice(index, { kind, capabilities: capabilitiesByDevice[kind] }) }}>{hardwareDeviceKinds.map((kind) => <option key={kind} value={kind}>{deviceKindLabels[kind]}</option>)}</select></label>
              <label><span>适配方式</span><select value={device.adapter} onChange={(event) => { const adapter = event.target.value as HardwareAdapterKind; updateDevice(index, { adapter, connectionReference: adapter === 'simulator' ? 'simulator' : '' }) }}>{hardwareAdapterKinds.map((adapter) => <option key={adapter} value={adapter}>{adapterLabels[adapter]}</option>)}</select></label>
              <label><span>连接引用</span><input value={device.connectionReference} placeholder="Secret名称、设备编号或通道名" onChange={(event) => updateDevice(index, { connectionReference: event.target.value })} /></label>
              <MultiReferencePicker label="区域" values={device.areaIds} options={areaOptions} onChange={(areaIds) => updateDevice(index, { areaIds })} />
              <MultiReferencePicker label="桌台" values={device.tableIds} options={tableOptions} onChange={(tableIds) => updateDevice(index, { tableIds })} />
              <MultiReferencePicker label="工作站" values={device.workstationIds} options={workstationOptions} onChange={(workstationIds) => updateDevice(index, { workstationIds })} />
            </div>
          </article>)}
        </div>
        <div className="hardware-save-band"><label><span>发布原因</span><input minLength={2} value={reason} onChange={(event) => setReason(event.target.value)} /></label><button className="primary-button" disabled={busy === 'save' || reason.trim().length < 2} onClick={() => void saveConfig()}>{busy === 'save' ? <RefreshCw className="is-spinning" size={16} /> : <Save size={16} />}发布设备配置</button></div>
      </section>
    </div>}
  </section>
}

function commandByKindLabel(kind: HardwareCommandKind) {
  const entry = Object.values(commandByDevice).find((item) => item.kind === kind)
  return entry?.label ?? kind
}
