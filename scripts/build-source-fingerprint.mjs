import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildInputPatterns = [
  'src', 'server', 'public', 'index.html', 'package.json', 'package-lock.json',
  'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'tsconfig.server.json',
  'vite.config.ts', 'scripts/copy-runtime-assets.mjs',
]
const viteEnvironmentFiles = ['.env', '.env.local', '.env.production', '.env.production.local']
const buildEnvironmentKeys = ['NODE_ENV', 'API_PROXY_TARGET']
const provenanceToolPath = 'scripts/build-source-fingerprint.mjs'

function gitFiles(args) {
  const output = execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' })
  return output.split('\0').filter(Boolean)
}

async function digestFiles(paths) {
  const hash = createHash('sha256')
  for (const path of [...new Set(paths)].toSorted()) {
    hash.update(`${path}\0`)
    try {
      hash.update(await readFile(resolve(repositoryRoot, path)))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      hash.update('<deleted>')
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function recursiveFiles(path) {
  if (!existsSync(resolve(repositoryRoot, path))) return []
  const output = []
  async function visit(relativePath) {
    const value = await stat(resolve(repositoryRoot, relativePath))
    if (value.isDirectory()) {
      for (const name of await readdir(resolve(repositoryRoot, relativePath))) {
        await visit(`${relativePath}/${name}`)
      }
    } else if (value.isFile()) output.push(relativePath)
  }
  await visit(path)
  return output
}

export async function buildSourceFingerprint() {
  const files = [
    ...gitFiles(['ls-files', '-z', '--', ...buildInputPatterns]),
    ...gitFiles(['ls-files', '-z', '--others', '--exclude-standard', '--', ...buildInputPatterns]),
    ...viteEnvironmentFiles.filter((path) => existsSync(resolve(repositoryRoot, path))),
  ].toSorted()
  return { algorithm: 'sha256', digest: await digestFiles(files), files: [...new Set(files)].length }
}

export function buildEnvironmentFingerprint(environment = process.env) {
  const names = Object.keys(environment)
    .filter((name) => name.startsWith('VITE_') || buildEnvironmentKeys.includes(name))
    .toSorted()
  const values = Object.fromEntries(names.map((name) => [name, environment[name] ?? '']))
  return {
    algorithm: 'sha256',
    digest: createHash('sha256').update(JSON.stringify(values)).digest('hex'),
    names,
  }
}

export async function buildOutputFingerprint() {
  const files = [...await recursiveFiles('dist'), ...await recursiveFiles('dist-server')].toSorted()
  if (!files.length) throw new Error('build output is missing: dist and dist-server are empty')
  return { algorithm: 'sha256', digest: await digestFiles(files), files: files.length }
}

async function provenanceToolFingerprint() {
  return createHash('sha256').update(await readFile(resolve(repositoryRoot, provenanceToolPath))).digest('hex')
}

export async function createBuildProvenance() {
  return {
    schemaVersion: 1,
    source: await buildSourceFingerprint(),
    environment: buildEnvironmentFingerprint(),
    output: await buildOutputFingerprint(),
    provenanceToolSha256: await provenanceToolFingerprint(),
  }
}

export async function verifyBuildProvenance(marker, currentProvenance) {
  const current = currentProvenance ?? await createBuildProvenance()
  const failures = []
  if (marker?.schemaVersion !== 1) failures.push('schemaVersion')
  if (marker?.source?.digest !== current.source.digest) failures.push('source')
  if (marker?.environment?.digest !== current.environment.digest) failures.push('environment')
  if (marker?.output?.digest !== current.output.digest) failures.push('output')
  if (marker?.provenanceToolSha256 !== current.provenanceToolSha256) failures.push('provenanceTool')
  return { passed: failures.length === 0, failures, current }
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const source = await buildSourceFingerprint()
  if (process.argv.includes('--environment')) {
    process.stdout.write(`${buildEnvironmentFingerprint().digest}\n`)
    return
  }
  const verifyTarget = argument('--verify')
  if (verifyTarget) {
    const marker = JSON.parse(await readFile(resolve(repositoryRoot, verifyTarget), 'utf8'))
    const verified = await verifyBuildProvenance(marker)
    process.stdout.write(`${JSON.stringify(verified)}\n`)
    if (!verified.passed) process.exitCode = 1
    return
  }
  const writeTarget = argument('--write')
  if (writeTarget) {
    const expectedSource = argument('--expected-source')
    const expectedEnvironment = argument('--expected-environment')
    const environment = buildEnvironmentFingerprint()
    if (expectedSource && expectedSource !== source.digest) throw new Error('source changed while build was running')
    if (expectedEnvironment && expectedEnvironment !== environment.digest) {
      throw new Error('build environment changed while build was running')
    }
    const marker = await createBuildProvenance()
    const output = resolve(repositoryRoot, writeTarget)
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${JSON.stringify({ ...marker, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(`${source.digest}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
