import { useMemo, useState } from 'react'
import { Camera, Check, QrCode, ShieldCheck, X } from 'lucide-react'
import type { BootstrapResponse, Employee } from '../shared/contracts'
import type { SopActionRecord } from '../shared/sop-contracts'
import { resolveSopAction } from '../api'

interface SopVerificationInboxProps {
  data: BootstrapResponse
  employee: Employee | null
  onRefresh: () => Promise<void>
  onNotice: (message: string) => void
}

const typeLabels: Record<SopActionRecord['type'], string> = {
  headset_notification: '耳机播报',
  wecom_notification: '企业微信通知',
  manager_review: '经理独立复核',
  table_qr_scan: '实体桌码验证',
  camera_snapshot: '摄像头抽帧',
}

export function SopVerificationInbox({ data, employee, onRefresh, onNotice }: SopVerificationInboxProps) {
  const [qrTokens, setQrTokens] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const roleIds = useMemo(() => {
    if (!employee) return []
    const shift = data.shiftAssignments.find((item) => item.employeeId === employee.id && item.status === 'active')
    return [...new Set([employee.roleId, ...(employee.roleIds ?? []), ...(shift ? [shift.roleId, ...(shift.roleIds ?? [])] : [])])]
  }, [data.shiftAssignments, employee])
  const records = (data.sopActionRecords ?? []).filter((record) => (
    ['manager_review', 'table_qr_scan', 'camera_snapshot'].includes(record.type)
    && ['awaiting_evidence', 'unconfigured', 'failed', 'rejected'].includes(record.status)
    && record.requiredRoleIds.some((roleId) => roleIds.includes(roleId))
  ))
  if (records.length === 0) return null

  async function resolve(record: SopActionRecord, decision: 'approve' | 'reject') {
    setBusyId(record.id)
    try {
      await resolveSopAction(record.id, {
        decision,
        note: decision === 'approve' ? `${typeLabels[record.type]}已核验` : `${typeLabels[record.type]}未通过`,
        tableQrToken: record.type === 'table_qr_scan' ? qrTokens[record.id]?.trim() : undefined,
        idempotencyKey: `sop-action-${record.id}-${decision}-${crypto.randomUUID()}`,
      })
      onNotice(decision === 'approve' ? '验证已通过，SOP会自动继续下一步。' : '已驳回并记录，SOP已停止继续执行。')
      await onRefresh()
    } catch (error) {
      onNotice(`验证失败：${error instanceof Error ? error.message : '操作没有保存'}`)
    } finally {
      setBusyId(null)
    }
  }

  return <section className="sop-verification-inbox" aria-label="SOP验证待办">
    <header><ShieldCheck size={18} /><div><strong>SOP验证待办</strong><span>验证完成后，后续步骤才会继续</span></div><b>{records.length}</b></header>
    <div>{records.map((record) => {
      const table = data.tables.find((item) => item.id === record.tableId)
      const retryBlocked = record.status !== 'awaiting_evidence'
      return <article key={record.id}>
        <span className="sop-verification-icon">{record.type === 'table_qr_scan' ? <QrCode size={18} /> : record.type === 'camera_snapshot' ? <Camera size={18} /> : <ShieldCheck size={18} />}</span>
        <div className="sop-verification-copy"><strong>{table?.code ?? record.tableId} · {typeLabels[record.type]}</strong><span>{record.content}</span>{record.failureReason && <em>{record.failureReason}</em>}</div>
        {record.type === 'table_qr_scan' && !retryBlocked && <input aria-label={`${table?.code ?? record.tableId}桌码内容`} placeholder="扫描桌码后自动填入，或粘贴二维码链接" value={qrTokens[record.id] ?? ''} onChange={(event) => setQrTokens({ ...qrTokens, [record.id]: event.target.value })} />}
        <div className="sop-verification-actions">
          {record.type !== 'table_qr_scan' && !retryBlocked && <button className="danger-outline-button" disabled={busyId === record.id} onClick={() => void resolve(record, 'reject')}><X size={14} />驳回</button>}
          {!retryBlocked && <button className="primary-button" disabled={busyId === record.id || (record.type === 'table_qr_scan' && !(qrTokens[record.id]?.trim()))} onClick={() => void resolve(record, 'approve')}><Check size={14} />确认通过</button>}
          {retryBlocked && <b>需要管理员检查通道配置</b>}
        </div>
      </article>
    })}</div>
  </section>
}
