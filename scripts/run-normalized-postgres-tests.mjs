import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { Client } from 'pg'

const sourceUrl = process.env.TEST_NORMALIZED_DATABASE_URL
  ?? process.env.TEST_NORMALIZED_ADMIN_URL

if (!sourceUrl) {
  throw new Error('必须配置TEST_NORMALIZED_DATABASE_URL或TEST_NORMALIZED_ADMIN_URL')
}

const adminUrl = new URL(sourceUrl)
adminUrl.pathname = '/postgres'
const databaseName = `mbox_normalized_test_${process.pid}_${randomBytes(4).toString('hex')}`
const testUrl = new URL(sourceUrl)
testUrl.pathname = `/${databaseName}`

const admin = new Client({
  connectionString: adminUrl.toString(),
  application_name: 'mbox-normalized-test-database-manager',
})

let created = false
try {
  await admin.connect()
  await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
  created = true
  const exitCode = await runVitest(testUrl.toString())
  if (exitCode !== 0) process.exitCode = exitCode
} finally {
  if (created) {
    await admin.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `, [databaseName]).catch(() => undefined)
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`)
      .catch((error) => {
        process.stderr.write(`临时规范化测试数据库清理失败：${error instanceof Error ? error.message : String(error)}\n`)
        process.exitCode = process.exitCode || 1
      })
  }
  await admin.end().catch(() => undefined)
}

function runVitest(databaseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        './node_modules/vitest/vitest.mjs',
        'run',
        'server/migrate-normalized.test.ts',
        'server/normalized',
        '--reporter=dot',
        '--hookTimeout=30000',
        '--pool=forks',
        '--maxWorkers=1',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, TEST_NORMALIZED_DATABASE_URL: databaseUrl },
        stdio: 'inherit',
      },
    )
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`规范化数据库测试被信号${signal}终止`))
      else resolve(code ?? 1)
    })
  })
}

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(value)) throw new Error('临时数据库名称无效')
  return `"${value.replaceAll('"', '""')}"`
}
