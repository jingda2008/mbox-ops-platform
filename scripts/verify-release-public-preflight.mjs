import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// Exercise the operator's real TLS path before uploading or taking a backup.
// A healthy origin does not prove this machine can complete post-cutover checks.
export function verifyPublicPreflight({ url, originIp, tier, maintenance }, run = execFileSync) {
  const target = new URL(url)
  if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/'
    || target.search || target.hash) throw new Error('invalid release public origin')
  const resolve = originIp ? ['--resolve', `${target.hostname}:443:${originIp}`] : []
  let identity
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = run('curl', [...resolve, '--silent', '--show-error', '--connect-timeout', '3',
      '--max-time', '8', '--header', 'Accept: application/json', '--header',
      'User-Agent: mbox-release-environment-preflight/1.0', '--write-out', '\n%{http_code}', `${target.origin}/api/ready`],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 })
    const boundary = response.lastIndexOf('\n')
    const status = response.slice(boundary + 1)
    const ready = JSON.parse(response.slice(0, boundary))
    const planned = maintenance && status === '503' && ready.reason === 'planned_maintenance_upgrade'
    if (!planned && (status !== '200' || ready.status !== 'ready' || ready.deploymentTier !== tier
      || !/^[a-f0-9]{40}$/.test(ready.commitSha)
      || !/^sha256:[a-f0-9]{64}$/.test(ready.releaseImageDigest))) {
      throw new Error('public environment preflight did not return a valid current release')
    }
    const current = JSON.stringify([planned ? 'maintenance' : 'ready', ready.commitSha, ready.releaseImageDigest])
    if (identity !== undefined && current !== identity) throw new Error('public release changed during environment preflight')
    identity = current
  }
  return { verified: true, probes: 3, tlsVerification: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(verifyPublicPreflight({ url: process.argv[2], originIp: process.argv[3],
    tier: process.argv[4], maintenance: process.argv[5] === '1' })))
}
