import {describe,expect,it} from 'vitest'
import {maintenanceDatabaseUrlForCommand,parseMaintenanceDatabaseUrl} from './database-maintenance-connection.js'

const service='[migration]\nhost=db.example\nport=5432\ndbname=mbox\nuser=migrator\nsslmode=verify-full\n'
describe('isolated maintenance credential loading',()=>{
  it('reads selected service and first matching pgpass entry, retaining escaped password bytes',()=>{
    const url=new URL(parseMaintenanceDatabaseUrl(service,'other:5432:mbox:migrator:no\ndb.example:5432:mbox:migrator:p\\:a\\\\ss\n*:*:*:*:fallback','migration'))
    expect(url.username).toBe('migrator');expect(decodeURIComponent(url.password)).toBe('p:a\\ss')
    expect(url.searchParams.get('sslmode')).toBe('verify-full')
  })
  it.each(['password=secret','passfile=/tmp/pass','options=-c role=postgres','sslmode=prefer','host=db2'])('rejects unsafe or duplicate service settings: %s',field=>{
    expect(()=>parseMaintenanceDatabaseUrl(service+field+'\n','*:*:*:*:secret','migration')).toThrow(/维护连接配置无效/)
  })
  it('does not fall back to the application credential in production',async()=>{
    await expect(maintenanceDatabaseUrlForCommand([],{MBOX_DEPLOYMENT_TIER:'production',DATABASE_URL:'postgresql://runtime:secret@db/app'})).rejects.toThrow(/维护连接配置无效/)
    await expect(maintenanceDatabaseUrlForCommand([],{NODE_ENV:'production',DATABASE_URL:'postgresql://runtime:secret@db/app'})).rejects.toThrow(/维护连接配置无效/)
    await expect(maintenanceDatabaseUrlForCommand([],{DATABASE_URL:'postgresql://dev@localhost/test'})).resolves.toBe('postgresql://dev@localhost/test')
  })
})
