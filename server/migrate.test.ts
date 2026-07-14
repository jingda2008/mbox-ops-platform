import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadMigrations, unwrapMigrationTransaction } from './migrate.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function directory() {
  const value = await mkdtemp(join(tmpdir(), 'mbox-migrations-'))
  temporaryDirectories.push(value)
  return value
}

describe('database migration loader', () => {
  it('sorts migrations and computes stable checksums', async () => {
    const path = await directory()
    await writeFile(join(path, '002_second.sql'), 'SELECT 2;\n')
    await writeFile(join(path, '001_first.sql'), 'SELECT 1;\n')
    const migrations = await loadMigrations(path)
    expect(migrations.map((item) => item.version)).toEqual(['001', '002'])
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a migration sequence with gaps', async () => {
    const path = await directory()
    await writeFile(join(path, '002_second.sql'), 'SELECT 2;\n')
    await expect(loadMigrations(path)).rejects.toThrow('不连续')
  })

  it('requires one explicit transaction wrapper', () => {
    expect(unwrapMigrationTransaction('BEGIN;\nSELECT 1;\nCOMMIT;')).toContain('SELECT 1')
    expect(() => unwrapMigrationTransaction('SELECT 1;')).toThrow('BEGIN/COMMIT')
  })
})
