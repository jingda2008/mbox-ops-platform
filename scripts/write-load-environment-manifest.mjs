import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cpus, freemem, hostname, release, totalmem } from 'node:os'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { buildSourceFingerprint } from './build-source-fingerprint.mjs'
import { describeKdsWriteProfile, describeVenueWorkload } from './load-workload-model.mjs'

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
  const venueWorkload = describeVenueWorkload({
    testWindowSeconds: Number(process.env.MBOX_LOAD_WINDOW_SECONDS ?? 300),
  })
  const kdsWriteProfile = describeKdsWriteProfile({
    guests: venueWorkload.guests,
    operatingHours: venueWorkload.operatingHours,
  })
  const migrationFiles = (await readdir(resolve(options.migrationDirectory ?? 'database/migrations')))
    .filter((name) => name.endsWith('.sql'))
    .map((name) => `${options.migrationDirectory ?? 'database/migrations'}/${name}`)
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const worktreeStatus = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trimEnd()
  const dirty = Boolean(worktreeStatus.trim())
  const diff = dirty ? execFileSync('git', ['diff', '--binary', 'HEAD'], { encoding: 'utf8' }) : ''
  const postgresImage = options.postgresImage ?? 'postgres:16-alpine'
  const chromiumPath = chromium.executablePath()
  const playwrightPackage = JSON.parse(await readFile(resolve('node_modules/@playwright/test/package.json'), 'utf8'))
  const buildFiles = [
    ...await recursiveFiles(options.webBuildDirectory ?? 'dist'),
    ...await recursiveFiles(options.serverBuildDirectory ?? 'dist-server'),
  ]
  const testFiles = [
    'scripts/rc68-mixed-load.mjs',
    'scripts/build-source-fingerprint.mjs',
    'scripts/load-workload-model.mjs',
    'scripts/measure-browser-startup.mjs',
    'scripts/analyze-runtime-logs.mjs',
    'scripts/verify-runtime-metrics.mjs',
    'scripts/run-local-rc68-load.sh',
    'scripts/run-local-rc68-route-suite.sh',
    'scripts/prepare-rc68-load-state.mjs',
    'scripts/load-reference-time.mjs',
    'scripts/write-load-environment-manifest.mjs',
    'scripts/merge-rc68-load-reports.mjs',
  ]
  const buildSource = await buildSourceFingerprint()
  return {
    schemaVersion: 1,
    runId: process.env.MBOX_LOAD_RUN_ID?.trim() || null,
    generatedAt: new Date().toISOString(),
    phase: options.phase,
    source: {
      commitSha,
      dirty,
      changedPaths: worktreeStatus ? worktreeStatus.split('\n').map((line) => line.slice(3)).toSorted() : [],
      diffSha256: dirty ? createHash('sha256').update(diff).digest('hex') : null,
      buildInputSha256: buildSource.digest,
      buildInputFiles: buildSource.files,
    },
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
      mutationQueueMax: Number(process.env.MBOX_DATABASE_MUTATION_QUEUE_MAX ?? 100),
      mutationQueueWaitMs: Number(process.env.MBOX_DATABASE_MUTATION_QUEUE_WAIT_MS ?? 15_000),
      stateReadCacheMs: Number(process.env.MBOX_STATE_READ_CACHE_MS ?? 3_000),
      postgresImage,
      postgresImageId: commandOutput('docker', ['image', 'inspect', '--format={{.Id}}', postgresImage]),
      postgresPort: Number(process.env.MBOX_LOAD_POSTGRES_PORT ?? 0) || null,
      apiPorts: [process.env.MBOX_LOAD_API_PORT_1, process.env.MBOX_LOAD_API_PORT_2]
        .map((value) => Number(value)).filter(Number.isSafeInteger),
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
      referenceTime: process.env.MBOX_LOAD_REFERENCE_TIME ?? null,
      operationalTime: process.env.MBOX_LOAD_OPERATIONAL_TIME ?? null,
      samplesPerReadOrAction: Number(process.env.MBOX_LOAD_SAMPLES ?? 300),
      browserSamples: Number(process.env.MBOX_BROWSER_STARTUP_SAMPLES ?? 30),
      readRps: Number(process.env.MBOX_LOAD_READ_RPS ?? 1),
      writeRps: Number(process.env.MBOX_LOAD_WRITE_RPS ?? kdsWriteProfile.representativeRegressionRps),
      venueAssumptions: venueWorkload,
      kdsWriteAssumptions: kdsWriteProfile,
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
