import { createPrivateKey } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export interface NativePushConfig {
  environment: 'sandbox' | 'production'
  topic: string
  teamId: string
  keyId: string
  privateKey: string
  tokenKey: Buffer
  tokenKeyId: string
  eventTtlSeconds: number
}
/** Disabled is the default. No provider or device configuration is invented. */
export function readNativePushConfig(environment: Record<string, string | undefined>): NativePushConfig | null {
  const enabled = environment.MBOX_NATIVE_PUSH_ENABLED?.trim()
  if (enabled === undefined || enabled === '' || enabled === 'false') return null
  if (enabled !== 'true') throw new Error('MBOX_NATIVE_PUSH_ENABLED invalid')
  try {
    const apnsEnvironment = environment.MBOX_APNS_ENVIRONMENT?.trim()
    const topic = environment.MBOX_APNS_TOPIC?.trim() ?? ''
    const teamId = environment.MBOX_APNS_TEAM_ID?.trim() ?? ''
    const keyId = environment.MBOX_APNS_KEY_ID?.trim() ?? ''
    const path = environment.MBOX_APNS_PRIVATE_KEY_FILE?.trim() ?? ''
    const encoded = environment.MBOX_NATIVE_PUSH_TOKEN_KEY_BASE64?.trim() ?? ''
    const tokenKey = Buffer.from(encoded, 'base64')
    const tokenKeyId = environment.MBOX_NATIVE_PUSH_TOKEN_KEY_ID?.trim() ?? ''
    const eventTtlSeconds = Number(environment.MBOX_NATIVE_PUSH_EVENT_TTL_SECONDS ?? '300')
    if (!['sandbox', 'production'].includes(apnsEnvironment ?? '') || !/^[A-Za-z0-9][A-Za-z0-9.-]{2,199}$/.test(topic)
      || !/^[A-Z0-9]{10}$/.test(teamId) || !/^[A-Z0-9]{10}$/.test(keyId) || !isAbsolute(path)
      || tokenKey.length !== 32 || tokenKey.toString('base64') !== encoded || !/^[A-Za-z0-9_.-]{1,64}$/.test(tokenKeyId)
      || !Number.isInteger(eventTtlSeconds) || eventTtlSeconds < 1 || eventTtlSeconds > 900) throw new Error('invalid')
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o037) !== 0 || ![0, process.getuid?.() ?? stat.uid].includes(stat.uid)) throw new Error('unsafe key file')
    const privateKey = readFileSync(path, 'utf8'), key = createPrivateKey(privateKey)
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('invalid signing key')
    return { environment: apnsEnvironment as NativePushConfig['environment'], topic, teamId, keyId, privateKey, tokenKey, tokenKeyId, eventTtlSeconds }
  } catch { throw new Error('Native push enabled configuration is incomplete or invalid') }
}

/** Android is independently enabled: no APNs credentials are required. */
export interface GetuiPushConfig {
  appId: string
  appKey: string
  masterSecret: string
  environment: 'production'
  topic: string
  tokenKey: Buffer
  tokenKeyId: string
  eventTtlSeconds: number

}
export function readGetuiPushConfig(environment: Record<string, string | undefined>): GetuiPushConfig | null {
  const enabled = environment.MBOX_GETUI_ENABLED?.trim()
  if (enabled === undefined || enabled === '' || enabled === 'false') return null
  if (enabled !== 'true') throw new Error('MBOX_GETUI_ENABLED invalid')
  try {
    const appId = environment.MBOX_GETUI_APP_ID?.trim() ?? ''
    const appKey = environment.MBOX_GETUI_APP_KEY?.trim() ?? ''
    const path = environment.MBOX_GETUI_MASTER_SECRET_FILE?.trim() ?? ''
    const encoded = environment.MBOX_NATIVE_PUSH_TOKEN_KEY_BASE64?.trim() ?? ''
    const tokenKey = Buffer.from(encoded, 'base64')
    const tokenKeyId = environment.MBOX_NATIVE_PUSH_TOKEN_KEY_ID?.trim() ?? ''
    const eventTtlSeconds = Number(environment.MBOX_NATIVE_PUSH_EVENT_TTL_SECONDS ?? '300')
    if (!/^[A-Za-z0-9_-]{3,128}$/.test(appId) || !/^[A-Za-z0-9_-]{3,128}$/.test(appKey) || !isAbsolute(path)
      || tokenKey.length !== 32 || tokenKey.toString('base64') !== encoded || !/^[A-Za-z0-9_.-]{1,64}$/.test(tokenKeyId)
      || !Number.isInteger(eventTtlSeconds) || eventTtlSeconds < 1 || eventTtlSeconds > 900) throw new Error('invalid')
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > 1024 || (stat.mode & 0o037) !== 0 || ![0, process.getuid?.() ?? stat.uid].includes(stat.uid)) throw new Error('unsafe key file')
    const masterSecret = readFileSync(path, 'utf8').trim()
    if (!/^[A-Za-z0-9_-]{3,128}$/.test(masterSecret)) throw new Error('invalid secret')
    return { appId, appKey, masterSecret, environment: 'production', topic: appId, tokenKey, tokenKeyId, eventTtlSeconds }
  } catch { throw new Error('Getui push enabled configuration is incomplete or invalid') }
}
