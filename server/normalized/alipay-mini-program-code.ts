import QRCode from 'qrcode'

export interface AlipayMiniProgramCodeInput {
  appId: string
  page: string
  query: string
  width?: number
}

export interface AlipayTableMiniCodeProvider {
  render(input: Readonly<AlipayMiniProgramCodeInput>): Promise<Buffer>
}

/**
 * Printable Alipay-entry table codes. These encode the official mini-program
 * scheme URL so scanning inside Alipay opens the guest order page. They are not
 * WeChat mini-program codes and must never be printed as a shared "one code".
 */
export class AlipayMiniProgramSchemeQrProvider implements AlipayTableMiniCodeProvider {
  async render(input: Readonly<AlipayMiniProgramCodeInput>): Promise<Buffer> {
    const appId = input.appId.trim()
    const page = input.page.trim().replace(/^\//, '')
    const query = input.query.trim()
    const width = input.width ?? 430
    if (!/^20\d{14,18}$/.test(appId)) {
      throw new TypeError('Alipay AppID is invalid')
    }
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(page)) {
      throw new TypeError('Alipay mini-program page path is invalid')
    }
    if (!query || query.length > 512) {
      throw new TypeError('Alipay mini-program query is invalid')
    }
    if (!Number.isSafeInteger(width) || width < 280 || width > 1280) {
      throw new TypeError('Alipay mini-program code width is invalid')
    }
    const scheme = `alipays://platformapi/startapp?appId=${encodeURIComponent(appId)}`
      + `&page=${encodeURIComponent(page)}`
      + `&query=${encodeURIComponent(query)}`
    return QRCode.toBuffer(scheme, {
      type: 'png',
      width,
      margin: 1,
      errorCorrectionLevel: 'M',
    })
  }
}
