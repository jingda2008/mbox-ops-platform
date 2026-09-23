import {readFile, lstat} from 'node:fs/promises'
import {Client} from 'pg'
import {assertRuntimeDatabaseConnection, runtimeDatabaseLogin} from './runtime-database-identity.js'

const invalid = () => new Error('数据库维护连接配置无效；维护凭据必须独立且仅由受保护文件读取')

/** Deliberately support a small, explicit libpq service subset. Unknown options
 * fail closed instead of silently changing TLS, routing or authentication. */
export function parseMaintenanceDatabaseUrl(serviceText: string, passText: string, serviceName: string): string {
  if (!/^[A-Za-z0-9_.-]{1,63}$/.test(serviceName)) throw invalid()
  let section = '', found = false
  const values = new Map<string,string>()
  const allowed = new Set(['host','port','dbname','user','sslmode','sslrootcert','connect_timeout','application_name'])
  for (const raw of serviceText.split(/\r?\n/)) {
    const line=raw.trim()
    if (!line || line.startsWith('#')) continue
    const header=line.match(/^\[([^\]]+)\]$/)
    if (header) {section=header[1]!;if(section===serviceName){if(found)throw invalid();found=true}continue}
    if (section!==serviceName) continue
    const match=line.match(/^([A-Za-z_]+)\s*=\s*(.*)$/)
    if (!match || !allowed.has(match[1]!) || values.has(match[1]!)) throw invalid()
    values.set(match[1]!,match[2]!)
  }
  const host=values.get('host'),port=values.get('port')??'5432',database=values.get('dbname'),user=values.get('user')
  const sslmode=values.get('sslmode')
  if (!found || !host || !database || !user || /[\s,/]/.test(host) || !/^\d{1,5}$/.test(port)
    || Number(port)<1 || Number(port)>65535 || !sslmode || !['disable','require','verify-ca','verify-full'].includes(sslmode)) throw invalid()
  const password=passText.split(/\r?\n/).filter(line=>line&&!line.startsWith('#')).map(parsePasswordLine)
    .find(parts=>parts.slice(0,4).every((part,index)=>part==='*'||part===[host,port,database,user][index]))?.[4]
  if (password===undefined || !password) throw invalid()
  const url=new URL(`postgresql://${host.includes(':')?`[${host}]`:host}:${port}/`)
  url.username=user;url.password=password;url.pathname=`/${encodeURIComponent(database)}`
  url.searchParams.set('sslmode',sslmode)
  for (const field of ['sslrootcert','connect_timeout','application_name']) {
    const value=values.get(field);if(value)url.searchParams.set(field,value)
  }
  return url.toString()
}

function parsePasswordLine(line:string):string[] {
  const fields=[''];let escaped=false
  for (const char of line) {
    if(escaped){fields[fields.length-1]+=char;escaped=false}
    else if(char==='\\')escaped=true
    else if(char===':')fields.push('')
    else fields[fields.length-1]+=char
  }
  if(escaped||fields.length!==5)throw invalid()
  return fields
}

async function protectedText(path:string|undefined) {
  if(!path?.startsWith('/')||path.includes('\u0000'))throw invalid()
  const info=await lstat(path)
  if(!info.isFile()||info.uid!==0||(info.mode&0o777)!==0o600)throw invalid()
  return readFile(path,'utf8')
}

/** Called only in a short-lived maintenance container, never by the app. The
 * privileged URL stays in process memory and is never put in process.env. */
export async function maintenanceDatabaseUrlForCommand(
  argv:readonly string[]=process.argv,
  environment:Readonly<Record<string,string|undefined>>=process.env,
):Promise<string> {
  const service=argv.find(value=>value.startsWith('--maintenance-service='))?.slice('--maintenance-service='.length)
  if(!service){
    if((environment.MBOX_DEPLOYMENT_TIER==='production'||environment.NODE_ENV==='production')||argv.includes('--verify-only')||!environment.DATABASE_URL)throw invalid()
    return environment.DATABASE_URL
  }
  const serviceText=await protectedText(environment.PGSERVICEFILE),passText=await protectedText(environment.PGPASSFILE)
  const adminUrl=parseMaintenanceDatabaseUrl(serviceText,passText,service)
  if(!environment.DATABASE_URL)throw invalid()
  await verifySeparateMaintenanceDatabase(environment.DATABASE_URL,adminUrl)
  return adminUrl
}

export async function verifySeparateMaintenanceDatabase(runtimeUrl:string,adminUrl:string):Promise<void> {
  const runtime=new Client({connectionString:runtimeUrl,connectionTimeoutMillis:5000})
  const admin=new Client({connectionString:adminUrl,connectionTimeoutMillis:5000})
  try {
    await runtime.connect()
    await assertRuntimeDatabaseConnection(runtime,runtimeDatabaseLogin(runtimeUrl))
    await admin.connect()
    const identitySql=`SELECT session_user::text AS login,current_user::text AS effective,
      current_database() || '|' || COALESCE(inet_server_addr()::text,'local') || '|' || current_setting('port') AS database_identity`
    const runtimeIdentity=(await runtime.query(identitySql)).rows[0],adminIdentity=(await admin.query(identitySql)).rows[0]
    if(!runtimeIdentity||!adminIdentity||runtimeIdentity.database_identity!==adminIdentity.database_identity
      ||runtimeIdentity.login===adminIdentity.login||adminIdentity.login!==adminIdentity.effective)throw invalid()
  } catch {throw invalid()}
  finally {await Promise.allSettled([runtime.end(),admin.end()])}
}
