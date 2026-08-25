import { access, readFile, readdir } from 'node:fs/promises'

const packageDocument = JSON.parse(await readFile('package.json', 'utf8'))
const lockDocument = JSON.parse(await readFile('package-lock.json', 'utf8'))
const changelog = await readFile('CHANGELOG.md', 'utf8')
const version = packageDocument.version
const releaseTag = `v${version}`
const releaseDocumentPath = `docs/release-${version}.md`
const qualityRegisters = [
  { path: `docs/tc-execution-register-${version}.csv`, identifiesVersion: true },
  { path: `docs/tc-release-blockers-${version}.csv`, identifiesVersion: false },
]
const failures = []

if (!/^\d+\.\d+\.\d+-rc\.\d+$/.test(version)) {
  failures.push(`package version ${version} is not a release-candidate version`)
}
if (lockDocument.version !== version || lockDocument.packages?.['']?.version !== version) {
  failures.push('package-lock.json version does not match package.json')
}

try {
  await access(releaseDocumentPath)
  const releaseDocument = await readFile(releaseDocumentPath, 'utf8')
  if (!releaseDocument.includes(version)) {
    failures.push(`${releaseDocumentPath} does not identify ${version}`)
  }
} catch {
  failures.push(`${releaseDocumentPath} is missing`)
}

for (const qualityRegisterDefinition of qualityRegisters) {
  const { path: qualityRegisterPath, identifiesVersion } = qualityRegisterDefinition
  try {
    await access(qualityRegisterPath)
    const qualityRegister = await readFile(qualityRegisterPath, 'utf8')
    if (qualityRegister.trim().length === 0) {
      failures.push(`${qualityRegisterPath} is empty`)
    } else if (identifiesVersion && !qualityRegister.includes(version)) {
      failures.push(`${qualityRegisterPath} does not identify ${version}`)
    }
  } catch {
    failures.push(`${qualityRegisterPath} is missing`)
  }
}

const escapedVersion = version.replaceAll('.', '\\.')
if (!new RegExp(`^## ${escapedVersion} - \\d{4}-\\d{2}-\\d{2}$`, 'm').test(changelog)) {
  failures.push(`CHANGELOG.md is missing a dated ${version} heading`)
}

const migrationFiles = await validateMigrationDirectory('database/migrations', 'database', failures)
const normalizedMigrationFiles = await validateMigrationDirectory(
  'database/normalized-migrations',
  'normalized database',
  failures,
)

const requestedTag = process.env.MBOX_RELEASE_TAG
  || (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : '')
if (requestedTag && requestedTag !== releaseTag) {
  failures.push(`release tag ${requestedTag} does not match package version ${releaseTag}`)
}

if (failures.length > 0) {
  process.stderr.write(`Release metadata verification failed:\n- ${failures.join('\n- ')}\n`)
  process.exit(1)
}

process.stdout.write(
  `Release metadata verified: ${releaseTag}, ${releaseDocumentPath}, `
    + `${qualityRegisters.length} quality registers, ${migrationFiles.length} legacy migrations, `
    + `${normalizedMigrationFiles.length} normalized migrations.\n`,
)

async function validateMigrationDirectory(directory, label, targetFailures) {
  const files = (await readdir(directory))
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort()
  const numbers = files.map((name) => Number(name.slice(0, 3)))
  if (new Set(numbers).size !== numbers.length) {
    targetFailures.push(`${label} migration numbers are not unique`)
  }
  for (let index = 0; index < numbers.length; index += 1) {
    if (numbers[index] !== index + 1) {
      targetFailures.push(`${label} migrations are not contiguous at ${files[index]}`)
      break
    }
  }
  return files
}
