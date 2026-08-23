import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedCommandExecutor } from './command-executor.js'
import { hardwareApiPlugin } from './hardware-api.js'
import type { HardwareRepository } from './hardware-repository.js'
import { NormalizedAuthenticationRequiredError } from './normalized-request-context.js'
import type { ScopedTransaction } from './transaction-runner.js'

const tenantId = '26200000-0000-4000-8000-000000000001'
const storeId = '26200000-0000-4000-8000-000000000002'
const employeeId = '26200000-0000-4000-8000-000000000003'
const deviceId = '26200000-0000-4000-8000-000000000004'
const apps: ReturnType<typeof Fastify>[] = []

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())))

describe('hardware API role cropping', () => {
  it('returns 401 instead of an internal error when the staff session is missing', async () => {
    const app = Fastify()
    apps.push(app)
    await app.register(hardwareApiPlugin, {
      transactions: { run: async (_scope, operation) => operation(transaction()) },
      commands: commandExecutor(),
      resolveContext: () => { throw new NormalizedAuthenticationRequiredError() },
      createRepository: () => repository() as unknown as HardwareRepository,
    })

    const response = await app.inject({ method: 'GET', url: '/hardware/printer-routes' })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: { code: 'AUTH_REQUIRED', message: '登录信息无效或已过期，请重新登录' },
    })
  })

  it('shows a bartender only bar production work, never kitchen work', async () => {
    const fake = repository()
    const app = await build(['print.view', 'work.bar'], fake)
    const response = await app.inject({ method: 'GET', url: '/hardware/work' })

    expect(response.statusCode).toBe(200)
    expect(fake.listPrintJobs).toHaveBeenCalledWith(expect.objectContaining({ stations: ['bar'] }))
    expect(fake.listDeliveryWork).not.toHaveBeenCalled()
  })

  it('shows a service employee only delivery work and no production slips', async () => {
    const fake = repository()
    const app = await build(['work.delivery'], fake)
    const response = await app.inject({ method: 'GET', url: '/hardware/work' })

    expect(response.statusCode).toBe(200)
    expect(response.json().data.production).toEqual([])
    expect(fake.listPrintJobs).not.toHaveBeenCalled()
    expect(fake.listDeliveryWork).toHaveBeenCalledTimes(1)
  })

  it('requires permission, a human reason and an idempotency key for hardware commands', async () => {
    const fake = repository()
    const app = await build(['hardware.command'], fake)
    const missingReason = await app.inject({
      method: 'POST', url: `/hardware/devices/${deviceId}/commands`,
      headers: { 'idempotency-key': 'hardware-command-0001' },
      payload: { commandType: 'test_print' },
    })
    expect(missingReason.statusCode).toBe(400)
    expect(fake.requestHardwareCommand).not.toHaveBeenCalled()

    const accepted = await app.inject({
      method: 'POST', url: `/hardware/devices/${deviceId}/commands`,
      headers: { 'idempotency-key': 'hardware-command-0002' },
      payload: { commandType: 'test_print', reason: '确认新纸卷打印正常' },
    })
    expect(accepted.statusCode).toBe(202)
    expect(fake.requestHardwareCommand).toHaveBeenCalledWith(expect.objectContaining({
      deviceId,
      requestedByEmployeeId: employeeId,
      reason: '确认新纸卷打印正常',
    }))
  })

  it('lets a printer manager maintain only printers, never other hardware', async () => {
    const fake = repository()
    fake.listDevices.mockResolvedValue([
      { id: deviceId, deviceType: 'printer', name: '收银热敏打印机' },
      { id: '26200000-0000-4000-8000-000000000009', deviceType: 'headset', name: '服务耳机' },
    ])
    const app = await build(['printer.manage'], fake)

    const devices = await app.inject({ method: 'GET', url: '/hardware/devices' })
    expect(devices.statusCode).toBe(200)
    expect(devices.json().data).toEqual([{ id: deviceId, deviceType: 'printer', name: '收银热敏打印机' }])

    const blockedDevice = await app.inject({
      method: 'POST', url: '/hardware/devices',
      headers: { 'idempotency-key': 'printer-manager-device-0001' },
      payload: { code: 'headset-01', name: '服务耳机', deviceType: 'headset', reason: '无权配置非打印设备' },
    })
    expect(blockedDevice.statusCode).toBe(403)
    expect(fake.createDevice).not.toHaveBeenCalled()

    const blockedCommand = await app.inject({
      method: 'POST', url: `/hardware/devices/${deviceId}/commands`,
      headers: { 'idempotency-key': 'printer-manager-command-0001' },
      payload: { commandType: 'open_cash_drawer', reason: '不允许用打印维护权限开钱箱' },
    })
    expect(blockedCommand.statusCode).toBe(403)
    expect(fake.requestHardwareCommand).not.toHaveBeenCalled()

    const accepted = await app.inject({
      method: 'POST', url: `/hardware/devices/${deviceId}/commands`,
      headers: { 'idempotency-key': 'printer-manager-command-0002' },
      payload: { commandType: 'test_print', reason: '确认80毫米热敏纸打印正常' },
    })
    expect(accepted.statusCode).toBe(202)
    expect(fake.requestHardwareCommand).toHaveBeenCalledWith(expect.objectContaining({
      commandType: 'test_print', printerOnly: true,
    }))
  })

  it('lets a printer manager edit and pause a printer with a required audited reason', async () => {
    const fake = repository()
    fake.updateDevice.mockResolvedValue({
      before: { id: deviceId, deviceType: 'printer', name: '旧打印机', status: 'active' },
      device: { id: deviceId, deviceType: 'printer', name: '收银打印机', status: 'paused' },
    })
    const app = await build(['printer.manage'], fake)
    const missingReason = await app.inject({
      method: 'PATCH', url: `/hardware/devices/${deviceId}`,
      headers: { 'idempotency-key': 'printer-update-missing-reason' },
      payload: { status: 'paused' },
    })
    expect(missingReason.statusCode).toBe(400)
    expect(fake.updateDevice).not.toHaveBeenCalled()

    const updated = await app.inject({
      method: 'PATCH', url: `/hardware/devices/${deviceId}`,
      headers: { 'idempotency-key': 'printer-update-with-reason' },
      payload: { name: '收银打印机', status: 'paused', reason: '更换纸卷暂停使用' },
    })
    expect(updated.statusCode).toBe(200)
    expect(fake.updateDevice).toHaveBeenCalledWith(expect.objectContaining({
      id: deviceId, name: '收银打印机', status: 'paused', printerOnly: true,
    }))
    expect(updated.json().data).toMatchObject({ id: deviceId, name: '收银打印机', status: 'paused' })
  })

  it('rejects kitchen print access for a bartender', async () => {
    const fake = repository()
    const app = await build(['print.view', 'work.bar'], fake)
    const response = await app.inject({ method: 'GET', url: '/hardware/print-jobs?station=kitchen' })
    expect(response.statusCode).toBe(403)
    expect(fake.listPrintJobs).not.toHaveBeenCalled()
  })
})

async function build(capabilities: string[], fake = repository()) {
  const app = Fastify()
  apps.push(app)
  await app.register(hardwareApiPlugin, {
    transactions: {
      run: async (_scope, operation) => operation(transaction()),
    },
    commands: commandExecutor(),
    resolveContext: () => ({
      scope: { tenantId, storeId }, employeeId, businessDate: '2026-08-11', capabilities,
    }),
    createRepository: () => fake as unknown as HardwareRepository,
  })
  return app
}

function commandExecutor() {
  return {
    execute: vi.fn(async (_command, handler) => {
      const outcome = await handler(transaction())
      return { value: outcome.result, replayed: false }
    }),
  } as unknown as Pick<NormalizedCommandExecutor, 'execute'>
}

function repository() {
  return {
    listDevices: vi.fn().mockResolvedValue([]),
    listPrintJobs: vi.fn().mockResolvedValue([]),
    listDeliveryWork: vi.fn().mockResolvedValue([{ kdsTaskId: 'delivery-1', tableCode: 'VIP1' }]),
    createDevice: vi.fn(),
    updateDevice: vi.fn(),
    getPrinterRouteByCode: vi.fn().mockResolvedValue(null),
    upsertPrinterRoute: vi.fn(),
    retryPrintJob: vi.fn(),
    requestHardwareCommand: vi.fn().mockResolvedValue({
      id: '26200000-0000-4000-8000-000000000005',
      publicId: 'hardware-command-public-0001',
      deviceId,
      commandType: 'test_print',
      status: 'requested',
      createdAt: '2026-08-11T00:00:00.000Z',
    }),
  }
}

function transaction(): ScopedTransaction {
  return {
    scope: { tenantId, storeId },
    query: async () => ({ rows: [], rowCount: 0 }),
  }
}
