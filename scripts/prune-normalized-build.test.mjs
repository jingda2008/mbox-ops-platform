import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
test('release pruning keeps runtime and CLI imports but removes type-only legacy output',async()=>{
 const root=await mkdtemp(join(tmpdir(),'normalized-build-'))
 try{
  await mkdir(join(root,'dist-normalized/server'),{recursive:true})
  await writeFile(join(root,'tsconfig.normalized-server.json'),JSON.stringify({files:['server/main.ts','server/cli.ts']}))
  for(const [name,text] of Object.entries({'main.js':"import './provider.js'",'provider.js':'export const provider=1','cli.js':"import './provider.js'",'legacy.js':'export const old=1'}))await writeFile(join(root,'dist-normalized/server',name),text)
  const run=()=>execFileSync(process.execPath,[new URL('./prune-normalized-build.mjs',import.meta.url).pathname],{cwd:root,encoding:'utf8',stdio:'pipe'})
  const result=JSON.parse(run());assert.deepEqual(result.removed,['server/legacy.js']);assert.equal(result.retained,3)
  await assert.rejects(readFile(join(root,'dist-normalized/server/legacy.js')),/ENOENT/)
  await writeFile(join(root,'dist-normalized/server/provider.js'),"import './missing.js'")
  assert.throws(run,/Unresolved runtime import/)
 }finally{await rm(root,{recursive:true,force:true})}
})
