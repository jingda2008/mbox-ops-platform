import { describe, expect, it } from 'vitest'
import { redactRequestUrl, requestLogSerializer } from './log-redaction.js'

describe('request log redaction', () => {
  it('redacts every credential-bearing query field without hiding useful routing context', () => {
    const redacted = redactRequestUrl('/guest?table=L01&token=secret&code=wechat-code&payOrder=order-1')
    expect(redacted).toBe('/guest?table=L01&token=REDACTED&code=REDACTED&payOrder=order-1')
    expect(redacted).not.toContain('secret')
    expect(redacted).not.toContain('wechat-code')
  })

  it('serializes request metadata with a sanitized URL', () => {
    expect(requestLogSerializer({
      method: 'POST',
      url: '/api/guest/session?sessionToken=private',
      headers: { host: 'mbox.example' },
      socket: { remoteAddress: '127.0.0.1', remotePort: 52100 },
    })).toEqual({
      method: 'POST',
      url: '/api/guest/session?sessionToken=REDACTED',
      host: 'mbox.example',
      remoteAddress: '127.0.0.1',
      remotePort: 52100,
    })
  })
})
