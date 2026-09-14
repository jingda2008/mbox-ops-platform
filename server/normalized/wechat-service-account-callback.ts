import {
  createDecipheriv,
  createHash,
  timingSafeEqual,
} from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'

const MAX_CLOCK_SKEW_SECONDS = 600
const MAX_XML_BYTES = 64 * 1024

export interface WechatServiceAccountCallbackConfig {
  appId: string
  token: string
  encodingAesKey: string
}

interface CallbackQuery {
  msg_signature?: unknown
  timestamp?: unknown
  nonce?: unknown
  echostr?: unknown
}

interface Options {
  config: Readonly<WechatServiceAccountCallbackConfig>
  now?: () => number
  handleEvent?: (xml: string) => Promise<boolean>
}

export const wechatServiceAccountCallbackPlugin: FastifyPluginAsync<Options> = async (app, options) => {
  const verifier = new WechatServiceAccountCallbackVerifier(options.config, options.now)

  app.addContentTypeParser(
    ['application/xml', 'text/xml'],
    { parseAs: 'string', bodyLimit: MAX_XML_BYTES },
    (_request, body, done) => done(null, body),
  )

  app.get<{ Querystring: CallbackQuery }>('/wechat/service-account/callback', async (request, reply) => {
    try {
      const echo = verifier.verifyChallenge(request.query)
      return reply.type('text/plain; charset=utf-8').send(echo)
    } catch {
      return reply.code(403).type('text/plain; charset=utf-8').send('forbidden')
    }
  })

  app.post<{ Querystring: CallbackQuery; Body: string }>('/wechat/service-account/callback', async (request, reply) => {
    let xml: string
    try {
      xml = verifier.verifyMessage(request.query, request.body)
    } catch {
      return reply.code(403).type('text/plain; charset=utf-8').send('forbidden')
    }
    try {
      const accepted = options.handleEvent === undefined ? false : await options.handleEvent(xml)
      if (!accepted) throw new Error('WeChat event handler unavailable')
      return reply.type('text/plain; charset=utf-8').send('success')
    } catch {
      return reply.code(503).type('text/plain; charset=utf-8').send('event handler unavailable')
    }
  })
}

export class WechatServiceAccountCallbackVerifier {
  private readonly key: Buffer
  private readonly iv: Buffer
  private readonly now: () => number

  constructor(
    private readonly config: Readonly<WechatServiceAccountCallbackConfig>,
    now: (() => number) | undefined = undefined,
  ) {
    if (!/^wx[A-Za-z0-9_-]{4,126}$/.test(config.appId)) throw new TypeError('WeChat service account appId is invalid')
    if (!/^[A-Za-z0-9]{3,32}$/.test(config.token)) throw new TypeError('WeChat service account callback token is invalid')
    if (!/^[A-Za-z0-9]{43}$/.test(config.encodingAesKey)) {
      throw new TypeError('WeChat service account EncodingAESKey is invalid')
    }
    this.key = Buffer.from(`${config.encodingAesKey}=`, 'base64')
    if (this.key.length !== 32) throw new TypeError('WeChat service account EncodingAESKey is invalid')
    this.iv = this.key.subarray(0, 16)
    this.now = now ?? Date.now
  }

  verifyChallenge(query: Readonly<CallbackQuery>): string {
    const encryptedEcho = field(query.echostr, 'echostr', 1, 8_192)
    this.verifySignature(query, encryptedEcho)
    return this.decrypt(encryptedEcho)
  }

  verifyMessage(query: Readonly<CallbackQuery>, body: unknown): string {
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_XML_BYTES) {
      throw new TypeError('WeChat callback body is invalid')
    }
    const encrypted = extractXmlCdata(body, 'Encrypt')
    this.verifySignature(query, encrypted)
    return this.decrypt(encrypted)
  }

  private verifySignature(query: Readonly<CallbackQuery>, encrypted: string): void {
    const signature = field(query.msg_signature, 'msg_signature', 40, 40)
    if (!/^[0-9a-f]{40}$/i.test(signature)) throw new TypeError('WeChat callback signature is invalid')
    const timestamp = field(query.timestamp, 'timestamp', 1, 16)
    if (!/^[0-9]{1,16}$/.test(timestamp)) throw new TypeError('WeChat callback timestamp is invalid')
    const timestampSeconds = Number(timestamp)
    if (!Number.isSafeInteger(timestampSeconds)
      || Math.abs(Math.floor(this.now() / 1_000) - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS) {
      throw new TypeError('WeChat callback timestamp is stale')
    }
    const nonce = field(query.nonce, 'nonce', 1, 256)
    const expected = createHash('sha1')
      .update([this.config.token, timestamp, nonce, encrypted].sort().join(''))
      .digest('hex')
    if (!safeEqual(signature.toLowerCase(), expected)) throw new TypeError('WeChat callback signature is invalid')
  }

  private decrypt(encrypted: string): string {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) throw new TypeError('WeChat callback ciphertext is invalid')
    const ciphertext = Buffer.from(encrypted, 'base64')
    if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
      throw new TypeError('WeChat callback ciphertext is invalid')
    }
    const decipher = createDecipheriv('aes-256-cbc', this.key, this.iv)
    decipher.setAutoPadding(false)
    const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const plaintext = removePkcs7Padding(padded)
    if (plaintext.length < 20) throw new TypeError('WeChat callback plaintext is invalid')
    const messageLength = plaintext.readUInt32BE(16)
    const messageEnd = 20 + messageLength
    if (messageLength < 1 || messageEnd > plaintext.length) throw new TypeError('WeChat callback plaintext is invalid')
    const appId = plaintext.subarray(messageEnd).toString('utf8')
    if (!safeEqual(appId, this.config.appId)) throw new TypeError('WeChat callback appId does not match')
    return plaintext.subarray(20, messageEnd).toString('utf8')
  }
}

function field(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new TypeError(`WeChat callback ${name} is invalid`)
  }
  return value
}

function extractXmlCdata(xml: string, element: string): string {
  const match = new RegExp(`<${element}>\\s*<!\\[CDATA\\[([\\s\\S]+?)\\]\\]>\\s*</${element}>`).exec(xml)
  if (!match?.[1]) throw new TypeError(`WeChat callback ${element} is missing`)
  return match[1].trim()
}

function removePkcs7Padding(value: Buffer): Buffer {
  const padding = value.at(-1)
  if (padding === undefined || padding < 1 || padding > 32 || padding > value.length) {
    throw new TypeError('WeChat callback padding is invalid')
  }
  const expected = Buffer.alloc(padding, padding)
  if (!timingSafeEqual(value.subarray(value.length - padding), expected)) {
    throw new TypeError('WeChat callback padding is invalid')
  }
  return value.subarray(0, value.length - padding)
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}
