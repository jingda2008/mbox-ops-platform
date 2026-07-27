import { cp, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const source = resolve('config')
const destination = resolve('dist-server/config')

await mkdir(destination, { recursive: true })
await cp(source, destination, { recursive: true, force: true })
process.stdout.write(`copied runtime assets: ${source} -> ${destination}\n`)
