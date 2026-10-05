import { performance } from 'node:perf_hooks'
import { setTimeout as wait } from 'node:timers/promises'
import type { Client } from 'pg'

// Test-only: pg-pool.end() can resolve before its removed clients finish their
// PostgreSQL Terminate exchange. Never force-kill those still-closing sockets.
export async function dropDisconnectedLocalFixtureDatabase(
  admin: Client,
  database: string,
  timeoutMs = 5_000,
): Promise<void> {
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(admin.host)
    || admin.database !== 'postgres'
    || !/^(?:consumption_upgrade|causal_upgrade|cleanup_probe)_[a-f0-9]{32}$/.test(database)) {
    throw new Error('Fixture cleanup requires a local administrator and an exact generated test database name')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) {
    throw new Error('Fixture cleanup requires a bounded positive timeout')
  }
  const deadline = performance.now() + timeoutMs
  const remaining = () => {
    const milliseconds = Math.ceil(deadline - performance.now())
    if (milliseconds <= 0) throw new Error('Fixture database still has connections at cleanup deadline; no connections were terminated')
    return milliseconds
  }
  for (;;) {
    const query = {
      text: 'SELECT count(*)::int AS connections FROM pg_stat_activity WHERE datname = $1',
      values: [database],
      query_timeout: remaining(),
    }
    const result = await admin.query<{ connections: number }>(query)
    if (result.rows[0]?.connections === 0) break
    // Poll the actual server-side condition, with a monotonic deadline; this is
    // not a fixed delay that assumes sockets have finished closing.
    await wait(Math.min(20, remaining()))
  }
  // This administrator is dedicated to fixture cleanup and closed by the
  // caller's finally. Bound the DDL on the server as well as the client; a
  // client read timeout alone does not cancel PostgreSQL's current statement.
  const configureDropTimeout = {
    text: "SELECT set_config('statement_timeout', $1, false), set_config('lock_timeout', $1, false)",
    values: [String(remaining())],
    query_timeout: remaining(),
  }
  await admin.query(configureDropTimeout)
  const drop = {
    // Without FORCE, even a new connection after the zero-count read cannot be
    // killed by cleanup: PostgreSQL refuses/waits for that connection instead.
    text: `DROP DATABASE IF EXISTS "${database}"`,
    query_timeout: remaining(),
  }
  await admin.query(drop)
}
