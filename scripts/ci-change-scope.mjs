const DOCUMENTATION_PATHS = [
  /^docs\//,
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^SECURITY\.md$/,
  /^AGENTS\.md$/,
]

const UI_ONLY_PATHS = [
  /^src\/presentation\//,
  /^src\/.*\.css$/,
  /^public\/.*\.(?:avif|gif|ico|jpe?g|png|svg|webp|woff2?)$/i,
]

const FRONTEND_PATHS = [
  /^src\/components\//,
  /^src\/(?:App|main)\.tsx$/,
  /^src\/.*\.css$/,
  /^public\//,
  /^tests\/e2e\/ui-smoke\.spec\.ts$/,
]

const HIGH_RISK_PATHS = [
  /^\.github\//,
  /^config\//,
  /^database\//,
  /^server\//,
  /^scripts\//,
  /^src\/(?:api|schemas|staff-access)\.ts$/,
  /^src\/shared\//,
  /^tests\/e2e\/(?!ui-smoke\.spec\.ts$)/,
  /(?:^|\/)(?:Dockerfile|package-lock\.json|package\.json|playwright\.config\.ts|tsconfig[^/]*\.json|vite\.config\.ts)$/,
  /(?:payment|refund|cashier|inventory|gift|permission|authorization|authentication|login|master-data|MasterData|OperationsConsole|reservation|sop)/i,
]

export function isDocumentationPath(path) {
  return DOCUMENTATION_PATHS.some((expression) => expression.test(path))
}

export function isUiOnlyPath(path) {
  return UI_ONLY_PATHS.some((expression) => expression.test(path))
    && !HIGH_RISK_PATHS.some((expression) => expression.test(path))
}

export function isFrontendPath(path) {
  return FRONTEND_PATHS.some((expression) => expression.test(path))
    && !HIGH_RISK_PATHS.some((expression) => expression.test(path))
}

export function classifyChangedPaths(paths, options = {}) {
  const normalized = [...new Set(paths.map((path) => path.trim()).filter(Boolean))].toSorted()
  const forceFull = options.forceFull === true
  const runtimePaths = normalized.filter((path) => !isDocumentationPath(path))
  const docsOnly = !forceFull && normalized.length > 0 && runtimePaths.length === 0
  const uiOnly = !forceFull && runtimePaths.length > 0 && runtimePaths.every(isUiOnlyPath)
  const frontendOnly = !forceFull && runtimePaths.length > 0 && runtimePaths.every(isFrontendPath)
  const migrationChanged = normalized.some((path) => path.startsWith('database/migrations/'))
  const scope = docsOnly ? 'docs' : uiOnly ? 'ui' : frontendOnly ? 'frontend' : 'full'

  return {
    scope,
    docsOnly,
    uiOnly,
    frontendOnly,
    fast: scope === 'ui' || scope === 'frontend',
    full: scope === 'full',
    migrationChanged,
    paths: normalized,
    reason: forceFull
      ? 'tag or manual release verification'
      : docsOnly
        ? 'documentation-only change'
        : uiOnly
          ? 'allowlisted presentation-only change'
          : frontendOnly
            ? 'allowlisted non-critical frontend change'
            : normalized.length === 0
              ? 'empty or unavailable diff defaults to full verification'
              : 'critical, mixed, unknown or release-pipeline change',
  }
}
