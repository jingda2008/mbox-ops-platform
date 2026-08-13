const baseUrl = process.env.MBOX_RELEASE_SMOKE_URL?.replace(/\/$/, '')
const expectedSha = process.env.MBOX_RELEASE_EXPECTED_SHA
const expectedDigest = process.env.MBOX_RELEASE_EXPECTED_DIGEST
const expectedTier = process.env.MBOX_RELEASE_EXPECTED_TIER ?? 'validation'
const expectedSchemaVersion = Number(process.env.MBOX_RELEASE_EXPECTED_SCHEMA_VERSION ?? 1)
const attempts = Number(process.env.MBOX_RELEASE_SMOKE_ATTEMPTS ?? 12)
const waitMs = Number(process.env.MBOX_RELEASE_SMOKE_WAIT_MS ?? 5_000)
const timeoutMs = Number(process.env.MBOX_RELEASE_SMOKE_TIMEOUT_MS ?? 3_000)
const browserRoutes = Object.freeze([
  '/',
  '/guest?table=W01',
  '/reserve',
  '/staff/live',
])
const browserAccept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
const browserUserAgent = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36 MBOXReleaseVerifier/1.0'

class DeterministicGateError extends Error {}

if (!baseUrl || !expectedSha || !expectedDigest) {
  throw new Error('release smoke requires URL, expected SHA and expected digest')
}
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('expected SHA is not a full commit identity')
if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) throw new Error('expected digest is not immutable')
if (!['validation', 'production'].includes(expectedTier)) throw new Error('expected deployment tier is invalid')
if (!Number.isInteger(expectedSchemaVersion) || expectedSchemaVersion < 1) {
  throw new Error('expected schema version is invalid')
}
if (!Number.isInteger(attempts) || attempts < 1 || attempts > 30) {
  throw new Error('release smoke attempts must be an integer from 1 to 30')
}
if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30_000) {
  throw new Error('release smoke wait must be an integer from 0 to 30000 milliseconds')
}
if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 10_000) {
  throw new Error('release smoke timeout must be an integer from 500 to 10000 milliseconds')
}

let lastFailure = 'no response'
let targetRouteFailures = 0
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const response = await fetch(`${baseUrl}/api/ready`, {
      headers: { accept: 'application/json', 'user-agent': 'mbox-release-verifier/1.0' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const contentType = response.headers.get('content-type') ?? ''
    if (response.status !== 200) throw new Error(`readiness HTTP ${response.status}`)
    if (!contentType.toLowerCase().includes('application/json')) {
      throw new Error(`readiness content-type ${contentType || 'missing'}`)
    }
    let body
    try {
      body = await response.json()
    } catch {
      throw new Error('readiness response is not valid JSON')
    }
    const failures = [
      body.status !== 'ready' && `status=${body.status}`,
      body.commitSha !== expectedSha && `commitSha=${body.commitSha}`,
      body.releaseImageDigest !== expectedDigest && `releaseImageDigest=${body.releaseImageDigest ?? 'missing'}`,
      body.schemaFlavor !== 'normalized-core-v1' && `schemaFlavor=${body.schemaFlavor}`,
      Number(body.schemaVersion) < expectedSchemaVersion && `schemaVersion=${body.schemaVersion}`,
      body.deploymentTier !== expectedTier && `deploymentTier=${body.deploymentTier ?? 'missing'}`,
    ].filter(Boolean)
    if (body.commitSha === expectedSha && failures.length > 0) {
      throw new DeterministicGateError(failures.join(', '))
    }
    if (failures.length === 0) {
      const routeFailures = await verifyBrowserRoutes()
      if (routeFailures.length > 0) {
        targetRouteFailures += 1
        lastFailure = routeFailures.join(', ')
        if (targetRouteFailures >= 2 || attempt >= attempts) {
          throw new DeterministicGateError(lastFailure)
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
        continue
      }
    }
    if (failures.length === 0) {
      process.stdout.write(`${JSON.stringify({
        verified: true,
        url: baseUrl,
        releaseSha: body.commitSha,
        digest: body.releaseImageDigest,
        schemaVersion: body.schemaVersion,
        browserRoutes,
      })}\n`)
      process.exit(0)
    }
    lastFailure = failures.join(', ')
  } catch (error) {
    lastFailure = error instanceof Error ? error.message : String(error)
    if (error instanceof DeterministicGateError) break
  }
  if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, waitMs))
}

throw new Error(`release smoke failed after ${attempts} attempts: ${lastFailure}`)

async function verifyBrowserRoutes() {
  const routeResults = await Promise.all(browserRoutes.map(async (route) => {
    try {
      const response = await fetch(`${baseUrl}${route}`, {
        headers: {
          accept: browserAccept,
          'user-agent': browserUserAgent,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const contentType = response.headers.get('content-type') ?? ''
      const body = await response.text()
      if (response.status !== 200) return { failure: `${route}=HTTP ${response.status}` }
      if (!contentType.toLowerCase().includes('text/html')) return { failure: `${route}=content-type ${contentType || 'missing'}` }
      const buildIdentity = new RegExp(`<meta name=["']mbox-build-commit["'] content=["']${expectedSha}["']\\s*/?>`, 'i')
      if (!buildIdentity.test(body)) return { failure: `${route}=build identity mismatch` }
      if (!/<div[^>]+id=["']root["'][^>]*>\s*<\/div>/i.test(body)) return { failure: `${route}=root mount missing` }
      const asset = body.match(/<script[^>]+type=["']module["'][^>]+src=["'](\/assets\/[^"']+\.js)["']/i)?.[1]
      if (!asset) return { failure: `${route}=module asset missing` }
      return { route, asset }
    } catch (error) {
      return { failure: `${route}=${error instanceof Error ? error.message : String(error)}` }
    }
  }))
  const failures = routeResults.flatMap((result) => result.failure ? [result.failure] : [])
  if (failures.length > 0) return failures
  const assets = [...new Set(routeResults.map((result) => result.asset).filter(Boolean))]
  const assetResults = await Promise.all(assets.map(async (asset) => {
    try {
      const response = await fetch(`${baseUrl}${asset}`, {
        headers: { accept: 'application/javascript,text/javascript,*/*;q=0.1', 'user-agent': browserUserAgent },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const contentType = response.headers.get('content-type') ?? ''
      if (response.status !== 200) return `${asset}=HTTP ${response.status}`
      if (!/(application|text)\/(javascript|x-javascript)/i.test(contentType)) {
        return `${asset}=content-type ${contentType || 'missing'}`
      }
      return null
    } catch (error) {
      return `${asset}=${error instanceof Error ? error.message : String(error)}`
    }
  }))
  return assetResults.filter(Boolean)
}
