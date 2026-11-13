import sharp from 'sharp'
import type { ChannelRule } from '../../src/shared/channel-distribution.js'

const escape = (text: string) => text.replace(/[<>&"']/g, value => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[value]!)
const time = (text: string) => new Date(Date.parse(text) + 28800000).toISOString().slice(0, 16).replace('T', ' ')
const money = (minor: number) => `¥${(minor / 100).toFixed(2)}`
export async function renderChannelPoster(input: { source: string; code: string; rule: ChannelRule; accepting: boolean }, officialCode: Buffer) {
  const { rule } = input
  // Decode and normalize the platform image; never substitute a plain QR for a Mini Program code.
  const png = await sharp(officialCode, { limitInputPixels: 1280 * 1280 }).resize(340, 340, { fit: 'contain', background: '#ffffff' }).png().toBuffer()
  const qr = `data:image/png;base64,${png.toString('base64')}`
  const offer = rule.offer.kind === 'gift' ? `${Array.from(rule.offer.productName ?? '指定好礼').slice(0, 14).join('')} ${rule.offer.quantity} 份` : rule.offer.kind === 'credit' ? `消费优惠 ${money(rule.offer.amountMinor)}` : `消费优惠 ${rule.offer.discountBps / 100}% · 上限 ${money(rule.offer.maximumMinor)}`
  const lines = [Array.from(input.source).slice(0, 24).join('') + ' 推荐', offer, `优惠号码：${input.code}`, `领取：${time(rule.claimFrom)} — ${time(rule.claimUntil)}`,
    `使用：${time(rule.useFrom)} — ${time(rule.useUntil)}`, `每人限领 ${rule.perCustomerClaims} 次 · 每客组限用 ${rule.perVisitUses} 次`,
    `本批次最多 ${rule.totalClaims} 份 · 满 ${money(rule.minimumMinor)} 可用`, '含赠品售价；北京时间，换桌不重置次数和额度', rule.allowStacking ? (rule.visitDiscountCapMinor == null ? '允许渠道券叠加 · 未设置客组总上限' : `可叠加 · 客组优惠合计最高 ${money(rule.visitDiscountCapMinor)}`) : '不叠加 · 本次客组只能用一张渠道券']
  const title = Array.from(rule.title).slice(0, 20).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="900" height="1220" viewBox="0 0 900 1220">
    <rect width="900" height="1220" rx="28" fill="#182b24"/><rect x="35" y="35" width="830" height="1150" rx="22" fill="#fff9ed"/>
    <g font-family="Noto Sans CJK SC, PingFang SC, sans-serif" fill="#183b2c"><text x="75" y="105" font-size="26" letter-spacing="4">M-BOX · 餐后再坐一会儿</text>
    <text x="75" y="175" font-size="37" font-weight="bold">${escape(title)}</text>
    ${lines.map((line, i) => `<text x="75" y="${235 + i * 49}" font-size="${i === 1 ? 36 : i > 2 ? 23 : 28}">${escape(line)}</text>`).join('')}
    <image x="280" y="680" width="340" height="340" xlink:href="${qr}"/>
    <text x="450" y="1075" text-anchor="middle" font-size="29">微信扫码或长按识别 · 直接领券</text>
    <text x="450" y="1120" text-anchor="middle" font-size="22">领到本人账户；也可到店出示优惠号码请服务员办理</text>
    ${input.accepting ? '' : '<rect x="650" y="55" width="190" height="45" rx="10" fill="#a84e29"/><text x="745" y="86" text-anchor="middle" fill="white" font-size="24">未开放新领取</text>'}
    </g></svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}
