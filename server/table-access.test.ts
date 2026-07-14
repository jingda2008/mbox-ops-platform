import { describe, expect, it } from 'vitest'
import {
  requireGuestSession,
  requireStaticTableQr,
  signGuestSessionToken,
  signStaticTableQrToken,
  TableAccessError,
  verifyTableAccessToken,
} from './table-access.js'

const secret = 'q'.repeat(32)

describe('signed table access', () => {
  it('round trips a long-lived static table QR without write-session claims', () => {
    const token = signStaticTableQrToken({
      storeId: 'mbox-lujiazui', tableCode: 'L01', tokenVersion: 1, issuedAt: Date.now(),
    }, secret)
    const claims = verifyTableAccessToken(token, secret)
    expect(requireStaticTableQr(claims)).toMatchObject({
      version: 2, tokenType: 'table_qr', tableCode: 'L01', tokenVersion: 1,
    })
    expect(() => requireGuestSession(claims)).toThrow('建立本次桌台会话')
  })

  it('round trips a short-lived token bound to an open table session', () => {
    const now = Date.now()
    const token = signGuestSessionToken({
      storeId: 'mbox-lujiazui', tableCode: 'L01', tableSessionId: 'visit-l01-1',
      tokenVersion: 3, issuedAt: now, expiresAt: now + 15 * 60_000,
    }, secret)
    expect(requireGuestSession(verifyTableAccessToken(token, secret, now))).toMatchObject({
      tokenType: 'guest_session', tableSessionId: 'visit-l01-1', tokenVersion: 3,
      expiresAt: now + 15 * 60_000,
    })
  })

  it('rejects tampering, future issuance, expiry and invalid token type use', () => {
    const now = Date.now()
    const token = signStaticTableQrToken({
      storeId: 'mbox-lujiazui', tableCode: 'L01', tokenVersion: 1, issuedAt: Date.now(),
    }, secret)
    expect(() => verifyTableAccessToken(`${token}x`, secret)).toThrow(TableAccessError)
    const future = signStaticTableQrToken({
      storeId: 'mbox-lujiazui', tableCode: 'L01', tokenVersion: 1, issuedAt: now + 120_000,
    }, secret)
    expect(() => verifyTableAccessToken(future, secret, now)).toThrow('声明无效')

    const expired = signGuestSessionToken({
      storeId: 'mbox-lujiazui', tableCode: 'L01', tableSessionId: 'visit-l01-1',
      tokenVersion: 1, issuedAt: now - 120_000, expiresAt: now - 1,
    }, secret)
    expect(() => verifyTableAccessToken(expired, secret, now)).toThrow('已过期')
    expect(() => requireStaticTableQr(verifyTableAccessToken(
      signGuestSessionToken({
        storeId: 'mbox-lujiazui', tableCode: 'L01', tableSessionId: 'visit-l01-1',
        tokenVersion: 1, issuedAt: now, expiresAt: now + 60_000,
      }, secret),
      secret,
      now,
    ))).toThrow('实体桌码')
    expect(() => signGuestSessionToken({
      storeId: 'mbox-lujiazui', tableCode: 'L01', tableSessionId: 'visit-l01-1',
      tokenVersion: 1, issuedAt: now, expiresAt: now + 60 * 60_000 + 1,
    }, secret)).toThrow('不能超过60分钟')
  })
})
