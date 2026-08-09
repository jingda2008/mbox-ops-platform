import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const referenceTime = process.env.MBOX_LOAD_REFERENCE_TIME ?? '2026-08-09T12:00:00.000Z'

function run(output) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/prepare-rc68-load-state.mjs'], {
      env: { ...process.env, MBOX_LOAD_REFERENCE_TIME: referenceTime, MBOX_LOAD_STATE_PATH: output },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`seed process exited ${code}: ${stderr}`)))
  })
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

const directory = await mkdtemp(join(tmpdir(), 'mbox-seed-determinism-'))
try {
  const first = join(directory, 'first.json')
  const second = join(directory, 'second.json')
  await run(first)
  await run(second)
  const [firstValue, secondValue] = await Promise.all([readFile(first), readFile(second)])
  const firstDigest = digest(firstValue)
  const secondDigest = digest(secondValue)
  if (firstDigest !== secondDigest) throw new Error(`load seed is not deterministic: ${firstDigest} != ${secondDigest}`)
  process.stdout.write(`${firstDigest}\n`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
