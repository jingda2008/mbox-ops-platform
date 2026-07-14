import { createHmac, timingSafeEqual } from 'node:crypto'
import type { TableAccessClaims } from '../src/shared/guest-contracts.js'

export class TableAccessError extends Error {
  constructor(message: string, readonly code = 'TABLE_ACCESS_INVALID', readonly statusCode = 401) {
    super(message)
  }
}

function signature(payload: string, secret: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function signTableAccessToken(
  claims: Omit<TableAccessClaims, 'version'>,
  secret: string,
) {
  if (secret.length < 32) throw new Error('桌码签名密钥至少需要32个字符')
  const payload = Buffer.from(JSON.stringify({ version: 1, ...claims })).toString('base64url')
  return `${payload}.${signature(payload, secret)}`
}

export function verifyTableAccessToken(token: string, secret: string): TableAccessClaims {
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
    claims.version !== 1 || !claims.storeId || !claims.tableCode ||
    !Number.isSafeInteger(claims.tokenVersion) || claims.tokenVersion < 1 ||
    !Number.isSafeInteger(claims.issuedAt) || claims.issuedAt > Date.now() + 60_000
  ) {
    throw new TableAccessError('桌码声明无效')
  }
  return claims
}
