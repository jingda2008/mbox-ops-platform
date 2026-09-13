import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import Fastify from 'fastify'
import { describe, it, expect, vi } from 'vitest'
import { createMenuThumbnailer, readLegacyMenuImage } from './menu-thumbnail.js'
import { mediaAssetApiPlugin } from './media-asset-api.js'
import { MediaAssetRepository } from './media-asset-repository.js'
const image = (bytes: Buffer) => ({ bytes, mimeType:'image/png',sha256:createHash('sha256').update(bytes).digest('hex') })
async function source(size=960) {return image(await sharp({create:{width:size,height:size,channels:3,background:'#ca9845'}}).png().toBuffer())}

describe('bounded public menu thumbnails', () => {
 it('shrinks list images, retains original bytes, reuses completed and in-flight results',async()=>{
  const original=await source();const make=createMenuThumbnailer();const [a,b]=await Promise.all([make(original),make(original)]);expect(a).toBe(b);expect(await make(original)).toBe(a)
  expect(a.bytes.length).toBeLessThan(original.bytes.length);expect(a.mimeType).toBe('image/webp');const metadata=await sharp(a.bytes).metadata();expect(metadata.width).toBe(320);expect(metadata.height).toBe(320);expect((await sharp(original.bytes).metadata()).width).toBe(960)
 })
 it('does not enlarge a small source and falls back locally for corrupt or oversized sources',async()=>{
  const make=createMenuThumbnailer();const small=await source(24);expect((await sharp((await make(small)).bytes).metadata()).width).toBe(24)
  const corrupt=image(Buffer.from('invalid image'));expect(await make(corrupt)).toBe(corrupt);expect(await make(corrupt)).toBe(corrupt)
  const large=image(Buffer.alloc(4*1024*1024+1));expect(await make(large)).toBe(large)
 })
 it('does not queue excess conversion work ahead of other requests',async()=>{
  const make=createMenuThumbnailer();const a=await source(950),b=await source(951),c=await source(952)
  const first=make(a),second=make(b);expect(await make(c)).toBe(c);await Promise.all([first,second]);expect((await make(c)).bytes.length).toBeLessThan(c.bytes.length)
 })
 it('allows only existing public menu files, rejects traversal and escaping symlinks',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mbox-menu-image-'));try{await mkdir(join(root,'menu'));const original=await source();await writeFile(join(root,'menu','饮品.png'),original.bytes);await writeFile(join(root,'secret.png'),original.bytes);await symlink(join(root,'secret.png'),join(root,'menu','escape.png'))
   expect((await readLegacyMenuImage(root,'/menu/饮品.png'))?.bytes).toEqual(original.bytes)
   for(const value of ['/menu/../secret.png','/menu/%2e%2e/secret.png','/menu/escape.png','/menu/no.png','/other.png','https://example.com/menu/a.png','/menu/a.png?secret=1','/menu/./饮品.png'])expect(await readLegacyMenuImage(root,value)).toBeNull()
  }finally{await rm(root,{recursive:true,force:true})}
 })
 it('preserves public visibility before cached conversion and 304, keeps full-size old URLs',async()=>{
  const original=await source();const publicBytes=vi.spyOn(MediaAssetRepository.prototype,'publicBytes').mockResolvedValue(original)
  const app=Fastify();try{await app.register(mediaAssetApiPlugin,{transactions:{run:async(_scope,callback)=>callback({} as never)},service:{} as never,resolveScope:()=>({tenantId:'t',storeId:'s'}),resolveStaffContext:()=>({} as never)})
   const url='/public/media-assets/MA00000000000000000000000000000001';const full=await app.inject(url);expect(full.rawPayload).toEqual(original.bytes)
   const thumb=await app.inject(url+'?variant=menu320');expect(thumb.statusCode).toBe(200);expect(thumb.rawPayload.length).toBeLessThan(full.rawPayload.length)
   const cached=await app.inject({url:url+'?variant=menu320',headers:{'if-none-match':thumb.headers.etag!}});expect(cached.statusCode).toBe(304)
   // Temporary conversion fallback must not pin a full-size image in the new variant cache for a year.
   publicBytes.mockResolvedValue(image(Buffer.from('undecodable old material')))
   const fallback=await app.inject(url+'?variant=menu320');expect(fallback.statusCode).toBe(200);expect(fallback.headers['cache-control']).toBe('public, max-age=60')
   publicBytes.mockResolvedValue(null);expect((await app.inject({url:url+'?variant=menu320',headers:{'if-none-match':thumb.headers.etag!}})).statusCode).toBe(404)
  }finally{await app.close();publicBytes.mockRestore()}
 })
 it('serves legacy thumbnails with validators and leaves unknown images as local 404s',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mbox-menu-route-'));const app=Fastify();try{await mkdir(join(root,'menu'));const original=await source();await writeFile(join(root,'menu','water.png'),original.bytes)
   await app.register(mediaAssetApiPlugin,{staticDirectory:root,transactions:{} as never,service:{} as never,resolveScope:()=>({tenantId:'t',storeId:'s'}),resolveStaffContext:()=>({} as never)})
   const url='/public/menu-thumbnail?path=%2Fmenu%2Fwater.png';const response=await app.inject(url);expect(response.statusCode).toBe(200);expect(response.rawPayload.length).toBeLessThan(original.bytes.length);expect((await app.inject({url,headers:{'if-none-match':response.headers.etag!}})).statusCode).toBe(304);expect((await app.inject('/public/menu-thumbnail?path=%2Fsecret.png')).statusCode).toBe(404)
  }finally{await app.close();await rm(root,{recursive:true,force:true})}
 })
})
