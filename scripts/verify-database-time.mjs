import { Client } from 'pg'

const databaseUrl = process.env.DATABASE_URL?.trim()
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const client = new Client({ connectionString: databaseUrl, application_name: 'mbox-time-verifier' })
await client.connect()
try {
  const results = []
  for (const sessionTimeZone of ['UTC', 'Asia/Shanghai']) {
    await client.query('BEGIN')
    try {
      await client.query(`SET LOCAL TIME ZONE '${sessionTimeZone}'`)
      const result = await client.query(`
        SELECT
          extract(epoch FROM timestamptz '2026-08-08 21:59:59+00')::bigint AS before_epoch,
          extract(epoch FROM timestamptz '2026-08-08 22:00:00+00')::bigint AS after_epoch,
          ((timestamptz '2026-08-08 21:59:59+00' AT TIME ZONE 'Asia/Shanghai') - interval '6 hours')::date::text AS before_business_date,
          ((timestamptz '2026-08-08 22:00:00+00' AT TIME ZONE 'Asia/Shanghai') - interval '6 hours')::date::text AS after_business_date,
          extract(epoch FROM clock_timestamp())::bigint AS database_epoch
      `)
      const row = result.rows[0]
      if (!row) throw new Error(`${sessionTimeZone} did not return a time verification row`)
      results.push({ sessionTimeZone, ...row })
      await client.query('ROLLBACK')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  }

  const [utc, shanghai] = results
  if (!utc || !shanghai) throw new Error('database time matrix is incomplete')
  for (const row of results) {
    if (row.before_business_date !== '2026-08-08' || row.after_business_date !== '2026-08-09') {
      throw new Error(`${row.sessionTimeZone} produced an incorrect 06:00 business-day boundary`)
    }
    if (!Number.isFinite(Number(row.database_epoch))) throw new Error('database clock is invalid')
  }
  if (utc.before_epoch !== shanghai.before_epoch || utc.after_epoch !== shanghai.after_epoch) {
    throw new Error('timestamptz epoch changed with the database session timezone')
  }
  process.stdout.write(`${JSON.stringify({ passed: true, results }, null, 2)}\n`)
} finally {
  await client.end()
}
