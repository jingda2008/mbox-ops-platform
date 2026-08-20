import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const archivePath = resolve(required('MBOX_BUNDLE_ARCHIVE'))
const archive = await readFile(archivePath)
const archiveSha256 = createHash('sha256').update(archive).digest('hex')
const migration = JSON.parse(await readFile(resolve(required('MBOX_MIGRATION_MANIFEST')), 'utf8'))
const storeConfigPath = resolve(required('MBOX_STORE_CONFIG'))
const catalogConfigPath = resolve(required('MBOX_CATALOG_CONFIG'))
const releaseSha = required('MBOX_BUNDLE_SHA')
const imageDigest = required('MBOX_BUNDLE_IMAGE_DIGEST')
const sourceBranch = required('MBOX_BUNDLE_SOURCE_BRANCH')
const frozenAt = required('MBOX_BUNDLE_FROZEN_AT')
const runtimeConfigVersion = required('MBOX_BUNDLE_CONFIG_VERSION')
const deploymentScriptDirectory = resolve(required('MBOX_DEPLOYMENT_SCRIPT_DIR'))
const deploymentScriptNames = [
  'deploy-release.sh',
  'activate-release.sh',
  'rollback-activated-release.sh',
  'verify-public-app.sh',
  'stage-release-evidence.sh',
  'upload-oss-verified.sh',
  'send-sls-events.sh',
  'prune-oss-images.sh',
  'release-state.sh',
  'normalize-runtime-env.sh',
  'backup-postgres.sh',
  'restore-postgres.sh',
]

if (!/^[0-9a-f]{40}$/.test(releaseSha)) throw new Error('MBOX_BUNDLE_SHA must be a full commit SHA')
if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) throw new Error('MBOX_BUNDLE_IMAGE_DIGEST is not immutable')
if (sourceBranch !== 'main') throw new Error('MBOX_BUNDLE_SOURCE_BRANCH must be main')
if (Number.isNaN(Date.parse(frozenAt))) throw new Error('MBOX_BUNDLE_FROZEN_AT must be an ISO timestamp')
if (runtimeConfigVersion !== 'normalized-runtime-config/v1') {
  throw new Error('MBOX_BUNDLE_CONFIG_VERSION must be normalized-runtime-config/v1')
}

const manifest = {
  schemaVersion: 5,
  generatedAt: new Date().toISOString(),
  releaseSha,
  releaseVersion: required('MBOX_BUNDLE_VERSION'),
  deploymentScope: {
    kind: 'normalized-staff-service-database',
    includes: ['normalized-web', 'normalized-server', 'normalized-database'],
    excludes: ['wechat-miniprogram'],
  },
  sourceBranch,
  frozenAt,
  runtimeConfigVersion,
  imageTag: required('MBOX_BUNDLE_IMAGE_TAG'),
  imageDigest,
  archive: basename(archivePath),
  archiveSha256,
  migration,
  configuration: {
    store: {
      file: basename(storeConfigPath),
      sha256: createHash('sha256').update(await readFile(storeConfigPath)).digest('hex'),
    },
    catalog: {
      file: basename(catalogConfigPath),
      sha256: createHash('sha256').update(await readFile(catalogConfigPath)).digest('hex'),
    },
  },
  deploymentScripts: Object.fromEntries(await Promise.all(deploymentScriptNames.map(async (file) => {
    const contents = await readFile(join(deploymentScriptDirectory, file))
    return [file.replace(/\.sh$/, '').replaceAll('-', '_'), {
      file,
      sha256: createHash('sha256').update(contents).digest('hex'),
    }]
  }))),
  ci: {
    repository: process.env.GITHUB_REPOSITORY ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  },
}

const output = resolve(process.env.MBOX_BUNDLE_MANIFEST ?? 'release-manifest.json')
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
