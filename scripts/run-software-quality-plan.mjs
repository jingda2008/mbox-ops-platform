import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUTPUT_TAIL_LIMIT = 8_000

function tail(value, limit = OUTPUT_TAIL_LIMIT) {
  return value.length <= limit ? value : value.slice(-limit)
}

function assertString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

export function validateQualityPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('quality plan must be an object')
  if (plan.schemaVersion !== 1) throw new Error('quality plan schemaVersion must be 1')
  if (plan.template === true) throw new Error('quality plan template must be copied and adapted before execution')
  assertString(plan.name, 'quality plan name')
  if (!Array.isArray(plan.gates) || plan.gates.length === 0) throw new Error('quality plan gates must be a non-empty array')
  const ids = new Set()
  for (const [index, gate] of plan.gates.entries()) {
    if (!gate || typeof gate !== 'object' || Array.isArray(gate)) throw new Error(`gate ${index + 1} must be an object`)
    const id = assertString(gate.id, `gate ${index + 1} id`)
    if (ids.has(id)) throw new Error(`duplicate gate id: ${id}`)
    ids.add(id)
    if (!Array.isArray(gate.command) || gate.command.length === 0
      || typeof gate.command[0] !== 'string' || !gate.command[0]
      || gate.command.slice(1).some((item) => typeof item !== 'string')) {
      throw new Error(`gate ${id} command must be a non-empty string array`)
    }
    if (gate.timeoutSeconds !== undefined && (!Number.isFinite(gate.timeoutSeconds) || gate.timeoutSeconds <= 0)) {
      throw new Error(`gate ${id} timeoutSeconds must be positive`)
    }
  }
  if (plan.profiles !== undefined) {
    if (!plan.profiles || typeof plan.profiles !== 'object' || Array.isArray(plan.profiles)) throw new Error('profiles must be an object')
    for (const [profile, gateIds] of Object.entries(plan.profiles)) {
      if (!Array.isArray(gateIds) || gateIds.length === 0) throw new Error(`profile ${profile} must contain gate ids`)
      for (const gateId of gateIds) if (!ids.has(gateId)) throw new Error(`profile ${profile} references unknown gate ${gateId}`)
    }
  }
  return plan
}

function sourceIdentity(cwd) {
  try {
    const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0
    return { commitSha, dirty }
  } catch {
    return { commitSha: null, dirty: null }
  }
}

export async function runGate(gate, { cwd, inheritedEnv = process.env } = {}) {
  const startedAt = new Date()
  const timeoutSeconds = gate.timeoutSeconds ?? 600
  const [executable, ...args] = gate.command
  let stdout = ''
  let stderr = ''
  let timedOut = false
  const started = performance.now()
  const exitCode = await new Promise((resolveExit) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...inheritedEnv, ...(gate.env ?? {}) },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => { stdout = tail(stdout + chunk.toString()) })
    child.stderr.on('data', (chunk) => { stderr = tail(stderr + chunk.toString()) })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
    }, timeoutSeconds * 1_000)
    timer.unref()
    child.on('error', (error) => {
      clearTimeout(timer)
      stderr = tail(`${stderr}\n${error.message}`)
      resolveExit(-1)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveExit(code ?? -1)
    })
  })
  return {
    id: gate.id,
    title: gate.title ?? gate.id,
    category: gate.category ?? 'functional',
    required: gate.required !== false,
    command: gate.command,
    startedAt: startedAt.toISOString(),
    durationMs: Math.round((performance.now() - started) * 10) / 10,
    exitCode,
    timedOut,
    passed: exitCode === 0 && !timedOut,
    stdoutTail: stdout,
    stderrTail: stderr,
  }
}

export async function runQualityPlan(plan, options = {}) {
  validateQualityPlan(plan)
  const cwd = resolve(options.cwd ?? plan.workingDirectory ?? process.cwd())
  const profile = options.profile ?? 'release'
  const selectedIds = plan.profiles?.[profile] ?? plan.gates.map((gate) => gate.id)
  const selected = selectedIds.map((id) => plan.gates.find((gate) => gate.id === id))
  const results = []
  for (const gate of selected) results.push(await runGate(gate, { cwd, inheritedEnv: options.env }))
  const blockingFailures = results.filter((result) => result.required && !result.passed)
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    plan: plan.name,
    profile,
    source: sourceIdentity(cwd),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    summary: {
      total: results.length,
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
      blockingFailures: blockingFailures.length,
    },
    gates: results,
    passed: blockingFailures.length === 0,
  }
}

function parseArgs(argv) {
  const parsed = { profile: 'release' }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--plan') parsed.plan = argv[++index]
    else if (value === '--output') parsed.output = argv[++index]
    else if (value === '--profile') parsed.profile = argv[++index]
    else if (value === '--cwd') parsed.cwd = argv[++index]
    else throw new Error(`unknown argument: ${value}`)
  }
  if (!parsed.plan) throw new Error('--plan is required')
  if (!parsed.output) throw new Error('--output is required')
  return parsed
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const plan = JSON.parse(await readFile(resolve(args.plan), 'utf8'))
  const report = await runQualityPlan(plan, { profile: args.profile, cwd: args.cwd })
  const output = resolve(args.output)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(report.summary)}\n`)
  if (!report.passed) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
