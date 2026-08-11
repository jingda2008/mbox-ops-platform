const baseUrl = process.env.MBOX_RELEASE_SMOKE_URL?.replace(/\/$/, '')
const expectedSha = process.env.MBOX_RELEASE_EXPECTED_SHA
const expectedDigest = process.env.MBOX_RELEASE_EXPECTED_DIGEST
const attempts = Number(process.env.MBOX_RELEASE_SMOKE_ATTEMPTS ?? 12)
const waitMs = Number(process.env.MBOX_RELEASE_SMOKE_WAIT_MS ?? 5_000)

if (!baseUrl || !expectedSha || !expectedDigest) {
  throw new Error('release smoke requires URL, expected SHA and expected digest')
}
if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) throw new Error('expected digest is not immutable')

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
      body.releaseSha !== expectedSha && `releaseSha=${body.releaseSha}`,
      body.releaseImageDigest !== expectedDigest && `releaseImageDigest=${body.releaseImageDigest}`,
      body.repository !== 'postgres' && `repository=${body.repository}`,
      body.projectionReady !== true && `projectionReady=${body.projectionReady}`,
      body.projectionCountsMatch !== true && `projectionCountsMatch=${body.projectionCountsMatch}`,
      body.kdsAuthorityConsistent !== true && `kdsAuthorityConsistent=${body.kdsAuthorityConsistent}`,
      body.projectionRevision !== body.revision && `projectionRevision=${body.projectionRevision},revision=${body.revision}`,
    ].filter(Boolean)
    if (failures.length === 0) {
      process.stdout.write(`${JSON.stringify({ verified: true, url: baseUrl, revision: body.revision, releaseSha: body.releaseSha, digest: body.releaseImageDigest })}\n`)
      process.exit(0)
    }
    lastFailure = failures.join(', ')
  } catch (error) {
    lastFailure = error instanceof Error ? error.message : String(error)
  }
  if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, waitMs))
}

throw new Error(`release smoke failed after ${attempts} attempts: ${lastFailure}`)
