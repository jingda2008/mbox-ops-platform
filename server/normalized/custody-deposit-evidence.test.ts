import {describe,it,expect} from 'vitest'
import sharp from 'sharp'
import {custodyPhoto,custodyPhone,validateDepositFraction} from './custody-deposit-evidence.js'
describe('custody deposit evidence',()=>{
 it('normalizes contact phones without claiming membership verification',()=>{expect(custodyPhone('138 0001 2345')).toBe('+8613800012345');expect(custodyPhone('+44 7700 900123')).toBe('+447700900123');expect(()=>custodyPhone('138****2345')).toThrow()})
 it('preserves exact fractions and rejects mismatched quantities and non-bottle units',()=>{const input={photoBase64:'',phone:null,fraction:'2/5' as const};expect(()=>validateDepositFraction(input,'0.400000','瓶')).not.toThrow();expect(()=>validateDepositFraction(input,'0.5','瓶')).toThrow();expect(()=>validateDepositFraction(input,'0.4','毫升')).toThrow()})
 it('decodes real raster images, adds server time, and rejects SVG disguised as a photo',async()=>{
  const source=await sharp({create:{width:320,height:240,channels:3,background:'#555555'}}).png().toBuffer()
  const result=await custodyPhoto(source.toString('base64'),new Date('2026-09-16T13:00:00Z'),'100001','0.5','1/2')
  expect(result.watermark).toContain('2026-09-16 21:00:00 UTC+08:00');expect(result.watermark).toContain('1/2')
  expect(await sharp(result.bytes).metadata()).toMatchObject({format:'jpeg',width:640,height:332});expect(result.bytes.length).toBeLessThan(524288)
  await expect(custodyPhoto(Buffer.from('<svg width="320" height="240"/>').toString('base64'),new Date(),'100001','1',null)).rejects.toThrow('照片无效')
  await expect(custodyPhoto('not_base64',new Date(),'100001','1',null)).rejects.toThrow('照片无效')
 })
})
