import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

function option(name, required = true) {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1]?.trim() : ''
  if (required && !value) throw new Error(`--${name} is required`)
  return value
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function extract(archive, path) {
  return execFileSync('tar', ['-xOf', archive, path], { maxBuffer: 16 * 1024 * 1024 })
}

const directory = resolve(option('directory'))
const expectedSha = option('expected-sha')
const expectedIntent = option('expected-intent')
const expectedTag = option('expected-tag', false)
const manifest = JSON.parse(await readFile(resolve(directory, 'release-manifest.json'), 'utf8'))

if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('expected SHA must be a full commit SHA')
if (!['commercial', 'validation-only'].includes(expectedIntent)) throw new Error('unsupported expected intent')
if (manifest.releaseSha !== expectedSha) throw new Error('release manifest SHA mismatch')
if (manifest.releaseIntent !== expectedIntent) throw new Error('release manifest intent mismatch')
if (!/^sha256:[0-9a-f]{64}$/.test(manifest.imageDigest)) throw new Error('invalid image identity')
if (expectedTag && expectedTag !== `v${manifest.releaseVersion}`) throw new Error('release tag/version mismatch')
if (typeof manifest.archive !== 'string' || basename(manifest.archive) !== manifest.archive) {
  throw new Error('unsafe archive name')
}

const archivePath = resolve(directory, manifest.archive)
const archive = await readFile(archivePath)
if (sha256(archive) !== manifest.archiveSha256) throw new Error('archive SHA256 mismatch')

const dockerManifest = JSON.parse(extract(archivePath, 'manifest.json').toString('utf8'))
const matchingImages = dockerManifest.filter((entry) => entry.RepoTags?.includes(manifest.imageTag))
if (matchingImages.length !== 1) throw new Error('archive image tag is missing or ambiguous')
const configPath = matchingImages[0].Config
let configDigest
if (/^blobs\/sha256\/[0-9a-f]{64}$/.test(configPath)) configDigest = configPath.slice('blobs/sha256/'.length)
else if (/^[0-9a-f]{64}\.json$/.test(configPath)) configDigest = configPath.slice(0, -'.json'.length)
else throw new Error('unsafe archive config path')
const config = extract(archivePath, configPath)
if (sha256(config) !== configDigest) throw new Error('archive config bytes were changed')
if (`sha256:${configDigest}` !== manifest.imageDigest) throw new Error('archive image identity mismatch')

const imageConfig = JSON.parse(config.toString('utf8'))
const labels = imageConfig.config?.Labels ?? {}
if (labels['org.opencontainers.image.revision'] !== expectedSha) throw new Error('image revision mismatch')
if (labels['org.opencontainers.image.version'] !== manifest.releaseVersion) throw new Error('image version mismatch')

const migration = JSON.parse(await readFile(resolve(directory, 'migration-manifest.json'), 'utf8'))
if (!isDeepStrictEqual(migration, manifest.migration)) throw new Error('migration manifest mismatch')

process.stdout.write(`${JSON.stringify({
  verified: true,
  releaseSha: expectedSha,
  releaseIntent: expectedIntent,
  imageId: manifest.imageDigest,
  archiveSha256: manifest.archiveSha256,
})}\n`)
