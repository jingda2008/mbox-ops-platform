import test from 'node:test'
import assert from 'node:assert/strict'
import { scanImportClosure } from './normalized-import-closure.mjs'

test('normalized default entry cannot reach the legacy API or offline runtime', async () => {
  const closure = await scanImportClosure({ cwd: process.cwd(), entries: ['src/main.tsx'] })
  assert.equal(closure.files.includes('src/api.ts'), false)
  assert.equal(closure.files.includes('src/offline.ts'), false)
})

import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

test('TS .js imports, aliases, directory modules and static dynamic imports remain in the runtime graph',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'import-closure-'))
 try{
  await mkdir(join(cwd,'folder'))
  await writeFile(join(cwd,'tsconfig.json'),JSON.stringify({compilerOptions:{moduleResolution:'bundler',baseUrl:'.',paths:{'@/*':['./*']}}}))
  await writeFile(join(cwd,'entry.ts'),"import {x} from './bridge.js'; import type {OnlyType} from './missing-type'; import {type OtherType} from './missing-other-type'; void import('@/folder'); console.log(x)")
  await writeFile(join(cwd,'bridge.ts'),"export {x} from './legacy'")
  await writeFile(join(cwd,'legacy.ts'),'export const x=1')
  await writeFile(join(cwd,'folder/index.ts'),'export const folder=1')
  const result=await scanImportClosure({cwd,entries:['entry.ts'],configFile:'tsconfig.json'})
  assert.deepEqual(result.files,['bridge.ts','entry.ts','folder/index.ts','legacy.ts'])
  await writeFile(join(cwd,'bridge.ts'),"import './missing-runtime.js'")
  await assert.rejects(scanImportClosure({cwd,entries:['entry.ts'],configFile:'tsconfig.json'}),/Unresolved runtime import/)
 }finally{await rm(cwd,{recursive:true,force:true})}
})
