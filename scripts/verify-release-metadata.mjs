import { access, readFile, readdir } from 'node:fs/promises'

const packageDocument = JSON.parse(await readFile('package.json', 'utf8'))
const lockDocument = JSON.parse(await readFile('package-lock.json', 'utf8'))
const changelog = await readFile('CHANGELOG.md', 'utf8')
const version = packageDocument.version
const releaseTag = `v${version}`
const releaseDocumentPath = `docs/release-${version}.md`
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

const escapedVersion = version.replaceAll('.', '\\.')
if (!new RegExp(`^## ${escapedVersion} - \\d{4}-\\d{2}-\\d{2}$`, 'm').test(changelog)) {
  failures.push(`CHANGELOG.md is missing a dated ${version} heading`)
}

const migrationFiles = (await readdir('database/migrations'))
  .filter((name) => /^\d{3}_.+\.sql$/.test(name))
  .sort()
const migrationNumbers = migrationFiles.map((name) => Number(name.slice(0, 3)))
const uniqueMigrationNumbers = new Set(migrationNumbers)
if (uniqueMigrationNumbers.size !== migrationNumbers.length) {
  failures.push('database migration numbers are not unique')
}
for (let index = 0; index < migrationNumbers.length; index += 1) {
  if (migrationNumbers[index] !== index + 1) {
    failures.push(`database migrations are not contiguous at ${migrationFiles[index]}`)
    break
  }
}

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
  `Release metadata verified: ${releaseTag}, ${releaseDocumentPath}, ${migrationFiles.length} migrations.\n`,
)
