import {describe, expect, it, vi} from 'vitest'
import {assertRuntimeDatabasePool, runtimeDatabaseLogin, validateRuntimeDatabaseIdentity, type RuntimeDatabaseIdentity} from './runtime-database-identity.js'

const safe: RuntimeDatabaseIdentity = {session_user:'mbox_app',current_user:'mbox_app',login:true,runtime_member:true,
  row_security:true,unsafe_attributes:false,unexpected_membership:false,owns_objects:false,can_create:false,unsafe_definer:false}

describe('actual runtime database identity', () => {
  it('requires an explicit URL login without disclosing the credential on errors', () => {
    expect(runtimeDatabaseLogin('postgresql://mbox_app:secret@db/mbox')).toBe('mbox_app')
    for (const url of ['postgresql://db/mbox','postgresql://mbox_app:secret@db','https://mbox_app:secret@db/mbox']) {
      expect(() => runtimeDatabaseLogin(url)).toThrow(/独立受限登录/)
      try {runtimeDatabaseLogin(url)} catch (error) {expect(String(error)).not.toContain('secret')}
    }
  })
  it('accepts a real restricted login, but rejects admin sessions hidden behind SET ROLE', () => {
    expect(() => validateRuntimeDatabaseIdentity(safe, 'mbox_app')).not.toThrow()
    expect(() => validateRuntimeDatabaseIdentity({...safe,session_user:'admin'}, 'mbox_app')).toThrow()
    expect(() => validateRuntimeDatabaseIdentity({...safe,current_user:'mbox_runtime'}, 'mbox_app')).toThrow()
    expect(() => validateRuntimeDatabaseIdentity(undefined, 'mbox_app')).toThrow()
  })
  it.each(['unsafe_attributes','unexpected_membership','owns_objects','can_create','unsafe_definer'] as const)('denies %s including recoverable privileged roles', field => {
    expect(() => validateRuntimeDatabaseIdentity({...safe,[field]:true}, 'mbox_app')).toThrow()
  })
  it.each(['login','runtime_member','row_security'] as const)('requires %s', field => {
    expect(() => validateRuntimeDatabaseIdentity({...safe,[field]:false}, 'mbox_app')).toThrow()
  })
  it('releases the pool client on rejection and never tries SET ROLE', async () => {
    const release=vi.fn(),query=vi.fn().mockResolvedValue({rows:[{...safe,unsafe_attributes:true}],rowCount:1})
    const pool={connect:async()=>({query,release}),end:async()=>{}}
    await expect(assertRuntimeDatabasePool(pool,'postgresql://mbox_app:secret@db/mbox')).rejects.toMatchObject({code:'RUNTIME_DATABASE_IDENTITY_UNSAFE'})
    expect(release).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]![0]).not.toMatch(/SET (?:LOCAL )?ROLE/)
  })
})
