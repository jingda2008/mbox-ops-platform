import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  loadNormalizedMigrations,
  NORMALIZED_SCHEMA_FLAVOR,
  unwrapNormalizedMigrationTransaction,
} from '../migrate-normalized.js'

const sourceUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const sourceAdminUrl = process.env.TEST_NORMALIZED_ADMIN_URL ?? sourceUrl
const postgresContainer = process.env.TEST_POSTGRES_CONTAINER
if (process.env.CI && sourceUrl && !postgresContainer) {
  throw new Error('TEST_POSTGRES_CONTAINER is required for the formal database recovery drill')
}
const integration = sourceUrl && postgresContainer ? describe : describe.skip
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`
const containerUrl = (source: string, database: string) => {
  const url = new URL(source)
  url.hostname = '127.0.0.1'
  url.port = '5432'
  url.pathname = `/${database}`
  return url.toString()
}

integration('contract database maintenance recovery', () => {
  it('restores 095 into a verified staging database before retaining and swapping out 096', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const databaseName = `mbox_restore_${suffix}`
    const backupRole = `mbox_backup_${suffix}`
    const root = mkdtempSync(join(tmpdir(), 'mbox-db-restore-'))
    const bin = join(root, 'bin')
    const wrapper = resolve('scripts/test-support/docker-postgres-client.sh')
    const evidence = join(root, 'source.json')
    const manifest = join(root, 'release-manifest.json')
    const report = join(root, 'report.json')
    const backupDirectory = join(root, 'backups')
    const serviceFile = join(root, 'pg_service.conf')
    const passFile = join(root, 'pgpass')
    const argvLog = join(root, 'postgres-client-argv.log')
    const targetService = `target_${suffix}`
    const adminService = `admin_${suffix}`
    const backupService = `backup_${suffix}`
    const adminUrl = containerUrl(sourceAdminUrl!, 'postgres')
    const targetUrl = containerUrl(sourceAdminUrl!, databaseName)
    const adminCredentials = new URL(adminUrl)
    const escapePassField = (value: string) => value.replaceAll('\\', '\\\\').replaceAll(':', '\\:')
    writeFileSync(serviceFile, [
      `[${targetService}]`, 'host=127.0.0.1', 'port=5432', `dbname=${databaseName}`,
      `user=${decodeURIComponent(adminCredentials.username)}`,
      `[${adminService}]`, 'host=127.0.0.1', 'port=5432', 'dbname=postgres',
      `user=${decodeURIComponent(adminCredentials.username)}`,
      `[${backupService}]`, 'host=127.0.0.1', 'port=5432', `dbname=${databaseName}`,
      `user=${backupRole}`, '',
    ].join('\n'))
    writeFileSync(passFile, [
      `127.0.0.1:5432:*:${escapePassField(decodeURIComponent(adminCredentials.username))}:${escapePassField(decodeURIComponent(adminCredentials.password))}`,
      `127.0.0.1:5432:*:${escapePassField(backupRole)}:backup-test`, '',
    ].join('\n'))
    chmodSync(serviceFile, 0o600)
    chmodSync(passFile, 0o600)
    execFileSync('mkdir', ['-p', bin, backupDirectory])
    for (const client of ['psql', 'pg_dump', 'pg_restore']) symlinkSync(wrapper, join(bin, client))
    chmodSync(wrapper, 0o755)
    const environment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TEST_POSTGRES_CONTAINER: postgresContainer!,
      PGSERVICEFILE: serviceFile,
      PGPASSFILE: passFile,
      TEST_POSTGRES_ARGV_LOG: argvLog,
    }
    const base = new URL(sourceAdminUrl!)
    base.pathname = '/postgres'
    const target = new URL(sourceUrl!)
    target.pathname = `/${databaseName}`
    const admin = new Client({ connectionString: base.toString() })
    let preservedDatabase: string | undefined
    await admin.connect()
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE template0`)
      await admin.query(`CREATE ROLE ${quoteIdentifier(backupRole)} LOGIN PASSWORD 'backup-test' BYPASSRLS`)
      await admin.query(`GRANT pg_monitor,pg_read_all_data TO ${quoteIdentifier(backupRole)}`)
      await admin.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(backupRole)}`)
      const client = new Client({ connectionString: target.toString() })
      await client.connect()
      const migrations = (await loadNormalizedMigrations()).filter((migration) => migration.version <= '095')
      await client.query('CREATE SCHEMA mbox')
      await client.query(`CREATE TABLE mbox.normalized_schema_metadata(
        singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),schema_flavor text NOT NULL,
        schema_version text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`)
      await client.query(`CREATE TABLE mbox.normalized_schema_migrations(
        version text PRIMARY KEY,filename text NOT NULL UNIQUE,checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`)
      await client.query(`INSERT INTO mbox.normalized_schema_metadata(singleton,schema_flavor,schema_version)
        VALUES(true,$1,'000')`, [NORMALIZED_SCHEMA_FLAVOR])
      for (const migration of migrations) {
        await client.query('BEGIN')
        try {
          await client.query(unwrapNormalizedMigrationTransaction(migration.sql))
          await client.query(`INSERT INTO mbox.normalized_schema_migrations(version,filename,checksum)
            VALUES($1,$2,$3)`, [migration.version, migration.filename, migration.checksum])
          await client.query(`UPDATE mbox.normalized_schema_metadata SET schema_version=$1,
            updated_at=clock_timestamp() WHERE singleton=true`, [migration.version])
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      }
      const tenantA = randomUUID(), tenantB = randomUUID(), storeA = randomUUID(), storeB = randomUUID()
      await client.query(`INSERT INTO mbox.tenants(id,code,name) VALUES
        ($1,$2,'Restore A'),($3,$4,'Restore B')`,
      [tenantA, `restore-a-${suffix}`, tenantB, `restore-b-${suffix}`])
      await client.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES
        ($1,$2,$3,'Restore A'),($4,$5,$6,'Restore B')`,
      [storeA, tenantA, `restore-a-${suffix}`, storeB, tenantB, `restore-b-${suffix}`])
      await client.end()
      await admin.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} CONNECTION LIMIT 17`)
      await admin.query(`REVOKE CONNECT,TEMPORARY ON DATABASE ${quoteIdentifier(databaseName)} FROM PUBLIC`)
      await admin.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(backupRole)}`)
      await admin.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} SET statement_timeout='45s'`)
      execFileSync(resolve('deploy/aliyun/restore-postgres.sh'), ['capture', evidence], {
        env: { ...environment, DATABASE_SERVICE: backupService, MBOX_EXPECTED_RESTORE_DATABASE: databaseName },
      })
      const backup = execFileSync(resolve('deploy/aliyun/backup-postgres.sh'), [], {
        encoding: 'utf8',
        env: { ...environment, DATABASE_SERVICE: backupService, BACKUP_DIR: backupDirectory },
      }).trim()
      writeFileSync(manifest, JSON.stringify({ migration: {
        count: migrations.length,
        files: migrations.map((migration) => ({ filename: migration.filename, sha256: migration.checksum })),
      } }))
      const upgraded = new Client({ connectionString: target.toString() })
      await upgraded.connect()
      const migration096 = (await loadNormalizedMigrations()).find((migration) => migration.version === '096')!
      await upgraded.query('BEGIN')
      await upgraded.query(unwrapNormalizedMigrationTransaction(migration096.sql))
      await upgraded.query(`INSERT INTO mbox.normalized_schema_migrations(version,filename,checksum)
        VALUES($1,$2,$3)`, [migration096.version, migration096.filename, migration096.checksum])
      await upgraded.query(`UPDATE mbox.normalized_schema_metadata SET schema_version='096',
        updated_at=clock_timestamp() WHERE singleton=true`)
      await upgraded.query('COMMIT')
      await upgraded.end()
      execFileSync(resolve('deploy/aliyun/restore-postgres.sh'), ['restore', backup], {
        env: {
          ...environment,
          DATABASE_SERVICE: targetService,
          ADMIN_DATABASE_SERVICE: adminService,
          MBOX_EXPECTED_RESTORE_DATABASE: databaseName,
          MBOX_EXPECTED_RESTORE_SCHEMA_VERSION: '095',
          MBOX_EXPECTED_RESTORE_MANIFEST: manifest,
          MBOX_EXPECTED_RESTORE_EVIDENCE: evidence,
          MBOX_RESTORE_REPORT: report,
          MBOX_CONFIRM_RESTORE: 'RESTORE',
        },
      })
      const restored = new Client({ connectionString: target.toString() })
      await restored.connect()
      expect((await restored.query(`SELECT schema_version FROM mbox.normalized_schema_metadata
        WHERE singleton=true`)).rows[0]?.schema_version).toBe('095')
      expect((await restored.query(`SELECT to_regclass('mbox.table_customer_movement_events') AS name`))
        .rows[0]?.name).toBeNull()
      expect(Number((await restored.query(`SELECT count(*) FROM mbox.tenants`)).rows[0]?.count)).toBe(2)
      await restored.end()
      const result = JSON.parse(readFileSync(report, 'utf8'))
      preservedDatabase = result.preservedDatabase
      expect(result.originalDatabaseRetained).toBe(true)
      const database = (await admin.query(`SELECT datconnlimit,datallowconn FROM pg_database WHERE datname=$1`,
        [databaseName])).rows[0]
      expect(database).toEqual({ datconnlimit: 17, datallowconn: true })
      expect((await admin.query(`SELECT datallowconn FROM pg_database WHERE datname=$1`,
        [preservedDatabase])).rows[0]?.datallowconn).toBe(false)
      const clientArgv = readFileSync(argvLog, 'utf8')
      expect(clientArgv).toContain(`pg_dump <--dbname=service=${backupService}>`)
      expect(clientArgv).toContain(`pg_restore <--dbname=service=${adminService} dbname=`)
      expect(clientArgv).not.toContain('backup-test')
      expect(clientArgv).not.toMatch(/postgres(?:ql)?:\/\//)

      const restored095Database = `mbox_restored095_${suffix}`
      await admin.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} WITH ALLOW_CONNECTIONS false`)
      await admin.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} RENAME TO ${quoteIdentifier(restored095Database)}`)
      await admin.query(`ALTER DATABASE ${quoteIdentifier(preservedDatabase!)} RENAME TO ${quoteIdentifier(databaseName)}`)
      await admin.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} WITH ALLOW_CONNECTIONS true`)
      await admin.query(`ALTER DATABASE ${quoteIdentifier(restored095Database)} WITH ALLOW_CONNECTIONS true`)
      await admin.query(`DROP DATABASE ${quoteIdentifier(restored095Database)}`)
      preservedDatabase = undefined
      const restoreEnvironment = {
        ...environment,
        DATABASE_SERVICE: targetService,
        ADMIN_DATABASE_SERVICE: adminService,
        MBOX_EXPECTED_RESTORE_DATABASE: databaseName,
        MBOX_EXPECTED_RESTORE_SCHEMA_VERSION: '095',
        MBOX_EXPECTED_RESTORE_MANIFEST: manifest,
        MBOX_EXPECTED_RESTORE_EVIDENCE: evidence,
        MBOX_RESTORE_REPORT: report,
        MBOX_CONFIRM_RESTORE: 'RESTORE',
      }
      const preRenameSignalMarker = join(root, 'pre-rename-signalled')
      expect(() => execFileSync(resolve('deploy/aliyun/restore-postgres.sh'), ['restore', backup], {
        env: {
          ...restoreEnvironment,
          TEST_PSQL_SIGNAL_PATTERN: 'ALTER DATABASE :"staging_database" WITH ALLOW_CONNECTIONS false;',
          TEST_PSQL_ONCE_FILE: preRenameSignalMarker,
        },
      })).toThrow()
      expect((await admin.query(`SELECT datallowconn FROM pg_database WHERE datname=$1`,
        [databaseName])).rows[0]?.datallowconn).toBe(true)
      const afterPreRenameSignal = new Client({ connectionString: target.toString() })
      await afterPreRenameSignal.connect()
      expect((await afterPreRenameSignal.query(`SELECT schema_version FROM mbox.normalized_schema_metadata
        WHERE singleton=true`)).rows[0]?.schema_version).toBe('096')
      await afterPreRenameSignal.end()
      expect(Number((await admin.query(`SELECT count(*) FROM pg_database
        WHERE datname LIKE 'mbox_restore_%' AND datname<>$1`, [databaseName])).rows[0]?.count)).toBe(0)

      const renameFailureMarker = join(root, 'rename-failed')
      expect(() => execFileSync(resolve('deploy/aliyun/restore-postgres.sh'), ['restore', backup], {
        env: {
          ...restoreEnvironment,
          TEST_PSQL_FAIL_PATTERN: 'ALTER DATABASE :"staging_database" RENAME TO :"target_database";',
          TEST_PSQL_ONCE_FILE: renameFailureMarker,
        },
      })).toThrow()
      expect((await admin.query(`SELECT datallowconn FROM pg_database WHERE datname=$1`,
        [databaseName])).rows[0]?.datallowconn).toBe(true)
      const afterRenameFailure = new Client({ connectionString: target.toString() })
      await afterRenameFailure.connect()
      expect((await afterRenameFailure.query(`SELECT schema_version FROM mbox.normalized_schema_metadata
        WHERE singleton=true`)).rows[0]?.schema_version).toBe('096')
      await afterRenameFailure.end()
      expect(Number((await admin.query(`SELECT count(*) FROM pg_database
        WHERE datname LIKE 'mbox_pre096_%'`)).rows[0]?.count)).toBe(0)
      expect(Number((await admin.query(`SELECT count(*) FROM pg_database
        WHERE datname LIKE 'mbox_restore_%' AND datname<>$1`, [databaseName])).rows[0]?.count)).toBe(0)

      const signalMarker = join(root, 'rename-signalled')
      expect(() => execFileSync(resolve('deploy/aliyun/restore-postgres.sh'), ['restore', backup], {
        env: {
          ...restoreEnvironment,
          TEST_PSQL_SIGNAL_PATTERN: 'ALTER DATABASE :"target_database" RENAME TO :"preserved_database";',
          TEST_PSQL_ONCE_FILE: signalMarker,
        },
      })).toThrow()
      expect((await admin.query(`SELECT datallowconn FROM pg_database WHERE datname=$1`,
        [databaseName])).rows[0]?.datallowconn).toBe(true)
      const afterSignal = new Client({ connectionString: target.toString() })
      await afterSignal.connect()
      expect((await afterSignal.query(`SELECT schema_version FROM mbox.normalized_schema_metadata
        WHERE singleton=true`)).rows[0]?.schema_version).toBe('096')
      await afterSignal.end()
      expect(Number((await admin.query(`SELECT count(*) FROM pg_database
        WHERE datname LIKE 'mbox_pre096_%'`)).rows[0]?.count)).toBe(0)
      expect(Number((await admin.query(`SELECT count(*) FROM pg_database
        WHERE datname LIKE 'mbox_restore_%' AND datname<>$1`, [databaseName])).rows[0]?.count)).toBe(0)

      const finalEvidenceMarker = join(root, 'final-evidence-corrupted')
      expect(() => execFileSync(resolve('deploy/aliyun/restore-postgres.sh'), ['restore', backup], {
        env: {
          ...restoreEnvironment,
          TEST_PSQL_AFTER_PATTERN: 'ALTER DATABASE :"target_database" WITH ALLOW_CONNECTIONS true;',
          TEST_PSQL_AFTER_DATABASE_SERVICE: targetService,
          TEST_PSQL_AFTER_SQL: `UPDATE mbox.normalized_schema_metadata SET schema_version='094' WHERE singleton=true`,
          TEST_PSQL_ONCE_FILE: finalEvidenceMarker,
        },
      })).toThrow()
      expect((await admin.query(`SELECT datallowconn FROM pg_database WHERE datname=$1`,
        [databaseName])).rows[0]?.datallowconn).toBe(true)
      const afterFinalEvidenceFailure = new Client({ connectionString: target.toString() })
      await afterFinalEvidenceFailure.connect()
      expect((await afterFinalEvidenceFailure.query(`SELECT schema_version FROM mbox.normalized_schema_metadata
        WHERE singleton=true`)).rows[0]?.schema_version).toBe('096')
      await afterFinalEvidenceFailure.end()
      expect(Number((await admin.query(`SELECT count(*) FROM pg_database
        WHERE datname LIKE 'mbox_failed_restore_%'`)).rows[0]?.count)).toBe(0)
    } finally {
      const related = (await admin.query<{ datname: string }>(`SELECT datname FROM pg_database
        WHERE datname=$1 OR datname LIKE 'mbox_pre096_%' OR datname LIKE 'mbox_restore_%'
          OR datname LIKE 'mbox_failed_restore_%'`, [databaseName])).rows.map((row) => row.datname)
      for (const name of [...new Set([databaseName, preservedDatabase, ...related].filter(Boolean) as string[])]) {
        await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1`, [name])
        await admin.query(`ALTER DATABASE ${quoteIdentifier(name)} WITH ALLOW_CONNECTIONS true`).catch(() => undefined)
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`).catch(() => undefined)
      }
      await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(backupRole)}`).catch(() => undefined)
      await admin.end()
    }
  }, 180_000)
})
