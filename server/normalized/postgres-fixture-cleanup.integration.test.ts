import { randomUUID } from 'node:crypto'
import { Client, Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { dropDisconnectedLocalFixtureDatabase } from '../../scripts/test-support/postgres-fixture-cleanup.js'

const ownerUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL

;(ownerUrl && runtimeUrl ? describe : describe.skip)('local PostgreSQL fixture shutdown', () => {
  async function fixture() {
    const owner = new URL(ownerUrl!), runtime = new URL(runtimeUrl!)
    for (const url of [owner, runtime]) {
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.search || url.hash) {
        throw new Error('Cleanup regression requires explicit local test database URLs')
      }
    }
    owner.pathname = '/postgres'
    const admin = new Client({ connectionString: owner.toString() })
    await admin.connect()
    const database = `cleanup_probe_${randomUUID().replaceAll('-', '')}`
    try { await admin.query(`CREATE DATABASE "${database}"`) }
    catch (error) { await admin.end(); throw error }
    runtime.pathname = `/${database}`
    return { admin, database, runtime: runtime.toString() }
  }

  it('waits for a real restricted connection after pool.end resolves before deleting its database', async () => {
    const { admin, database, runtime } = await fixture()
    const pool = new Pool({ connectionString: runtime, max: 1 })
    const errors: string[] = []
    pool.on('error', error => { errors.push((error as Error & { code?: string }).code ?? 'unknown') })
    let release: (() => void) | undefined
    let resumeEnd: (() => void) | undefined
    let ended: Promise<void> | undefined
    let dropping: Promise<void> | undefined
    try {
      const client = await pool.connect()
      let released = false
      release = () => { if (!released) { released = true; client.release() } }
      const role = (await client.query('SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
      expect(role).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false })
      ended = new Promise(resolve => { client.once('end', resolve) })
      const internal = client as unknown as { connection: { end: () => void }; _ending: boolean; _ended: boolean }
      const originalEnd = internal.connection.end.bind(internal.connection)
      // Hold only the real protocol close write. The Pool, socket, role and
      // pg_stat_activity checks are actual PostgreSQL, not mocked errors.
      internal.connection.end = () => { resumeEnd = originalEnd }
      release()
      await pool.end()
      expect(internal._ending).toBe(true)
      expect(internal._ended).toBe(false)
      expect(typeof resumeEnd).toBe('function')
      let dropped = false
      dropping = dropDisconnectedLocalFixtureDatabase(admin, database).then(() => { dropped = true })
      expect((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1', [database])).rows[0].n).toBe(1)
      expect((await admin.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [database])).rows[0].n).toBe(1)
      expect(dropped).toBe(false)
      resumeEnd!()
      await dropping
      await ended
      expect(errors).toEqual([])
      expect((await admin.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [database])).rows[0].n).toBe(0)
    } finally {
      resumeEnd?.()
      release?.()
      if (!pool.ending) await pool.end()
      await ended
      await dropping?.catch(() => undefined)
      try { await dropDisconnectedLocalFixtureDatabase(admin, database) }
      finally { await admin.end() }
    }
  })

  it('fails at a bounded deadline without terminating an open connection, then cleans up after disconnect', async () => {
    const { admin, database, runtime } = await fixture()
    const client = new Client({ connectionString: runtime })
    try {
      await client.connect()
      const queries = vi.spyOn(admin, 'query')
      try {
        // Either deadline path is a hard failure before DROP: the polling
        // deadline or pg's explicit client query timeout on a loaded CI host.
        await expect(dropDisconnectedLocalFixtureDatabase(admin, database, 500)).rejects.toThrow(/cleanup deadline|Query read timeout/)
        expect(queries.mock.calls.some(([query]) => /^DROP DATABASE/.test(typeof query === 'string' ? query : 'text' in query ? query.text : ''))).toBe(false)
      } finally { queries.mockRestore() }
      expect((await client.query('SELECT 1 AS alive')).rows[0].alive).toBe(1)
      expect((await admin.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [database])).rows[0].n).toBe(1)
      await client.end()
      await dropDisconnectedLocalFixtureDatabase(admin, database)
      expect((await admin.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [database])).rows[0].n).toBe(0)
    } finally {
      await client.end()
      try { await dropDisconnectedLocalFixtureDatabase(admin, database) }
      finally { await admin.end() }
    }
  })

  it('rejects non-fixture database names and non-local administrators before querying', async () => {
    const local = new Client({ host: '127.0.0.1', database: 'postgres' })
    const remote = new Client({ host: 'example.invalid', database: 'postgres' })
    await expect(dropDisconnectedLocalFixtureDatabase(local, 'postgres')).rejects.toThrow('exact generated test database name')
    await expect(dropDisconnectedLocalFixtureDatabase(local, 'cleanup_probe_not-a-uuid')).rejects.toThrow('exact generated test database name')
    await expect(dropDisconnectedLocalFixtureDatabase(remote, `cleanup_probe_${'a'.repeat(32)}`)).rejects.toThrow('local administrator')
  })
})
