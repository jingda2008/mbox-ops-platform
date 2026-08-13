import { describe, expect, it } from 'vitest'
import { readPersistedCart } from './menu-cart-storage'

describe('guest cart recovery', () => {
  it('restores only valid quantities after a failed or interrupted submission', () => {
    const storage = fixedStorage(JSON.stringify({ beer: 2, food: 1, invalid: -1, huge: 1_000 }))
    expect(readPersistedCart('guest-cart', storage)).toEqual({ beer: 2, food: 1 })
  })

  it('fails open with an empty cart when browser storage is malformed', () => {
    expect(readPersistedCart('guest-cart', fixedStorage('{broken'))).toEqual({})
  })
})

function fixedStorage(value: string): Pick<Storage, 'getItem'> {
  return { getItem: () => value }
}
