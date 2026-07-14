import type {
  InternalReconciliationEntry,
  PaymentProviderAdapter,
  PaymentProviderSecretSource,
  PaymentReconciliationRun,
  ProviderBillEntry,
  ReconciliationDifferenceType,
  ReconciliationItem,
  ReconciliationManualStatus,
  ReconciliationResolution,
} from '../src/shared/payment-provider-contracts.js'

export interface ReconcileDailyPaymentsInput {
  runId: string
  provider: string
  merchantId: string
  businessDate: string
  createdAt: string
  internalEntries: readonly InternalReconciliationEntry[]
  providerEntries: readonly ProviderBillEntry[]
}

export interface DownloadAndReconcileProviderDayInput
  extends Omit<ReconcileDailyPaymentsInput, 'provider' | 'providerEntries'> {
  adapter: PaymentProviderAdapter
  secrets: PaymentProviderSecretSource
}

export interface UpdateReconciliationManualStatusCommand {
  itemId: string
  status: Exclude<ReconciliationManualStatus, 'not_required'>
  actorId: string
  reason: string
  resolution?: ReconciliationResolution
  occurredAt: string
}

function assertNonEmpty(value: string, label: string) {
  if (!value.trim()) throw new Error(`${label}不能为空`)
}

function assertTimestamp(value: string, label: string) {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label}必须是有效的ISO时间`)
}

function entryKey(entry: Pick<ProviderBillEntry, 'type' | 'providerTransactionId'>) {
  return `${entry.type}\u0000${entry.providerTransactionId}`
}

function differenceType(
  internalEntry: InternalReconciliationEntry,
  providerEntry: ProviderBillEntry,
): ReconciliationDifferenceType {
  if (internalEntry.amount !== providerEntry.amount) return 'amount_mismatch'
  if (internalEntry.currency !== providerEntry.currency) return 'currency_mismatch'
  if (internalEntry.status !== providerEntry.status) return 'status_mismatch'
  return 'matched'
}

function makeItem(
  runId: string,
  suffix: string,
  type: ReconciliationDifferenceType,
  providerTransactionId: string,
  internalEntry: InternalReconciliationEntry | null,
  providerEntry: ProviderBillEntry | null,
): ReconciliationItem {
  return {
    id: `${runId}:${suffix}`,
    differenceType: type,
    providerTransactionId,
    internalEntry,
    providerEntry,
    manualStatus: type === 'matched' ? 'not_required' : 'pending',
    resolution: null,
    manualEvents: [],
  }
}

export function reconcileDailyPayments(
  input: ReconcileDailyPaymentsInput,
): PaymentReconciliationRun {
  assertNonEmpty(input.runId, '对账批次ID')
  assertNonEmpty(input.provider, '支付供应商')
  assertNonEmpty(input.merchantId, '商户ID')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) throw new Error('营业日格式必须为YYYY-MM-DD')
  assertTimestamp(input.createdAt, '对账创建时间')

  const internalByKey = new Map<string, InternalReconciliationEntry>()
  for (const entry of input.internalEntries) {
    assertNonEmpty(entry.providerTransactionId, '系统渠道交易号')
    const key = entryKey(entry)
    if (internalByKey.has(key)) throw new Error('系统侧渠道交易号重复')
    internalByKey.set(key, entry)
  }

  const primaryProviderByKey = new Map<string, ProviderBillEntry>()
  const duplicateProviderEntries: ProviderBillEntry[] = []
  for (const entry of input.providerEntries) {
    assertNonEmpty(entry.providerEntryId, '渠道账单明细ID')
    assertNonEmpty(entry.providerTransactionId, '渠道交易号')
    const key = entryKey(entry)
    if (primaryProviderByKey.has(key)) duplicateProviderEntries.push(entry)
    else primaryProviderByKey.set(key, entry)
  }

  const items: ReconciliationItem[] = []
  let sequence = 0
  for (const [key, internalEntry] of internalByKey) {
    const providerEntry = primaryProviderByKey.get(key) ?? null
    const type = providerEntry ? differenceType(internalEntry, providerEntry) : 'internal_only'
    items.push(
      makeItem(
        input.runId,
        String(++sequence),
        type,
        internalEntry.providerTransactionId,
        internalEntry,
        providerEntry,
      ),
    )
    primaryProviderByKey.delete(key)
  }

  for (const providerEntry of primaryProviderByKey.values()) {
    items.push(
      makeItem(
        input.runId,
        String(++sequence),
        'provider_only',
        providerEntry.providerTransactionId,
        null,
        providerEntry,
      ),
    )
  }

  for (const providerEntry of duplicateProviderEntries) {
    items.push(
      makeItem(
        input.runId,
        String(++sequence),
        'duplicate_provider_entry',
        providerEntry.providerTransactionId,
        internalByKey.get(entryKey(providerEntry)) ?? null,
        providerEntry,
      ),
    )
  }

  return {
    id: input.runId,
    provider: input.provider,
    merchantId: input.merchantId,
    businessDate: input.businessDate,
    createdAt: input.createdAt,
    items,
  }
}

export async function downloadAndReconcileProviderDay(
  input: DownloadAndReconcileProviderDayInput,
) {
  const providerEntries = await input.adapter.downloadBill(
    { merchantId: input.merchantId, businessDate: input.businessDate },
    { secrets: input.secrets },
  )
  return reconcileDailyPayments({
    runId: input.runId,
    provider: input.adapter.provider,
    merchantId: input.merchantId,
    businessDate: input.businessDate,
    createdAt: input.createdAt,
    internalEntries: input.internalEntries,
    providerEntries,
  })
}

export function updateReconciliationManualStatus(
  run: PaymentReconciliationRun,
  command: UpdateReconciliationManualStatusCommand,
) {
  assertNonEmpty(command.actorId, '人工处理人')
  assertNonEmpty(command.reason, '人工处理原因')
  assertTimestamp(command.occurredAt, '人工处理时间')
  const item = run.items.find((candidate) => candidate.id === command.itemId)
  if (!item) throw new Error('对账差异不存在')
  if (item.manualStatus === 'not_required') throw new Error('已自动对平的明细不需要人工处理')
  const lastEvent = item.manualEvents.at(-1)
  const earliestAllowed = lastEvent?.occurredAt ?? run.createdAt
  if (Date.parse(command.occurredAt) < Date.parse(earliestAllowed)) {
    throw new Error('人工处理时间不能早于已有对账记录')
  }
  if (command.status === 'resolved' && !command.resolution) throw new Error('结案必须填写处理结论')
  if (command.status !== 'resolved' && command.resolution) throw new Error('只有结案状态可以填写处理结论')
  if (item.manualStatus === 'resolved' && command.status !== 'investigating') {
    throw new Error('已结案差异只能重新进入调查')
  }

  item.manualStatus = command.status
  item.resolution = command.status === 'resolved' ? command.resolution ?? null : null
  item.manualEvents.push({
    status: command.status,
    actorId: command.actorId,
    reason: command.reason.trim(),
    resolution: command.status === 'resolved' ? command.resolution ?? null : null,
    occurredAt: command.occurredAt,
  })
  return item
}
