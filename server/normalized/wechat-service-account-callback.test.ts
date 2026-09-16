import { createCipheriv, createHash } from 'node:crypto'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import {
  wechatServiceAccountCallbackPlugin,
  type WechatServiceAccountCallbackConfig,
} from './wechat-service-account-callback.js'

const NOW = 1_789_347_600_000
const TIMESTAMP = String(Math.floor(NOW / 1_000))
const NONCE = 'callback-nonce-1'
const KEY = Buffer.alloc(32, 7)
const config: WechatServiceAccountCallbackConfig = {
  appId: 'wxMboxService01',
  token: 'MBoxCallbackToken2026',
  encodingAesKey: KEY.toString('base64').slice(0, -1),
}

describe('wechatServiceAccountCallbackPlugin', () => {
  it('verifies and decrypts a safe-mode WeChat URL challenge', async () => {
    const app = Fastify()
    await app.register(wechatServiceAccountCallbackPlugin, { config, now: () => NOW })
    const encryptedEcho = encrypt('wechat-echo-value', config)

    const response = await app.inject({
      method: 'GET',
      url: `/wechat/service-account/callback?timestamp=${TIMESTAMP}&nonce=${NONCE}`
        + `&echostr=${encodeURIComponent(encryptedEcho)}`
        + `&msg_signature=${signature(encryptedEcho)}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/plain')
    expect(response.body).toBe('wechat-echo-value')
    await app.close()
  })

  it('rejects a forged or stale URL challenge without exposing details', async () => {
    const app = Fastify()
    await app.register(wechatServiceAccountCallbackPlugin, { config, now: () => NOW })
    const encryptedEcho = encrypt('wechat-echo-value', config)

    const forged = await app.inject({
      method: 'GET',
      url: `/wechat/service-account/callback?timestamp=${TIMESTAMP}&nonce=${NONCE}`
        + `&echostr=${encodeURIComponent(encryptedEcho)}&msg_signature=${'0'.repeat(40)}`,
    })
    const stale = await app.inject({
      method: 'GET',
      url: `/wechat/service-account/callback?timestamp=1&nonce=${NONCE}`
        + `&echostr=${encodeURIComponent(encryptedEcho)}`
        + `&msg_signature=${signature(encryptedEcho, '1')}`,
    })

    expect(forged.statusCode).toBe(403)
    expect(forged.body).toBe('forbidden')
    expect(stale.statusCode).toBe(403)
    await app.close()
  })

  it('decrypts signed POST events and fails closed without a durable handler', async () => {
    const event = '<xml><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event></xml>'
    const encrypted = encrypt(event, config)
    const body = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`

    const unavailable = Fastify()
    await unavailable.register(wechatServiceAccountCallbackPlugin, { config, now: () => NOW })
    const unavailableResponse = await unavailable.inject({
      method: 'POST',
      url: callbackUrl(encrypted),
      headers: { 'content-type': 'text/xml' },
      payload: body,
    })
    expect(unavailableResponse.statusCode).toBe(503)
    await unavailable.close()

    let received = ''
    const available = Fastify()
    await available.register(wechatServiceAccountCallbackPlugin, {
      config,
      now: () => NOW,
      handleEvent: async (xml) => {
        received = xml
        return true
      },
    })
    const response = await available.inject({
      method: 'POST',
      url: callbackUrl(encrypted),
      headers: { 'content-type': 'application/xml' },
      payload: body,
    })
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('success')
    expect(received).toBe(event)
    await available.close()
  })
})

function callbackUrl(encrypted: string): string {
  return `/wechat/service-account/callback?timestamp=${TIMESTAMP}&nonce=${NONCE}`
    + `&msg_signature=${signature(encrypted)}`
}

function signature(encrypted: string, timestamp = TIMESTAMP): string {
  return createHash('sha1')
    .update([config.token, timestamp, NONCE, encrypted].sort().join(''))
    .digest('hex')
}

function encrypt(message: string, target: WechatServiceAccountCallbackConfig): string {
  const messageBytes = Buffer.from(message, 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(messageBytes.length)
  const plaintext = Buffer.concat([
    Buffer.alloc(16, 3),
    length,
    messageBytes,
    Buffer.from(target.appId, 'utf8'),
  ])
  const paddingLength = 32 - (plaintext.length % 32)
  const padded = Buffer.concat([plaintext, Buffer.alloc(paddingLength, paddingLength)])
  const cipher = createCipheriv('aes-256-cbc', KEY, KEY.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64')
}

it('preserves signed plaintext URL verification while rejecting unsigned challenges',async()=>{
 const app=Fastify();await app.register(wechatServiceAccountCallbackPlugin,{config,now:()=>NOW});
 const plainSignature=createHash('sha1').update([config.token,TIMESTAMP,NONCE].sort().join('')).digest('hex');
 const query=`?timestamp=${TIMESTAMP}&nonce=${NONCE}&echostr=plain-echo`;
 expect((await app.inject('/wechat/service-account/callback'+query+'&signature='+plainSignature)).body).toBe('plain-echo');
 expect((await app.inject('/wechat/service-account/callback'+query)).statusCode).toBe(403);await app.close();
})
it('accepts only an explicitly configured additional callback account',async()=>{
 const app=Fastify();const official='wxConfiguredOfficial';await app.register(wechatServiceAccountCallbackPlugin,{config:{...config,officialAccountAppId:official},now:()=>NOW});
 for(const [appId,status] of [[official,200],['wxUnconfiguredOther',403]] as const){const echo=encrypt('echo',{...config,appId});const response=await app.inject(`/wechat/service-account/callback?timestamp=${TIMESTAMP}&nonce=${NONCE}&echostr=${encodeURIComponent(echo)}&msg_signature=${signature(echo)}`);expect(response.statusCode).toBe(status)}await app.close();
})
