import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createSeedState } from '../dist-server/server/seed.js'

const output = resolve(process.env.MBOX_LOAD_STATE_PATH?.trim() || '.runtime/rc68-load-state.json')
const state = createSeedState(new Date())
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
console.log(output)
