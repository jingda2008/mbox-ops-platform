import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { appendAuditEvent, type JsonObject } from './command-executor.js'
import { normalizeHardwareFailureCode, type HardwareStation, type PrintProfile } from './hardware-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

export interface PrintBridgeView {
  id: string
  publicId: string
  name: string
  status: 'active' | 'revoked'
  hostname: string
  platform: 'windows'
  softwareVersion: string
  lastSeenAt: string | null
  installedAt: string
  printerCount: number
  online: boolean
  queues: string[]
}

export interface ClaimedBridgePrintJob {
  id: string
  businessKey: string
  printerDeviceId: string
  printerCode: string
  printerName: string
  windowsQueueName: string
  printProfile: PrintProfile
  stationCode: HardwareStation
  copies: number
  printSnapshot: JsonObject
  containsPriorityNote: boolean
  attempt: number
}

export interface ClaimedBridgeCommand {
  id: string
  publicId: string
  deviceId: string
  commandType: 'test_print' | 'reconnect' | 'ping'
  windowsQueueName: string
  printProfile: PrintProfile
  payloadSnapshot: JsonObject
  attempt: number
}

interface BridgeAuthRow extends Record<string, unknown> {
  id: string
  public_id: string
  secret_hash: string
  status: 'active' | 'revoked'
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BRIDGE_PUBLIC_ID_PATTERN = /^print-bridge-[A-Za-z0-9_-]{16,96}$/

export class PrintBridgeAuthenticationError extends Error {
  constructor() {
    super('打印桥身份无效或已撤销')
    this.name = 'PrintBridgeAuthenticationError'
  }
}

export class PrintBridgeRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrintBridgeRequestError'
  }
}

export class PrintBridgeRepository {
  constructor(private readonly transaction: ScopedTransaction, private readonly hashSecret: string) {}

  async createPairingCode(createdByEmployeeId: string, reason: string, ttlSeconds = 600) {
    assertUuid(createdByEmployeeId, 'createdByEmployeeId')
    requireText(reason, 'reason', 3, 1000)
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 1800) {
      throw new PrintBridgeRequestError('配对码有效期必须为1至30分钟')
    }
    const raw = randomBytes(10).toString('hex').toUpperCase()
    const pairingCode = `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15)}`
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()
    const result = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.print_bridge_pairing_codes(
        tenant_id,store_id,code_hash,created_by_employee_id,reason,expires_at
      ) VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5,$6::timestamptz)
      RETURNING id
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      this.hash(pairingCode), createdByEmployeeId, reason.trim(), expiresAt,
    ])
    if (result.rowCount !== 1 || result.rows[0] === undefined) throw new Error('打印桥配对码创建失败')
    return { id: result.rows[0].id, pairingCode, expiresAt }
  }

  async pair(input: Readonly<{
    pairingCode: string
    name: string
    hostname: string
    softwareVersion: string
  }>) {
    requireText(input.pairingCode, 'pairingCode', 20, 32)
    requireText(input.name, 'name', 1, 120)
    requireText(input.hostname, 'hostname', 1, 160)
    requireText(input.softwareVersion, 'softwareVersion', 1, 64)
    const pairing = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.print_bridge_pairing_codes
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND code_hash=$3
        AND consumed_at IS NULL AND expires_at>clock_timestamp()
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, this.hash(input.pairingCode)])
    const pairingId = pairing.rows[0]?.id
    if (pairingId === undefined) throw new PrintBridgeAuthenticationError()
    const publicId = `print-bridge-${randomUUID().replaceAll('-', '')}`
    const credential = randomBytes(32).toString('base64url')
    const inserted = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.print_bridges(
        tenant_id,store_id,public_id,name,secret_hash,hostname,software_version
      ) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7)
      RETURNING id
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId,
      input.name.trim(), this.hash(credential), input.hostname.trim(), input.softwareVersion.trim(),
    ])
    const bridgeId = inserted.rows[0]?.id
    if (bridgeId === undefined) throw new Error('打印桥配对失败')
    const consumed = await this.transaction.query(`
      UPDATE mbox.print_bridge_pairing_codes
      SET consumed_at=clock_timestamp(),consumed_by_bridge_id=$4::uuid
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND consumed_at IS NULL
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, pairingId, bridgeId])
    if (consumed.rowCount !== 1) throw new Error('打印桥配对码状态冲突')
    const businessDate = await this.currentBusinessDate()
    await appendAuditEvent(this.transaction, {
      actor: { type: 'integration', ref: publicId },
      action: 'print.bridge.paired', objectType: 'print_bridge', objectId: bridgeId,
      businessDate, reason: '使用管理员签发的一次性配对码完成门店打印桥安装',
      afterData: { publicId, hostname: input.hostname.trim(), softwareVersion: input.softwareVersion.trim() },
    })
    return { bridgeId, publicId, credential }
  }

  async authenticate(publicId: string, credential: string) {
    if (!BRIDGE_PUBLIC_ID_PATTERN.test(publicId) || credential.length < 32 || credential.length > 128) {
      throw new PrintBridgeAuthenticationError()
    }
    const result = await this.transaction.query<BridgeAuthRow>(`
      SELECT id,public_id,secret_hash,status
      FROM mbox.print_bridges
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3
        AND status='active' AND secret_hash=$4
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, publicId, this.hash(credential)])
    const row = result.rows[0]
    if (row === undefined) throw new PrintBridgeAuthenticationError()
    return { id: row.id, publicId: row.public_id }
  }

  async list(): Promise<PrintBridgeView[]> {
    const result = await this.transaction.query<{
      id: string; public_id: string; name: string; status: 'active' | 'revoked'; hostname: string
      platform: 'windows'; software_version: string; last_seen_at: string | null; installed_at: string
      printer_count: string; queue_snapshot: unknown
    }>(`
      SELECT bridge.id,bridge.public_id,bridge.name,bridge.status,bridge.hostname,
        bridge.platform,bridge.software_version,bridge.last_seen_at::text,bridge.installed_at::text,
        bridge.queue_snapshot,count(device.id)::text AS printer_count
      FROM mbox.print_bridges bridge
      LEFT JOIN mbox.devices device
        ON device.tenant_id=bridge.tenant_id AND device.store_id=bridge.store_id
       AND device.print_bridge_id=bridge.id AND device.status<>'retired'
      WHERE bridge.tenant_id=$1::uuid AND bridge.store_id=$2::uuid
      GROUP BY bridge.id
      ORDER BY bridge.status,bridge.name,bridge.id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    const onlineThreshold = Date.now() - 90_000
    return result.rows.map((row) => ({
      id: row.id, publicId: row.public_id, name: row.name, status: row.status,
      hostname: row.hostname, platform: row.platform, softwareVersion: row.software_version,
      lastSeenAt: row.last_seen_at, installedAt: row.installed_at,
      printerCount: Number(row.printer_count),
      online: row.status === 'active' && row.last_seen_at !== null && Date.parse(row.last_seen_at) >= onlineThreshold,
      queues: Array.isArray(row.queue_snapshot)
        ? row.queue_snapshot.filter((value): value is string => typeof value === 'string')
        : [],
    }))
  }

  async revoke(bridgeId: string) {
    assertUuid(bridgeId, 'bridgeId')
    const result = await this.transaction.query<{
      id: string; public_id: string; name: string; hostname: string; software_version: string
    }>(`
      UPDATE mbox.print_bridges SET status='revoked',revoked_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='active'
      RETURNING id,public_id,name,hostname,software_version
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, bridgeId])
    if (result.rowCount !== 1 || result.rows[0] === undefined) {
      throw new PrintBridgeRequestError('打印桥不存在或已撤销')
    }
    await this.transaction.query(`
      UPDATE mbox.devices SET connectivity_status='offline'
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND print_bridge_id=$3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, bridgeId])
    const row = result.rows[0]
    return {
      before: {
        id: row.id, publicId: row.public_id, name: row.name, hostname: row.hostname,
        softwareVersion: row.software_version, status: 'active' as const,
      },
      bridge: { id: row.id, publicId: row.public_id, status: 'revoked' as const },
    }
  }

  async heartbeat(bridgeId: string, input: Readonly<{
    hostname: string
    softwareVersion: string
    queues: readonly string[]
  }>) {
    assertUuid(bridgeId, 'bridgeId')
    requireText(input.hostname, 'hostname', 1, 160)
    requireText(input.softwareVersion, 'softwareVersion', 1, 64)
    const queues = [...new Set(input.queues.map((queue) => requireText(queue, 'queue', 1, 180)))].slice(0, 64)
    await this.transaction.query(`
      UPDATE mbox.print_bridges
      SET hostname=$4,software_version=$5,queue_snapshot=$6::jsonb,last_seen_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='active'
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId, bridgeId,
      input.hostname.trim(), input.softwareVersion.trim(), JSON.stringify(queues),
    ])
    await this.transaction.query(`
      UPDATE mbox.devices
      SET connectivity_status=CASE WHEN windows_queue_name=ANY($4::text[]) THEN 'online' ELSE 'offline' END,
          last_seen_at=CASE WHEN windows_queue_name=ANY($4::text[]) THEN clock_timestamp() ELSE last_seen_at END
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND print_bridge_id=$3::uuid
        AND status='active' AND device_type='printer'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, bridgeId, queues])
    return { accepted: true, serverTime: new Date().toISOString() }
  }

  async claim(bridge: Readonly<{ id: string; publicId: string }>, limit = 10, staleLockSeconds = 90) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new PrintBridgeRequestError('领取数量无效')
    const jobs = await this.claimJobs(bridge, limit, staleLockSeconds)
    const commands = await this.claimCommands(bridge, Math.max(1, Math.min(10, limit)), staleLockSeconds)
    return { jobs, commands }
  }

  async recordPrintResult(bridge: Readonly<{ id: string; publicId: string }>, input: Readonly<{
    jobId: string
    outcome: 'printed' | 'failed'
    failureCode?: string | null
  }>) {
    assertUuid(input.jobId, 'jobId')
    const existing = await this.transaction.query<{ status: string; attempts: number; max_attempts: number }>(`
      SELECT status,attempts,max_attempts FROM mbox.print_jobs
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND print_bridge_id=$4::uuid FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.jobId, bridge.id])
    const job = existing.rows[0]
    if (job === undefined) throw new PrintBridgeRequestError('打印任务不存在')
    if (job.status === 'printed') return { id: input.jobId, status: 'printed', replayed: true }
    if (job.status !== 'printing') throw new PrintBridgeRequestError('打印任务租约已失效，请勿重复出纸')
    const lockedBy = `bridge:${bridge.publicId}`
    if (input.outcome === 'printed') {
      const updated = await this.transaction.query(`
        UPDATE mbox.print_jobs SET status='printed',printed_at=clock_timestamp(),
          locked_by=NULL,locked_at=NULL,last_error_code=NULL
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status='printing' AND locked_by=$4
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.jobId, lockedBy])
      if (updated.rowCount !== 1) throw new PrintBridgeRequestError('打印任务租约已失效，请勿重复出纸')
      await this.appendPrintEvent(input.jobId, 'printed', 'printing', 'printed', null)
      return { id: input.jobId, status: 'printed', replayed: false }
    }
    const failureCode = normalizeHardwareFailureCode(input.failureCode ?? 'bridge_print_failed')
    const terminal = Number(job.attempts) >= Number(job.max_attempts)
    const status = terminal ? 'dead' : 'failed'
    const updated = await this.transaction.query(`
      UPDATE mbox.print_jobs SET status=$5,
        dead_at=CASE WHEN $5='dead' THEN clock_timestamp() ELSE NULL END,
        available_at=CASE WHEN $5='failed' THEN clock_timestamp()+interval '5 seconds' ELSE available_at END,
        locked_by=NULL,locked_at=NULL,last_error_code=$6
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND status='printing' AND locked_by=$4
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.jobId, lockedBy, status, failureCode])
    if (updated.rowCount !== 1) throw new PrintBridgeRequestError('打印任务租约已失效')
    await this.appendPrintEvent(input.jobId, terminal ? 'dead' : 'retry_scheduled', 'printing', status, failureCode)
    return { id: input.jobId, status, replayed: false }
  }

  async recordCommandResult(bridge: Readonly<{ id: string; publicId: string }>, input: Readonly<{
    commandId: string
    outcome: 'succeeded' | 'failed'
    failureCode?: string | null
    resultSnapshot?: JsonObject
  }>) {
    assertUuid(input.commandId, 'commandId')
    const failureCode = input.outcome === 'failed'
      ? normalizeHardwareFailureCode(input.failureCode ?? 'bridge_command_failed') : null
    const updated = await this.transaction.query<{ status: string }>(`
      UPDATE mbox.hardware_commands command SET status=$5,completed_at=clock_timestamp(),
        locked_by=NULL,locked_at=NULL,last_error_code=$6,result_snapshot=$7::jsonb
      FROM mbox.devices device
      WHERE command.tenant_id=$1::uuid AND command.store_id=$2::uuid AND command.id=$3::uuid
        AND command.status='executing' AND command.locked_by=$4
        AND device.tenant_id=command.tenant_id AND device.store_id=command.store_id
        AND device.id=command.device_id AND device.print_bridge_id=$8::uuid
      RETURNING command.status
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId, input.commandId,
      `bridge:${bridge.publicId}`, input.outcome, failureCode,
      JSON.stringify(input.resultSnapshot ?? {}), bridge.id,
    ])
    if (updated.rowCount !== 1) throw new PrintBridgeRequestError('设备指令不存在或租约已失效')
    return { id: input.commandId, status: updated.rows[0]!.status }
  }

  private async claimJobs(bridge: Readonly<{ id: string; publicId: string }>, limit: number, staleLockSeconds: number) {
    const result = await this.transaction.query<{
      id: string; business_key: string; printer_device_id: string; printer_code: string; printer_name: string
      windows_queue_name: string; print_profile: PrintProfile; station_code: HardwareStation; copies: number
      print_snapshot: JsonObject; contains_priority_note: boolean; attempts: number
    }>(`
      WITH candidates AS (
        SELECT job.id FROM mbox.print_jobs job
        JOIN mbox.devices candidate_device
          ON candidate_device.tenant_id=job.tenant_id AND candidate_device.store_id=job.store_id
         AND candidate_device.id=job.printer_device_id
        WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid
          AND job.delivery_mode='bridge_pull' AND job.print_bridge_id=$3::uuid
          AND candidate_device.status='active' AND candidate_device.print_bridge_id=$3::uuid
          AND job.attempts<job.max_attempts AND (
            (job.status IN ('pending','failed') AND job.available_at<=clock_timestamp())
            OR (job.status='printing' AND job.locked_at<clock_timestamp()-($6::int*interval '1 second'))
          )
        ORDER BY job.contains_priority_note DESC,job.available_at,job.created_at,job.id
        FOR UPDATE OF job SKIP LOCKED LIMIT $5
      )
      UPDATE mbox.print_jobs job SET status='printing',locked_by=$4,locked_at=clock_timestamp(),
        attempts=job.attempts+1,last_error_code=NULL
      FROM candidates,mbox.devices device
      WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid AND job.id=candidates.id
        AND device.tenant_id=job.tenant_id AND device.store_id=job.store_id
        AND device.id=job.printer_device_id AND device.print_bridge_id=$3::uuid
        AND device.status='active'
        AND device.windows_queue_name IS NOT NULL AND device.print_profile IS NOT NULL
      RETURNING job.id,job.business_key,job.printer_device_id,device.code AS printer_code,
        device.name AS printer_name,device.windows_queue_name,device.print_profile,
        job.station_code,job.copies,job.print_snapshot,job.contains_priority_note,job.attempts
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId, bridge.id,
      `bridge:${bridge.publicId}`, limit, staleLockSeconds,
    ])
    return result.rows.map((row): ClaimedBridgePrintJob => ({
      id: row.id, businessKey: row.business_key, printerDeviceId: row.printer_device_id,
      printerCode: row.printer_code, printerName: row.printer_name,
      windowsQueueName: row.windows_queue_name, printProfile: row.print_profile,
      stationCode: row.station_code, copies: Number(row.copies), printSnapshot: row.print_snapshot,
      containsPriorityNote: row.contains_priority_note, attempt: Number(row.attempts),
    }))
  }

  private async claimCommands(bridge: Readonly<{ id: string; publicId: string }>, limit: number, staleLockSeconds: number) {
    const result = await this.transaction.query<{
      id: string; public_id: string; device_id: string; command_type: ClaimedBridgeCommand['commandType']
      windows_queue_name: string; print_profile: PrintProfile; payload_snapshot: JsonObject; attempts: number
    }>(`
      WITH candidates AS (
        SELECT command.id FROM mbox.hardware_commands command
        JOIN mbox.devices device
          ON device.tenant_id=command.tenant_id AND device.store_id=command.store_id
         AND device.id=command.device_id
        WHERE command.tenant_id=$1::uuid AND command.store_id=$2::uuid
          AND device.print_bridge_id=$3::uuid AND device.device_type='printer'
          AND device.status='active' AND device.windows_queue_name IS NOT NULL
          AND device.print_profile IS NOT NULL
          AND command.command_type IN ('test_print','reconnect','ping')
          AND command.attempts<command.max_attempts AND (
            command.status='requested'
            OR (command.status='executing' AND command.locked_at<clock_timestamp()-($6::int*interval '1 second'))
          )
        ORDER BY command.available_at,command.created_at,command.id
        FOR UPDATE OF command SKIP LOCKED LIMIT $5
      )
      UPDATE mbox.hardware_commands command SET status='executing',locked_by=$4,
        locked_at=clock_timestamp(),attempts=command.attempts+1,last_error_code=NULL
      FROM candidates,mbox.devices device
      WHERE command.tenant_id=$1::uuid AND command.store_id=$2::uuid AND command.id=candidates.id
        AND device.tenant_id=command.tenant_id AND device.store_id=command.store_id
        AND device.id=command.device_id AND device.print_bridge_id=$3::uuid
        AND device.status='active' AND device.windows_queue_name IS NOT NULL
        AND device.print_profile IS NOT NULL
      RETURNING command.id,command.public_id,command.device_id,command.command_type,
        device.windows_queue_name,device.print_profile,command.payload_snapshot,command.attempts
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId, bridge.id,
      `bridge:${bridge.publicId}`, limit, staleLockSeconds,
    ])
    return result.rows.map((row): ClaimedBridgeCommand => ({
      id: row.id, publicId: row.public_id, deviceId: row.device_id,
      commandType: row.command_type, windowsQueueName: row.windows_queue_name,
      printProfile: row.print_profile, payloadSnapshot: row.payload_snapshot, attempt: Number(row.attempts),
    }))
  }

  private appendPrintEvent(
    jobId: string, eventType: string, fromStatus: string, toStatus: string, failureCode: string | null,
  ) {
    return this.transaction.query(`
      INSERT INTO mbox.print_job_events(
        tenant_id,store_id,print_job_id,event_type,from_status,to_status,actor_type,failure_code
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,'integration',$7)
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      jobId, eventType, fromStatus, toStatus, failureCode,
    ])
  }

  private hash(value: string) {
    return createHmac('sha256', this.hashSecret).update(value, 'utf8').digest('hex')
  }

  private async currentBusinessDate() {
    const result = await this.transaction.query<{ business_date: string }>(`
      SELECT COALESCE(
        (SELECT business_date::text FROM mbox.business_days
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status IN ('open','awaiting_close')
          ORDER BY business_date DESC LIMIT 1),
        (clock_timestamp() AT TIME ZONE store.timezone)::date::text
      ) AS business_date
      FROM mbox.stores store
      WHERE store.tenant_id=$1::uuid AND store.id=$2::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    const businessDate = result.rows[0]?.business_date
    if (businessDate === undefined) throw new Error('门店营业日不存在')
    return businessDate
  }
}

function requireText(value: string, field: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length < minimum || value.trim().length > maximum) {
    throw new PrintBridgeRequestError(`${field}格式无效`)
  }
  return value.trim()
}

function assertUuid(value: string, field: string) {
  if (!UUID_PATTERN.test(value)) throw new PrintBridgeRequestError(`${field}格式无效`)
}
