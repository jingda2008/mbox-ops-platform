import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import type { StoreScope } from './transaction-runner.js'

export function revocationHash(secret: string): string {
  return createHash('sha256').update('mbox:native-push:revocation:v1\0').update(secret).digest('hex')
}
export function canonicalRevocationSecret(secret: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(secret) && Buffer.from(secret, 'base64url').length === 32
    && Buffer.from(secret, 'base64url').toString('base64url') === secret
}
export class NativePushProtection {
  constructor(private readonly key: Buffer, readonly keyId: string, private readonly lookupSecret: string) {
    if (key.length !== 32 || !/^[A-Za-z0-9_.-]{1,64}$/.test(keyId) || lookupSecret.length < 32) throw new Error('Invalid native push protection configuration')
  }
  hash(token: string) { return createHmac('sha256', this.lookupSecret).update('mbox:native-push:token:v1\0').update(token).digest('hex') }
  private aad(scope: StoreScope, id: string, revision: number) { return Buffer.from(JSON.stringify(['mbox-native-push-v1', scope.tenantId, scope.storeId, id, revision])) }
  protect(token: string, scope: StoreScope, id: string, revision: number): Buffer {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(this.aad(scope, id, revision))
    const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), data])
  }
  reveal(value: Buffer, keyId: string, scope: StoreScope, id: string, revision: number): string {
    try {
      if (keyId !== this.keyId || value.length < 30 || value[0] !== 1) throw new Error('invalid')
      const cipher = createDecipheriv('aes-256-gcm', this.key, value.subarray(1, 13))
      cipher.setAuthTag(value.subarray(13, 29)); cipher.setAAD(this.aad(scope, id, revision))
      return Buffer.concat([cipher.update(value.subarray(29)), cipher.final()]).toString('utf8')
    } catch { throw new Error('Native push token unavailable') }
  }
}
