import type {PostgresPool, PostgresPoolClient} from './transaction-runner.js'

export const RUNTIME_DATABASE_ISOLATION_CONTRACT = 'restricted-login/v1'

export interface RuntimeDatabaseIdentity extends Record<string, unknown> {
  session_user: string
  current_user: string
  login: boolean
  runtime_member: boolean
  row_security: boolean
  unsafe_attributes: boolean
  unexpected_membership: boolean
  owns_objects: boolean
  can_create: boolean
  unsafe_definer: boolean
}

export class RuntimeDatabaseIdentityError extends Error {
  readonly code = 'RUNTIME_DATABASE_IDENTITY_UNSAFE'
  constructor() {
    super('应用数据库必须使用独立受限登录；禁止维护账号、角色切换或可恢复的高权限')
    this.name = 'RuntimeDatabaseIdentityError'
  }
}

/** An explicit login is part of the runtime contract; PGUSER/SET ROLE cannot
 * silently replace it. Never include the supplied URL in diagnostics. */
export function runtimeDatabaseLogin(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl)
    const login = decodeURIComponent(url.username)
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !login || !url.hostname
      || !url.pathname.slice(1) || [...login].some(char=>char.codePointAt(0)!<32||char.codePointAt(0)===127)) throw new Error()
    return login
  } catch { throw new RuntimeDatabaseIdentityError() }
}

export function validateRuntimeDatabaseIdentity(identity: RuntimeDatabaseIdentity | undefined, expectedLogin: string): void {
  if (!identity || identity.session_user !== expectedLogin || identity.current_user !== expectedLogin
    || identity.login !== true || identity.runtime_member !== true || identity.row_security !== true
    || identity.unsafe_attributes !== false || identity.unexpected_membership !== false
    || identity.owns_objects !== false || identity.can_create !== false || identity.unsafe_definer !== false) throw new RuntimeDatabaseIdentityError()
}

/** Check both the authenticated identity and all reachable roles. Restrict the
 * login to mbox_runtime membership; an admin credential with SET ROLE is never
 * accepted, even if current_user alone appears safe. Catalog reads do not need
 * business scope and never read customer data. */
export async function assertRuntimeDatabaseConnection(client: Pick<PostgresPoolClient, 'query'>, expectedLogin: string) {
  const result = await client.query<RuntimeDatabaseIdentity>(`
    WITH reachable AS MATERIALIZED (
      SELECT role.* FROM pg_catalog.pg_roles role
      WHERE role.rolname = session_user OR pg_catalog.pg_has_role(session_user,role.oid,'MEMBER')
    )
    SELECT session_user::text AS session_user,current_user::text AS current_user,
      COALESCE((SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname=session_user),false) AS login,
      EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='mbox_runtime'
        AND pg_catalog.pg_has_role(session_user,oid,'USAGE') AND NOT rolcanlogin) AS runtime_member,
      current_setting('row_security')='on' AS row_security,
      EXISTS(SELECT 1 FROM reachable WHERE rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS unsafe_attributes,
      EXISTS(SELECT 1 FROM reachable WHERE rolname NOT IN (session_user,'mbox_runtime')) AS unexpected_membership,
      (EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datname=current_database() AND datdba IN (SELECT oid FROM reachable))
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner IN (SELECT oid FROM reachable))
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner IN (SELECT oid FROM reachable))
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE proowner IN (SELECT oid FROM reachable))) AS owns_objects,
      (pg_catalog.has_database_privilege(session_user,current_database(),'CREATE')
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg_temp_%'
          AND nspname NOT LIKE 'pg_toast_temp_%' AND pg_catalog.has_schema_privilege(session_user,oid,'CREATE'))) AS can_create,
      EXISTS(SELECT 1 FROM pg_catalog.pg_proc function JOIN pg_catalog.pg_namespace namespace ON namespace.oid=function.pronamespace
        WHERE function.prosecdef AND namespace.nspname NOT IN ('pg_catalog','information_schema')
          AND pg_catalog.has_function_privilege(session_user,function.oid,'EXECUTE')
          AND (namespace.nspname<>'mbox' OR NOT COALESCE(function.proconfig @> ARRAY['search_path=pg_catalog, mbox'],false))) AS unsafe_definer
  `)
  const identity = result.rows[0]
  validateRuntimeDatabaseIdentity(identity, expectedLogin)
  return identity!
}

export async function assertRuntimeDatabasePool(pool: PostgresPool, databaseUrl: string) {
  const login = runtimeDatabaseLogin(databaseUrl)
  const client = await pool.connect()
  try { return await assertRuntimeDatabaseConnection(client, login) }
  finally { client.release() }
}
