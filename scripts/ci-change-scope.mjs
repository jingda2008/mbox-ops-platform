const DOCUMENTATION_PATHS = [
  /^docs\//,
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^SECURITY\.md$/,
  /^AGENTS\.md$/,
]

export function isDocumentationPath(path) {
  return DOCUMENTATION_PATHS.some((expression) => expression.test(path))
}

export function classifyChangedPaths(paths, options = {}) {
  const normalized = [...new Set(paths.map((path) => path.trim()).filter(Boolean))].toSorted()
  const forceFull = options.forceFull === true
  const docsOnly = !forceFull && normalized.length > 0 && normalized.every(isDocumentationPath)
  const migrationChanged = normalized.some((path) => path.startsWith('database/migrations/'))

  return {
    scope: docsOnly ? 'docs' : 'full',
    docsOnly,
    full: !docsOnly,
    migrationChanged,
    paths: normalized,
    reason: forceFull
      ? 'tag or manual release verification'
      : docsOnly
        ? 'documentation-only change'
        : normalized.length === 0
          ? 'empty or unavailable diff defaults to full verification'
          : 'runtime or release-pipeline change',
  }
}
