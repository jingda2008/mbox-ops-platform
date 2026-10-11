import { readFile, readdir, rm } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { scanImportClosure } from './normalized-import-closure.mjs'

const root = process.cwd(), output = resolve(root, 'dist-normalized')
const config = JSON.parse(await readFile(resolve(root, 'tsconfig.normalized-server.json'), 'utf8'))
const entries = config.files.map(file => file.replace(/\.tsx?$/, '.js'))
const closure = await scanImportClosure({ cwd: output, entries })
const retained = new Set(closure.files)
const removed = []
async function prune(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, item.name)
    if (item.isDirectory()) await prune(file)
    else if (item.name.endsWith('.js') && !retained.has(relative(output, file))) {
      await rm(file); removed.push(relative(output, file))
    }
  }
}
await prune(output)
// Every published JS module must belong to a declared runtime or operations entry.
await scanImportClosure({ cwd: output, entries })
process.stdout.write(`${JSON.stringify({ entries, retained: retained.size, removed }, null, 2)}\n`)
