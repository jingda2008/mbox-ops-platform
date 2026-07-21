import { describe, expect, it } from 'vitest'
import { applyStaffViewport, STAFF_VIEWPORT_CONTENT } from './staff-viewport.js'

function documentStub(initialContent = 'width=device-width, initial-scale=1.0') {
  let content: string | null = initialContent
  const classes = new Set<string>()
  const meta = {
    getAttribute: () => content,
    setAttribute: (_name: string, value: string) => { content = value },
    removeAttribute: () => { content = null },
  }
  const doc = {
    querySelector: () => meta,
    documentElement: {
      classList: {
        add: (...tokens: string[]) => tokens.forEach((token) => classes.add(token)),
        remove: (...tokens: string[]) => tokens.forEach((token) => classes.delete(token)),
        toggle: (token: string, force: boolean) => force ? (classes.add(token), true) : (classes.delete(token), false),
      },
    },
  } as unknown as Document
  return { doc, classes, content: () => content }
}

describe('staff viewport', () => {
  it('locks phone staff pages to the device width and restores public-page zoom', () => {
    const stub = documentStub()
    const restore = applyStaffViewport(stub.doc, { width: 430, height: 932 })

    expect(stub.content()).toBe(STAFF_VIEWPORT_CONTENT)
    expect(stub.classes).toEqual(new Set(['staff-viewport', 'staff-phone-device']))

    restore()
    expect(stub.content()).toBe('width=device-width, initial-scale=1.0')
    expect(stub.classes.size).toBe(0)
  })

  it('does not apply the phone navigation fallback to desktop staff pages', () => {
    const stub = documentStub()
    const restore = applyStaffViewport(stub.doc, { width: 1440, height: 900 })

    expect(stub.classes.has('staff-viewport')).toBe(true)
    expect(stub.classes.has('staff-phone-device')).toBe(false)
    restore()
  })
})
