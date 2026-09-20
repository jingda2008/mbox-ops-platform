import { useCallback, useEffect, useState } from 'react'
import { BadgeCheck, CircleAlert, Gift, LoaderCircle, ScanLine } from 'lucide-react'
import {
  GROUP_VOUCHER_PLATFORM_CODES,
  GROUP_VOUCHER_PLATFORM_LABELS,
  type GroupVoucherPlatformCode,
  type GroupVoucherPlatformStatus,
  type GroupVoucherPreparePreview,
  type GroupVoucherRedemptionResult,
} from '../shared/group-voucher-contracts'
import { NormalizedApiError, type NormalizedApiClient, type StaffAuthView } from '../normalized-api'
import { executeRecoverableCommand } from './recoverable-command'
import { createIdempotencyKey } from './cashier-mutation'
import { useConfirmationDialog } from './ConfirmationDialog'
import { InventoryBarcodeScanner } from './InventoryBarcodeScanner'
import './group-voucher-redemption-panel.css'

export function GroupVoucherRedemptionPanel({
  api,
  auth,
}: {
  api: NormalizedApiClient
  auth: StaffAuthView
}) {
  const canRedeem = auth.permissions.includes('commercial.voucher.redeem')
  const canView = canRedeem || auth.permissions.includes('commercial.voucher.view')
  const { confirmAction } = useConfirmationDialog()
  const [platforms, setPlatforms] = useState<GroupVoucherPlatformStatus[]>([])
  const [recent, setRecent] = useState<GroupVoucherRedemptionResult[]>([])
  const [platform, setPlatform] = useState<GroupVoucherPlatformCode>('meituan')
  const [code, setCode] = useState('')
  const [preview, setPreview] = useState<GroupVoucherPreparePreview | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [scannerOpen, setScannerOpen] = useState(false)

  const load = useCallback(async () => {
    const [platformResponse, voucherResponse] = await Promise.all([
      api.getEndpoint<{ data: GroupVoucherPlatformStatus[] }>('/api/commercial-ops/vouchers/platforms'),
      api.getEndpoint<{ data: GroupVoucherRedemptionResult[] }>('/api/commercial-ops/vouchers'),
    ])
    setPlatforms(platformResponse.data)
    setRecent(voucherResponse.data.slice(0, 20))
  }, [api])

  useEffect(() => {
    if (!canView) return
    void load().catch((error: unknown) => {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '团购核销数据暂时无法读取' })
    })
  }, [canView, load])

  if (!canView) return null

  const selected = platforms.find((item) => item.code === platform)
  const enabled = selected?.enabled === true

  async function lookup() {
    const voucherCode = code.trim()
    if (!canRedeem || !enabled || voucherCode.length < 4 || busy) return
    setBusy('prepare')
    setNotice(null)
    setPreview(null)
    try {
      const prepared = await api.postEndpoint<GroupVoucherPreparePreview>(
        '/api/commercial-ops/vouchers/prepare',
        { platform, voucherCode },
      )
      setPreview(prepared)
      setNotice({ tone: 'success', text: `已查询到${prepared.platformLabel}券，请核对后确认核销。` })
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof NormalizedApiError ? error.message : '查询失败，券尚未核销' })
    } finally {
      setBusy('')
    }
  }

  async function consume() {
    if (!preview || !canRedeem || busy) return
    if (!(await confirmAction({
      title: '确认核销团购券',
      description: `${preview.platformLabel} · ${preview.campaignName}\n券码 ${preview.voucherCodeMasked}\n面额 ¥${yuan(preview.faceValueMinor)} · 结算 ¥${yuan(preview.settlementAmountMinor)}\n确认后将向平台核销，不能撤销。`,
      confirmLabel: '确认核销',
    }))) return
    setBusy('consume')
    setNotice(null)
    try {
      const body = { platform, voucherCode: code.trim(), prepareHandle: preview.prepareHandle }
      const redeemed = await executeRecoverableCommand(
        `${auth.employee.id}:voucher-redeem:${preview.prepareHandle}`,
        body,
        createIdempotencyKey('voucher-redeem'),
        (idempotencyKey) => api.postEndpoint<GroupVoucherRedemptionResult>(
          '/api/commercial-ops/vouchers/redeem',
          body,
          { idempotencyKey },
        ),
      )
      setPreview(null)
      setCode('')
      setNotice({ tone: 'success', text: `${redeemed.platform}券 ${redeemed.voucherCodeMasked} 已核销。` })
      await load()
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof NormalizedApiError ? error.message : '核销未完成，请按平台结果核对' })
    } finally {
      setBusy('')
    }
  }

  return <section className="group-voucher-panel" aria-label="团购核销">
    <header>
      <span><Gift size={18} /></span>
      <div>
        <strong>团购券核销</strong>
        <small>仅支持大众点评、美团、抖音、快手。先查询再确认，避免未核对就消耗券码。</small>
      </div>
    </header>
    {notice && <p className={`group-voucher-notice is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      {notice.tone === 'success' ? <BadgeCheck size={16} /> : <CircleAlert size={16} />}
      {notice.text}
    </p>}
    {canRedeem && <form className="staff-module-form" onSubmit={(event) => { event.preventDefault(); void lookup() }}>
      <header>
        <strong>查询待核销券</strong>
        <small>{enabled ? `${selected?.label}当前可核销` : `${GROUP_VOUCHER_PLATFORM_LABELS[platform]}尚未配置，请先设置运行环境变量。`}</small>
      </header>
      <label>平台
        <select value={platform} onChange={(event) => {
          setPlatform(event.target.value as GroupVoucherPlatformCode)
          setPreview(null)
        }}>
          {GROUP_VOUCHER_PLATFORM_CODES.map((code) => {
            const item = platforms.find((entry) => entry.code === code)
            return <option key={code} value={code}>
              {GROUP_VOUCHER_PLATFORM_LABELS[code]}{item && !item.enabled ? '（未配置）' : ''}
            </option>
          })}
        </select>
      </label>
      <label className="inventory-code-field">券码或付款码
        <div>
          <input required minLength={4} maxLength={256} value={code} autoComplete="off"
            placeholder="输入或扫描顾客出示的券码"
            onChange={(event) => { setCode(event.target.value); setPreview(null) }} />
          <button type="button" onClick={() => setScannerOpen(true)}><ScanLine size={16} />扫码</button>
        </div>
      </label>
      <button type="submit" disabled={!enabled || code.trim().length < 4 || Boolean(busy)}>
        {busy === 'prepare' ? <><LoaderCircle className="is-spinning" size={16} />正在查询</> : '查询券状态'}
      </button>
    </form>}
    {preview && <article className="group-voucher-preview">
      <header>
        <strong>{preview.campaignName}</strong>
        <small>{preview.platformLabel} · {preview.voucherCodeMasked} · {preview.statusLabel}</small>
      </header>
      <p>面额 ¥{yuan(preview.faceValueMinor)} · 平台结算 ¥{yuan(preview.settlementAmountMinor)} · {preview.quantity}份</p>
      {canRedeem && <button type="button" disabled={Boolean(busy)} onClick={() => void consume()}>
        {busy === 'consume' ? '正在核销' : '确认核销'}
      </button>}
    </article>}
    <div className="staff-module-list" aria-label="最近核销">
      {recent.length === 0
        ? <p className="staff-module-empty">本营业日还没有团购核销记录</p>
        : recent.map((item) => <article key={item.id}>
          <div>
            <strong>{item.campaignName}</strong>
            <small>{item.platform} · {item.voucherCodeMasked}</small>
          </div>
          <b>¥{yuan(item.faceValueMinor)}</b>
        </article>)}
    </div>
    {scannerOpen && <InventoryBarcodeScanner
      title="扫描团购券码或二维码"
      cameraLabel="团购券扫码摄像头画面"
      onClose={() => setScannerOpen(false)}
      onDetected={(value) => { setCode(value); setPreview(null); setScannerOpen(false) }}
    />}
  </section>
}

function yuan(amount: number): string {
  return (amount / 100).toFixed(2)
}
