import QRCode from 'qrcode'

const QR_OPTIONS = {
  width: 480,
  margin: 2,
  errorCorrectionLevel: 'M' as const,
}

function identificationValue(value: string, label: string): string {
  const normalized = value.trim()
  if (normalized.length < 3 || normalized.length > 128) {
    throw new Error(`${label}不符合二维码生成规则`)
  }
  return normalized
}

export function memberIdentificationPayload(memberNo: string): string {
  return `MBOX_MEMBER_V1:${identificationValue(memberNo, '会员号')}`
}

export function benefitClaimPayload(claimCode: string): string {
  return `MBOX_CLAIM_V1:${identificationValue(claimCode, '核销码')}`
}

export function createMemberIdentificationQrDataUrl(memberNo: string): Promise<string> {
  return QRCode.toDataURL(memberIdentificationPayload(memberNo), QR_OPTIONS)
}

export function createBenefitClaimQrDataUrl(claimCode: string): Promise<string> {
  return QRCode.toDataURL(benefitClaimPayload(claimCode), QR_OPTIONS)
}
