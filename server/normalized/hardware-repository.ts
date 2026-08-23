import { createHash } from 'node:crypto'
import type { JsonObject } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type HardwareStation = 'bar' | 'kitchen' | 'cashier'
export type DeviceStation = HardwareStation | 'service'
export type DeviceType = 'printer' | 'kds_display' | 'cash_drawer' | 'headset' | 'controller'
export type DeviceStatus = 'active' | 'paused' | 'retired'
export type ConnectivityStatus = 'unknown' | 'online' | 'offline' | 'degraded'
export type PrintJobStatus = 'pending' | 'printing' | 'printed' | 'failed' | 'dead' | 'cancelled'
export type PrintProfile = 'escpos_58' | 'escpos_80' | 'windows_text'

export interface HardwareDevice {
  id: string
  code: string
  name: string
  deviceType: DeviceType
  stationCode: DeviceStation | null
  status: DeviceStatus
  connectivityStatus: ConnectivityStatus
  capabilities: string[]
  printBridgeId: string | null
  windowsQueueName: string | null
  printProfile: PrintProfile | null
  lastSeenAt: string | null
  createdAt: string
  updatedAt: string
}

export interface PrinterRoute {
  id: string
  code: string
  name: string
  stationCode: HardwareStation
  productCategoryCode: string | null
  printerDeviceId: string
  copies: number
  priority: number
  status: DeviceStatus
  createdAt: string
  updatedAt: string
}

export interface PrintJob {
  id: string
  businessKey: string
  printerRouteId: string
  printerDeviceId: string
  printerCode: string
  printerName: string
  connectivityStatus: ConnectivityStatus
  stationCode: HardwareStation
  productCategoryCode: string | null
  sourceType: 'order' | 'kds' | 'cashier'
  sourceReference: string
  printSnapshot: JsonObject
  containsPriorityNote: boolean
  copies: number
  status: PrintJobStatus
  availableAt: string
  attempts: number
  maxAttempts: number
  failureCode: string | null
  printedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface DeliveryWorkItem {
  kdsTaskId: string
  orderItemId: string
  orderPublicId: string
  tableCode: string
  productName: string
  quantity: number
  note: string | null
  readyAt: string
}

export interface CreateDeviceInput {
  code: string
  name: string
  deviceType: DeviceType
  stationCode?: DeviceStation | null
  capabilities?: readonly string[]
  configSnapshot?: JsonObject
  printBridgeId?: string | null
  windowsQueueName?: string | null
  printProfile?: PrintProfile | null
}

export interface UpdateDeviceInput {
  id: string
  name?: string
  stationCode?: DeviceStation | null
  status?: DeviceStatus
  printBridgeId?: string | null
  windowsQueueName?: string | null
  printProfile?: PrintProfile | null
  printerOnly?: boolean
}

export interface UpsertPrinterRouteInput {
  code: string
  name: string
  stationCode: HardwareStation
  productCategoryCode?: string | null
  printerDeviceId: string
  copies?: number
  priority?: number
  status?: DeviceStatus
}

export interface MaterializePrintJobsInput {
  sourceOutboxMessageId: string
  stationCode: HardwareStation
  productCategoryCode?: string | null
  sourceType: 'order' | 'kds' | 'cashier'
  sourceReference: string
  printSnapshot: JsonObject
  containsPriorityNote?: boolean
  maxAttempts?: number
}

export interface RequestHardwareCommandInput {
  publicId: string
  deviceId: string
  commandType: 'test_print' | 'reconnect' | 'ping' | 'open_cash_drawer' | 'restart'
  requestedByEmployeeId: string
  reason: string
  payloadSnapshot?: JsonObject
  printerOnly?: boolean
}

interface DeviceRow extends Record<string, unknown> {
  id: string
  code: string
  name: string
  device_type: DeviceType
  station_code: DeviceStation | null
  status: DeviceStatus
  connectivity_status: ConnectivityStatus
  capabilities: string[]
  print_bridge_id: string | null
  windows_queue_name: string | null
  print_profile: PrintProfile | null
  last_seen_at: string | null
  created_at: string
  updated_at: string
}

interface RouteRow extends Record<string, unknown> {
  id: string
  code: string
  name: string
  station_code: HardwareStation
  product_category_code: string | null
  printer_device_id: string
  copies: number
  priority: number
  status: DeviceStatus
  created_at: string
  updated_at: string
  device_print_bridge_id?: string | null
}

interface PrintJobRow extends Record<string, unknown> {
  id: string
  business_key: string
  printer_route_id: string
  printer_device_id: string
  printer_code: string
  printer_name: string
  connectivity_status: ConnectivityStatus
  station_code: HardwareStation
  product_category_code: string | null
  source_type: 'order' | 'kds' | 'cashier'
  source_reference: string
  print_snapshot: JsonObject
  contains_priority_note: boolean
  copies: number
  status: PrintJobStatus
  available_at: string
  attempts: number
  max_attempts: number
  last_error_code: string | null
  printed_at: string | null
  created_at: string
  updated_at: string
}

interface DeliveryRow extends Record<string, unknown> {
  kds_task_id: string
  order_item_id: string
  order_public_id: string
  table_code: string
  product_name: string
  quantity: number
  note: string | null
  ready_at: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/
const CAPABILITY_PATTERN = /^[a-z][a-z0-9_.-]{1,63}$/
const FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_.:-]{2,95}$/
const MAX_SNAPSHOT_BYTES = 32 * 1024

export class HardwareNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HardwareNotFoundError'
  }
}

export class HardwareConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HardwareConflictError'
  }
}

export class HardwarePolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HardwarePolicyError'
  }
}

export class HardwareRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async createDevice(input: Readonly<CreateDeviceInput>): Promise<HardwareDevice> {
    validateDeviceInput(input)
    if (input.printBridgeId && input.windowsQueueName) {
      await this.assertActiveBridgeQueue(input.printBridgeId, input.windowsQueueName)
    }
    const result = await this.transaction.query<DeviceRow>(`
      INSERT INTO mbox.devices (
        tenant_id, store_id, code, name, device_type, station_code,
        capabilities, config_snapshot, print_bridge_id, windows_queue_name, print_profile
      ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::text[], $8::jsonb, $9::uuid, $10, $11)
      RETURNING id, code, name, device_type, station_code, status,
        connectivity_status, capabilities, print_bridge_id, windows_queue_name,
        print_profile, last_seen_at, created_at, updated_at
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.code,
      input.name.trim(),
      input.deviceType,
      input.stationCode ?? null,
      [...new Set(input.capabilities ?? [])],
      JSON.stringify(input.configSnapshot ?? {}),
      input.printBridgeId ?? null,
      input.windowsQueueName?.trim() ?? null,
      input.printProfile ?? null,
    ])
    return mapDevice(requireRow(result.rows[0], '设备创建失败'))
  }

  async updateDevice(input: Readonly<UpdateDeviceInput>): Promise<{
    before: HardwareDevice
    device: HardwareDevice
  }> {
    assertUuid(input.id, 'deviceId')
    const selected = await this.transaction.query<DeviceRow>(`
      SELECT id, code, name, device_type, station_code, status,
        connectivity_status, capabilities, print_bridge_id, windows_queue_name,
        print_profile, last_seen_at, created_at, updated_at
      FROM mbox.devices
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.id])
    if (selected.rows[0] === undefined) throw new HardwareNotFoundError('设备不存在')
    const before = mapDevice(selected.rows[0])
    if (input.printerOnly && before.deviceType !== 'printer') {
      throw new HardwarePolicyError('打印维护权限只能修改打印机')
    }
    if (before.status === 'retired' && input.status !== undefined && input.status !== 'retired') {
      throw new HardwarePolicyError('已退役设备不能重新启用，请新建设备并重新验收')
    }
    const next: CreateDeviceInput & { status: DeviceStatus } = {
      code: before.code,
      name: input.name ?? before.name,
      deviceType: before.deviceType,
      stationCode: input.stationCode === undefined ? before.stationCode : input.stationCode,
      capabilities: before.capabilities,
      printBridgeId: input.printBridgeId === undefined ? before.printBridgeId : input.printBridgeId,
      windowsQueueName: input.windowsQueueName === undefined ? before.windowsQueueName : input.windowsQueueName,
      printProfile: input.printProfile === undefined ? before.printProfile : input.printProfile,
      status: input.status ?? before.status,
    }
    validateDeviceInput(next)
    assertEnum(next.status, ['active', 'paused', 'retired'], 'status')
    const printConfigurationChanged = next.printBridgeId !== before.printBridgeId
      || next.windowsQueueName !== before.windowsQueueName
      || next.printProfile !== before.printProfile
    if (next.status === 'active' && next.printBridgeId && next.windowsQueueName
      && (printConfigurationChanged || before.status !== 'active')) {
      await this.assertActiveBridgeQueue(next.printBridgeId, next.windowsQueueName)
    }
    const updated = await this.transaction.query<DeviceRow>(`
      UPDATE mbox.devices
      SET name=$4,station_code=$5,status=$6,print_bridge_id=$7::uuid,
        windows_queue_name=$8,print_profile=$9
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      RETURNING id, code, name, device_type, station_code, status,
        connectivity_status, capabilities, print_bridge_id, windows_queue_name,
        print_profile, last_seen_at, created_at, updated_at
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId, input.id,
      next.name.trim(), next.stationCode ?? null, next.status, next.printBridgeId ?? null,
      next.windowsQueueName?.trim() ?? null, next.printProfile ?? null,
    ])
    return { before, device: mapDevice(requireRow(updated.rows[0], '设备修改失败')) }
  }

  async recordConnectivity(
    deviceId: string,
    connectivityStatus: ConnectivityStatus,
  ): Promise<HardwareDevice> {
    assertUuid(deviceId, 'deviceId')
    assertEnum(connectivityStatus, ['unknown', 'online', 'offline', 'degraded'], 'connectivityStatus')
    const result = await this.transaction.query<DeviceRow>(`
      UPDATE mbox.devices
      SET connectivity_status = $4,
          last_seen_at = CASE WHEN $4 IN ('online', 'degraded') THEN clock_timestamp() ELSE last_seen_at END
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      RETURNING id, code, name, device_type, station_code, status,
        connectivity_status, capabilities, print_bridge_id, windows_queue_name,
        print_profile, last_seen_at, created_at, updated_at
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, deviceId, connectivityStatus])
    if (!result.rows[0]) throw new HardwareNotFoundError('设备不存在')
    return mapDevice(result.rows[0])
  }

  async upsertPrinterRoute(input: Readonly<UpsertPrinterRouteInput>): Promise<PrinterRoute> {
    validateRouteInput(input)
    const printer = await this.transaction.query<{ device_type: DeviceType; status: DeviceStatus }>(`
      SELECT device_type, status
      FROM mbox.devices
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.printerDeviceId])
    if (!printer.rows[0]) throw new HardwareNotFoundError('打印设备不存在')
    if (printer.rows[0].device_type !== 'printer') throw new HardwarePolicyError('打印路由只能绑定打印机设备')
    if (printer.rows[0].status === 'retired') throw new HardwarePolicyError('已退役打印机不能绑定路由')

    const result = await this.transaction.query<RouteRow>(`
      INSERT INTO mbox.printer_routes (
        tenant_id, store_id, code, name, station_code, product_category_code,
        printer_device_id, copies, priority, status
      ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8, $9, $10)
      ON CONFLICT (tenant_id, store_id, code) DO UPDATE
      SET name = EXCLUDED.name,
          station_code = EXCLUDED.station_code,
          product_category_code = EXCLUDED.product_category_code,
          printer_device_id = EXCLUDED.printer_device_id,
          copies = EXCLUDED.copies,
          priority = EXCLUDED.priority,
          status = EXCLUDED.status
      RETURNING id, code, name, station_code, product_category_code,
        printer_device_id, copies, priority, status, created_at, updated_at
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.code,
      input.name.trim(),
      input.stationCode,
      normalizeNullable(input.productCategoryCode),
      input.printerDeviceId,
      input.copies ?? 1,
      input.priority ?? 100,
      input.status ?? 'active',
    ])
    return mapRoute(requireRow(result.rows[0], '打印路由保存失败'))
  }

  async listPrinterRoutes(): Promise<PrinterRoute[]> {
    const result = await this.transaction.query<RouteRow>(`
      SELECT id,code,name,station_code,product_category_code,printer_device_id,
        copies,priority,status,created_at,updated_at
      FROM mbox.printer_routes
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
      ORDER BY status,station_code,priority,code,id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    return result.rows.map(mapRoute)
  }

  async getPrinterRouteByCode(code: string, lock = false): Promise<PrinterRoute | null> {
    if (!CODE_PATTERN.test(code)) throw new HardwarePolicyError('路由编码格式无效')
    const result = await this.transaction.query<RouteRow>(`
      SELECT id,code,name,station_code,product_category_code,printer_device_id,
        copies,priority,status,created_at,updated_at
      FROM mbox.printer_routes
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND code=$3
      ${lock ? 'FOR UPDATE' : ''}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, code])
    return result.rows[0] ? mapRoute(result.rows[0]) : null
  }

  async materializeFromOutbox(input: Readonly<MaterializePrintJobsInput>): Promise<PrintJob[]> {
    validateMaterializeInput(input)
    const source = await this.transaction.query<{ id: string }>(`
      SELECT id
      FROM mbox.outbox_messages
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.sourceOutboxMessageId])
    if (!source.rows[0]) throw new HardwareNotFoundError('打印源Outbox事件不存在')

    const routes = await this.transaction.query<RouteRow>(`
      SELECT route.id, route.code, route.name, route.station_code,
        route.product_category_code, route.printer_device_id, route.copies,
        route.priority, route.status, route.created_at, route.updated_at,
        device.print_bridge_id AS device_print_bridge_id
      FROM mbox.printer_routes AS route
      JOIN mbox.devices AS device
        ON device.tenant_id = route.tenant_id AND device.store_id = route.store_id
       AND device.id = route.printer_device_id
      WHERE route.tenant_id = $1::uuid
        AND route.store_id = $2::uuid
        AND route.station_code = $3
        AND route.status = 'active'
        AND device.status = 'active'
        AND (
          route.product_category_code = $4
          OR (
            route.product_category_code IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM mbox.printer_routes AS exact_route
              JOIN mbox.devices AS exact_device
                ON exact_device.tenant_id = exact_route.tenant_id
               AND exact_device.store_id = exact_route.store_id
               AND exact_device.id = exact_route.printer_device_id
              WHERE exact_route.tenant_id = route.tenant_id
                AND exact_route.store_id = route.store_id
                AND exact_route.station_code = route.station_code
                AND exact_route.product_category_code = $4
                AND exact_route.status = 'active'
                AND exact_device.status = 'active'
            )
          )
        )
      ORDER BY route.priority, route.id
      FOR SHARE OF route, device
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.stationCode,
      normalizeNullable(input.productCategoryCode),
    ])
    if (routes.rows.length === 0) throw new HardwarePolicyError('当前商品没有可用打印路由')

    const jobs: PrintJob[] = []
    for (const route of routes.rows) {
      const businessKey = printBusinessKey(input.sourceOutboxMessageId, route.id, input.sourceReference)
      const inserted = await this.transaction.query<{ id: string }>(`
        INSERT INTO mbox.print_jobs (
          tenant_id, store_id, business_key, source_outbox_message_id,
          printer_route_id, printer_device_id, station_code, product_category_code,
          source_type, source_reference, print_snapshot, contains_priority_note,
          copies, max_attempts, delivery_mode, print_bridge_id
        ) VALUES (
          $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::uuid, $7, $8,
          $9, $10, $11::jsonb, $12, $13, $14,
          CASE WHEN $15::uuid IS NULL THEN 'cloud_adapter' ELSE 'bridge_pull' END, $15::uuid
        )
        ON CONFLICT (tenant_id, store_id, business_key) DO NOTHING
        RETURNING id
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        businessKey,
        input.sourceOutboxMessageId,
        route.id,
        route.printer_device_id,
        input.stationCode,
        normalizeNullable(input.productCategoryCode),
        input.sourceType,
        input.sourceReference.trim(),
        JSON.stringify(input.printSnapshot),
        input.containsPriorityNote ?? false,
        route.copies,
        input.maxAttempts ?? 8,
        route.device_print_bridge_id ?? null,
      ])
      const job = await this.getByBusinessKey(businessKey, true)
      if (!job) throw new HardwareConflictError('打印任务创建后无法读取')
      if (!sameMaterialization(job, route, input)) {
        throw new HardwareConflictError('打印任务幂等键与已有内容冲突')
      }
      if (inserted.rowCount === 1) {
        await this.appendPrintJobEvent(job.id, 'created', null, 'pending', 'integration', null, null, null)
      }
      jobs.push(job)
    }
    return jobs
  }

  async getByBusinessKey(businessKey: string, lock = false): Promise<PrintJob | null> {
    const result = await this.transaction.query<PrintJobRow>(`
      SELECT ${PRINT_JOB_COLUMNS}
      FROM mbox.print_jobs AS job
      JOIN mbox.devices AS device
        ON device.tenant_id = job.tenant_id AND device.store_id = job.store_id
       AND device.id = job.printer_device_id
      WHERE job.tenant_id = $1::uuid AND job.store_id = $2::uuid
        AND job.business_key = $3
      ${lock ? 'FOR UPDATE OF job' : ''}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, businessKey])
    return result.rows[0] ? mapPrintJob(result.rows[0]) : null
  }

  async listDevices(stations?: readonly DeviceStation[]): Promise<HardwareDevice[]> {
    const normalized = stations ? [...new Set(stations)] : null
    const result = await this.transaction.query<DeviceRow>(`
      SELECT id, code, name, device_type, station_code, status,
        connectivity_status, capabilities, print_bridge_id, windows_queue_name,
        print_profile, last_seen_at, created_at, updated_at
      FROM mbox.devices
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND ($3::text[] IS NULL OR station_code = ANY($3::text[]))
      ORDER BY station_code NULLS LAST, name, id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, normalized])
    return result.rows.map(mapDevice)
  }

  private async assertActiveBridgeQueue(printBridgeId: string, windowsQueueName: string) {
    const result = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.print_bridges
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND status='active' AND queue_snapshot ? $4
      FOR SHARE
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      printBridgeId, windowsQueueName.trim(),
    ])
    if (result.rows[0] === undefined) {
      throw new HardwarePolicyError('打印桥未启用或没有上报该Windows打印机队列')
    }
  }

  async listPrintJobs(input: Readonly<{
    stations: readonly HardwareStation[]
    statuses?: readonly PrintJobStatus[]
    limit?: number
  }>): Promise<PrintJob[]> {
    const stations = [...new Set(input.stations)]
    if (stations.length === 0) return []
    stations.forEach((station) => assertStation(station))
    const statuses = input.statuses ? [...new Set(input.statuses)] : null
    statuses?.forEach((status) => assertEnum(status, ['pending', 'printing', 'printed', 'failed', 'dead', 'cancelled'], 'status'))
    const limit = boundedInteger(input.limit ?? 50, 1, 200, 'limit')
    const result = await this.transaction.query<PrintJobRow>(`
      SELECT ${PRINT_JOB_COLUMNS}
      FROM mbox.print_jobs AS job
      JOIN mbox.devices AS device
        ON device.tenant_id = job.tenant_id AND device.store_id = job.store_id
       AND device.id = job.printer_device_id
      WHERE job.tenant_id = $1::uuid AND job.store_id = $2::uuid
        AND job.station_code = ANY($3::text[])
        AND ($4::text[] IS NULL OR job.status = ANY($4::text[]))
      ORDER BY
        CASE job.status WHEN 'dead' THEN 0 WHEN 'failed' THEN 1 WHEN 'pending' THEN 2
          WHEN 'printing' THEN 3 ELSE 4 END,
        job.contains_priority_note DESC, job.available_at, job.created_at, job.id
      LIMIT $5
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, stations, statuses, limit])
    return result.rows.map(mapPrintJob)
  }

  async listDeliveryWork(limit = 100): Promise<DeliveryWorkItem[]> {
    const safeLimit = boundedInteger(limit, 1, 200, 'limit')
    const result = await this.transaction.query<DeliveryRow>(`
      SELECT task.id AS kds_task_id, item.id AS order_item_id,
        order_header.public_id AS order_public_id, venue_table.code AS table_code,
        COALESCE(item.product_snapshot->>'name', product.name) AS product_name,
        item.quantity, item.note, task.ready_at
      FROM mbox.kds_tasks AS task
      JOIN mbox.order_items AS item
        ON item.tenant_id = task.tenant_id AND item.store_id = task.store_id
       AND item.id = task.order_item_id
      JOIN mbox.orders AS order_header
        ON order_header.tenant_id = item.tenant_id AND order_header.store_id = item.store_id
       AND order_header.id = item.order_id
      JOIN mbox.products AS product
        ON product.tenant_id = item.tenant_id AND product.store_id = item.store_id
       AND product.id = item.product_id
      JOIN mbox.table_sessions AS session
        ON session.tenant_id = order_header.tenant_id AND session.store_id = order_header.store_id
       AND session.id = order_header.table_session_id
      JOIN mbox.tables AS venue_table
        ON venue_table.tenant_id = session.tenant_id AND venue_table.store_id = session.store_id
       AND venue_table.id = session.table_id
      WHERE task.tenant_id = $1::uuid AND task.store_id = $2::uuid
        AND task.status = 'ready' AND item.status = 'ready'
      ORDER BY task.ready_at, task.priority, task.id
      LIMIT $3
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, safeLimit])
    return result.rows.map((row) => ({
      kdsTaskId: row.kds_task_id,
      orderItemId: row.order_item_id,
      orderPublicId: row.order_public_id,
      tableCode: row.table_code,
      productName: row.product_name,
      quantity: Number(row.quantity),
      note: row.note,
      readyAt: row.ready_at,
    }))
  }

  async retryPrintJob(jobId: string, employeeId: string, reason: string): Promise<PrintJob> {
    assertUuid(jobId, 'jobId')
    assertUuid(employeeId, 'employeeId')
    const normalizedReason = requireText(reason, 'reason', 3, 1000)
    const current = await this.transaction.query<{ status: PrintJobStatus }>(`
      SELECT status FROM mbox.print_jobs
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, jobId])
    if (!current.rows[0]) throw new HardwareNotFoundError('打印任务不存在')
    if (!['failed', 'dead'].includes(current.rows[0].status)) {
      throw new HardwareConflictError('只有失败或已终止的打印任务可以重试')
    }
    await this.transaction.query(`
      UPDATE mbox.print_jobs
      SET status = 'pending', available_at = clock_timestamp(), dead_at = NULL,
          locked_by = NULL, locked_at = NULL, last_error_code = NULL
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, jobId])
    await this.appendPrintJobEvent(
      jobId, 'manual_retry', current.rows[0].status, 'pending', 'employee', employeeId, null, normalizedReason,
    )
    const result = await this.getById(jobId)
    if (!result) throw new HardwareNotFoundError('打印任务不存在')
    return result
  }

  async requestHardwareCommand(input: Readonly<RequestHardwareCommandInput>) {
    assertUuid(input.deviceId, 'deviceId')
    assertUuid(input.requestedByEmployeeId, 'requestedByEmployeeId')
    requireText(input.publicId, 'publicId', 8, 128)
    requireText(input.reason, 'reason', 3, 1000)
    validateSnapshot(input.payloadSnapshot ?? {})
    const result = await this.transaction.query<{
      id: string; public_id: string; device_id: string; command_type: string; status: string; created_at: string
    }>(`
      INSERT INTO mbox.hardware_commands (
        tenant_id, store_id, public_id, device_id, command_type,
        requested_by_employee_id, reason, payload_snapshot
      )
      SELECT $1::uuid, $2::uuid, $3, device.id, $5, $6::uuid, $7, $8::jsonb
      FROM mbox.devices AS device
      WHERE device.tenant_id = $1::uuid AND device.store_id = $2::uuid
        AND device.id = $4::uuid AND device.status <> 'retired'
        AND ($9::boolean IS FALSE OR device.device_type='printer')
      RETURNING id, public_id, device_id, command_type, status, created_at
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.publicId,
      input.deviceId,
      input.commandType,
      input.requestedByEmployeeId,
      input.reason.trim(),
      JSON.stringify(input.payloadSnapshot ?? {}),
      input.printerOnly === true,
    ])
    if (!result.rows[0]) throw new HardwareNotFoundError('设备不存在或已退役')
    return {
      id: result.rows[0].id,
      publicId: result.rows[0].public_id,
      deviceId: result.rows[0].device_id,
      commandType: result.rows[0].command_type,
      status: result.rows[0].status,
      createdAt: result.rows[0].created_at,
    }
  }

  private async getById(id: string): Promise<PrintJob | null> {
    const result = await this.transaction.query<PrintJobRow>(`
      SELECT ${PRINT_JOB_COLUMNS}
      FROM mbox.print_jobs AS job
      JOIN mbox.devices AS device
        ON device.tenant_id = job.tenant_id AND device.store_id = job.store_id
       AND device.id = job.printer_device_id
      WHERE job.tenant_id = $1::uuid AND job.store_id = $2::uuid AND job.id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
    return result.rows[0] ? mapPrintJob(result.rows[0]) : null
  }

  private async appendPrintJobEvent(
    jobId: string,
    eventType: string,
    fromStatus: PrintJobStatus | null,
    toStatus: PrintJobStatus | null,
    actorType: 'employee' | 'system' | 'integration',
    actorEmployeeId: string | null,
    failureCode: string | null,
    reason: string | null,
  ) {
    await this.transaction.query(`
      INSERT INTO mbox.print_job_events (
        tenant_id, store_id, print_job_id, event_type, from_status, to_status,
        actor_type, actor_employee_id, failure_code, reason
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9, $10)
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      jobId,
      eventType,
      fromStatus,
      toStatus,
      actorType,
      actorEmployeeId,
      failureCode,
      reason,
    ])
  }
}

export interface TrustedPrintOutboxConsumerPort {
  materialize(input: Readonly<MaterializePrintJobsInput>): Promise<PrintJob[]>
}

export class TrustedPrintOutboxConsumer implements TrustedPrintOutboxConsumerPort {
  constructor(private readonly repository: HardwareRepository) {}

  materialize(input: Readonly<MaterializePrintJobsInput>): Promise<PrintJob[]> {
    return this.repository.materializeFromOutbox(input)
  }
}

const PRINT_JOB_COLUMNS = `
  job.id, job.business_key, job.printer_route_id, job.printer_device_id,
  device.code AS printer_code, device.name AS printer_name,
  device.connectivity_status, job.station_code, job.product_category_code,
  job.source_type, job.source_reference, job.print_snapshot,
  job.contains_priority_note, job.copies, job.status, job.available_at,
  job.attempts, job.max_attempts, job.last_error_code, job.printed_at,
  job.created_at, job.updated_at
`

function mapDevice(row: DeviceRow): HardwareDevice {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    deviceType: row.device_type,
    stationCode: row.station_code,
    status: row.status,
    connectivityStatus: row.connectivity_status,
    capabilities: row.capabilities,
    printBridgeId: row.print_bridge_id,
    windowsQueueName: row.windows_queue_name,
    printProfile: row.print_profile,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapRoute(row: RouteRow): PrinterRoute {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    stationCode: row.station_code,
    productCategoryCode: row.product_category_code,
    printerDeviceId: row.printer_device_id,
    copies: Number(row.copies),
    priority: Number(row.priority),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapPrintJob(row: PrintJobRow): PrintJob {
  return {
    id: row.id,
    businessKey: row.business_key,
    printerRouteId: row.printer_route_id,
    printerDeviceId: row.printer_device_id,
    printerCode: row.printer_code,
    printerName: row.printer_name,
    connectivityStatus: row.connectivity_status,
    stationCode: row.station_code,
    productCategoryCode: row.product_category_code,
    sourceType: row.source_type,
    sourceReference: row.source_reference,
    printSnapshot: row.print_snapshot,
    containsPriorityNote: row.contains_priority_note,
    copies: Number(row.copies),
    status: row.status,
    availableAt: row.available_at,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    failureCode: row.last_error_code,
    printedAt: row.printed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function sameMaterialization(job: PrintJob, route: RouteRow, input: Readonly<MaterializePrintJobsInput>) {
  return job.printerRouteId === route.id
    && job.printerDeviceId === route.printer_device_id
    && job.stationCode === input.stationCode
    && job.productCategoryCode === normalizeNullable(input.productCategoryCode)
    && job.sourceType === input.sourceType
    && job.sourceReference === input.sourceReference.trim()
    && job.containsPriorityNote === (input.containsPriorityNote ?? false)
    && canonicalJson(job.printSnapshot) === canonicalJson(input.printSnapshot)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).toSorted().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

function printBusinessKey(sourceOutboxMessageId: string, routeId: string, sourceReference: string): string {
  const variant = createHash('sha256').update(sourceReference, 'utf8').digest('hex').slice(0, 20)
  return `print:${sourceOutboxMessageId}:${routeId}:${variant}`
}

function validateDeviceInput(input: Readonly<CreateDeviceInput>) {
  if (!CODE_PATTERN.test(input.code)) throw new HardwarePolicyError('设备编码格式无效')
  requireText(input.name, 'name', 1, 120)
  assertEnum(input.deviceType, ['printer', 'kds_display', 'cash_drawer', 'headset', 'controller'], 'deviceType')
  if (input.stationCode) assertEnum(input.stationCode, ['bar', 'kitchen', 'cashier', 'service'], 'stationCode')
  const bridgeConfigured = input.printBridgeId !== undefined && input.printBridgeId !== null
    || input.windowsQueueName !== undefined && input.windowsQueueName !== null
    || input.printProfile !== undefined && input.printProfile !== null
  if (bridgeConfigured) {
    if (input.deviceType !== 'printer' || input.printBridgeId == null || input.windowsQueueName == null || input.printProfile == null) {
      throw new HardwarePolicyError('Windows打印队列必须同时选择打印桥、队列名称和打印规格')
    }
    assertUuid(input.printBridgeId, 'printBridgeId')
    requireText(input.windowsQueueName, 'windowsQueueName', 1, 180)
    assertEnum(input.printProfile, ['escpos_58', 'escpos_80', 'windows_text'], 'printProfile')
  }
  for (const capability of input.capabilities ?? []) {
    if (!CAPABILITY_PATTERN.test(capability)) throw new HardwarePolicyError('设备能力编码格式无效')
  }
  validateSnapshot(input.configSnapshot ?? {})
}

function validateRouteInput(input: Readonly<UpsertPrinterRouteInput>) {
  if (!CODE_PATTERN.test(input.code)) throw new HardwarePolicyError('路由编码格式无效')
  requireText(input.name, 'name', 1, 120)
  assertStation(input.stationCode)
  assertUuid(input.printerDeviceId, 'printerDeviceId')
  if (input.productCategoryCode) requireText(input.productCategoryCode, 'productCategoryCode', 1, 64)
  boundedInteger(input.copies ?? 1, 1, 5, 'copies')
  boundedInteger(input.priority ?? 100, 0, 1000, 'priority')
}

function validateMaterializeInput(input: Readonly<MaterializePrintJobsInput>) {
  assertUuid(input.sourceOutboxMessageId, 'sourceOutboxMessageId')
  assertStation(input.stationCode)
  requireText(input.sourceReference, 'sourceReference', 1, 160)
  if (input.productCategoryCode) requireText(input.productCategoryCode, 'productCategoryCode', 1, 64)
  boundedInteger(input.maxAttempts ?? 8, 1, 20, 'maxAttempts')
  validateSnapshot(input.printSnapshot)
  if (Object.keys(input.printSnapshot).length === 0) throw new HardwarePolicyError('打印快照不能为空')
}

function validateSnapshot(snapshot: JsonObject) {
  const serialized = JSON.stringify(snapshot)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new HardwarePolicyError('硬件快照超过大小限制')
  }
  if (/(?:secret|password|token|access.?key|private.?key)/i.test(serialized)) {
    throw new HardwarePolicyError('硬件快照包含禁止的敏感字段')
  }
}

function assertStation(value: string): asserts value is HardwareStation {
  assertEnum(value, ['bar', 'kitchen', 'cashier'], 'stationCode')
}

function assertUuid(value: string, field: string) {
  if (!UUID_PATTERN.test(value)) throw new HardwarePolicyError(`${field}格式无效`)
}

function assertEnum(value: string, values: readonly string[], field: string) {
  if (!values.includes(value)) throw new HardwarePolicyError(`${field}格式无效`)
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new HardwarePolicyError(`${field}格式无效`)
  }
  return value
}

function requireText(value: string, field: string, minimum: number, maximum: number) {
  const normalized = value.trim()
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new HardwarePolicyError(`${field}格式无效`)
  }
  return normalized
}

function normalizeNullable(value: string | null | undefined) {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function requireRow<Row>(row: Row | undefined, message: string): Row {
  if (!row) throw new HardwareConflictError(message)
  return row
}

export function normalizeHardwareFailureCode(value: string): string {
  const normalized = value.trim().toLowerCase()
  return FAILURE_CODE_PATTERN.test(normalized) ? normalized : 'hardware_failed:invalid_code'
}
