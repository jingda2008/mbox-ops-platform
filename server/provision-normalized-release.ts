import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { parseNormalizedCatalog, provisionNormalizedCatalog } from './provision-normalized-catalog.js'
import { parseStoreProvisionConfig, provisionNormalizedStore } from './provision-normalized-store.js'

export async function provisionNormalizedRelease(input: {
  databaseUrl: string
  storeConfig: ReturnType<typeof parseStoreProvisionConfig>
  catalogConfig: ReturnType<typeof parseNormalizedCatalog>
  environment?: Readonly<Record<string, string | undefined>>
  sourceCommitSha?: string
}) {
  const client = new Client({
    connectionString: input.databaseUrl,
    application_name: 'mbox-normalized-release-provisioner',
  })
  await client.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const store = await provisionNormalizedStore({
      databaseUrl: input.databaseUrl,
      config: input.storeConfig,
      environment: input.environment,
      sourceCommitSha: input.sourceCommitSha,
      client,
    })
    const catalog = await provisionNormalizedCatalog({
      databaseUrl: input.databaseUrl,
      tenantId: store.tenantId,
      storeId: store.storeId,
      catalog: input.catalogConfig,
      sourceCommitSha: input.sourceCommitSha,
      client,
    })
    await client.query('COMMIT')
    return { store, catalog }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isDirectRun) {
  const storePath = process.argv.find((entry) => entry.startsWith('--store='))?.slice('--store='.length)
  const catalogPath = process.argv.find((entry) => entry.startsWith('--catalog='))?.slice('--catalog='.length)
  const databaseUrl = process.env.DATABASE_URL
  if (!storePath || !catalogPath || !databaseUrl) {
    throw new Error('DATABASE_URL, --store and --catalog are required')
  }
  const storeConfig = parseStoreProvisionConfig(JSON.parse(await readFile(resolve(storePath), 'utf8')))
  const catalogConfig = parseNormalizedCatalog(JSON.parse(await readFile(resolve(catalogPath), 'utf8')))
  const summary = await provisionNormalizedRelease({ databaseUrl, storeConfig, catalogConfig })
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}
