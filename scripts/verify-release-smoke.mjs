const baseUrl = process.env.MBOX_RELEASE_SMOKE_URL?.replace(/\/$/, '')
const expectedSha = process.env.MBOX_RELEASE_EXPECTED_SHA
const expectedDigest = process.env.MBOX_RELEASE_EXPECTED_DIGEST
const expectedSchemaVersion = Number(process.env.MBOX_RELEASE_EXPECTED_SCHEMA_VERSION ?? 1)
const attempts = Number(process.env.MBOX_RELEASE_SMOKE_ATTEMPTS ?? 12)
const waitMs = Number(process.env.MBOX_RELEASE_SMOKE_WAIT_MS ?? 5_000)
const browserRoutes = Object.freeze([
  '/',
  '/guest?table=W01',
  '/reserve',
  '/staff/live',
])
const browserAccept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

if (!baseUrl || !expectedSha || !expectedDigest) {
  throw new Error('release smoke requires URL, expected SHA and expected digest')
}
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('expected SHA is not a full commit identity')
if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) throw new Error('expected digest is not immutable')
if (!Number.isInteger(expectedSchemaVersion) || expectedSchemaVersion < 1) {
  throw new Error('expected schema version is invalid')
}

let lastFailure = 'no response'
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const response = await fetch(`${baseUrl}/api/ready`, {
      headers: { 'user-agent': 'mbox-release-verifier/1.0' },
      signal: AbortSignal.timeout(10_000),
    })
    const body = await response.json()
    const failures = [
      response.status !== 200 && `HTTP ${response.status}`,
      body.status !== 'ready' && `status=${body.status}`,
      body.commitSha !== expectedSha && `commitSha=${body.commitSha}`,
      body.releaseImageDigest !== expectedDigest && `releaseImageDigest=${body.releaseImageDigest ?? 'missing'}`,
      body.schemaFlavor !== 'normalized-core-v1' && `schemaFlavor=${body.schemaFlavor}`,
      Number(body.schemaVersion) < expectedSchemaVersion && `schemaVersion=${body.schemaVersion}`,
    ].filter(Boolean)
    if (failures.length === 0) {
      failures.push(...await verifyBrowserRoutes())
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
  }
  if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, waitMs))
}

throw new Error(`release smoke failed after ${attempts} attempts: ${lastFailure}`)

async function verifyBrowserRoutes() {
  const failures = []
  for (const route of browserRoutes) {
    try {
      const response = await fetch(`${baseUrl}${route}`, {
        headers: {
          accept: browserAccept,
          'user-agent': 'mbox-release-browser-verifier/1.0',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      const contentType = response.headers.get('content-type') ?? ''
      const body = await response.text()
      if (response.status !== 200) failures.push(`${route}=HTTP ${response.status}`)
      else if (!contentType.toLowerCase().includes('text/html')) failures.push(`${route}=content-type ${contentType || 'missing'}`)
      else if (!/^\s*<!doctype html>|<html[\s>]/i.test(body)) failures.push(`${route}=HTML shell missing`)
    } catch (error) {
      failures.push(`${route}=${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return failures
}
