import { OperationalReadStoreError } from './operational-read-store.js'
import { PostgresRepositoryError } from './postgres-repository.js'

const persistenceCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '40001',
  '40P01',
  '55P03',
])

const persistenceCodePrefixes = ['08', '53', '57', '58']

const persistenceMessages = [
  /timeout exceeded when trying to connect/i,
  /connection terminated unexpectedly/i,
  /connection.*closed/i,
  /remaining connection slots are reserved/i,
  /too many clients/i,
]

export function isPersistenceFailure(error: unknown) {
  if (error instanceof PostgresRepositoryError || error instanceof OperationalReadStoreError) return true
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; message?: unknown }
  const code = String(candidate.code ?? '')
  if (persistenceCodes.has(code) || persistenceCodePrefixes.some((prefix) => code.startsWith(prefix))) return true
  const message = String(candidate.message ?? '')
  return persistenceMessages.some((pattern) => pattern.test(message))
}

export function isClientDisconnect(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; message?: unknown }
  return candidate.code === 'ERR_STREAM_PREMATURE_CLOSE'
    || /premature close/i.test(String(candidate.message ?? ''))
}
