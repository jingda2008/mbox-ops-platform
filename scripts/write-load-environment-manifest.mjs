import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cpus, freemem, hostname, release, totalmem } from 'node:os'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

async function digestFiles(paths) {
  const hash = createHash('sha256')
  for (const path of paths.toSorted()) {
    hash.update(`${path}\0`)
    hash.update(await readFile(resolve(path)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function recursiveFiles(root) {
  if (!existsSync(resolve(root))) return []
  const output = []
  async function visit(path) {
    const value = await stat(resolve(path))
    if (value.isDirectory()) {
      for (const name of await readdir(resolve(path))) await visit(`${path}/${name}`)
    } else if (value.isFile()) output.push(path)
  }
  await visit(root)
  return output
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

export async function createLoadEnvironmentManifest(options = {}) {
  const migrationFiles = (await readdir(resolve(options.migrationDirectory ?? 'database/migrations')))
    .filter((name) => name.endsWith('.sql'))
    .map((name) => `${options.migrationDirectory ?? 'database/migrations'}/${name}`)
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim())
  const postgresImage = options.postgresImage ?? 'postgres:16-alpine'
  const chromiumPath = chromium.executablePath()
  const playwrightPackage = JSON.parse(await readFile(resolve('node_modules/@playwright/test/package.json'), 'utf8'))
  const buildFiles = [
    ...await recursiveFiles(options.webBuildDirectory ?? 'dist'),
    ...await recursiveFiles(options.serverBuildDirectory ?? 'dist-server'),
  ]
  const testFiles = [
    'scripts/rc68-mixed-load.mjs',
    'scripts/measure-browser-startup.mjs',
    'scripts/analyze-runtime-logs.mjs',
    'scripts/verify-runtime-metrics.mjs',
    'scripts/run-local-rc68-load.sh',
  ]
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    phase: options.phase,
    source: { commitSha, dirty },
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      osRelease: release(),
      hostname: hostname(),
      cpuCount: cpus().length,
      cpuModel: cpus()[0]?.model ?? null,
      totalMemoryBytes: totalmem(),
      freeMemoryBytesAtCapture: freemem(),
      instances: Number(options.instances ?? 2),
      databasePoolMax: Number(options.databasePoolMax ?? 10),
      postgresImage,
      postgresImageId: commandOutput('docker', ['image', 'inspect', '--format={{.Id}}', postgresImage]),
      playwrightVersion: playwrightPackage.version,
      chromiumPath,
      chromiumVersion: commandOutput(chromiumPath, ['--version']),
    },
    inputs: {
      packageLockSha256: await digestFiles([options.packageLockPath ?? 'package-lock.json']),
      migrationSetSha256: await digestFiles(migrationFiles),
      seedStateSha256: await digestFiles([options.seedStatePath ?? '.runtime/rc68-load-state.json']),
      buildSetSha256: buildFiles.length ? await digestFiles(buildFiles) : null,
      testHarnessSha256: await digestFiles(testFiles),
    },
    workload: {
      phase: options.phase,
      profile: process.env.MBOX_LOAD_PROFILE ?? 'route-regression',
      samplesPerReadOrAction: Number(process.env.MBOX_LOAD_SAMPLES ?? 300),
      browserSamples: Number(process.env.MBOX_BROWSER_STARTUP_SAMPLES ?? 30),
    },
  }
}

const phase = process.env.MBOX_LOAD_PHASE?.trim() || 'all'
const output = process.env.MBOX_LOAD_ENVIRONMENT_MANIFEST_PATH?.trim()
if (output) {
  const manifest = await createLoadEnvironmentManifest({
    phase,
    instances: process.env.MBOX_LOAD_INSTANCES ?? 2,
    databasePoolMax: process.env.MBOX_DATABASE_POOL_MAX ?? 10,
    postgresImage: process.env.MBOX_LOAD_POSTGRES_IMAGE ?? 'postgres:16-alpine',
  })
  await writeFile(resolve(output), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
}
