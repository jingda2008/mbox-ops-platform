import { describe, expect, it } from 'vitest'
import { createSeedState } from './seed.js'
import { assertProvisionIdentity, validateProvisionState } from './provision-runtime.js'

describe('runtime provisioning validation', () => {
  it('accepts a complete explicitly identified state', () => {
    expect(validateProvisionState(createSeedState(), 'mbox-lujiazui').tables.length).toBeGreaterThan(0)
  })

  it('rejects store mismatch and broken responsibility references', () => {
    expect(() => validateProvisionState(createSeedState(), 'another-store')).toThrow('MBOX_STORE_CODE')
    const state = createSeedState()
    state.tables[0]!.primaryEmployeeId = 'missing'
    expect(() => validateProvisionState(state, 'mbox-lujiazui')).toThrow('主责员工不存在')
  })

  it('rejects silently reusing an existing production identity with different metadata', () => {
    expect(() => assertProvisionIdentity('门店', {
      id: 'store-1', tenant_id: 'tenant-1', code: 'LJZ', name: '旧名称', timezone: 'Asia/Shanghai',
    }, {
      id: 'store-1', tenant_id: 'tenant-1', code: 'LJZ', name: 'M-Box陆家嘴', timezone: 'Asia/Shanghai',
    })).toThrow('name不一致')
    expect(() => assertProvisionIdentity('租户', undefined, { id: 'tenant-1' })).toThrow('写入后不可见')
  })
})
