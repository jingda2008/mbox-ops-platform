import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('release manifest binds the exact store and catalog configuration digests', () => {
  const root = mkdtempSync(join(tmpdir(), 'mbox-release-manifest-'))
  const archive = join(root, 'image.tar.gz')
  const migration = join(root, 'migration.json')
  const store = join(root, 'store.json')
  const catalog = join(root, 'catalog.json')
  const output = join(root, 'release-manifest.json')
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
      MBOX_BUNDLE_IMAGE_TAG: 'mbox:test',
      MBOX_BUNDLE_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`,
      MBOX_MIGRATION_MANIFEST: migration,
      MBOX_STORE_CONFIG: store,
      MBOX_CATALOG_CONFIG: catalog,
      MBOX_BUNDLE_MANIFEST: output,
    },
  })
  const manifest = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(manifest.schemaVersion, 2)
  assert.equal(manifest.configuration.store.file, 'store.json')
  assert.match(manifest.configuration.store.sha256, /^[0-9a-f]{64}$/)
  assert.equal(manifest.configuration.catalog.file, 'catalog.json')
  assert.match(manifest.configuration.catalog.sha256, /^[0-9a-f]{64}$/)
  assert.notEqual(manifest.configuration.store.sha256, manifest.configuration.catalog.sha256)
})
