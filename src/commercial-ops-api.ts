import { ApiError, OfflineWriteBlockedError } from './api'
import { getOfflineStatus, reportNetworkAvailable, reportNetworkUnavailable } from './offline'
import { shouldTrackMutation, withInteractionAction } from './interaction-feedback'
import type {
  CommercialOpsConfig,
  CommercialOpsWorkspace,
  GroupVoucherRedemption,
  PrintJob,
  ProcurementBatch,
  ScanCodeBinding,
} from './shared/commercial-ops-contracts'
import type { MemberProfile } from './shared/benefit-contracts'

async function commercialRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET'
  return withInteractionAction(async () => {
    if (method !== 'GET' && !getOfflineStatus().online) throw new OfflineWriteBlockedError()
    const headers = new Headers(init?.headers)
    if (init?.body) headers.set('Content-Type', 'application/json')
    const token = window.localStorage.getItem('mbox.auth.token')
    if (token) headers.set('Authorization', `Bearer ${token}`)
    else {
      headers.set('x-mbox-actor-id', window.localStorage.getItem('mbox.actor.id') ?? 'emp-chen')
      headers.set('x-mbox-store-id', 'mbox-lujiazui')
    }
    let response: Response
    try {
      response = await fetch(path, { ...init, headers })
    } catch (error) {
      reportNetworkUnavailable()
      throw error
    }
    reportNetworkAvailable()
    const body = await response.json() as T & { message?: string; code?: string }
    if (!response.ok) throw new ApiError(body.message ?? '经营工具操作失败', response.status, body.code)
    return body
  }, { enabled: shouldTrackMutation(path, method) })
}

function envelope<T extends object>(input: T, prefix: string) {
  return { ...input, occurredAt: new Date().toISOString(), idempotencyKey: `${prefix}-${crypto.randomUUID()}` }
}

export function getCommercialOpsWorkspace() {
  return commercialRequest<CommercialOpsWorkspace>('/api/commercial-ops')
}

export function updateCommercialOpsConfig(config: Omit<CommercialOpsConfig, 'version' | 'updatedAt' | 'updatedBy'>, reason: string) {
  return commercialRequest<CommercialOpsConfig>('/api/commercial-ops/config', {
    method: 'PUT',
    body: JSON.stringify({ ...config, reason, idempotencyKey: `commercial-config-${crypto.randomUUID()}` }),
  })
}

export function upsertScanBinding(input: Omit<ScanCodeBinding, 'id' | 'updatedAt' | 'updatedBy'> & { bindingId?: string; reason: string }) {
  return commercialRequest<ScanCodeBinding>('/api/commercial-ops/scan-bindings', {
    method: 'POST', body: JSON.stringify(envelope(input, 'scan-binding')),
  })
}

export function receiveProcurement(input: {
  targetType: 'product' | 'ingredient'
  targetId: string
  scanCode?: string
  supplierName: string
  supplierReference: string
  quantity: number
  unitCode: string
  unitCostAmount: number
  reason: string
}) {
  return commercialRequest<ProcurementBatch>('/api/commercial-ops/procurement-batches', {
    method: 'POST', body: JSON.stringify(envelope(input, 'procurement')),
  })
}

export function redeemGroupVoucher(input: {
  platform: string
  campaignName: string
  voucherCode: string
  faceValueAmount: number
  settlementAmount: number
  tableSessionId?: string
  orderId?: string
  reason: string
}) {
  return commercialRequest<GroupVoucherRedemption>('/api/commercial-ops/vouchers/redeem', {
    method: 'POST', body: JSON.stringify(envelope(input, 'voucher-redeem')),
  })
}

export function updateMemberTags(memberId: string, tags: string[], reason: string) {
  return commercialRequest<MemberProfile>(`/api/commercial-ops/members/${encodeURIComponent(memberId)}/tags`, {
    method: 'PUT', body: JSON.stringify(envelope({ tags, reason }, 'member-tags')),
  })
}

export function reportPrintJobResult(jobId: string, input: { status: 'queued' | 'printed' | 'failed'; error?: string }) {
  return commercialRequest<PrintJob>(`/api/commercial-ops/print-jobs/${encodeURIComponent(jobId)}/result`, {
    method: 'POST', body: JSON.stringify(envelope({ status: input.status, error: input.error ?? '' }, 'print-job-result')),
  })
}
