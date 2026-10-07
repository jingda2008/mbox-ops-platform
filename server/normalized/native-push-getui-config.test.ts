import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readGetuiPushConfig, readNativePushConfig } from './native-push-config.js'

describe('independent disabled-by-default Getui configuration',()=>{
 it('does not require or read credentials while disabled',()=>{
  expect(readGetuiPushConfig({})).toBeNull()
  expect(readGetuiPushConfig({MBOX_GETUI_ENABLED:'false',MBOX_GETUI_MASTER_SECRET_FILE:'/absent'})).toBeNull()
  expect(()=>readGetuiPushConfig({MBOX_GETUI_ENABLED:'yes'})).toThrow('invalid')
  expect(()=>readGetuiPushConfig({MBOX_GETUI_ENABLED:'true'})).toThrow('incomplete or invalid')
 })
 it('pins app scope, independently enables Android, protects secrets and rejects malformed key/TTL/file',()=>{
  const dir=mkdtempSync(join(tmpdir(),'getui-config-')),path=join(dir,'secret')
  writeFileSync(path,'synthetic-test-secret\n',{mode:0o600})
  const env={MBOX_GETUI_ENABLED:'true',MBOX_GETUI_APP_ID:'synthetic-app',MBOX_GETUI_APP_KEY:'synthetic-key',MBOX_GETUI_MASTER_SECRET_FILE:path,MBOX_NATIVE_PUSH_TOKEN_KEY_BASE64:randomBytes(32).toString('base64'),MBOX_NATIVE_PUSH_TOKEN_KEY_ID:'key-1'}
  try {
   expect(readNativePushConfig(env)).toBeNull()
   expect(readGetuiPushConfig(env)).toMatchObject({appId:'synthetic-app',topic:'synthetic-app',environment:'production',eventTtlSeconds:300,masterSecret:'synthetic-test-secret'})
   for(const patch of [{MBOX_GETUI_APP_ID:'https://attacker.invalid'},{MBOX_NATIVE_PUSH_TOKEN_KEY_BASE64:'invalid'},{MBOX_NATIVE_PUSH_EVENT_TTL_SECONDS:'0'},{MBOX_NATIVE_PUSH_EVENT_TTL_SECONDS:'901'},{MBOX_GETUI_MASTER_SECRET_FILE:'relative'}])expect(()=>readGetuiPushConfig({...env,...patch})).toThrow('incomplete or invalid')
   chmodSync(path,0o644);expect(()=>readGetuiPushConfig(env)).toThrow('incomplete or invalid')
   chmodSync(path,0o600);writeFileSync(path,'x'.repeat(1025));expect(()=>readGetuiPushConfig(env)).toThrow('incomplete or invalid')
  }finally{rmSync(dir,{recursive:true,force:true})}
 })
})
