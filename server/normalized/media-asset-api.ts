import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createMenuThumbnailer, readLegacyMenuImage } from './menu-thumbnail.js'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { ActivityOperationsStaffContext } from './activity-operations-service.js'
import { IdempotencyConflictError, IdempotencyInProgressError, IdempotencyRecordError } from './command-executor.js'
import { MediaAssetRepository, type MediaAssetView, type MediaPurpose } from './media-asset-repository.js'
import { MediaAssetService } from './media-asset-service.js'
import { OutboxMessageConflictError } from './command-executor.js'
import { isStaffAuthenticationRequiredError, STAFF_AUTHENTICATION_REQUIRED_ERROR } from './staff-api-authentication.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

const MAX_IMAGE_BYTES = 200 * 1024
const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4
// Base64 and the JSON envelope are larger than the source image. This is a
// transport allowance only; the decoded image remains limited to 200 KiB.
const MEDIA_UPLOAD_BODY_LIMIT_BYTES = 300_000
const MEDIA_READ_PERMISSIONS = ['community.activity.view', 'community.activity.manage', 'community.activity.publish',
  'customer.experience.feature.manage', 'media.asset.menu.manage'] as const

export interface MediaAssetApiOptions {
  staticDirectory?: string
  transactions: Pick<ScopedPostgresTransactionRunner,'run'>
  service: MediaAssetService
  resolveStaffContext(request: FastifyRequest): ActivityOperationsStaffContext | Promise<ActivityOperationsStaffContext>
  resolveScope(): Readonly<StoreScope>
  createStaffAccessRepository?(transaction: ScopedTransaction): Pick<StaffAccessRepository,'assertPermission'>
}

export const mediaAssetApiPlugin: FastifyPluginAsync<MediaAssetApiOptions> = async (app, options) => {
  const thumbnail = createMenuThumbnailer()
  const staffThumbnail = createMenuThumbnailer({maxQueued:24,preserveJpeg:true})
  const timing=new WeakMap<FastifyRequest,{started:number;ready:number;phases:Record<string,number>;thumbnail:boolean}>()
  app.addHook('onResponse',async request=>{
    const value=timing.get(request)
    if(value&&performance.now()-value.started>500)request.log.info({event:'staff_media_read_slow',requestId:request.id,
      ...value.phases,sendMs:performance.now()-value.ready,totalMs:performance.now()-value.started,thumbnail:value.thumbnail},'Staff image read exceeded 500ms')
  })
  app.get<{ Querystring: { path?: string } }>('/public/menu-thumbnail', async (request, reply) => {
    const original = await readLegacyMenuImage(options.staticDirectory, request.query.path)
    if (!original) return reply.code(404).send({ error: { code: 'MENU_IMAGE_NOT_FOUND', message: '图片不存在' } })
    const image = await thumbnail(original)
    reply.header('cache-control', image === original ? 'public, max-age=60' : 'public, max-age=86400').header('etag', `"${image.sha256}"`)
    if (request.headers['if-none-match'] === `"${image.sha256}"`) return reply.code(304).send()
    return reply.type(image.mimeType).send(image.bytes)
  })
  app.get<{Querystring:{purpose?:string;before?:string;limit?:string}}>('/staff/media-assets', async (request, reply) => handle(reply, async () => {
    const context = await authorizedAny(options, request, MEDIA_READ_PERMISSIONS)
    const purpose=request.query.purpose===undefined?undefined:enumeration(request.query.purpose,'图片用途',['community_activity','home_content','menu','performer','support_contact'] as const)
    const before=request.query.before===undefined?undefined:assetPublicId(request.query.before)
    const limit=request.query.limit===undefined?12:Number(request.query.limit)
    if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw invalid('图片每页数量应为 1 至 50')
    const items=await options.service.list(context,{purpose,before,limit:limit+1})
    return reply.send({data:items.slice(0,limit),meta:{nextCursor:items.length>limit?items[limit-1]!.publicId:null}})
  }))

  app.post('/staff/media-assets', { bodyLimit: MEDIA_UPLOAD_BODY_LIMIT_BYTES }, async (request, reply) => handle(reply, async () => {
    const body = object(request.body)
    const purpose = enumeration(body.purpose, '图片用途', ['community_activity','home_content','menu','performer','support_contact'] as const) as MediaPurpose
    const context = purpose === 'support_contact'
      ? await authorizedAny(options, request, ['community.activity.manage', 'customer.experience.feature.manage'])
      : purpose === 'menu'
        ? await authorized(options, request, 'media.asset.menu.manage')
        : await authorized(options, request, 'community.activity.manage')
    const mimeType = enumeration(body.mimeType, '图片格式', ['image/jpeg','image/png','image/webp'] as const)
    const bytes = decodeBase64(body.base64)
    if (bytes.length > MAX_IMAGE_BYTES) throw invalid('图片压缩后不能超过 200KB')
    if (!matchesSignature(bytes, mimeType)) throw invalid('图片内容与声明格式不一致')
    const result = await options.service.upload(context, {
      purpose,
      originalFileName: fileName(body.fileName), mimeType, bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'), idempotencyKey: key(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.get<{ Params: { publicId: string }; Querystring:{size?:string} }>('/staff/media-assets/:publicId', async (request, reply) => handle(reply, async () => {
    const started=performance.now()
    const context=await options.resolveStaffContext(request)
    const authenticated=performance.now()
    const isThumbnail=request.query.size==='thumbnail'
    if(request.query.size!==undefined&&!isThumbnail)throw invalid('图片尺寸无效')
    const publicId=assetPublicId(request.params.publicId)
    let acquired=authenticated,permitted=authenticated,metadataRead=authenticated
    const value=await options.transactions.run(context.scope,async transaction=>{
      acquired=performance.now()
      await assertAnyMediaPermission(options,transaction,context.employeeId,MEDIA_READ_PERMISSIONS)
      permitted=performance.now()
      const repo=new MediaAssetRepository(transaction),metadata=await repo.staffMetadata(publicId)
      metadataRead=performance.now()
      if(!metadata)return null
      // A thumbnail may fall back to the original under bounded CPU pressure;
      // use a weak validator for that semantically equivalent representation.
      const etag=`${isThumbnail?'W/':''}"${metadata.sha256}${isThumbnail?':thumbnail-v1':''}"`
      // A conditional read must still authenticate and check current authority.
      if(request.headers['if-none-match']===etag)return{etag,image:null}
      const image=await repo.staffBytes(publicId)
      return image?{etag,image}:null
    },{readOnly:true})
    const read=performance.now()
    if(!value)return reply.code(404).send({error:{code:'MEDIA_ASSET_NOT_FOUND',message:'图片不存在'}})
    const image=value.image && isThumbnail?await staffThumbnail(value.image):value.image
    const transformed=performance.now()
    const phases={authMs:authenticated-started,poolAndSetupMs:acquired-authenticated,permissionMs:permitted-acquired,
      metadataMs:metadataRead-permitted,bytesAndCommitMs:read-metadataRead,transformMs:transformed-read}
    timing.set(request,{started,ready:transformed,phases,thumbnail:isThumbnail})
    reply.header('cache-control','private, no-cache').header('vary','Cookie, Authorization').header('etag',value.etag)
      .header('server-timing',Object.entries(phases).map(([name,duration])=>`media_${name.replace(/Ms$/,'')};dur=${duration.toFixed(2)}`).join(', '))
    if(!image)return reply.code(304).send()
    return reply.type(image.mimeType).send(image.bytes)
  }))

  app.get<{ Params: { publicId: string } }>('/public/media-assets/:publicId', async (request, reply) => {
    const publicId = assetPublicId(request.params.publicId)
    const value = await options.transactions.run(options.resolveScope(), (transaction) => (
      new MediaAssetRepository(transaction).publicBytes(publicId)
    ), { readOnly: true })
    if (value === null) return reply.code(404).send({ error: { code: 'MEDIA_ASSET_NOT_PUBLIC', message: '图片不存在或尚未发布' } })
    // Authorization/publication lookup above always precedes cached conversion.
    const query = request.query as { variant?: string }
    const image = query.variant === 'menu320' ? await thumbnail(value) : value
    reply.header('cache-control', query.variant === 'menu320' && image === value
      ? 'public, max-age=60' : 'public, max-age=31536000, immutable')
    reply.header('etag', `"${image.sha256}"`)
    if (request.headers['if-none-match'] === `"${image.sha256}"`) return reply.code(304).send()
    return reply.type(image.mimeType).send(image.bytes)
  })
}

async function authorized(options: MediaAssetApiOptions, request: FastifyRequest, permission: string) {
  const context = await options.resolveStaffContext(request)
  await options.transactions.run(context.scope, async (transaction) => {
    const access = options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction)
    await access.assertPermission(context.employeeId, permission)
  }, { readOnly: true })
  return context
}

async function authorizedAny(options: MediaAssetApiOptions, request: FastifyRequest, permissions: readonly string[]) {
  const context = await options.resolveStaffContext(request)
  await options.transactions.run(context.scope, transaction=>assertAnyMediaPermission(options,transaction,context.employeeId,permissions), { readOnly: true })
  return context
}

async function assertAnyMediaPermission(options:MediaAssetApiOptions,transaction:ScopedTransaction,employeeId:string,permissions:readonly string[]){
    const access = options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction)
    let denied: unknown = new StaffAccessDeniedError('当前岗位没有图片读取权限')
    for (const permission of permissions) {
      try { await access.assertPermission(employeeId, permission); return }
      catch (error) { if (!(error instanceof StaffAccessDeniedError)) throw error; denied = error }
    }
    throw denied
}

async function handle(reply: FastifyReply, execute: () => Promise<unknown>) { try { return await execute() } catch (error) {
  if (isStaffAuthenticationRequiredError(error)) return reply.code(401).send({ error: STAFF_AUTHENTICATION_REQUIRED_ERROR })
  if (error instanceof InputError) return reply.code(400).send({ error: { code: 'MEDIA_ASSET_INPUT_INVALID', message: error.message } })
  if (error instanceof StaffAccessDeniedError) return reply.code(403).send({ error: { code: 'STAFF_ACCESS_DENIED', message: '没有管理图片素材的权限' } })
  if (error instanceof IdempotencyConflictError || error instanceof OutboxMessageConflictError) return reply.code(409).send({ error: { code: 'IDEMPOTENCY_CONFLICT', message: '重复图片请求内容不一致' } })
  if (error instanceof IdempotencyInProgressError) return reply.code(425).send({ error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: '图片上传正在处理中' } })
  if (error instanceof IdempotencyRecordError) return reply.code(503).send({ error: { code: 'IDEMPOTENCY_UNAVAILABLE', message: '图片上传结果暂时无法确认' } })
  throw error
} }

class InputError extends Error {}
function invalid(message: string): never { throw new InputError(message) }
function object(value: unknown): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('请求格式不正确'); return value as Record<string, unknown> }
function text(value: unknown, label: string, min: number, max: number) { if (typeof value !== 'string') invalid(`${label}格式不正确`); const result = value.trim(); if (result.length < min || result.length > max) invalid(`${label}长度不正确`); return result }
function enumeration<const Values extends readonly string[]>(value: unknown, label: string, values: Values): Values[number] { if (typeof value !== 'string' || !values.includes(value)) invalid(`${label}不支持`); return value as Values[number] }
function fileName(value: unknown) { const result = text(value, '文件名', 1, 180); if (/[/\\\u0000-\u001f]/.test(result)) invalid('文件名不合法'); return result }
function key(request: FastifyRequest) { const raw = request.headers['idempotency-key']; if (Array.isArray(raw)) invalid('Idempotency-Key格式不正确'); const result = text(raw, 'Idempotency-Key', 8, 128); if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(result)) invalid('Idempotency-Key格式不正确'); return result }
function assetPublicId(value: unknown) { const result = text(value, '图片编号', 34, 34); if (!/^MA[0-9A-F]{32}$/.test(result)) invalid('图片编号格式不正确'); return result }
function decodeBase64(value: unknown) { const textValue = text(value, '图片内容', 4, MAX_IMAGE_BASE64_LENGTH); if (!/^[A-Za-z0-9+/]+={0,2}$/.test(textValue) || textValue.length % 4 !== 0) invalid('图片内容不是有效Base64'); const bytes = Buffer.from(textValue, 'base64'); if (bytes.length === 0 || bytes.toString('base64') !== textValue) invalid('图片内容不是有效Base64'); return bytes }
function matchesSignature(bytes: Buffer, mimeType: MediaAssetView['mimeType']) { return (mimeType === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
  || (mimeType === 'image/png' && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
  || (mimeType === 'image/webp' && bytes.length >= 12 && bytes.subarray(0,4).toString('ascii') === 'RIFF' && bytes.subarray(8,12).toString('ascii') === 'WEBP') }
