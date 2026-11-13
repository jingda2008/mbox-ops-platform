import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { ScopedTransaction } from './transaction-runner.js'
import type { ChannelApiOptions } from './channel-distribution-api.js'
import { ChannelDistributionError } from './channel-distribution-policy.js'
import { ChannelDistributionRepository } from './channel-distribution-repository.js'

const cookieName = '__Secure-mbox_channel_partner_session'
const credentials = z.object({ username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{3,39}$/), password: z.string().min(12).max(128) })
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const hashChannelWebToken = (token: string) => createHash('sha256').update(token).digest('hex')
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)))
export async function hashChannelWebPassword(password: string) {
  const salt = randomBytes(16).toString('hex')
  return `scrypt1:${salt}:${(await derive(password, salt)).toString('hex')}`
}
export async function verifyChannelWebPassword(password: string, encoded: string) {
  const match = /^scrypt1:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(encoded)
  const actual = await derive(password, match?.[1] ?? '00000000000000000000000000000000')
  return Boolean(match && timingSafeEqual(actual, Buffer.from(match[2]!, 'hex')))
}
function denied(): never { throw new ChannelDistributionError('NOT_AUTHORIZED', 401) }
export function channelWebScope(options: ChannelApiOptions) {
  if (!options.webScope) throw new ChannelDistributionError('NOT_AUTHORIZED', 503)
  return options.webScope
}
export function channelWebToken(request: FastifyRequest) {
  const values = (request.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${cookieName}=`))
  if (values.length !== 1) return denied()
  const token = values[0]!.slice(cookieName.length + 1)
  if (!tokenSchema.safeParse(token).success) return denied()
  return token
}
export async function authorizeChannelWeb(tx: ScopedTransaction, token: string) {
  const row = (await tx.query<{ id: string; name: string; can_confirm_statement: boolean; partner_id: string }>(`
    SELECT p.id,p.name,p.can_confirm_statement,p.partner_id FROM mbox.channel_web_sessions s
    JOIN mbox.channel_promoters p ON (p.tenant_id,p.store_id,p.id)=(s.tenant_id,s.store_id,s.promoter_id)
    JOIN mbox.channel_partners r ON (r.tenant_id,r.store_id,r.id)=(p.tenant_id,p.store_id,p.partner_id)
    WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.token_hash=$3 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    AND p.status='active' AND r.status='active'`, [tx.scope.tenantId, tx.scope.storeId, hashChannelWebToken(token)])).rows[0]
  if (!row) return denied()
  return row
}
export function requireChannelWebOrigin(request: FastifyRequest) {
  if (!['https://www.shmbox.com', 'https://shmbox.com'].includes(String(request.headers.origin)) || request.headers['x-channel-web'] !== '1') {
    throw new ChannelDistributionError('NOT_AUTHORIZED', 403)
  }
}
export async function inviteChannelWeb(tx: ScopedTransaction, promoterId: string, employeeId: string) {
  const args = [tx.scope.tenantId, tx.scope.storeId, promoterId]
  const row = (await tx.query(`SELECT id FROM mbox.channel_promoters WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='active' FOR UPDATE`, args)).rows[0]
  if (!row) throw new ChannelDistributionError('NOT_AUTHORIZED', 403)
  await tx.query(`UPDATE mbox.channel_web_invitations SET expires_at=LEAST(expires_at,clock_timestamp()) WHERE tenant_id=$1 AND store_id=$2 AND promoter_id=$3 AND accepted_at IS NULL`, args)
  const token = randomBytes(32).toString('base64url')
  const invite = (await tx.query<{ id: string; expiresAt: string }>(`INSERT INTO mbox.channel_web_invitations(tenant_id,store_id,promoter_id,token_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '72 hours') RETURNING id,expires_at::text AS "expiresAt"`, [...args, hashChannelWebToken(token)])).rows[0]!
  await new ChannelDistributionRepository(tx).event(invite.id, 'partner.web-invited', `employee:${employeeId}`, { promoterId })
  return { ...invite, token }
}
function setSession(reply: FastifyReply, token: string, maxAge: number) {
  reply.header('set-cookie', `${cookieName}=${token}; Path=/cooperation; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`)
}
export function registerChannelWebAuth(app: FastifyInstance, options: ChannelApiOptions) {
  app.addHook('preHandler', async request => {
    const route=request.routeOptions.url??''
    if(!route.includes('/cooperation/')||['/login','/activate','/logout'].some(path=>route.endsWith(path)))return
    const token=channelWebToken(request),scope=channelWebScope(options)
    const count=await options.transactions.run(scope,async tx=>{
      await authorizeChannelWeb(tx,token)
      return (await tx.query<{count:number}>(`INSERT INTO mbox.channel_request_buckets(tenant_id,store_id,actor_hash,minute,count) VALUES($1,$2,$3,date_trunc('minute',clock_timestamp()),1) ON CONFLICT(tenant_id,store_id,actor_hash,minute) DO UPDATE SET count=channel_request_buckets.count+1 RETURNING count`,[scope.tenantId,scope.storeId,hashChannelWebToken(`web-session:${token}`)])).rows[0]!.count
    })
    if(count>60)throw new ChannelDistributionError('RATE_LIMIT',429)
  })
  // Throttle before password derivation in a separate committed transaction: rejected logins still count.
  async function throttle(request: FastifyRequest, username?: string) {
    const counts = await options.transactions.run(channelWebScope(options), async tx => {
      const actors = [`web-ip:${request.ip}`, ...(username ? [`web-user:${username}`] : [])]
      const counts: number[] = []
      for (const actor of actors) counts.push((await tx.query<{ count: number }>(`INSERT INTO mbox.channel_request_buckets(tenant_id,store_id,actor_hash,minute,count)
        VALUES($1,$2,$3,date_bin('15 minutes',clock_timestamp(),'2000-01-01'::timestamptz),1)
        ON CONFLICT(tenant_id,store_id,actor_hash,minute) DO UPDATE SET count=channel_request_buckets.count+1 RETURNING count`, [tx.scope.tenantId, tx.scope.storeId, hashChannelWebToken(actor)])).rows[0]!.count)
      return counts
    })
    if (counts[0]! > 30 || (counts[1] ?? 0) > 10) throw new ChannelDistributionError('RATE_LIMIT', 429)
  }
  app.post('/cooperation/login', { bodyLimit: 2048 }, async (request, reply) => {
    requireChannelWebOrigin(request)
    const input = credentials.strict().parse(request.body)
    await throttle(request, input.username)
    const scope = channelWebScope(options)
    const account = await options.transactions.run(scope, async tx => (await tx.query<{ promoter_id: string; password_hash: string }>(`SELECT promoter_id,password_hash FROM mbox.channel_web_accounts WHERE tenant_id=$1 AND store_id=$2 AND username=$3`, [scope.tenantId, scope.storeId, input.username])).rows[0], { readOnly: true })
    const valid = await verifyChannelWebPassword(input.password, account?.password_hash ?? '')
    if (!account || !valid) return denied()
    const token = randomBytes(32).toString('base64url')
    await options.transactions.run(scope, async tx => {
      // Lock/recheck the password: a concurrent reset must not issue an old-credential session.
      const current = (await tx.query<{ password_hash: string }>(`SELECT password_hash FROM mbox.channel_web_accounts WHERE tenant_id=$1 AND store_id=$2 AND promoter_id=$3 FOR UPDATE`, [scope.tenantId, scope.storeId, account.promoter_id])).rows[0]
      if (current?.password_hash !== account.password_hash) return denied()
      await tx.query(`INSERT INTO mbox.channel_web_sessions(tenant_id,store_id,promoter_id,token_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '12 hours')`, [scope.tenantId, scope.storeId, account.promoter_id, hashChannelWebToken(token)])
      await authorizeChannelWeb(tx, token)
    })
    setSession(reply, token, 43200)
    return { data: { authenticated: true } }
  })
  app.post('/cooperation/activate', { bodyLimit: 2048 }, async request => {
    requireChannelWebOrigin(request)
    const input = credentials.extend({ token: tokenSchema }).strict().parse(request.body)
    await throttle(request, input.username)
    const encoded = await hashChannelWebPassword(input.password)
    await options.transactions.run(channelWebScope(options), async tx => {
      const args = [tx.scope.tenantId, tx.scope.storeId]
      // Shared lock order for invitation regeneration and activation: promoter then invitation.
      const candidate = (await tx.query<{ promoter_id: string }>(`SELECT promoter_id FROM mbox.channel_web_invitations WHERE tenant_id=$1 AND store_id=$2 AND token_hash=$3`, [...args, hashChannelWebToken(input.token)])).rows[0]
      if (!candidate) return denied()
      const active = (await tx.query(`SELECT p.id FROM mbox.channel_promoters p JOIN mbox.channel_partners r ON (r.tenant_id,r.store_id,r.id)=(p.tenant_id,p.store_id,p.partner_id) WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.id=$3 AND p.status='active' AND r.status='active' FOR UPDATE OF p`, [...args, candidate.promoter_id])).rows[0]
      if (!active) return denied()
      const invitation = (await tx.query<{ id: string }>(`UPDATE mbox.channel_web_invitations SET accepted_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND token_hash=$3 AND accepted_at IS NULL AND expires_at>clock_timestamp() RETURNING id`, [...args, hashChannelWebToken(input.token)])).rows[0]
      if (!invitation) return denied()
      await tx.query(`INSERT INTO mbox.channel_web_accounts(tenant_id,store_id,promoter_id,username,password_hash) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(tenant_id,store_id,promoter_id) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash,updated_at=clock_timestamp()`, [...args, candidate.promoter_id, input.username, encoded])
      await tx.query(`UPDATE mbox.channel_web_sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND promoter_id=$3 AND revoked_at IS NULL`, [...args, candidate.promoter_id])
      await new ChannelDistributionRepository(tx).event(candidate.promoter_id, 'partner.web-activated', `promoter:${candidate.promoter_id}`, { invitationId: invitation.id })
    })
    return { data: { activated: true } }
  })
  app.post('/cooperation/logout', async (request, reply) => {
    requireChannelWebOrigin(request)
    const scope = channelWebScope(options), token = channelWebToken(request)
    await options.transactions.run(scope, tx => tx.query(`UPDATE mbox.channel_web_sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND token_hash=$3 AND revoked_at IS NULL`, [scope.tenantId, scope.storeId, hashChannelWebToken(token)]))
    setSession(reply, '', 0)
    return { data: { authenticated: false } }
  })
}
