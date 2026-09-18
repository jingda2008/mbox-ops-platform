// Apply the approved venue header to the fixed 1.0.9 native bridge candidate.
// The checked-in legacy bridge is not the structured renderer used by that package.
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const [input, output, printerInput, printerOutput] = process.argv.slice(2)
if (!input || !output || input === output) throw new Error('Expected original bridge.mjs and a different output path')
const original = await readFile(input)
if (createHash('sha256').update(original).digest('hex') !== '794026455090582e3e116c35deb90222a2d2cadd2d2258757fd8d15c7d3aaac8') {
  throw new Error('Expected the verified original 1.0.9-r1 bridge')
}
const venueBitmap = JSON.parse(await readFile(new URL('../deploy/windows-print-bridge/checkout-venue-bitmap.json', import.meta.url), 'utf8'))
let source = original.toString('utf8')
function replaceOnce(before, after) {
  if (source.split(before).length !== 2) throw new Error('Unexpected renderer baseline')
  source = source.replace(before, after)
}
replaceOnce("  const title = requiredText(value.title,'ticket.title')", `  const checkoutVenue = ['cashier_settlement', 'cashier_payment', 'table_settlement'].includes(value.kind) || value.documentRole === 'checkout' || value.checkoutState !== undefined
  if (checkoutVenue) rows.push({type:'venue', ...${JSON.stringify(venueBitmap)}})
  const title = checkoutVenue ? requiredText(value.title,'ticket.title').replace(/[（(]未确认收款[）)]/, '') : requiredText(value.title,'ticket.title')`)
replaceOnce("  if (value.subtitle) text(String(value.subtitle).replace(/^M-BOX\\s*[·・-]\\s*/,''),value.kind === 'production_notice' ? 17 : 0,value.kind === 'production_notice',1)", `  let subtitle = String(value.subtitle || '').replace(/^M-BOX\\s*[·・-]\\s*/,'')
  if (checkoutVenue) subtitle = subtitle.replace(/^陆家嘴中心 L\\+MALL(?:\\s*·\\s*|$)/, '').split('·').map(part => part.trim()).filter(part => !/^(?:本桌次完整消费账单|未确认收款|已确认收款|不代表(?:已经|已)付款)$/.test(part)).join(' · ')
  if (subtitle) text(subtitle,value.kind === 'production_notice' ? 17 : 0,value.kind === 'production_notice',1)`)
await writeFile(output, source)
if (printerInput || printerOutput) {
  if (!printerInput || !printerOutput || printerInput === printerOutput) throw new Error('Expected different original and candidate printer paths')
  const printer = await readFile(printerInput)
  if (createHash('sha256').update(printer).digest('hex') !== '1f610cf25d587d20db915c097ad54d986d3a7d14847e202d4faa44128657dd0a') throw new Error('Unexpected printer baseline')
  const printerSource = printer.toString('utf8')
  const rowAnchor = "      'text' { Add-ReceiptRow ([string]$row.text) ([int]$row.size) ([bool]$row.bold) ([int]$row.align) }"
  if (printerSource.split(rowAnchor).length !== 2) throw new Error('Unexpected receipt row switch')
  // Fixed-size monochrome text uses the existing ESC * bitmap path, like the brand.
  // It does not depend on the store PC font or stretch the printer ROM glyphs.
  const bitmapCase = `
      'venue' {
        $key = if ($TicketProfile -eq 'escpos_58') { 'escpos_58' } else { 'escpos_80' }
        $width = if ($TicketProfile -eq 'escpos_58') { 384 } else { 504 }
        $bitmap = $row.profiles.$key
        if ([int]$bitmap.width -ne $width -or [int]$bitmap.height -ne 48) { throw 'invalid_venue_bitmap_size' }
        $bits = [Convert]::FromBase64String([string]$bitmap.bits)
        $stride = [int]($width / 8)
        if ($bits.Length -ne $stride * 48) { throw 'invalid_venue_bitmap_data' }
        $chunks.AddRange([byte[]](0x1B,0x61,0,0x1D,0x21,0,0x1B,0x45,0,0x1B,0x33,24))
        for ($band=0; $band -lt 2; $band++) {
          $chunks.AddRange([byte[]](0x1B,0x2A,33,($width -band 255),($width -shr 8)))
          for ($x=0; $x -lt $width; $x++) {
            for ($block=0; $block -lt 3; $block++) {
              [byte]$column=0
              for ($bit=0; $bit -lt 8; $bit++) {
                $y=$band*24+$block*8+$bit
                $offset=$y*$stride+[int][Math]::Floor($x/8)
                if (($bits[$offset] -band (128 -shr ($x % 8))) -ne 0) { $column=$column -bor (128 -shr $bit) }
              }
              $chunks.Add($column)
            }
          }
          $chunks.Add(10)
        }
      }`
  await writeFile(printerOutput, printerSource.replace(rowAnchor, rowAnchor + bitmapCase.replaceAll('\n', '\r\n')))

}
console.log(output)
