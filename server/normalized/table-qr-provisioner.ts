import { randomBytes } from 'node:crypto'
import { hashTableQrCredential } from './guest-session-repository.js'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
  StoreScope,
} from './transaction-runner.js'

export interface ProvisionedTableQr {
  tableId: string
  tableCode: string
  tableDisplayName: string
  qrVersion: number
  tableQrToken: string
}

export interface TableQrProvisioningInput {
  scope: Readonly<StoreScope>
  businessDate: string
  actorEmployeeId: string
  tableCodes: readonly string[]
  reason: string
  rotateExisting?: boolean
}

interface TableRow extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
  qr_version: number
  active_credential_id: string | null
}

export class TableQrAlreadyProvisionedError extends Error {
  constructor(tableCode: string) {
    super(`${tableCode}已经存在有效固定桌码；如需换码必须明确执行轮换`)
    this.name = 'TableQrAlreadyProvisionedError'
  }
}

export class TableQrProvisioningError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TableQrProvisioningError'
  }
}

export class TableQrProvisioningRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async lockTables(tableCodes: readonly string[]): Promise<TableRow[]> {
    const result = await this.transaction.query<TableRow>(`
      SELECT table_record.id, table_record.code, table_record.display_name,
        table_record.qr_version,
        credential.id AS active_credential_id
      FROM mbox.tables AS table_record
      LEFT JOIN mbox.table_qr_credentials AS credential
        ON credential.tenant_id = table_record.tenant_id
        AND credential.store_id = table_record.store_id
        AND credential.table_id = table_record.id
        AND credential.status = 'active'
      WHERE table_record.tenant_id = $1::uuid
        AND table_record.store_id = $2::uuid
        AND table_record.code = ANY($3::text[])
        AND table_record.status <> 'retired'
      ORDER BY table_record.code
      FOR UPDATE OF table_record
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, [...tableCodes]])
    return result.rows
  }

  async rotateExisting(tableId: string): Promise<number> {
    await this.transaction.query(`
      UPDATE mbox.table_qr_credentials
      SET status = 'rotated', retired_at = clock_timestamp()
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND table_id = $3::uuid AND status = 'active'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, tableId])
    const result = await this.transaction.query<{ qr_version: number }>(`
      UPDATE mbox.tables
      SET qr_version = qr_version + 1
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      RETURNING qr_version
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, tableId])
    const version = result.rows[0]?.qr_version
    if (!Number.isSafeInteger(version)) throw new TableQrProvisioningError('桌码版本更新失败')
    return Number(version)
  }

  async insertCredential(tableId: string, qrVersion: number, credentialHash: string): Promise<void> {
    await this.transaction.query(`
      INSERT INTO mbox.table_qr_credentials (
        tenant_id, store_id, table_id, qr_version, credential_hash
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      tableId,
      qrVersion,
      credentialHash,
    ])
  }

  async writeAudit(input: Readonly<{
    actorEmployeeId: string
    businessDate: string
    tableId: string
    tableCode: string
    qrVersion: number
    action: 'table_qr.provisioned' | 'table_qr.rotated'
    reason: string
  }>): Promise<void> {
    await this.transaction.query(`
      INSERT INTO mbox.audit_events (
        tenant_id, store_id, actor_type, actor_employee_id,
        action, object_type, object_id, reason, business_date, metadata
      ) VALUES (
        $1::uuid, $2::uuid, 'employee', $3::uuid,
        $4, 'table_qr', $5, $6, $7::date,
        jsonb_build_object('tableCode', $8::text, 'qrVersion', $9::integer)
      )
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.actorEmployeeId,
      input.action,
      input.tableId,
      input.reason,
      input.businessDate,
      input.tableCode,
      input.qrVersion,
    ])
  }
}

export class TableQrProvisioner {
  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner, 'run'>,
    private readonly hashSecret: string,
    private readonly randomToken: () => string = () => randomBytes(24).toString('base64url'),
  ) {
    if (hashSecret.length < 32) throw new TypeError('桌码哈希密钥至少需要32个字符')
  }

  provision(input: Readonly<TableQrProvisioningInput>): Promise<ProvisionedTableQr[]> {
    const tableCodes = normalizeTableCodes(input.tableCodes)
    const reason = input.reason.trim()
    if (reason.length < 2 || reason.length > 500) {
      throw new TableQrProvisioningError('签发或轮换桌码必须填写2至500字原因')
    }
    if (!isUuid(input.actorEmployeeId)) throw new TableQrProvisioningError('操作员工无效')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
      throw new TableQrProvisioningError('营业日格式无效')
    }

    return this.transactions.run(input.scope, async (transaction) => {
      const repository = new TableQrProvisioningRepository(transaction)
      const rows = await repository.lockTables(tableCodes)
      const found = new Set(rows.map((row) => row.code))
      const missing = tableCodes.filter((code) => !found.has(code))
      if (missing.length > 0) throw new TableQrProvisioningError(`找不到可用桌台：${missing.join('、')}`)

      const provisioned: ProvisionedTableQr[] = []
      for (const row of rows) {
        const rotating = row.active_credential_id !== null
        if (rotating && input.rotateExisting !== true) {
          throw new TableQrAlreadyProvisionedError(row.code)
        }
        const qrVersion = rotating
          ? await repository.rotateExisting(row.id)
          : Number(row.qr_version)
        const tableQrToken = this.randomToken()
        if (!/^[A-Za-z0-9_-]{32,256}$/.test(tableQrToken)) {
          throw new TableQrProvisioningError('桌码随机源返回了无效凭证')
        }
        const credentialHash = hashTableQrCredential(this.hashSecret, input.scope, tableQrToken)
        await repository.insertCredential(row.id, qrVersion, credentialHash)
        await repository.writeAudit({
          actorEmployeeId: input.actorEmployeeId,
          businessDate: input.businessDate,
          tableId: row.id,
          tableCode: row.code,
          qrVersion,
          action: rotating ? 'table_qr.rotated' : 'table_qr.provisioned',
          reason,
        })
        provisioned.push({
          tableId: row.id,
          tableCode: row.code,
          tableDisplayName: row.display_name,
          qrVersion,
          tableQrToken,
        })
      }
      return provisioned
    }, { isolation: 'serializable', retryOnConflict: 2 })
  }
}

function normalizeTableCodes(values: readonly string[]): string[] {
  const normalized = [...new Set(values.map((value) => value.trim().toUpperCase()).filter(Boolean))]
  if (normalized.length < 1 || normalized.length > 200) {
    throw new TableQrProvisioningError('每次必须选择1至200张桌台')
  }
  for (const value of normalized) {
    if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(value)) {
      throw new TableQrProvisioningError(`桌号格式无效：${value}`)
    }
  }
  return normalized.toSorted()
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
