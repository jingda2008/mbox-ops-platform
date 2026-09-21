/** The trusted candidate supplies the guard code, while the previous container
 * supplies its own environment and pg driver. No credential leaves that container.
 * Requiring the prior guard contract excludes legacy images whose ready check
 * cannot establish a restricted rollback baseline. */
export function buildRuntimeDatabaseContainerProbe(compiledGuard:string):string {
  return `${compiledGuard}\n
import pg from 'pg';
import {pathToFileURL} from 'node:url';
const runtimePools=[];
try {
  const previous=await import(pathToFileURL(process.cwd()+'/dist-normalized/server/normalized/runtime-database-identity.js').href);
  if(previous.RUNTIME_DATABASE_ISOLATION_CONTRACT!==RUNTIME_DATABASE_ISOLATION_CONTRACT)throw new Error();
  for(const name of ['ADMIN_DATABASE_URL','BACKUP_DATABASE_URL','MBOX_MIGRATION_DATABASE_URL','MBOX_DATABASE_ADMIN_URL','PGPASSWORD','PGPASSFILE','PGSERVICEFILE','PGSERVICE']) {
    if(process.env[name]?.trim())throw new Error();
  }
  const databaseUrl=process.env.DATABASE_URL;
  const logins={};
  for(const component of ['api','worker']) {
    const pool=new pg.Pool({connectionString:databaseUrl,max:1,connectionTimeoutMillis:5000});runtimePools.push(pool);
    const actual=await assertRuntimeDatabasePool(pool,databaseUrl);
    await previous.assertRuntimeDatabasePool(pool,databaseUrl);
    logins[component]=actual.session_user;
  }
  process.stdout.write(JSON.stringify({status:'restricted',contract:RUNTIME_DATABASE_ISOLATION_CONTRACT,logins})+'\\n');
} catch {
  process.stderr.write('ROLLBACK_DATABASE_ISOLATION_UNVERIFIED: prepare and validate a restricted rollback baseline before migration or cutover\\n');
  process.exitCode=1;
} finally {await Promise.allSettled(runtimePools.map(pool=>pool.end()));}
`
}
