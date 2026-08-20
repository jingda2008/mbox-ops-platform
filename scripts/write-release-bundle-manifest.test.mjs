import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('release manifest binds the exact store and catalog configuration digests', () => {
  const root = mkdtempSync(join(tmpdir(), 'mbox-release-manifest-'))
  const archive = join(root, 'image.tar.gz')
  const migration = join(root, 'migration.json')
  const store = join(root, 'store.json')
  const catalog = join(root, 'catalog.json')
  const output = join(root, 'release-manifest.json')
  const scripts = join(root, 'scripts')
  mkdirSync(scripts)
  for (const name of [
    'deploy-release.sh',
    'activate-release.sh', 'rollback-activated-release.sh', 'verify-public-app.sh',
    'stage-release-evidence.sh', 'upload-oss-verified.sh', 'send-sls-events.sh',
    'prune-oss-images.sh',
    'release-state.sh',
    'normalize-runtime-env.sh',
    'backup-postgres.sh',
    'restore-postgres.sh',
  ]) writeFileSync(join(scripts, name), `#!/bin/sh\nprintf '${name}\\n'\n`)
  writeFileSync(archive, 'image')
  writeFileSync(migration, JSON.stringify({ count: 40, digest: 'a'.repeat(64) }))
  writeFileSync(store, JSON.stringify({ version: 'store-v1' }))
  writeFileSync(catalog, JSON.stringify({ version: 'catalog-v1' }))
  execFileSync(process.execPath, ['scripts/write-release-bundle-manifest.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      MBOX_BUNDLE_ARCHIVE: archive,
      MBOX_BUNDLE_SHA: 'b'.repeat(40),
      MBOX_BUNDLE_VERSION: '1.0.0-rc.test',
      MBOX_BUNDLE_SOURCE_BRANCH: 'main',
      MBOX_BUNDLE_FROZEN_AT: '2026-08-14T00:00:00Z',
      MBOX_BUNDLE_CONFIG_VERSION: 'normalized-runtime-config/v1',
      MBOX_BUNDLE_IMAGE_TAG: 'mbox:test',
      MBOX_BUNDLE_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`,
      MBOX_MIGRATION_MANIFEST: migration,
      MBOX_STORE_CONFIG: store,
      MBOX_CATALOG_CONFIG: catalog,
      MBOX_DEPLOYMENT_SCRIPT_DIR: scripts,
      MBOX_BUNDLE_MANIFEST: output,
    },
  })
  const manifest = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(manifest.schemaVersion, 5)
  assert.deepEqual(manifest.deploymentScope, {
    kind: 'normalized-staff-service-database',
    includes: ['normalized-web', 'normalized-server', 'normalized-database'],
    excludes: ['wechat-miniprogram'],
  })
  assert.equal(manifest.sourceBranch, 'main')
  assert.equal(manifest.runtimeConfigVersion, 'normalized-runtime-config/v1')
  assert.equal(manifest.configuration.store.file, 'store.json')
  assert.match(manifest.configuration.store.sha256, /^[0-9a-f]{64}$/)
  assert.equal(manifest.configuration.catalog.file, 'catalog.json')
  assert.match(manifest.configuration.catalog.sha256, /^[0-9a-f]{64}$/)
  assert.notEqual(manifest.configuration.store.sha256, manifest.configuration.catalog.sha256)
  assert.equal(Object.keys(manifest.deploymentScripts).length, 12)
  assert.equal(manifest.deploymentScripts.activate_release.file, 'activate-release.sh')
  assert.match(manifest.deploymentScripts.activate_release.sha256, /^[0-9a-f]{64}$/)
})
