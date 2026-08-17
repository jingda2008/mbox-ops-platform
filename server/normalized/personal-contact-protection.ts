import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import type { ProtectedContact } from './waitlist-repository.js'

export interface ActivityContactProtectionKeyring {
  readonly activeKeyId: string
  protect(value: string): ProtectedContact
  reveal(input: Readonly<{
    encryptedContact: Buffer
    contactHash: string
    encryptionKeyId: string
  }>): string
  hasKey(keyId: string): boolean
  protectPhone(value: string): Readonly<{
    contactHash: string; matchHashes: readonly string[]; encryptedValue: Buffer
    encryptionKeyId: string; maskedValue: string
  }>
  validateProbe(input:Readonly<{
    kind:'activity_registration_contact'|'verified_membership_phone'
    encryptionKeyId:string; contactHash:string; encryptedValue:Buffer
  }>):boolean
}

export interface ActivityContactKeyringConfig {
  activeKeyId: string
  activeKey: Buffer
  lookupKey: Buffer
  legacyPhoneLookupKey: Buffer
  previousKeys: readonly Readonly<{ keyId: string; key: Buffer }>[]
}

export class PersonalContactDecryptionError extends Error {
  constructor(readonly code: 'KEY_UNAVAILABLE' | 'CIPHERTEXT_INVALID' | 'HASH_MISMATCH') {
    super('受保护联系方式无法安全解密')
    this.name = 'PersonalContactDecryptionError'
  }
}

export function createActivityContactProtectionKeyring(
  config: ActivityContactKeyringConfig | null,
  legacySecret: string,
): ActivityContactProtectionKeyring {
  if (legacySecret.length < 16) throw new TypeError('Legacy activity contact protection secret is too short')
  const derivedLegacyActivityKey = createHash('sha256')
    .update(`mbox:reservation-contact:v1:${legacySecret}`, 'utf8').digest()
  const derivedLegacyPhoneKey = createHash('sha256')
    .update(`mbox:membership-recovery:encryption:${legacySecret}`).digest()
  const derivedLegacyPhoneLookupKey = createHmac('sha256',legacySecret)
    .update('mbox:membership-recovery:lookup:v1').digest()
  const activeKeyId = config?.activeKeyId ?? 'normalized-contact-v1'
  const activeKey = config?.activeKey ?? derivedLegacyActivityKey
  const lookupKey = config?.lookupKey ?? derivedLegacyActivityKey
  const legacyPhoneLookupKey = config?.legacyPhoneLookupKey ?? derivedLegacyPhoneLookupKey
  assertKey(activeKeyId, activeKey)
  if (lookupKey.length !== 32) throw new TypeError('Activity contact lookup key is invalid')
  const keys = new Map<string, Buffer>()
  for (const item of config?.previousKeys ?? []) {
    assertKey(item.keyId, item.key)
    if (keys.has(item.keyId) && !keys.get(item.keyId)!.equals(item.key)) {
      throw new TypeError('Activity contact key id is assigned to different key material')
    }
    keys.set(item.keyId, Buffer.from(item.key))
  }
  if (!keys.has('normalized-contact-v1')) keys.set('normalized-contact-v1',derivedLegacyActivityKey)
  if (!keys.has('normalized-phone-v1')) keys.set('normalized-phone-v1',derivedLegacyPhoneKey)
  if (keys.has(activeKeyId) && !keys.get(activeKeyId)!.equals(activeKey)) {
    throw new TypeError('Active activity contact key id conflicts with a previous key')
  }
  keys.set(activeKeyId, Buffer.from(activeKey))
  return Object.freeze({
    activeKeyId,
    hasKey(keyId: string) { return keys.has(keyId) },
    protect(value: string) {
      const normalized = value.trim()
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', activeKey, iv)
      const encrypted = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return {
        hash: createHmac('sha256', lookupKey).update(normalized, 'utf8').digest('hex'),
        encryptedBase64: Buffer.concat([Buffer.from([1]), iv, tag, encrypted]).toString('base64'),
        keyId: activeKeyId,
        masked: maskContact(normalized),
      }
    },
    reveal(input: Readonly<{
      encryptedContact: Buffer; contactHash: string; encryptionKeyId: string
    }>) {
      const key = keys.get(input.encryptionKeyId)
      if (!key) throw new PersonalContactDecryptionError('KEY_UNAVAILABLE')
      const envelope = input.encryptedContact
      if (envelope.length < 32 || envelope[0] !== 1) {
        throw new PersonalContactDecryptionError('CIPHERTEXT_INVALID')
      }
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(1, 13))
        decipher.setAuthTag(envelope.subarray(13, 29))
        const value = Buffer.concat([decipher.update(envelope.subarray(29)), decipher.final()]).toString('utf8')
        const hashKey = input.encryptionKeyId === 'normalized-contact-v1' ? key : lookupKey
        const actualHash = Buffer.from(createHmac('sha256', hashKey).update(value, 'utf8').digest('hex'), 'hex')
        const expectedHash = Buffer.from(input.contactHash, 'hex')
        if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
          throw new PersonalContactDecryptionError('HASH_MISMATCH')
        }
        return value
      } catch (error) {
        if (error instanceof PersonalContactDecryptionError) throw error
        throw new PersonalContactDecryptionError('CIPHERTEXT_INVALID')
      }
    },
    protectPhone(value: string) {
      const phone = value.trim()
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm',activeKey,iv)
      const encrypted = Buffer.concat([cipher.update(phone,'utf8'),cipher.final()])
      const contactHash = createHmac('sha256',lookupKey).update(phone).digest('hex')
      const legacyHash = createHmac('sha256',legacyPhoneLookupKey).update(phone).digest('hex')
      return {
        contactHash,
        matchHashes:Object.freeze(contactHash === legacyHash ? [contactHash] : [contactHash,legacyHash]),
        encryptedValue:Buffer.concat([Buffer.from([1]),iv,cipher.getAuthTag(),encrypted]),
        encryptionKeyId:activeKeyId,
        maskedValue:maskContact(phone),
      }
    },
    validateProbe(input:Readonly<{
      kind:'activity_registration_contact'|'verified_membership_phone'
      encryptionKeyId:string; contactHash:string; encryptedValue:Buffer
    }>) {
      const key=keys.get(input.encryptionKeyId)
      if (!key) return false
      try {
        if (input.kind==='activity_registration_contact') {
          const envelope=input.encryptedValue
          if (envelope.length<32 || envelope[0]!==1) return false
          const decipher=createDecipheriv('aes-256-gcm',key,envelope.subarray(1,13))
          decipher.setAuthTag(envelope.subarray(13,29))
          const value=Buffer.concat([decipher.update(envelope.subarray(29)),decipher.final()]).toString('utf8')
          const hashKey=input.encryptionKeyId==='normalized-contact-v1'?key:lookupKey
          return createHmac('sha256',hashKey).update(value).digest('hex')===input.contactHash
        }
        const envelope=input.encryptedValue
        const legacy=input.encryptionKeyId==='normalized-phone-v1'
        const offset=legacy?0:1
        if (envelope.length<31+offset || (!legacy && envelope[0]!==1)) return false
        const decipher=createDecipheriv('aes-256-gcm',key,envelope.subarray(offset,offset+12))
        decipher.setAuthTag(envelope.subarray(offset+12,offset+28))
        const value=Buffer.concat([decipher.update(envelope.subarray(offset+28)),decipher.final()]).toString('utf8')
        const hashKey=legacy?legacyPhoneLookupKey:lookupKey
        return createHmac('sha256',hashKey).update(value).digest('hex')===input.contactHash
      } catch { return false }
    },
  })
}

function assertKey(keyId: string, key: Buffer) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(keyId) || key.length !== 32) {
    throw new TypeError('Activity contact key id or key material is invalid')
  }
}

function maskContact(value: string): string {
  if (/^1\d{10}$/.test(value)) return `${value.slice(0, 3)}****${value.slice(-4)}`
  if (value.length <= 4) return '*'.repeat(value.length)
  return `${value.slice(0, 2)}***${value.slice(-2)}`
}
