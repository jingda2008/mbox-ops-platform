import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import type {
  MembershipRecoveryPhoneAuthorizationPort,
  MiniProgramPhoneAuthorizationProvider,
  VerifiedRecoveryPhoneAuthorization,
} from './membership-recovery-service.js'

export interface OfficialAlipayPhoneAuthorizationOptions {
  appId: string
  aesKey: string
  now?: () => Date
}

const ZERO_IV = Buffer.alloc(16, 0)

export class OfficialAlipayPhoneAuthorizationProvider
implements MembershipRecoveryPhoneAuthorizationPort {
  private readonly aesKey: Buffer
  private readonly now: () => Date

  constructor(options: Readonly<OfficialAlipayPhoneAuthorizationOptions>) {
    if (!/^20\d{14,18}$/.test(options.appId)) throw new TypeError('Alipay AppID is invalid')
    this.aesKey = parseAesKey(options.aesKey)
    this.now = options.now ?? (() => new Date())
  }

  async verify(input: Readonly<{
    authorizationCode: string
    customerId: string
  }>): Promise<VerifiedRecoveryPhoneAuthorization> {
    if (!/^[0-9a-f-]{36}$/i.test(input.customerId)) {
      throw new CustomerExperienceRequestError(
        '会员会话无效，请完全关闭支付宝小程序后重新打开再授权',
        'ALIPAY_PHONE_SESSION_INVALID',
        401,
      )
    }
    if (readPlaintextPhonePayload(input.authorizationCode)) {
      throw new CustomerExperienceRequestError(
        '支付宝返回了未加密手机号报文，服务端拒绝入会。请确认开放平台已配置接口内容加密后再用真机授权',
        'ALIPAY_PHONE_PLAINTEXT_REJECTED',
        400,
      )
    }
    const candidates = collectCiphertextCandidates(input.authorizationCode)
    let stage = candidates.length === 0 ? 'empty' : 'decrypt'
    let parseHint: Record<string, unknown> | null = null
    let providerError: CustomerExperienceRequestError | null = null
    let acceptedCiphertext = ''
    for (const ciphertext of candidates) {
      let decrypted = ''
      try {
        decrypted = decryptAesCbc(ciphertext, this.aesKey)
      } catch {
        stage = 'decrypt'
        continue
      }
      try {
        const payload = parseDecryptedPhone(decrypted)
        acceptedCiphertext = ciphertext
        const e164Phone = toE164(payload.mobile)
        return {
          e164Phone,
          providerReference: `alipay-phone:${createHash('sha256').update(acceptedCiphertext).digest('hex')}`,
          verifiedAt: this.now().toISOString(),
        }
      } catch (error) {
        stage = 'parse'
        parseHint = describeDecryptedPhoneFailure(decrypted, error)
        if (error instanceof CustomerExperienceRequestError
          && error.code !== 'ALIPAY_PHONE_AUTHORIZATION_INVALID') {
          providerError = error
          break
        }
        if (error instanceof CustomerExperienceRequestError) {
          providerError = error
        }
      }
    }
    console.error('ALIPAY_PHONE_VERIFY_FAILED', JSON.stringify({
      stage,
      candidateCount: candidates.length,
      payloadKind: classifyPhonePayload(input.authorizationCode),
      payloadLength: String(input.authorizationCode || '').length,
      ...(parseHint || {}),
    }))
    if (providerError) throw providerError
    throw invalidAuthorization()
  }
}

export class MiniProgramPhoneAuthorizationRouter
implements MembershipRecoveryPhoneAuthorizationPort {
  constructor(private readonly options: Readonly<{
    wechat?: MembershipRecoveryPhoneAuthorizationPort
    alipay?: MembershipRecoveryPhoneAuthorizationPort
  }>) {}

  async verify(input: Readonly<{
    authorizationCode: string
    customerId: string
    provider?: MiniProgramPhoneAuthorizationProvider
  }>) {
    if (shouldUseAlipayPhoneProvider(input.provider, input.authorizationCode)) {
      if (this.options.alipay === undefined) {
        throw new CustomerExperienceRequestError(
          '支付宝手机号入会尚未接通，请用微信小程序授权，或联系门店配置支付宝 AES 密钥后重试',
          'ALIPAY_PHONE_NOT_CONFIGURED',
          503,
        )
      }
      return this.options.alipay.verify(input)
    }
    if (this.options.wechat === undefined) {
      throw new CustomerExperienceRequestError(
        '微信手机号入会尚未接通',
        'MEMBERSHIP_ENROLLMENT_PHONE_NOT_CONFIGURED',
        503,
      )
    }
    return this.options.wechat.verify(input)
  }
}

export function shouldUseAlipayPhoneProvider(
  provider: MiniProgramPhoneAuthorizationProvider | undefined,
  authorizationCode: string,
): boolean {
  if (provider === 'alipay') return true
  if (provider === 'wechat') return false
  return looksLikeAlipayPhonePayload(authorizationCode)
}

export function looksLikeAlipayPhonePayload(value: string): boolean {
  const code = String(value || '').trim()
  if (!code) return false
  if (code.startsWith('{') || code.startsWith('%7B') || code.startsWith('%7b')) return true
  if (code.length > 80) return true
  return /[+/=]/.test(code) && code.length > 40
}

export function encryptAlipayPhoneFixture(mobile: string, aesKey: string): string {
  const key = parseAesKey(aesKey)
  const cipher = createCipheriv('aes-128-cbc', key, ZERO_IV)
  const plaintext = JSON.stringify({ code: '10000', msg: 'Success', mobile })
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64')
}

function collectCiphertextCandidates(raw: string): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  const visit = (value: string, depth: number) => {
    const trimmed = String(value || '').trim()
    if (!trimmed || depth > 4) return
    const decoded = decodeMaybeUri(trimmed)
    for (const candidate of [trimmed, decoded, normalizeBase64(trimmed), normalizeBase64(decoded)]) {
      if (!candidate || seen.has(candidate)) continue
      if (candidate.startsWith('{') || candidate.startsWith('%')) continue
      seen.add(candidate)
      output.push(candidate)
    }
    const parsed = tryParseJson(decoded)
    if (!parsed) return
    for (const key of ['response', 'encryptedData', 'encrypted_data']) {
      const nested = parsed[key]
      if (typeof nested === 'string') visit(nested, depth + 1)
      else if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        visit(JSON.stringify(nested), depth + 1)
      }
    }
  }
  visit(String(raw || ''), 0)
  return output
}

function classifyPhonePayload(raw: string): string {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return 'empty'
  if (readPlaintextPhonePayload(trimmed)) return 'plaintext-json'
  if (trimmed.startsWith('{') || trimmed.startsWith('%7B') || trimmed.startsWith('%7b')) return 'json-wrapper'
  if (trimmed.length > 40) return 'raw-cipher'
  return 'short'
}

function readPlaintextPhonePayload(raw: string): { mobile: string } | null {
  const parsed = tryParseJson(decodeMaybeUri(String(raw || '').trim()))
  if (!parsed) return null
  const nested = parsed.response && typeof parsed.response === 'object' && !Array.isArray(parsed.response)
    ? parsed.response as Record<string, unknown>
    : typeof parsed.response === 'string' ? tryParseJson(parsed.response) : null
  return asPlainPhone(parsed) ?? (nested ? asPlainPhone(nested) : null)
}

function asPlainPhone(record: Record<string, unknown>): { mobile: string } | null {
  const mobile = String(record.mobile || record.phoneNumber || record.phone || '').trim()
  const code = String(record.code || '').trim()
  if (!/^[0-9]{7,15}$/.test(mobile)) return null
  if (code && code !== '10000') return null
  return { mobile }
}

function tryParseJson(value: string): Record<string, unknown> | null {
  if (!value.startsWith('{')) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function decodeMaybeUri(value: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(value)) return value
  try { return decodeURIComponent(value) } catch { return value }
}

function normalizeBase64(value: string): string {
  return value.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')
}

function decryptAesCbc(ciphertext: string, key: Buffer): string {
  const decipher = createDecipheriv('aes-128-cbc', key, ZERO_IV)
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

function parseDecryptedPhone(decrypted: string): { mobile: string } {
  const providerError = readAlipayProviderError(decrypted)
  if (providerError) throw providerError
  const mobile = findMobileInDecrypted(decrypted)
  if (!mobile) {
    throw new CustomerExperienceRequestError(
      '支付宝手机号明文缺少可用号码',
      'ALIPAY_PHONE_AUTHORIZATION_INVALID',
      400,
    )
  }
  return { mobile }
}

function readAlipayProviderError(decrypted: string): CustomerExperienceRequestError | null {
  const root = decodeJsonTree(decrypted)
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null
  const record = root as Record<string, unknown>
  const code = String(record.code ?? record.errorCode ?? '').trim()
  const subCode = String(record.subCode ?? record.sub_code ?? '').trim()
  const subMsg = String(record.subMsg ?? record.sub_msg ?? '').trim()
  const msg = String(record.msg ?? record.errorMessage ?? '').trim()
  if (!code || code === '10000') return null
  if (hasMobileField(record)) return null
  if (
    code === '40001'
    || /missing-encrypt-key|missing-default-signature|Missing Required Arguments/i.test(`${subCode} ${subMsg} ${msg}`)
  ) {
    return new CustomerExperienceRequestError(
      '支付宝开放平台仍缺接口内容加密、接口加签或应用网关配置。后台已能解密，但支付宝返回的是配置错误而不是手机号。请在开放平台补齐这三项后，在小程序里解除用户信息授权再重试',
      'ALIPAY_PHONE_PLATFORM_CONFIG',
      503,
    )
  }
  if (code === '40003' || /无效的授权|invalid.*auth/i.test(`${subCode} ${subMsg} ${msg}`)) {
    return new CustomerExperienceRequestError(
      '支付宝手机号授权关系无效，请直接点入会按钮重新授权，不要只登录支付宝账号',
      'ALIPAY_PHONE_AUTHORIZATION_INVALID',
      400,
    )
  }
  return new CustomerExperienceRequestError(
    `支付宝未返回手机号（${code}${subCode ? `/${subCode}` : ''}）。请检查开放平台手机号能力与开发设置后重试`,
    'ALIPAY_PHONE_AUTHORIZATION_INVALID',
    400,
  )
}

function hasMobileField(record: Record<string, unknown>): boolean {
  return ['mobile', 'phoneNumber', 'phone', 'mobileNumber', 'phone_number']
    .some((key) => record[key] !== undefined && record[key] !== null && String(record[key]).trim() !== '')
}

function findMobileInDecrypted(decrypted: string): string | null {
  const root = decodeJsonTree(decrypted)
  if (root === null) return null
  return findMobileValue(root, 0)
}

function decodeJsonTree(value: unknown, depth = 0): unknown {
  if (depth > 5) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return trimmed
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return trimmed
    try {
      return decodeJsonTree(JSON.parse(trimmed), depth + 1)
    } catch {
      return trimmed
    }
  }
  return value
}

function findMobileValue(value: unknown, depth: number): string | null {
  if (depth > 6 || value === null || value === undefined) return null
  if (typeof value === 'string') {
    const normalized = normalizeMobileDigits(value)
    return normalized || null
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findMobileValue(entry, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const code = String(record.code ?? record.errorCode ?? record.sub_code ?? '').trim()
  if (code && !['10000', 'Success', 'success'].includes(code) && !record.mobile && !record.phoneNumber && !record.phone) {
    // Keep searching nested success payloads; only reject later if no mobile exists.
  }
  for (const key of ['mobile', 'phoneNumber', 'phone', 'mobileNumber', 'phone_number']) {
    if (record[key] === undefined || record[key] === null) continue
    const found = findMobileValue(record[key], depth + 1)
    if (found) return found
  }
  for (const key of Object.keys(record)) {
    if (['sign', 'sign_type', 'encrypt_type', 'charset'].includes(key)) continue
    const found = findMobileValue(record[key], depth + 1)
    if (found) return found
  }
  return null
}

function normalizeMobileDigits(raw: string): string | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  if (/^\+[1-9][0-9]{7,14}$/.test(trimmed)) {
    return trimmed.slice(1)
  }
  const compact = trimmed.replace(/[\s()-]/g, '')
  if (/^\+?[0-9]{7,15}$/.test(compact)) {
    return compact.replace(/^\+/, '')
  }
  // Alipay overseas examples may look like "1-1234432112".
  const digits = trimmed.replace(/[^\d]/g, '')
  if (/^[0-9]{7,15}$/.test(digits)) return digits
  return null
}

function toE164(mobile: string): string {
  const digits = mobile.replace(/[^\d]/g, '').replace(/^0+/, '')
  if (!digits) throw invalidAuthorization()
  const e164 = digits.startsWith('86') && digits.length >= 13 ? `+${digits}` : `+86${digits}`
  if (!/^\+[1-9][0-9]{7,14}$/.test(e164)) throw invalidAuthorization()
  return e164
}

function describeDecryptedPhoneFailure(
  decrypted: string,
  error: unknown,
): Record<string, unknown> {
  const root = decodeJsonTree(decrypted)
  const keys = root && typeof root === 'object' && !Array.isArray(root)
    ? Object.keys(root as Record<string, unknown>).slice(0, 12)
    : []
  const record = root && typeof root === 'object' && !Array.isArray(root)
    ? root as Record<string, unknown>
    : null
  const code = record ? String(record.code ?? record.errorCode ?? '') : ''
  const subCode = record ? String(record.subCode ?? record.sub_code ?? '') : ''
  const msg = record
    ? String(record.subMsg ?? record.sub_msg ?? record.msg ?? record.errorMessage ?? '').slice(0, 80)
    : ''
  const mobileRaw = record
    ? String(record.mobile ?? record.phoneNumber ?? record.phone ?? '')
    : ''
  return {
    decryptedKind: typeof root,
    decryptedKeys: keys,
    providerCode: code || null,
    providerSubCode: subCode || null,
    providerMsg: msg || null,
    mobileRawLength: mobileRaw.length,
    mobileLooksNumeric: /^[+\d\s()-]+$/.test(mobileRaw),
    parseError: error instanceof Error ? error.message.slice(0, 80) : 'unknown',
  }
}

function parseAesKey(value: string): Buffer {
  const trimmed = value.trim()
  const utf8 = Buffer.from(trimmed, 'utf8')
  if (utf8.length === 16) return utf8
  const hex = /^[0-9a-fA-F]{32}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : null
  if (hex && hex.length === 16) return hex
  try {
    const b64 = Buffer.from(trimmed, 'base64')
    if (b64.length === 16) return b64
  } catch {
    // fall through
  }
  throw new TypeError('Alipay AES key must be 16 bytes')
}

function invalidAuthorization(): CustomerExperienceRequestError {
  return new CustomerExperienceRequestError(
    '支付宝手机号授权无效或已过期，请重新授权',
    'ALIPAY_PHONE_AUTHORIZATION_INVALID',
    400,
  )
}
