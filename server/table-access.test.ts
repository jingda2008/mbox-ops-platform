import { describe, expect, it } from 'vitest'
import { signTableAccessToken, TableAccessError, verifyTableAccessToken } from './table-access.js'

const secret = 'q'.repeat(32)

describe('signed table access', () => {
  it('round trips an immutable table binding', () => {
    const token = signTableAccessToken({
      storeId: 'mbox-lujiazui', tableCode: 'L01', tokenVersion: 1, issuedAt: Date.now(),
    }, secret)
    expect(verifyTableAccessToken(token, secret)).toMatchObject({ tableCode: 'L01', tokenVersion: 1 })
  })

  it('rejects tampering and future issuance', () => {
    const token = signTableAccessToken({
      storeId: 'mbox-lujiazui', tableCode: 'L01', tokenVersion: 1, issuedAt: Date.now(),
    }, secret)
    expect(() => verifyTableAccessToken(`${token}x`, secret)).toThrow(TableAccessError)
    const future = signTableAccessToken({
      storeId: 'mbox-lujiazui', tableCode: 'L01', tokenVersion: 1, issuedAt: Date.now() + 120_000,
    }, secret)
    expect(() => verifyTableAccessToken(future, secret)).toThrow('声明无效')
  })
})
