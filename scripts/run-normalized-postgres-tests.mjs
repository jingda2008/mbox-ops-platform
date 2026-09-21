import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { Client } from 'pg'

const sourceUrl = process.env.TEST_NORMALIZED_DATABASE_URL
  ?? process.env.TEST_NORMALIZED_ADMIN_URL

if (!sourceUrl) {
  throw new Error('必须配置TEST_NORMALIZED_DATABASE_URL或TEST_NORMALIZED_ADMIN_URL')
}

// Validate before connecting or migrating: migrations touch cluster-wide roles.
// pg accepts query-string host/user/password overrides, so no URL parameters are
// permitted here. Never propagate ERR_INVALID_URL.input, which includes secrets.
function localTestUrl(value) {
  try {
    const url = new URL(value)
    if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !url.username || !url.pathname.slice(1) || url.search || url.hash) throw new Error()
    if (!url.port) url.port = '5432'
    return url
  } catch { throw new Error('规范化数据库测试只允许显式本机 PostgreSQL 登录，禁止连接参数覆盖') }
}
const adminUrl = localTestUrl(sourceUrl)
adminUrl.pathname = '/postgres'
const databaseName = `mbox_normalized_test_${process.pid}_${randomBytes(4).toString('hex')}`
const testUrl = localTestUrl(sourceUrl)
testUrl.pathname = `/${databaseName}`
const runtimeRole = `audit_security_login_${randomBytes(12).toString('hex')}`
const runtimePassword = randomBytes(24).toString('hex')
const runtimeUrl = new URL(testUrl)
runtimeUrl.username = runtimeRole
runtimeUrl.password = runtimePassword

const admin = new Client({
  connectionString: adminUrl.toString(),
  application_name: 'mbox-normalized-test-database-manager',
})

let created = false
let roleCreated = false
let activeChild = null
let interruption = null
let killTimer = null
const interrupt = (signal) => {
  interruption ??= signal
  process.exitCode = interruption === 'SIGINT' ? 130 : 143
  if (activeChild) {
    activeChild.kill(signal)
    // A child that ignores graceful cancellation must not keep the disposable
    // database and login alive indefinitely. Cleanup still waits for close.
    killTimer ??= setTimeout(() => activeChild?.kill('SIGKILL'), 10_000)
    killTimer.unref()
  }
}
const onSigint = () => interrupt('SIGINT')
const onSigterm = () => interrupt('SIGTERM')
process.on('SIGINT', onSigint)
process.on('SIGTERM', onSigterm)
try {
  await admin.connect()
  assertNotInterrupted()
  await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
  created = true
  assertNotInterrupted()
  // Migrations create the NOLOGIN runtime group before the test login joins it.
  // Only the disposable database's administrator runs migration/fixture writes.
  const migrated = await runChild(['--import', 'tsx', './server/migrate-normalized.ts'], {
    DATABASE_URL: testUrl.toString(), MBOX_DEPLOYMENT_TIER: 'validation',
  })
  if (migrated !== 0) throw new Error('独立测试数据库迁移失败')
  await admin.query(`CREATE ROLE ${quoteIdentifier(runtimeRole)} LOGIN INHERIT
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${runtimePassword}'`)
  roleCreated = true
  assertNotInterrupted()
  await admin.query(`GRANT mbox_runtime TO ${quoteIdentifier(runtimeRole)}`)
  assertNotInterrupted()
  const exitCode = await runVitest(testUrl.toString(), runtimeUrl.toString())
  if (exitCode !== 0) process.exitCode = exitCode
} catch (error) {
  if (!interruption) throw error
  process.stderr.write(`规范化数据库测试收到${interruption}，子进程已关闭，正在清理临时资源\n`)
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
  if (roleCreated) {
    await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(runtimeRole)}`).catch((error) => {
      process.stderr.write(`临时受限测试登录清理失败：${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = process.exitCode || 1
    })
  }
  await admin.end().catch(() => undefined)
  clearTimeout(killTimer)
  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)
}

function runVitest(databaseUrl, runtimeDatabaseUrl) {
  return runChild([
    './node_modules/vitest/vitest.mjs', 'run', 'server/migrate-normalized.test.ts', 'server/normalized',
    '--reporter=dot', '--hookTimeout=30000', '--pool=forks', '--maxWorkers=1',
  ], {
    TEST_NORMALIZED_DATABASE_URL: databaseUrl,
    TEST_NORMALIZED_RUNTIME_DATABASE_URL: runtimeDatabaseUrl,
  })
}

function runChild(args, environment) {
  assertNotInterrupted()
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      args,
      {
        cwd: process.cwd(),
        // PostgreSQL renders timestamptz through each connection's session
        // timezone.  Normalized integration assertions use canonical UTC text,
        // so force that session setting instead of inheriting the developer
        // machine's database default (for example Asia/Shanghai).
        env: {
          ...process.env,
          PGOPTIONS: normalizedTestPgOptions(process.env.PGOPTIONS),
          ...environment,
        },
        stdio: 'inherit',
      },
    )
    activeChild = child
    let spawnError = null
    child.once('error', (error) => { spawnError = error })
    child.once('close', (code, signal) => {
      activeChild = null
      clearTimeout(killTimer)
      killTimer = null
      if (interruption) reject(new Error('规范化数据库测试已取消'))
      else if (spawnError) reject(spawnError)
      else if (signal) reject(new Error(`规范化数据库测试被信号${signal}终止`))
      else resolve(code ?? 1)
    })
  })
}

function assertNotInterrupted() {
  if (interruption) throw new Error('规范化数据库测试已取消')
}

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(value)) throw new Error('临时数据库名称无效')
  return `"${value.replaceAll('"', '""')}"`
}

function normalizedTestPgOptions(existing) {
  return `${existing ?? ''} -c TimeZone=UTC`.trim()
}
