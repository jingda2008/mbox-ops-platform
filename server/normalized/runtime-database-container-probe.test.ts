import {spawnSync} from 'node:child_process'
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,describe,expect,it} from 'vitest'
import {buildRuntimeDatabaseContainerProbe} from './runtime-database-container-probe.js'

const directories:string[]=[]
const contract="export const RUNTIME_DATABASE_ISOLATION_CONTRACT='restricted-login/v1';"
const guard=`${contract}\nexport async function assertRuntimeDatabasePool(pool,url){if(new URL(url).username!=='safe_runtime')throw new Error('must not expose '+url);return{session_user:new URL(url).username};}`
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})))})
async function run(previous:string|null,url='postgresql://safe_runtime:never-print-this@db/mbox',extra:Record<string,string>={}){
  const directory=await mkdtemp(join(tmpdir(),'runtime-container-probe-'));directories.push(directory)
  await mkdir(join(directory,'dist-normalized/server/normalized'),{recursive:true})
  await mkdir(join(directory,'node_modules/pg'),{recursive:true})
  await writeFile(join(directory,'package.json'),' {"type":"module"}')
  await writeFile(join(directory,'node_modules/pg/package.json'),'{"type":"module","exports":"./index.js"}')
  // The probe is tested as a real child process. Socket behavior belongs to the
  // separate real-login integration test; this driver records pool independence.
  await writeFile(join(directory,'node_modules/pg/index.js'),`let count=0;export default{Pool:class{constructor(options){if(++count>2||options.connectionString!==process.env.DATABASE_URL)throw new Error('wrong pool');this.url=options.connectionString}async end(){}}}`)
  if(previous!==null)await writeFile(join(directory,'dist-normalized/server/normalized/runtime-database-identity.js'),previous)
  return spawnSync(process.execPath,['--input-type=module'],{cwd:directory,input:buildRuntimeDatabaseContainerProbe(guard),encoding:'utf8',env:{DATABASE_URL:url,...extra}})
}
describe('restricted rollback container probe',()=>{
  it('uses the old container environment for two independently verified pools without printing credentials',async()=>{
    const result=await run(guard);expect(result.status,result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({status:'restricted',contract:'restricted-login/v1',logins:{api:'safe_runtime',worker:'safe_runtime'}})
    expect(result.stdout+result.stderr).not.toContain('never-print-this')
  })
  it('rejects a legacy image even after its URL has been changed to a low login',async()=>{
    for(const previous of [null,"export const RUNTIME_DATABASE_ISOLATION_CONTRACT='legacy';"]){
      const result=await run(previous);expect(result.status).toBe(1);expect(result.stderr).toContain('prepare and validate a restricted rollback baseline')
    }
  })
  it('rejects high privilege and hidden maintenance credentials without reflecting their values',async()=>{
    const high=await run(guard,'postgresql://postgres:never-print-this@db/mbox')
    const secret=await run(guard,undefined,{PGPASSFILE:'/run/never-print-this'})
    for(const result of [high,secret]){expect(result.status).toBe(1);expect(result.stdout+result.stderr).not.toContain('never-print-this')}
  })
  it('also applies the previous image guard instead of trusting a matching version string',async()=>{
    const result=await run(contract+"export async function assertRuntimeDatabasePool(){throw new Error('unsafe previous runtime')}")
    expect(result.status).toBe(1);expect(result.stderr).toContain('ROLLBACK_DATABASE_ISOLATION_UNVERIFIED')
  })
})
