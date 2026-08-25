import { PNG } from 'pngjs'
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library'
import { describe, expect, it } from 'vitest'
import {
  benefitClaimPayload,
  createBenefitClaimQrDataUrl,
  createMemberIdentificationQrDataUrl,
  memberIdentificationPayload,
} from './member-code-qr.js'

describe('member and benefit identification QR', () => {
  it('round-trips the exact scoped identification payload through a real QR decoder', async () => {
    const memberNo = 'MBX-35648'
    const claimCode = 'DSN-ABCDEFGHIJ'

    expect(decode(await createMemberIdentificationQrDataUrl(memberNo))).toBe(memberIdentificationPayload(memberNo))
    expect(decode(await createBenefitClaimQrDataUrl(claimCode))).toBe(benefitClaimPayload(claimCode))
  })
})

function decode(dataUrl: string): string {
  const encoded = dataUrl.split(',', 2)[1]
  if (encoded === undefined) throw new Error('QR data URL is missing image bytes')
  const image = PNG.sync.read(Buffer.from(encoded, 'base64'))
  const luminance = new Uint8ClampedArray(image.width * image.height)
  for (let source = 0, target = 0; source < image.data.length; source += 4, target += 1) {
    luminance[target] = Math.round(
      0.299 * (image.data[source] ?? 0)
      + 0.587 * (image.data[source + 1] ?? 0)
      + 0.114 * (image.data[source + 2] ?? 0),
    )
  }
  const bitmap = new BinaryBitmap(new HybridBinarizer(
    new RGBLuminanceSource(luminance, image.width, image.height),
  ))
  const hints = new Map<DecodeHintType, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]],
  ])
  return new MultiFormatReader().decode(bitmap, hints).getText()
}
