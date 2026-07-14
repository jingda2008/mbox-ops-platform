import { createHmac, timingSafeEqual } from 'node:crypto'
import type {
  GuestSessionClaims,
  StaticTableQrClaims,
  TableAccessClaims,
} from '../src/shared/guest-contracts.js'

const MAX_GUEST_SESSION_TTL_MS = 60 * 60_000

export class TableAccessError extends Error {
  constructor(message: string, readonly code = 'TABLE_ACCESS_INVALID', readonly statusCode = 401) {
    super(message)
  }
}

function signature(payload: string, secret: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function signTableAccessToken(claims: Omit<TableAccessClaims, 'version'>, secret: string) {
  if (secret.length < 32) throw new Error('桌码签名密钥至少需要32个字符')
  const payload = Buffer.from(JSON.stringify({ version: 2, ...claims })).toString('base64url')
  return `${payload}.${signature(payload, secret)}`
}

export function signStaticTableQrToken(claims: Omit<StaticTableQrClaims, 'version' | 'tokenType'>, secret: string) {
  return signTableAccessToken({ tokenType: 'table_qr', ...claims }, secret)
}

export function signGuestSessionToken(claims: Omit<GuestSessionClaims, 'version' | 'tokenType'>, secret: string) {
  if (claims.expiresAt <= claims.issuedAt) throw new Error('客人桌次令牌到期时间必须晚于签发时间')
  if (claims.expiresAt - claims.issuedAt > MAX_GUEST_SESSION_TTL_MS) {
    throw new Error('客人桌次令牌有效期不能超过60分钟')
  }
  return signTableAccessToken({ tokenType: 'guest_session', ...claims }, secret)
}

export function verifyTableAccessToken(token: string, secret: string, now = Date.now()): TableAccessClaims {
  const [payload, suppliedSignature, extra] = token.split('.')
  if (!payload || !suppliedSignature || extra) throw new TableAccessError('桌码格式无效')
  const expected = Buffer.from(signature(payload, secret))
  const supplied = Buffer.from(suppliedSignature)
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new TableAccessError('桌码签名无效')
  }
  let claims: TableAccessClaims
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TableAccessClaims
  } catch {
    throw new TableAccessError('桌码载荷无效')
  }
  if (
    claims.version !== 2 || !claims.storeId || !claims.tableCode ||
    !Number.isSafeInteger(claims.tokenVersion) || claims.tokenVersion < 1 ||
    !Number.isSafeInteger(claims.issuedAt) || claims.issuedAt > now + 60_000 ||
    !['table_qr', 'guest_session'].includes(claims.tokenType)
  ) {
    throw new TableAccessError('桌码声明无效')
  }
  if (claims.tokenType === 'guest_session') {
    if (
      !claims.tableSessionId || !Number.isSafeInteger(claims.expiresAt) ||
      claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > MAX_GUEST_SESSION_TTL_MS
    ) {
      throw new TableAccessError('客人桌次令牌声明无效')
    }
    if (claims.expiresAt <= now) {
      throw new TableAccessError('客人桌次令牌已过期，请重新扫码', 'GUEST_SESSION_EXPIRED', 401)
    }
  }
  return claims
}

export function requireStaticTableQr(claims: TableAccessClaims): StaticTableQrClaims {
  if (claims.tokenType !== 'table_qr') {
    throw new TableAccessError('需要实体桌码凭证', 'TABLE_QR_REQUIRED', 401)
  }
  return claims
}

export function requireGuestSession(claims: TableAccessClaims): GuestSessionClaims {
  if (claims.tokenType !== 'guest_session') {
    throw new TableAccessError('请先用桌上二维码建立本次桌台会话', 'GUEST_SESSION_REQUIRED', 401)
  }
  return claims
}
