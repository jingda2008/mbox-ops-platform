import sharp from 'sharp'
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {BottleCustodyError,quantityUnits} from './bottle-custody-policy.js'
export const fractions={'1':'1','1/2':'0.5','1/4':'0.25','3/4':'0.75','1/5':'0.2','2/5':'0.4','3/5':'0.6','4/5':'0.8','1/10':'0.1'} as const
export const depositEvidenceSchema=z.object({
 photoBase64:z.string().min(100).max(1400000),
 phone:z.string().trim().max(32).nullable().default(null),
 fraction:z.enum(['1','1/2','1/4','3/4','1/5','2/5','3/5','4/5','1/10']).nullable().default(null),
}).strict()
export type DepositEvidence=z.infer<typeof depositEvidenceSchema>
export function validateDepositFraction(evidence:DepositEvidence,quantity:string,unit:string){
 if(evidence.fraction&&(unit!=='瓶'||quantityUnits(fractions[evidence.fraction])!==quantityUnits(quantity)))throw new BottleCustodyError('所选剩余比例与存入数量不一致，请重新选择')
}
export function custodyPhone(value:string){
 const compact=value.replace(/[\s()-]/g,'');const normalized=/^1[3-9]\d{9}$/.test(compact)?`+86${compact}`:compact
 if(!/^\+[1-9]\d{7,14}$/.test(normalized))throw new BottleCustodyError('请填写有效手机号，境外号码请包含国家区号')
 return normalized
}
function escape(value:string){return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')}
/** Server receipt time is authoritative; a browser cannot attest the physical camera or EXIF capture time. */
export async function custodyPhoto(base64:string,at:Date,memberNo:string,quantity:string,fraction:string|null){
 try{
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))throw Error('encoding')
  const input=Buffer.from(base64,'base64');if(input.length>1048576||input.toString('base64')!==base64)throw Error('size')
  const source=sharp(input,{limitInputPixels:12000000,failOn:'warning'});const metadata=await source.metadata()
  if(!['jpeg','png'].includes(metadata.format??'')||metadata.pages&&metadata.pages!==1||(metadata.width??0)<160||(metadata.height??0)<120)throw Error('format')
  const {data,info}=await source.rotate().resize({width:1280,height:1280,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:80}).toBuffer({resolveWithObject:true})
  const time=new Date(at.getTime()+28800000).toISOString().slice(0,19).replace('T',' ')
  const watermark=`M-BOX | ${time} UTC+08:00 | ${memberNo} | ${fraction??quantity}`
  const width=Math.max(info.width,640),height=info.height+92
  const svg=Buffer.from(`<svg width="${width}" height="92"><rect width="100%" height="100%" fill="#12251c"/><text x="16" y="32" fill="white" font-family="sans-serif" font-size="20">M-BOX | ${time} UTC+08:00</text><text x="16" y="66" fill="white" font-family="sans-serif" font-size="18">Member: ${escape(memberNo)} | Amount: ${escape(fraction??quantity)}</text></svg>`)
  const bytes=await sharp({create:{width,height,channels:3,background:'#ffffff'}}).composite([{input:data,left:0,top:0},{input:svg,left:0,top:info.height}]).jpeg({quality:78}).toBuffer()
  if(bytes.length>524288)throw Error('output size')
  return{bytes,watermark,sha256:createHash('sha256').update(bytes).digest('hex')}
 }catch{throw new BottleCustodyError('照片无效或过大，请重新拍摄清晰照片（JPEG/PNG，最大1MB）')}
}
