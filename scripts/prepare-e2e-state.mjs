import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

await rm(resolve('.runtime/e2e-state.json'), { force: true })
