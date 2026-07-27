import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const archivePath = resolve(required('MBOX_BUNDLE_ARCHIVE'))
const archive = await readFile(archivePath)
const archiveSha256 = createHash('sha256').update(archive).digest('hex')
const migration = JSON.parse(await readFile(resolve(required('MBOX_MIGRATION_MANIFEST')), 'utf8'))
const releaseSha = required('MBOX_BUNDLE_SHA')
const imageDigest = required('MBOX_BUNDLE_IMAGE_DIGEST')

if (!/^[0-9a-f]{40}$/.test(releaseSha)) throw new Error('MBOX_BUNDLE_SHA must be a full commit SHA')
if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) throw new Error('MBOX_BUNDLE_IMAGE_DIGEST is not immutable')

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  releaseSha,
  releaseVersion: required('MBOX_BUNDLE_VERSION'),
  imageTag: required('MBOX_BUNDLE_IMAGE_TAG'),
  imageDigest,
  archive: basename(archivePath),
  archiveSha256,
  migration,
  ci: {
    repository: process.env.GITHUB_REPOSITORY ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  },
}

const output = resolve(process.env.MBOX_BUNDLE_MANIFEST ?? 'release-manifest.json')
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
