import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useRef, useState } from 'react'
import { CustomerPaymentCodeScanner, CUSTOMER_PAYMENT_CODE } from '../components/CustomerPaymentCodeScanner'

const decoder = vi.hoisted(() => ({ decode: vi.fn(), stop: vi.fn() }))
vi.mock('@zxing/browser', () => ({ BrowserMultiFormatReader: class {
  decodeFromStream(...args: unknown[]) { return decoder.decode(...args) }
} }))
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(), useEffect: vi.fn(), useRef: vi.fn(), useState: vi.fn(),
}))

describe('customer payment camera lifecycle', () => {
  const stop = vi.fn()
  const stream = { getTracks: () => [{ stop }] }
  const video = { srcObject: null, play: vi.fn().mockResolvedValue(undefined) }
  const media = vi.fn()
  const setState = vi.fn()
  let dispose: (() => void) | undefined
  const mount = () => {
    CustomerPaymentCodeScanner({tableCode:'W01',amountLabel:'¥40.00',onClose:vi.fn(),onConfirm:vi.fn()})
    dispose = vi.mocked(useEffect).mock.calls[0]![0]() as () => void
  }
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useRef).mockImplementation((value) => ({current: value === null ? video : value}))
    vi.mocked(useState).mockImplementation((value) => [value, setState] as never)
    media.mockResolvedValue(stream)
    decoder.decode.mockResolvedValue({stop:decoder.stop})
    vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:media}})
    vi.stubGlobal('window',{setTimeout,clearTimeout})
  })
  afterEach(() => { dispose?.(); dispose = undefined; vi.unstubAllGlobals() })

  it('uses local fallback when native detection is absent', async () => {
    mount()
    await vi.waitFor(() => expect(decoder.decode).toHaveBeenCalledOnce())
    const callback = decoder.decode.mock.calls[0]![2] as (result: {getText():string}) => void
    callback({getText:()=> '101234567890123456'})
    expect(setState).toHaveBeenCalledWith('101234567890123456')
    expect(stop).toHaveBeenCalled()
  })
  it('falls back from a QR-only native detector', async () => {
    Object.assign(window, {BarcodeDetector: class { static async getSupportedFormats() { return ['qr_code'] } }})
    mount()
    await vi.waitFor(() => expect(decoder.decode).toHaveBeenCalledOnce())
  })
  it('does not leak a stream granted after the dialog closes', async () => {
    let grant!: (value: unknown) => void
    media.mockReturnValue(new Promise((resolve) => { grant = resolve }))
    mount(); dispose?.(); dispose = undefined
    grant(stream)
    await vi.waitFor(() => expect(stop).toHaveBeenCalled())
    expect(decoder.decode).not.toHaveBeenCalled()
  })
  it('stops late decoder controls after closing during initialization', async () => {
    let finish!: (value: unknown) => void
    decoder.decode.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    mount()
    await vi.waitFor(() => expect(decoder.decode).toHaveBeenCalledOnce())
    dispose?.(); dispose = undefined
    finish({stop:decoder.stop})
    await vi.waitFor(() => expect(decoder.stop).toHaveBeenCalled())
  })
  it('explains camera permission rejection without initiating payment', async () => {
    media.mockRejectedValue(Object.assign(new Error('denied'),{name:'NotAllowedError'}))
    mount()
    await vi.waitFor(() => expect(setState).toHaveBeenCalledWith(expect.stringContaining('摄像头未获授权')))
    expect(decoder.decode).not.toHaveBeenCalled()
  })
  it('ignores personal collection URLs and accepts only supported payer formats', () => {
    expect(CUSTOMER_PAYMENT_CODE.test('https://wxp.tenpay.com/collect/example')).toBe(false)
    expect(CUSTOMER_PAYMENT_CODE.test('101234567890123456')).toBe(true)
    expect(CUSTOMER_PAYMENT_CODE.test('10123456789012345')).toBe(false)
  })
})
