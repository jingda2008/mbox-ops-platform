import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { ConfigVersionRecord } from '../src/shared/config-versioning-contracts.js'
import { createSeedState } from './seed.js'
import { migrateRuntimeState } from './runtime-state-migrations.js'

export interface RuntimeRepositoryHealth {
  ready: boolean
  repository: string
  revision: number | null
}

export interface RuntimeRepository {
  init(): Promise<void>
  read(): Promise<RuntimeState>
  mutate<T>(mutation: (state: RuntimeState) => T | Promise<T>, options?: unknown): Promise<T>
  reset(): Promise<RuntimeState>
  healthCheck(): Promise<RuntimeRepositoryHealth>
  close(): Promise<void>
}

function migrateConfigVersions(loaded: RuntimeState, seed: RuntimeState): ConfigVersionRecord[] {
  const config = loaded.config ?? seed.config
  const existing = loaded.configVersions
  if (existing?.length) {
    const repairableBaseline = existing.length === 1 && existing[0]?.operation === 'baseline' &&
      ['system-seed', 'system-migration'].includes(existing[0].actorId) && existing[0].version === config.version
    if (!repairableBaseline || JSON.stringify(existing[0]?.snapshot) === JSON.stringify(config)) return existing
  }
  return [{
    id: `config_version_${loaded.store?.id ?? seed.store.id}_${config.version}`,
    storeId: loaded.store?.id ?? seed.store.id,
    version: config.version,
    operation: 'baseline',
    sourceVersion: null,
    rollbackTargetVersion: null,
    snapshot: structuredClone(config),
    actorId: 'system-migration',
    reason: '存量配置迁移基线',
    idempotencyKey: `migrate-config-baseline-${config.version}`,
    createdAt: config.publishedAt ?? seed.config.publishedAt!,
  }]
}

export class JsonRepository {
  private state: RuntimeState = createSeedState()
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      const loaded = JSON.parse(await readFile(this.filePath, 'utf8')) as RuntimeState
      const seed = createSeedState()
      this.state = migrateRuntimeState({
        ...seed,
        ...loaded,
        employees: (loaded.employees ?? seed.employees).map((employee) => ({
          ...employee,
          status: employee.status ?? 'active',
        })),
        shiftAssignments: loaded.shiftAssignments ?? seed.shiftAssignments,
        products: loaded.products ?? seed.products,
        orderDomain: loaded.orderDomain ?? seed.orderDomain,
        paymentDomain: loaded.paymentDomain ?? seed.paymentDomain,
        awaitingOrderIntents: loaded.awaitingOrderIntents ?? seed.awaitingOrderIntents,
        sopExecutions: loaded.sopExecutions ?? seed.sopExecutions,
        sopActionRecords: loaded.sopActionRecords ?? seed.sopActionRecords,
        members: loaded.members ?? seed.members,
        benefitTemplates: loaded.benefitTemplates ?? seed.benefitTemplates,
        benefitGrantPolicies: loaded.benefitGrantPolicies ?? seed.benefitGrantPolicies,
        benefitGrantRequests: loaded.benefitGrantRequests ?? seed.benefitGrantRequests,
        memberBenefits: loaded.memberBenefits ?? seed.memberBenefits,
        benefitRedemptions: loaded.benefitRedemptions ?? seed.benefitRedemptions,
        benefitCampaigns: loaded.benefitCampaigns ?? seed.benefitCampaigns,
        customerNotifications: (loaded.customerNotifications ?? seed.customerNotifications).map((notification) => ({
          ...notification,
          attemptCount: notification.attemptCount ?? 0,
          lastAttemptAt: notification.lastAttemptAt ?? null,
          nextAttemptAt: notification.nextAttemptAt ?? (notification.status === 'queued' ? notification.queuedAt : null),
          providerMessageId: notification.providerMessageId ?? null,
          lastErrorCode: notification.lastErrorCode ?? null,
        })),
        songState: loaded.songState ?? seed.songState,
        tasks: (loaded.tasks ?? seed.tasks).map((task) => ({ ...task, triggerId: task.triggerId ?? null })),
        config: {
          ...(loaded.config ?? seed.config),
          proactiveOrderCare: loaded.config?.proactiveOrderCare ?? seed.config.proactiveOrderCare,
          guestServiceLimits: loaded.config?.guestServiceLimits ?? seed.config.guestServiceLimits,
          communityBrand: loaded.config?.communityBrand ?? seed.config.communityBrand,
          sopRules: loaded.config?.sopRules ?? seed.config.sopRules,
        },
        configVersions: migrateConfigVersions(loaded, seed),
        draftConfig: loaded.draftConfig
          ? {
              ...loaded.draftConfig,
              proactiveOrderCare: loaded.draftConfig.proactiveOrderCare ?? seed.config.proactiveOrderCare,
              guestServiceLimits: loaded.draftConfig.guestServiceLimits ?? seed.config.guestServiceLimits,
              communityBrand: loaded.draftConfig.communityBrand ?? seed.config.communityBrand,
              sopRules: loaded.draftConfig.sopRules ?? seed.config.sopRules,
            }
          : null,
      })
      await this.persist(this.state)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.persist(this.state)
    }
  }

  async read() {
    await this.queue
    return structuredClone(this.state)
  }

  async mutate<T>(mutation: (state: RuntimeState) => T | Promise<T>): Promise<T> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      const workingCopy = structuredClone(this.state)
      const previousRevision = this.state.revision
      const result = await mutation(workingCopy)
      if (workingCopy.revision !== previousRevision) {
        await this.persist(workingCopy)
        this.state = workingCopy
      }
      return result
    })
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  async reset() {
    return this.mutate((state) => {
      const nextRevision = state.revision + 1
      const next = createSeedState()
      next.revision = nextRevision
      Object.assign(state, next)
      return state
    })
  }

  async healthCheck(): Promise<RuntimeRepositoryHealth> {
    await this.queue
    return { ready: true, repository: 'json', revision: this.state.revision }
  }

  async close() {
    await this.queue
  }

  private async persist(state: RuntimeState) {
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.filePath)
  }
}
