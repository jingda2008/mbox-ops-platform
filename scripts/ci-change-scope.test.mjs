import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyChangedPaths, isDocumentationPath, isFrontendPath, isUiOnlyPath } from './ci-change-scope.mjs'

function expected(scope, paths, reason, migrationChanged = false) {
  return {
    scope,
    docsOnly: scope === 'docs',
    uiOnly: scope === 'ui',
    frontendOnly: scope === 'frontend',
    fast: scope === 'ui' || scope === 'frontend',
    full: scope === 'full',
    migrationChanged,
    paths: paths.toSorted(),
    reason,
  }
}

test('documentation paths stay on the fast lane', () => {
  assert.equal(isDocumentationPath('docs/release.md'), true)
  assert.equal(isDocumentationPath('README.md'), true)
  assert.deepEqual(
    classifyChangedPaths(['docs/release.md', 'CHANGELOG.md']),
    expected('docs', ['CHANGELOG.md', 'docs/release.md'], 'documentation-only change'),
  )
})

test('presentation-only files use the UI lane and can include documentation', () => {
  for (const path of ['src/App.css', 'src/presentation/guest-copy.ts', 'public/brand/logo.png']) {
    assert.equal(isUiOnlyPath(path), true, path)
    assert.equal(classifyChangedPaths([path]).scope, 'ui', path)
  }
  assert.equal(classifyChangedPaths(['src/App.css', 'docs/ui-note.md']).scope, 'ui')
})

test('allowlisted non-critical components use the frontend lane', () => {
  for (const path of ['src/App.tsx', 'src/components/GuestPortal.tsx', 'src/components/GuestPortal.test.ts']) {
    assert.equal(isFrontendPath(path), true, path)
    assert.equal(classifyChangedPaths([path]).scope, 'frontend', path)
  }
  assert.equal(classifyChangedPaths(['src/components/GuestPortal.tsx', 'docs/guest.md']).scope, 'frontend')
})

test('critical, configuration, workflow and unknown changes always receive full verification', () => {
  for (const path of [
    'src/api.ts',
    'src/shared/contracts.ts',
    'src/components/PaymentView.tsx',
    'src/components/InventoryView.css',
    'server/guest-api.ts',
    'config/seed.json',
    '.github/workflows/ci.yml',
    'Dockerfile',
    'unclassified/runtime.bin',
  ]) {
    const result = classifyChangedPaths([path])
    assert.equal(result.scope, 'full', path)
    assert.equal(result.full, true, path)
  }
  assert.equal(classifyChangedPaths(['src/App.css', 'server/guest-api.ts']).scope, 'full')
})

test('database migrations are explicitly identified', () => {
  const result = classifyChangedPaths(['database/migrations/020_example.sql'])
  assert.equal(result.scope, 'full')
  assert.equal(result.migrationChanged, true)
})

test('unknown diffs and release tags fail closed to full verification', () => {
  assert.equal(classifyChangedPaths([]).scope, 'full')
  assert.equal(classifyChangedPaths(['docs/release.md'], { forceFull: true }).scope, 'full')
  assert.equal(classifyChangedPaths(['src/App.css'], { forceFull: true }).scope, 'full')
})
