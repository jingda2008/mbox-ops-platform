export const GROUP_VOUCHER_PLATFORM_CODES = ['dianping', 'meituan', 'douyin', 'kuaishou'] as const

export type GroupVoucherPlatformCode = (typeof GROUP_VOUCHER_PLATFORM_CODES)[number]

export const GROUP_VOUCHER_PLATFORM_LABELS = Object.freeze({
  dianping: '大众点评',
  meituan: '美团',
  douyin: '抖音',
  kuaishou: '快手',
} as const satisfies Record<GroupVoucherPlatformCode, string>)

const PLATFORM_ALIASES: Readonly<Record<string, GroupVoucherPlatformCode>> = Object.freeze({
  dianping: 'dianping',
  meituan: 'meituan',
  douyin: 'douyin',
  kuaishou: 'kuaishou',
  大众点评: 'dianping',
  美团: 'meituan',
  抖音: 'douyin',
  快手: 'kuaishou',
})

export function parseGroupVoucherPlatform(value: string): GroupVoucherPlatformCode | null {
  return PLATFORM_ALIASES[value.trim()] ?? null
}

export function groupVoucherPlatformLabel(code: GroupVoucherPlatformCode): string {
  return GROUP_VOUCHER_PLATFORM_LABELS[code]
}

export interface GroupVoucherPlatformStatus {
  code: GroupVoucherPlatformCode
  label: string
  enabled: boolean
  mode: 'disabled' | 'test' | 'uat' | 'production'
}

export interface GroupVoucherPreparePreview {
  platform: GroupVoucherPlatformCode
  platformLabel: string
  campaignName: string
  voucherCodeMasked: string
  faceValueMinor: number
  settlementAmountMinor: number
  currency: string
  quantity: number
  statusLabel: string
  expiresAt: string
  prepareHandle: string
}

export interface GroupVoucherRedemptionResult {
  id: string
  publicId: string
  platform: string
  platformCode: GroupVoucherPlatformCode | null
  campaignName: string
  voucherCodeMasked: string
  faceValueMinor: number
  settlementAmountMinor: number
  currency: string
  isSettled: boolean
  providerCertificateId: string | null
  providerVerifyId: string | null
  redeemedBusinessDate: string
  redeemedAt: string
}
