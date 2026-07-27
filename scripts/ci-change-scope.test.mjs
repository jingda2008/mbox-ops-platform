import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyChangedPaths, isDocumentationPath } from './ci-change-scope.mjs'

test('documentation paths stay on the fast lane', () => {
  assert.equal(isDocumentationPath('docs/release.md'), true)
  assert.equal(isDocumentationPath('README.md'), true)
  assert.deepEqual(
    classifyChangedPaths(['docs/release.md', 'CHANGELOG.md']),
    {
      scope: 'docs',
      docsOnly: true,
      full: false,
      migrationChanged: false,
      paths: ['CHANGELOG.md', 'docs/release.md'],
      reason: 'documentation-only change',
    },
  )
})

test('runtime, configuration and workflow changes always receive full verification', () => {
  for (const path of ['src/App.tsx', 'config/seed.json', '.github/workflows/ci.yml', 'Dockerfile']) {
    const result = classifyChangedPaths([path])
    assert.equal(result.scope, 'full', path)
    assert.equal(result.full, true, path)
  }
})

test('database migrations are explicitly identified', () => {
  const result = classifyChangedPaths(['database/migrations/020_example.sql'])
  assert.equal(result.scope, 'full')
  assert.equal(result.migrationChanged, true)
})

test('unknown diffs and release tags fail closed to full verification', () => {
  assert.equal(classifyChangedPaths([]).scope, 'full')
  assert.equal(classifyChangedPaths(['docs/release.md'], { forceFull: true }).scope, 'full')
})
