import sharp from 'sharp'
import type { ChannelRule } from '../../src/shared/channel-distribution.js'
import { channelOfferText } from '../../src/shared/channel-rule-display.js'

const escape = (text: string) => text.replace(/[<>&"']/g, value => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[value]!)
const time = (text: string) => new Date(Date.parse(text) + 28800000).toISOString().slice(0, 16).replace('T', ' ')
const money = (minor: number) => `¥${(minor / 100).toFixed(2)}`
// Conservative width in half-em units; bounded rows keep even 500 long names clear of the code.
export function wrapChannelPosterText(text: string, width: number, maximumLines: number) {
  const lines: string[] = []; let line = '', units = 0, truncated = false
  for (const char of Array.from(text.replace(/\s+/gu, ' ').trim())) {
    const size = /[\u0020-\u007e]/u.test(char) ? 1 : 2
    if (units + size > width) {
      lines.push(line); line = ''; units = 0
      if (lines.length === maximumLines) { truncated = true; break }
    }
    line += char; units += size
  }
  if (!truncated && line) lines.push(line)
  if (truncated) lines[lines.length - 1] = Array.from(lines[lines.length - 1]!).slice(0, -2).join('') + '…'
  return { lines, truncated }
}
type PosterInput = { source: string; code: string; rule: ChannelRule; accepting: boolean }
export function buildChannelPosterSvg(input: PosterInput, codeDataUrl: string) {
  const { rule } = input
  const names = rule.eligibleProductIds.map(id => rule.eligibleProductNames?.find(p => p.id === id)?.name)
  if (names.some(name => !name) || !names.length) throw new Error('适用商品名称未完整读取，请核对后生成推广图')
  const title = wrapChannelPosterText(rule.title, 38, 3)
  const source = wrapChannelPosterText(`${input.source} 推荐`, 50, 2)
  const offer = wrapChannelPosterText(channelOfferText(rule), 44, 3)
  const scope = wrapChannelPosterText(names.join('、'), 56, 6)
  const texts: string[] = []; let y = 105
  const draw = (line: string, size: number, gap: number, bold = false) => { texts.push(`<text x="75" y="${y}" font-size="${size}"${bold ? ' font-weight="bold"' : ''}>${escape(line)}</text>`); y += gap }
  draw('M-BOX · 餐后再坐一会儿', 26, 65)
  for (const line of title.lines) draw(line, 37, 47, true)
  y += 10
  for (const line of source.lines) draw(line, 27, 38)
  for (const line of offer.lines) draw(line, 32, 43, true)
  draw(`优惠号码：${input.code}`, 28, 47)
  for (const line of [
    `领取：${time(rule.claimFrom)} — ${time(rule.claimUntil)}`,
    `使用：${time(rule.useFrom)} — ${time(rule.useUntil)}`,
    `每人限领 ${rule.perCustomerClaims} 次 · 每客组限用 ${rule.perVisitUses} 次`,
    `本批次最多 ${rule.totalClaims} 份 · 满 ${money(rule.minimumMinor)} 可用`,
    rule.allowStacking ? (rule.visitDiscountCapMinor == null ? '允许渠道券叠加 · 未设置客组总上限' : `可叠加 · 客组优惠合计最高 ${money(rule.visitDiscountCapMinor)}`) : '不叠加 · 本次客组只能用一张渠道券',
    '北京时间；换桌不重置次数和额度',
  ]) draw(line, 23, 39)
  draw(`仅限以下商品（共 ${names.length} 款）：`, 25, 38, true)
  for (const line of scope.lines) draw(line, 23, 34)
  if (scope.truncated) draw('仅限指定商品 · 完整适用范围请微信扫码查看', 23, 36, true)
  if (rule.allowStacking) draw('赠品按正常售价计入客组总优惠', 23, 36)
  const qrY = y + 16, height = qrY + 340 + 175
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="900" height="${height}" viewBox="0 0 900 ${height}">
    <rect width="900" height="${height}" rx="28" fill="#182b24"/><rect x="35" y="35" width="830" height="${height - 70}" rx="22" fill="#fff9ed"/>
    <g font-family="Noto Sans CJK SC, PingFang SC, sans-serif" fill="#183b2c">${texts.join('')}
    <image x="280" y="${qrY}" width="340" height="340" xlink:href="${codeDataUrl}"/>
    <text x="450" y="${qrY + 395}" text-anchor="middle" font-size="29">微信扫码或长按识别 · 直接领券</text>
    <text x="450" y="${qrY + 440}" text-anchor="middle" font-size="22">领到本人账户；也可到店出示优惠号码请服务员办理</text>
    ${input.accepting ? '' : '<rect x="650" y="55" width="190" height="45" rx="10" fill="#a84e29"/><text x="745" y="86" text-anchor="middle" fill="white" font-size="24">未开放新领取</text>'}
    </g></svg>`
}
export async function renderChannelPoster(input: PosterInput, officialCode: Buffer) {
  const png = await sharp(officialCode, { limitInputPixels: 1280 * 1280 }).resize(340, 340, { fit: 'contain', background: '#ffffff' }).png().toBuffer()
  return sharp(Buffer.from(buildChannelPosterSvg(input, `data:image/png;base64,${png.toString('base64')}`))).png().toBuffer()
}
