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

const files = await Promise.all(filenames.map(async (filename) => {
  const content = await readFile(resolve(directory, filename))
  return {
    filename,
    sha256: createHash('sha256').update(content).digest('hex'),
  }
}))
const digest = createHash('sha256')
for (const file of files) digest.update(`${file.filename}\0${file.sha256}\n`)

const manifest = {
  schemaVersion: 1,
  digest: `sha256:${digest.digest('hex')}`,
  count: files.length,
  files,
}
const serialized = `${JSON.stringify(manifest, null, 2)}\n`
if (output) await writeFile(output, serialized)
process.stdout.write(serialized)
