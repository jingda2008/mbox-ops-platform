import { describe, expect, it } from 'vitest'
import { BusinessRuleError } from './business-rule-error.js'
import { isClientDisconnect, isPersistenceFailure } from './error-classification.js'
import { PostgresMutationQueueFullError, PostgresMutationQueueTimeoutError } from './postgres-repository.js'

describe('runtime error classification', () => {
  it('classifies pool exhaustion and repository backpressure as temporary persistence failures', () => {
    expect(isPersistenceFailure(new Error('timeout exceeded when trying to connect'))).toBe(true)
    expect(isPersistenceFailure(Object.assign(new Error('remaining connection slots are reserved'), { code: '53300' }))).toBe(true)
    expect(isPersistenceFailure(new PostgresMutationQueueFullError(100))).toBe(true)
    expect(isPersistenceFailure(new PostgresMutationQueueTimeoutError(15_001))).toBe(true)
  })

  it('keeps business rejections and client disconnects out of the persistence outage class', () => {
    expect(isPersistenceFailure(new BusinessRuleError('请先开台', 'TABLE_NOT_OPEN'))).toBe(false)
    expect(isPersistenceFailure(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe(false)
    expect(isPersistenceFailure(Object.assign(new Error('check constraint'), { code: '23514' }))).toBe(false)
    const disconnect = Object.assign(new Error('premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })
    expect(isClientDisconnect(disconnect)).toBe(true)
    expect(isPersistenceFailure(disconnect)).toBe(false)
  })


  it('classifies retryable PostgreSQL connection and transaction failures', () => {
    expect(isPersistenceFailure(Object.assign(new Error('connection failure'), { code: '08006' }))).toBe(true)
    expect(isPersistenceFailure(Object.assign(new Error('serialization failure'), { code: '40001' }))).toBe(true)
    expect(isPersistenceFailure(Object.assign(new Error('deadlock detected'), { code: '40P01' }))).toBe(true)
  })
})
