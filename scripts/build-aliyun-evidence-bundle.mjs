import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectEvidenceDirectory } from './verify-sensitive-artifacts.mjs'

function options(argv) {
  const parsed = { inputs: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--input') parsed.inputs.push(argv[++index])
    else if (token.startsWith('--')) parsed[token.slice(2)] = argv[++index]
  }
  return parsed
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function filesUnder(root) {
  const files = []
  async function visit(path) {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new Error(`evidence source contains symlink: ${path}`)
    if (stat.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry))
    } else if (stat.isFile()) files.push(path)
  }
  await visit(root)
  return files.toSorted()
}

async function checksum(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

export async function buildEvidenceBundle(input) {
  const output = resolve(input.output)
  const releaseSha = required(input.releaseSha, 'releaseSha')
  if (!/^[0-9a-f]{40}$/.test(releaseSha)) throw new Error('releaseSha must be a full lowercase commit SHA')
  if (!['temp', 'main', 'rc'].includes(input.channel)) throw new Error('channel must be temp, main or rc')
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })

  for (const spec of input.inputs) {
    const separator = spec.indexOf('=')
    if (separator < 1) throw new Error(`invalid input specification: ${spec}`)
    const label = spec.slice(0, separator)
    const source = resolve(spec.slice(separator + 1))
    if (!/^[a-z0-9-]+$/.test(label)) throw new Error(`invalid input label: ${label}`)
    await cp(source, join(output, label), { recursive: true, errorOnExist: true })
  }

  const findings = await inspectEvidenceDirectory(output)
  if (findings.length) throw new Error(`evidence bundle contains ${findings.length} sensitive or invalid item(s)`)
  const artifactFiles = await filesUnder(output)
  const artifacts = []
  for (const path of artifactFiles) {
    const stat = await lstat(path)
    artifacts.push({ path: relative(output, path), bytes: stat.size, sha256: await checksum(path) })
  }
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    channel: input.channel,
    releaseVersion: required(input.releaseVersion, 'releaseVersion'),
    releaseSha,
    ciRunId: input.ciRunId || null,
    artifacts,
  }
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const sealedFiles = await filesUnder(output)
  const lines = []
  for (const path of sealedFiles) lines.push(`${await checksum(path)}  ${relative(output, path)}`)
  await writeFile(join(output, 'SHA256SUMS'), `${lines.join('\n')}\n`)
  return { output, manifest, fileCount: sealedFiles.length + 1 }
}

async function main() {
  const parsed = options(process.argv.slice(2))
  const result = await buildEvidenceBundle({
    output: required(parsed.output, '--output'),
    channel: required(parsed.channel, '--channel'),
    releaseVersion: required(parsed.version, '--version'),
    releaseSha: required(parsed.sha, '--sha'),
    ciRunId: parsed['ci-run-id'],
    inputs: parsed.inputs,
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
