import { lookup } from 'node:dns/promises'
import { connect } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { loadNormalizedRuntimeConfig } from './normalized/normalized-runtime-config.js'

export interface RuntimePreflightReport {
  schemaVersion: 1
  checkedAt: string
  status: 'pass'
  configVersion: string
  deploymentTier: string
  releaseSha: string
  imageDigest: string | null
  modes: Record<string, string>
  externalHosts: string[]
}

export async function verifyNormalizedRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  checkExternal = false,
): Promise<RuntimePreflightReport> {
  const config = loadNormalizedRuntimeConfig(environment)
  const expectedSha = environment.MBOX_EXPECTED_RELEASE_SHA?.trim()
  const expectedDigest = environment.MBOX_EXPECTED_IMAGE_DIGEST?.trim()
  if (expectedSha && config.commitSha !== expectedSha) throw new Error('发布提交身份与配置不一致')
  if (expectedDigest && config.releaseImageDigest !== expectedDigest) throw new Error('镜像摘要身份与配置不一致')

  const externalUrls = [
    environment.MBOX_PUBLIC_URL,
    config.payment?.callbackUrl,
    config.integrations.ai?.endpoint,
    config.integrations.printingEndpoint,
    config.integrations.headsetEndpoint,
  ].filter((value): value is string => Boolean(value?.trim()))
  const hosts = [...new Set(externalUrls.map((value) => new URL(value).hostname))].toSorted()
  if (checkExternal) {
    for (const hostname of hosts) await verifyDnsAndTls(hostname)
  }

  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    status: 'pass',
    configVersion: config.configVersion,
    deploymentTier: config.deploymentTier,
    releaseSha: config.commitSha,
    imageDigest: config.releaseImageDigest,
    modes: { ...config.integrations.modes },
    externalHosts: hosts,
  }
}

async function verifyDnsAndTls(hostname: string) {
  await lookup(hostname)
  await new Promise<void>((resolvePromise, reject) => {
    const socket = connect({ host: hostname, port: 443, servername: hostname, timeout: 8_000 }, () => {
      if (!socket.authorized) {
        const reason = socket.authorizationError
        socket.destroy()
        reject(new Error(`TLS校验失败：${hostname} (${reason})`))
        return
      }
      socket.end()
      resolvePromise()
    })
    socket.once('timeout', () => socket.destroy(new Error(`TLS连接超时：${hostname}`)))
    socket.once('error', reject)
  })
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isDirectRun) {
  const report = await verifyNormalizedRuntimeConfig(process.env, process.argv.includes('--external'))
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}
