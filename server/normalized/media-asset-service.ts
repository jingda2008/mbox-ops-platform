import { createHash, randomUUID } from 'node:crypto'
import type { AuditEvent, JsonCodec, JsonValue, NormalizedCommandExecutor } from './command-executor.js'
import { MediaAssetRepository, type MediaAssetView } from './media-asset-repository.js'
import type { ActivityOperationsStaffContext } from './activity-operations-service.js'
import type { ScopedPostgresTransactionRunner } from './transaction-runner.js'

export class MediaAssetService {
  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner,'run'>,
    private readonly commands: NormalizedCommandExecutor,
  ) {}

  list(context: ActivityOperationsStaffContext) {
    return this.transactions.run(context.scope, (transaction) => new MediaAssetRepository(transaction).list(), { readOnly: true })
  }

  upload(context: ActivityOperationsStaffContext, input: Readonly<{
    purpose: MediaAssetView['purpose']; originalFileName: string; mimeType: MediaAssetView['mimeType'];
    bytes: Buffer; sha256: string; idempotencyKey: string
  }>) {
    return this.commands.execute({
      scope: context.scope, operationScope: 'media.asset.upload', idempotencyKey: input.idempotencyKey,
      requestFingerprint: createHash('sha256').update(`${input.purpose}:${input.sha256}`).digest('hex'), resultCodec: codec(),
    }, async (transaction) => {
      const created = await new MediaAssetRepository(transaction).create({
        ...input, publicId: `MA${randomUUID().replaceAll('-','').toUpperCase()}`, employeeId: context.employeeId,
      })
      const audit: AuditEvent = {
        actor: { type: 'employee', employeeId: context.employeeId }, businessDate: context.businessDate,
        action: created.replayed ? 'media.asset.reused' : 'media.asset.uploaded', objectType: 'media_asset',
        objectId: created.asset.publicId, reason: `上传${input.purpose}图片`,
        afterData: { purpose: created.asset.purpose, mimeType: created.asset.mimeType, byteLength: created.asset.byteLength, sha256: created.asset.sha256 },
      }
      return { result: created.asset, auditEvents: [audit], outboxMessages: [] }
    })
  }
}

function codec(): JsonCodec<MediaAssetView> { return {
  encode: (value) => value as unknown as JsonValue,
  decode: (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('图片上传重放结果无效')
    return value as MediaAssetView
  },
} }
