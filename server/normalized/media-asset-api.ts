import { createHash } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { ActivityOperationsStaffContext } from './activity-operations-service.js'
import { IdempotencyConflictError, IdempotencyInProgressError, IdempotencyRecordError } from './command-executor.js'
import { MediaAssetRepository, type MediaAssetView, type MediaPurpose } from './media-asset-repository.js'
import { MediaAssetService } from './media-asset-service.js'
import { OutboxMessageConflictError } from './command-executor.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

const MAX_IMAGE_BYTES = 200 * 1024
const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4
// Base64 and the JSON envelope are larger than the source image. This is a
// transport allowance only; the decoded image remains limited to 200 KiB.
const MEDIA_UPLOAD_BODY_LIMIT_BYTES = 300_000

export interface MediaAssetApiOptions {
  transactions: Pick<ScopedPostgresTransactionRunner,'run'>
  service: MediaAssetService
  resolveStaffContext(request: FastifyRequest): ActivityOperationsStaffContext | Promise<ActivityOperationsStaffContext>
  resolveScope(): Readonly<StoreScope>
  createStaffAccessRepository?(transaction: ScopedTransaction): Pick<StaffAccessRepository,'assertPermission'>
}

export const mediaAssetApiPlugin: FastifyPluginAsync<MediaAssetApiOptions> = async (app, options) => {
  app.get('/staff/media-assets', async (request, reply) => handle(reply, async () => {
    const context = await authorized(options, request, 'community.activity.view')
    return reply.send({ data: await options.service.list(context) })
  }))

  app.post('/staff/media-assets', { bodyLimit: MEDIA_UPLOAD_BODY_LIMIT_BYTES }, async (request, reply) => handle(reply, async () => {
    const context = await authorized(options, request, 'community.activity.manage')
    const body = object(request.body)
    const mimeType = enumeration(body.mimeType, '图片格式', ['image/jpeg','image/png','image/webp'] as const)
    const bytes = decodeBase64(body.base64)
    if (bytes.length > MAX_IMAGE_BYTES) throw invalid('图片压缩后不能超过 200KB')
    if (!matchesSignature(bytes, mimeType)) throw invalid('图片内容与声明格式不一致')
    const result = await options.service.upload(context, {
      purpose: enumeration(body.purpose, '图片用途', ['community_activity','home_content','menu','performer','support_contact'] as const) as MediaPurpose,
      originalFileName: fileName(body.fileName), mimeType, bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'), idempotencyKey: key(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.get<{ Params: { publicId: string } }>('/staff/media-assets/:publicId', async (request, reply) => handle(reply, async () => {
    const context = await authorized(options, request, 'community.activity.view')
    const value = await options.transactions.run(context.scope, (transaction) => (
      new MediaAssetRepository(transaction).staffBytes(assetPublicId(request.params.publicId))
    ), { readOnly: true })
    if (value === null) return reply.code(404).send({ error: { code: 'MEDIA_ASSET_NOT_FOUND', message: '图片不存在' } })
    reply.header('cache-control', 'private, no-store')
    reply.header('pragma', 'no-cache')
    return reply.type(value.mimeType).send(value.bytes)
  }))

  app.get<{ Params: { publicId: string } }>('/public/media-assets/:publicId', async (request, reply) => {
    const publicId = assetPublicId(request.params.publicId)
    const value = await options.transactions.run(options.resolveScope(), (transaction) => (
      new MediaAssetRepository(transaction).publicBytes(publicId)
    ), { readOnly: true })
    if (value === null) return reply.code(404).send({ error: { code: 'MEDIA_ASSET_NOT_PUBLIC', message: '图片不存在或尚未发布' } })
    reply.header('cache-control', 'public, max-age=31536000, immutable')
    reply.header('etag', `"${value.sha256}"`)
    return reply.type(value.mimeType).send(value.bytes)
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

async function handle(reply: FastifyReply, execute: () => Promise<unknown>) { try { return await execute() } catch (error) {
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
