import type {
  AuditActor,
  CommandExecution,
  JsonCodec,
  JsonObject,
  JsonValue,
} from './command-executor.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import {
  PerformerRepository,
  type CreatePerformerInput,
  type Performer,
  type UpdatePerformerInput,
} from './performer-repository.js'
import {
  PerformerSongRepository,
  type PerformerSong,
  type PerformerSongImportResult,
  type PerformerSongInput,
} from './performer-song-repository.js'
import {
  ScheduleRepository,
  type CreateScheduleInput,
  type PerformanceSchedule,
  type ScheduleStatus,
  type UpdateScheduleInput,
} from './schedule-repository.js'
import {
  SongRequestRepository,
  type ConfirmSongRequestInput,
  type MarkSongRequestPaidInput,
  type SongRequest,
  type SongRequestSubmission,
  type SubmitSongRequestInput,
} from './song-request-repository.js'
import type { StoreScope } from './transaction-runner.js'

interface CommandMetadata {
  scope: Readonly<StoreScope>
  actor: AuditActor
  businessDate: string
  idempotencyKey: string
  requestFingerprint: string
}

export interface CreatePerformerCommand extends CreatePerformerInput, CommandMetadata {}
export interface UpdatePerformerCommand extends UpdatePerformerInput, CommandMetadata {}
export interface ImportPerformerSongsCommand extends CommandMetadata {
  performerId: string
  sourceName: string
  mode: 'upsert' | 'replace'
  songs: readonly PerformerSongInput[]
}
export interface UpdatePerformerSongCommand extends CommandMetadata {
  songId: string
  changes: Partial<PerformerSongInput>
}
export interface CreateScheduleCommand extends CreateScheduleInput, CommandMetadata {}
export interface UpdateScheduleCommand extends UpdateScheduleInput, CommandMetadata {}

export interface ScheduleTransitionCommand extends CommandMetadata {
  scheduleId: string
  targetStatus: Extract<ScheduleStatus, 'performing' | 'completed' | 'cancelled'>
}

export interface SubmitSongRequestCommand extends SubmitSongRequestInput, CommandMetadata {}
export interface ConfirmSongRequestCommand extends ConfirmSongRequestInput, CommandMetadata {}
export interface MarkSongRequestPaidCommand extends MarkSongRequestPaidInput, CommandMetadata {}

export interface SongRequestTransitionCommand extends CommandMetadata {
  requestId: string
  actorEmployeeId?: string
}

export class PerformanceCommandService {
  constructor(private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>) {}

  createPerformer(input: Readonly<CreatePerformerCommand>): Promise<CommandExecution<Performer>> {
    return this.commands.execute(command(input, 'performer.create', performerCodec), async (transaction) => {
      const performer = await new PerformerRepository(transaction).create(input)
      return outcome(
        performer,
        input.actor,
        input.businessDate,
        input.idempotencyKey,
        'performer.created',
        'performer',
        performer.id,
        { code: performer.code, stageName: performer.stageName, status: performer.status },
      )
    })
  }

  updatePerformer(input: Readonly<UpdatePerformerCommand>): Promise<CommandExecution<Performer>> {
    return this.commands.execute(command(input, 'performer.update', performerCodec), async (transaction) => {
      const repository = new PerformerRepository(transaction)
      const before = await repository.findById(input.performerId)
      const performer = await repository.update(input)
      return outcome(
        performer,
        input.actor,
        input.businessDate,
        input.idempotencyKey,
        'performer.updated',
        'performer',
        performer.id,
        { stageName: performer.stageName, status: performer.status, songCount: performer.songCatalog.length },
        before === null ? null : { stageName: before.stageName, status: before.status, songCount: before.songCatalog.length },
      )
    })
  }

  importPerformerSongs(
    input: Readonly<ImportPerformerSongsCommand>,
  ): Promise<CommandExecution<PerformerSongImportResult>> {
    return this.commands.execute(command(input, 'performer-song.import', songImportCodec), async (transaction) => {
      const result = await new PerformerSongRepository(transaction).import({
        performerId: input.performerId,
        employeeId: input.actor.type === 'employee' ? input.actor.employeeId : null,
        sourceName: input.sourceName,
        mode: input.mode,
        songs: input.songs,
      })
      return outcome(
        result,
        input.actor,
        input.businessDate,
        input.idempotencyKey,
        'performer_song.imported',
        'performer_song_import_batch',
        result.batchId,
        {
          performerId: result.performerId,
          mode: result.mode,
          rowCount: result.rowCount,
          importedCount: result.importedCount,
          rejectedCount: result.rejectedCount,
          sourceSha256: result.sourceSha256,
        },
      )
    })
  }

  updatePerformerSong(
    input: Readonly<UpdatePerformerSongCommand>,
  ): Promise<CommandExecution<PerformerSong>> {
    return this.commands.execute(command(input, 'performer-song.update', performerSongCodec), async (transaction) => {
      const repository = new PerformerSongRepository(transaction)
      const before = await repository.findById(input.songId, true)
      const song = await repository.update(input.songId, input.changes)
      return outcome(
        song,
        input.actor,
        input.businessDate,
        input.idempotencyKey,
        'performer_song.updated',
        'performer_song',
        song.id,
        performerSongAuditData(song),
        before === null ? null : performerSongAuditData(before),
      )
    })
  }

  createSchedule(input: Readonly<CreateScheduleCommand>): Promise<CommandExecution<PerformanceSchedule>> {
    return this.commands.execute(command(input, 'performance-schedule.create', scheduleCodec), async (transaction) => {
      const schedule = await new ScheduleRepository(transaction).create(input)
      return outcome(
        schedule,
        input.actor,
        input.businessDate,
        input.idempotencyKey,
        'performance_schedule.created',
        'performance_schedule',
        schedule.id,
        scheduleAuditData(schedule),
      )
    })
  }

  updateSchedule(input: Readonly<UpdateScheduleCommand>): Promise<CommandExecution<PerformanceSchedule>> {
    return this.commands.execute(command(input, 'performance-schedule.update', scheduleCodec), async (transaction) => {
      const repository = new ScheduleRepository(transaction)
      const before = await repository.findById(input.scheduleId)
      const schedule = await repository.update(input)
      return outcome(
        schedule,
        input.actor,
        input.businessDate,
        input.idempotencyKey,
        'performance_schedule.updated',
        'performance_schedule',
        schedule.id,
        scheduleAuditData(schedule),
        before === null ? null : scheduleAuditData(before),
      )
    })
  }

  transitionSchedule(
    input: Readonly<ScheduleTransitionCommand>,
  ): Promise<CommandExecution<PerformanceSchedule>> {
    return this.commands.execute(command(input, `performance-schedule.${input.targetStatus}`, scheduleCodec), async (transaction) => {
      const repository = new ScheduleRepository(transaction)
      const before = await repository.findById(input.scheduleId)
      const schedule = input.targetStatus === 'performing'
        ? await repository.start(input.scheduleId)
        : input.targetStatus === 'completed'
          ? await repository.complete(input.scheduleId)
          : await repository.cancel(input.scheduleId)
      return outcome(
        schedule,
        input.actor,
        input.businessDate,
        input.idempotencyKey,
        `performance_schedule.${input.targetStatus}`,
        'performance_schedule',
        schedule.id,
        scheduleAuditData(schedule),
        before === null ? null : scheduleAuditData(before),
      )
    })
  }

  submitSongRequest(
    input: Readonly<SubmitSongRequestCommand>,
  ): Promise<CommandExecution<SongRequestSubmission>> {
    return this.commands.execute(command(input, 'song-request.submit', submissionCodec), async (transaction) => {
      const submission = await new SongRequestRepository(transaction).submit(input)
      const request = submission.request
      const afterData: JsonObject = {
        status: request.status,
        requestType: request.requestType,
        scheduleId: request.scheduleId,
        performerId: request.performerId,
        slot: submission.slot,
        extensionRequested: submission.extensionRequested,
        requiresStaffConfirmation: true,
      }
      const event = submission.extensionRequested
        ? 'song_request.extension_requested'
        : request.requestType === 'custom'
          ? 'song_request.custom_requested'
          : 'song_request.requested'
      return outcome(
        submission,
        input.actor,
        input.businessDate,
        input.idempotencyKey,
        event,
        'song_request',
        request.id,
        afterData,
      )
    })
  }

  confirmSongRequest(
    input: Readonly<ConfirmSongRequestCommand>,
  ): Promise<CommandExecution<SongRequest>> {
    ensureEmployeeActor(input.actor, input.actorEmployeeId)
    return this.commands.execute(command(input, 'song-request.confirm', songRequestCodec), async (transaction) => {
      const repository = new SongRequestRepository(transaction)
      const before = await repository.findById(input.requestId)
      const mutation = await repository.confirmWithResult(input)
      if (!mutation.changed) {
        return { result: mutation.request, auditEvents: [], outboxMessages: [] }
      }
      return outcome(
        mutation.request,
        input.actor,
        input.businessDate,
        input.idempotencyKey,
        'song_request.accepted',
        'song_request',
        mutation.request.id,
        songRequestAuditData(mutation.request),
        before === null ? null : songRequestAuditData(before),
      )
    })
  }

  rejectSongRequest(
    input: Readonly<SongRequestTransitionCommand>,
  ): Promise<CommandExecution<SongRequest>> {
    const employeeId = requireEmployee(input)
    return this.songCommand(input, 'song-request.reject', 'song_request.rejected', async (repository) => (
      repository.reject(input.requestId, employeeId)
    ))
  }

  markSongRequestPaid(
    input: Readonly<MarkSongRequestPaidCommand>,
  ): Promise<CommandExecution<SongRequest>> {
    ensureEmployeeActor(input.actor, input.actorEmployeeId)
    return this.songCommand(input, 'song-request.paid', 'song_request.paid', async (repository) => (
      repository.markPaid(input)
    ))
  }

  markSongRequestPerformed(
    input: Readonly<SongRequestTransitionCommand>,
  ): Promise<CommandExecution<SongRequest>> {
    const employeeId = requireEmployee(input)
    return this.songCommand(input, 'song-request.performed', 'song_request.performed', async (repository) => (
      repository.markPerformed(input.requestId, employeeId)
    ))
  }

  cancelSongRequest(
    input: Readonly<SongRequestTransitionCommand>,
  ): Promise<CommandExecution<SongRequest>> {
    return this.songCommand(input, 'song-request.cancel', 'song_request.cancelled', async (repository) => (
      repository.cancel(input.requestId)
    ))
  }

  private songCommand(
    input: Readonly<SongRequestTransitionCommand>,
    operationScope: string,
    eventType: string,
    change: (repository: SongRequestRepository) => Promise<SongRequest>,
  ): Promise<CommandExecution<SongRequest>> {
    return this.commands.execute(command(input, operationScope, songRequestCodec), async (transaction) => {
      const repository = new SongRequestRepository(transaction)
      const before = await repository.findById(input.requestId)
      const request = await change(repository)
      return outcome(
        request,
        input.actor,
        input.businessDate,
        input.idempotencyKey,
        eventType,
        'song_request',
        request.id,
        songRequestAuditData(request),
        before === null ? null : songRequestAuditData(before),
      )
    })
  }
}

function command<Result>(
  input: Readonly<CommandMetadata>,
  operationScope: string,
  resultCodec: JsonCodec<Result>,
) {
  return {
    scope: input.scope,
    operationScope,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: input.requestFingerprint,
    resultCodec,
  }
}

function outcome<Result>(
  result: Result,
  actor: AuditActor,
  businessDate: string,
  messageKey: string,
  eventType: string,
  objectType: string,
  objectId: string,
  afterData: JsonObject,
  beforeData: JsonObject | null = null,
) {
  return {
    result,
    auditEvents: [{
      actor,
      action: eventType,
      objectType,
      objectId,
      businessDate,
      beforeData,
      afterData,
    }],
    outboxMessages: [{
      eventId: `performance:${eventType}:${messageKey}`,
      aggregateType: objectType,
      aggregateId: objectId,
      aggregateVersion: 1,
      eventType: `${eventType}.v1`,
      payload: afterData,
    }],
  }
}

function scheduleAuditData(schedule: PerformanceSchedule): JsonObject {
  return {
    performerId: schedule.performerId,
    startsAt: schedule.startsAt,
    endsAt: schedule.endsAt,
    status: schedule.status,
    sortOrder: schedule.sortOrder,
  }
}

function songRequestAuditData(request: SongRequest): JsonObject {
  return {
    tableSessionId: request.tableSessionId,
    performerId: request.performerId,
    scheduleId: request.scheduleId,
    requestType: request.requestType,
    status: request.status,
    quotedAmountMinor: request.quotedAmountMinor,
    currency: request.currency,
  }
}

function performerSongAuditData(song: PerformerSong): JsonObject {
  return {
    performerId: song.performerId,
    code: song.code,
    title: song.title,
    aliases: song.aliases,
    status: song.status,
  }
}

function ensureEmployeeActor(actor: AuditActor, employeeId: string): void {
  if (actor.type !== 'employee' || actor.employeeId !== employeeId) {
    throw new TypeError('Song request employee action must use the authenticated employee actor')
  }
}

function requireEmployee(input: Readonly<SongRequestTransitionCommand>): string {
  if (input.actorEmployeeId === undefined) {
    if (input.actor.type !== 'employee') throw new TypeError('This song request action requires an employee')
    return input.actor.employeeId
  }
  ensureEmployeeActor(input.actor, input.actorEmployeeId)
  return input.actorEmployeeId
}

function jsonCodec<Result>(): JsonCodec<Result> {
  return {
    encode(value): JsonValue {
      return JSON.parse(JSON.stringify(value)) as JsonValue
    },
    decode(value): Result {
      if (typeof value !== 'object' || value === null) throw new TypeError('Stored command result is invalid')
      return value as Result
    },
  }
}

const performerCodec = jsonCodec<Performer>()
const performerSongCodec = jsonCodec<PerformerSong>()
const songImportCodec = jsonCodec<PerformerSongImportResult>()
const scheduleCodec = jsonCodec<PerformanceSchedule>()
const songRequestCodec = jsonCodec<SongRequest>()
const submissionCodec = jsonCodec<SongRequestSubmission>()
