// Apply only the two production-note font changes to the verified 1.0.10 renderer.
import {readFile, writeFile} from 'node:fs/promises'
const [input,output]=process.argv.slice(2)
if(!input||!output)throw new Error('Expected input and output bridge paths')
let source=await readFile(input,'utf8')
function replaceOnce(before,after){
  if(source.split(before).length!==2)throw new Error(`Unexpected baseline: ${before}`)
  source=source.replace(before,after)
}
replaceOnce("const VERSION = '1.0.10'", "const VERSION = '1.0.11'")
// ESC/POS 0x11: double width and height, like production item names. Preserve bold/alignment.
const size="['bar_production','kitchen_production'].includes(value.kind) ? 17 : 0"
replaceOnce('if (item.note) text(`备注：${item.note}`)', 'if (item.note) text(`备注：${item.note}`, '+size+')')
replaceOnce('if (value.note) text(`备注：${value.note}`)', 'if (value.note) text(`备注：${value.note}`, '+size+')')
await writeFile(output,source)
