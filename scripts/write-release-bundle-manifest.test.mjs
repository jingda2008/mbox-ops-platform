import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('release manifest binds configuration and passes actual activation and rollback validators', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mbox-release-manifest-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
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
  'maintenance-bootstrap.sh',
  'maintenance-bootstrap.py',
  'maintenance-ingress.mjs',
  'publish-native-update.py',
  'commercial-worker-adapters.mjs',
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
      MBOX_BUNDLE_PLATFORM_IMAGE_DIGEST: `sha256:${'d'.repeat(64)}`,
      MBOX_MIGRATION_MANIFEST: migration,
      MBOX_STORE_CONFIG: store,
      MBOX_CATALOG_CONFIG: catalog,
      MBOX_DEPLOYMENT_SCRIPT_DIR: scripts,
      MBOX_BUNDLE_MANIFEST: output,
    },
  })
  const manifest = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(manifest.schemaVersion, 6)
  assert.equal(manifest.imageDigest, `sha256:${'c'.repeat(64)}`)
  assert.equal(manifest.platformImageDigest, `sha256:${'d'.repeat(64)}`)
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
  assert.equal(Object.keys(manifest.deploymentScripts).length, 17)
  assert.equal(manifest.deploymentScripts.activate_release.file, 'activate-release.sh')
  assert.match(manifest.deploymentScripts.activate_release.sha256, /^[0-9a-f]{64}$/)

  // Exercise both real shell boundaries against the generated manifest. Merely
  // checking the publisher's count misses a stale activation/rollback guard.
  const manifestPath = join(scripts, 'release-manifest.json')
  const storeManifest = (value) => writeFileSync(manifestPath, JSON.stringify(value))
  for (const entry of ['activate-release.sh', 'rollback-activated-release.sh']) {
    const source = readFileSync(new URL(`../deploy/aliyun/${entry}`, import.meta.url), 'utf8')
    const validator = source.match(/^verify_deployment_scripts\(\) \{[\s\S]*?^\}/m)?.[0]
    assert.ok(validator, `${entry} must expose the bundle validation boundary`)
    const verify = () => execFileSync('bash', ['-c',
      `set -Eeuo pipefail\nrelease_dir=$1\nmanifest="$release_dir/release-manifest.json"\n${validator}\nverify_deployment_scripts`,
      'bundle-contract-test', scripts,
    ], { stdio: 'pipe' })
    storeManifest(manifest)
    assert.doesNotThrow(verify, `${entry} must accept the publisher's complete bundle`)
    storeManifest({ ...manifest, deploymentScripts: Object.fromEntries(
      Object.entries(manifest.deploymentScripts).filter(([, value]) => value.file !== 'commercial-worker-adapters.mjs'),
    ) })
    assert.throws(verify, `${entry} must reject the old 16-file bundle`)
    storeManifest({ ...manifest, deploymentScripts: {
      ...manifest.deploymentScripts, unexpected: manifest.deploymentScripts.activate_release,
    } })
    assert.throws(verify, `${entry} must reject an extra manifest entry`)
    storeManifest(manifest)
    const adapterPath = join(scripts, 'commercial-worker-adapters.mjs')
    const adapter = readFileSync(adapterPath)
    writeFileSync(adapterPath, 'unverified adapter bytes')
    assert.throws(verify, `${entry} must reject a changed adapter digest`)
    writeFileSync(adapterPath, adapter)
    assert.doesNotThrow(verify)
  }
})
