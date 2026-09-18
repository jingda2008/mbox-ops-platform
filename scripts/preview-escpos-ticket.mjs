// Decode the actual RAW printer payload; never reflow a receipt using browser CSS.
// Text uses host glyphs: printer ROM fonts and physical paper still require acceptance.
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { chromium } from '@playwright/test'
const input=process.argv[2]
const output=process.argv[3]
if(!input||!output)throw new Error('Expected input .bin and output .png')
const bytes=await readFile(input)
const paper=input.includes('escpos_58')?464:640
const printable=input.includes('escpos_58')?384:576
const margin=(paper-printable)/2
const decode=new TextDecoder('gbk')
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
let i=0,x=0,y=24,size=0,bold=0,align=0,spacing=30,height=0
let row=[],svg=[],records=[],cuts=0,bands=0
let cutSeen=false
function flush(){
 if(x>printable)throw new Error(`Emitted row exceeds printable width: ${x}>${printable}`)
 records.push({text:row.filter(item=>item.type!=='pixel').map(item=>item.text).join(''),size,bold,align,widthDots:x,yDots:y})
 const shift=align===1?(printable-x)/2:align===2?printable-x:0
 for(const item of row){
  if(item.type==='pixel')svg.push(`<rect x="${margin+item.x}" y="${y+item.y}" width="1" height="1"/>`)
  else svg.push(`<text x="${margin+item.x+shift}" y="${y+20*item.sy}" font-size="${24*item.sy}" font-weight="${item.bold?'700':'400'}" textLength="${item.width}" lengthAdjust="spacingAndGlyphs">${escape(item.text)}</text>`)
 }
 y+=Math.max(spacing,height);x=0;height=0;row=[]
}
while(i<bytes.length){
 if(cutSeen)throw new Error('Data after terminal paper cut')
 const b=bytes[i]
 if(b===27){
  const c=bytes[i+1]
  if(c===64){i+=2;continue}
  if(c===50){spacing=30;i+=2;continue}
  if(c===42){
   const n=bytes[i+3]+256*bytes[i+4];if(bytes[i+2]!==33)throw Error('Unsupported image mode')
   i+=5;bands++
   for(let col=0;col<n;col++)for(let block=0;block<3;block++){
    const v=bytes[i++];for(let bit=0;bit<8;bit++)if(v&(128>>bit))row.push({type:'pixel',x:x+col,y:block*8+bit})
   }
   x+=n;height=Math.max(height,24);continue
  }
  if(c===51)spacing=bytes[i+2]
  else if(c===69)bold=bytes[i+2]
  else if(c===97)align=bytes[i+2]
  else if(c!==116)throw Error('Unsupported ESC '+c)
  i+=3;continue
 }
 if(b===29){const c=bytes[i+1];if(c===33)size=bytes[i+2];else if(c===86){cuts++;cutSeen=true}else throw Error('Unsupported GS');i+=3;continue}
 if(b===10){flush();i++;continue}
 const count=b>=0x81&&b<=0xfe?2:1
 const text=decode.decode(bytes.subarray(i,i+count));i+=count
 const sx=1+(size>>4),sy=1+(size&15),width=count*12*sx
 row.push({type:'text',x,text,width,sy,bold});x+=width;height=Math.max(height,24*sy)
}
if(cuts!==1)throw new Error(`Expected one terminal cut, got ${cuts}`)
if(row.length)throw new Error('Unterminated print row')
await writeFile(output.replace(/\.png$/,'.evidence.json'),JSON.stringify({input,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,paperDots:paper,printableDots:printable,cuts,bands,records,nativeGlyphsVerified:false},null,2)+'\n')
const document=`<svg xmlns="http://www.w3.org/2000/svg" width="${paper}" height="${y+24}" viewBox="0 0 ${paper} ${y+24}"><rect width="100%" height="100%" fill="white"/><g fill="black" font-family="Songti SC,SimSun,serif">${svg.join('')}</g></svg>`
await writeFile(output.replace(/\.png$/,'.svg'),document)
const browser=await chromium.launch({headless:true})
const page=await browser.newPage({viewport:{width:paper,height:Math.ceil(y+24)},deviceScaleFactor:1})
await page.setContent(`<style>body{margin:0}</style>${document}`)
await page.screenshot({path:output,fullPage:true})
await browser.close()
console.log(output)
