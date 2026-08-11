import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const directory = resolve(option('directory', 'database/migrations'))
const output = option('output')
const filenames = (await readdir(directory))
  .filter((filename) => /^\d{3}_[a-z0-9_]+\.sql$/.test(filename))
  .toSorted()

if (filenames.length === 0) throw new Error(`No migration files found in ${directory}`)

function migrationCompatibility(content) {
  const sql = content.toString('utf8')
    .replaceAll(/--[^\n]*/g, ' ')
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
  const checks = [
    ['drop-object', /\bDROP\s+(TABLE|COLUMN|TYPE|SCHEMA|INDEX|CONSTRAINT)\b/i],
    ['truncate-data', /\bTRUNCATE\b/i],
    ['delete-data', /\bDELETE\s+FROM\b/i],
    ['rewrite-data', /\bUPDATE\s+[a-z0-9_."-]+\s+SET\b/i],
    ['rename-object', /\b(ALTER\s+TABLE\b[^;]*\bRENAME\b|RENAME\s+(TABLE|COLUMN)\b)/i],
    ['alter-column-contract', /\bALTER\s+TABLE\b[^;]*\bALTER\s+COLUMN\b/i],
    ['replace-object', /\bCREATE\s+OR\s+REPLACE\b/i],
    ['alter-type', /\bALTER\s+TYPE\b/i],
    ['new-write-constraint', /\bALTER\s+TABLE\b[^;]*\bADD\s+(?:COLUMN\b[^;]*\bNOT\s+NULL\b|CONSTRAINT\b)/i],
    ['new-unique-contract', /\bCREATE\s+UNIQUE\s+INDEX\b/i],
  ]
  const blockingOperations = checks.filter(([, pattern]) => pattern.test(sql)).map(([kind]) => kind)
  return {
    expandContractCompatible: blockingOperations.length === 0,
    blockingOperations,
  }
}

const files = await Promise.all(filenames.map(async (filename) => {
  const content = await readFile(resolve(directory, filename))
  return {
    filename,
    sha256: createHash('sha256').update(content).digest('hex'),
    ...migrationCompatibility(content),
  }
}))
const digest = createHash('sha256')
for (const file of files) digest.update(`${file.filename}\0${file.sha256}\n`)

const manifest = {
  schemaVersion: 2,
  compatibilityPolicy: 'expand-contract-v1',
  digest: `sha256:${digest.digest('hex')}`,
  count: files.length,
  files,
}
const serialized = `${JSON.stringify(manifest, null, 2)}\n`
if (output) await writeFile(output, serialized)
process.stdout.write(serialized)
