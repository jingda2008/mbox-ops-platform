export function createCashReceiptReference(tableCode: string, now = new Date(), nonce?: string): string {
  const timestamp = now.toISOString().replace(/\D/g, '').slice(0, 14)
  const suffix = nonce ?? globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 8)
    ?? Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
  return `CASH-${tableCode.replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toUpperCase() || 'TABLE'}-${timestamp}-${suffix}`
}

export function shortPaymentOrderLabel(publicId: string): string {
  const normalized = publicId.trim()
  return normalized.length <= 18 ? normalized : `订单 …${normalized.slice(-8)}`
}
