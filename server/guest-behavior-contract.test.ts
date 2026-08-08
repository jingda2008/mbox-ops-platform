import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { guestBehaviorEventTypes } from '../src/shared/guest-insight-contracts.js'

describe('guest behavior database contract', () => {
  it('keeps every accepted application event in the latest database check constraint', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'database/migrations/022_guest_behavior_event_contract_alignment.sql'),
      'utf8',
    )
    const constrained = [...sql.matchAll(/'([a-z][a-z0-9_]*)'/g)].map((match) => match[1])

    expect(new Set(constrained)).toEqual(new Set(guestBehaviorEventTypes))
    expect(constrained).toHaveLength(guestBehaviorEventTypes.length)
  })
})
