import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

type Image = Readonly<{ bytes: Buffer; mimeType: string; sha256: string }>
const MAX_INPUT = 4 * 1024 * 1024
const MAX_CACHE = 16 * 1024 * 1024

// Per-process bounded work and cache. Staff libraries may wait in a small
// bounded queue after their read transaction has ended; public menus keep the
// immediate fallback. Neither path queues or locks a sales transaction.
export function createMenuThumbnailer(options: { maxQueued?: number; preserveJpeg?: boolean } = {}) {
  const maxQueued=options.maxQueued??0
  if(!Number.isSafeInteger(maxQueued)||maxQueued<0||maxQueued>32)throw new RangeError('thumbnail queue limit must be 0..32')
  const cache = new Map<string, Image>()
  const pending = new Map<string, Promise<Image>>()
  const waiting:Array<()=>void>=[]
  let active = 0
  let cacheBytes = 0
  return async (original: Image): Promise<Image> => {
    if (!original.bytes.length || original.bytes.length > MAX_INPUT) return original
    const key = `${original.sha256}:menu320-v1`
    const hit = cache.get(key)
    if (hit) { cache.delete(key); cache.set(key, hit); return hit }
    const inProgress = pending.get(key)
    if (inProgress) return inProgress
    if (active >= 2 && waiting.length >= maxQueued) return original
    const slot=active<2?(active++,Promise.resolve()):new Promise<void>(resolve=>waiting.push(resolve))
    const work = slot.then(async () => {
      try {
        // Missing native support disables only thumbnails, never application startup.
        const { default: sharp } = await import('sharp')
        const pipeline = sharp(original.bytes, { limitInputPixels: 12_000_000, animated: false })
          .rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true })
        // Re-encoding an already compressed JPEG as WebP can retain nearly all
        // its bytes. Staff previews preserve JPEG; transparent images use WebP.
        const useJpeg=options.preserveJpeg && original.mimeType==='image/jpeg'
        const bytes = await (useJpeg ? pipeline.jpeg({quality:70,progressive:true})
          : pipeline.webp({ quality: 74, effort: 2 })).timeout({ seconds: 2 }).toBuffer()
        const result = bytes.length < original.bytes.length
          ? { bytes, mimeType: useJpeg?'image/jpeg':'image/webp', sha256: createHash('sha256').update(bytes).digest('hex') }
          : original
        while (cache.size && (cacheBytes + result.bytes.length > MAX_CACHE || cache.size >= 256)) {
          const first = cache.keys().next().value!
          cacheBytes -= cache.get(first)!.bytes.length
          cache.delete(first)
        }
        cache.set(key, result); cacheBytes += result.bytes.length
        return result
      } catch { return original }
      finally {
        pending.delete(key)
        const next=waiting.shift()
        if(next)next();else active--
      }
    })
    pending.set(key, work)
    return work
  }
}

// Only the already-public menu directory is eligible. Never fetch arbitrary URLs.
export async function readLegacyMenuImage(staticDirectory: string | undefined, value: unknown): Promise<Image | null> {
  if (!staticDirectory || typeof value !== 'string' || !value.startsWith('/menu/')
    || value.length > 512 || /[\\\u0000-\u001f?#%]/.test(value)
    || value.split('/').some(part => part === '.' || part === '..')
    || !/\.(jpe?g|png|webp)$/i.test(value)) return null
  try {
    const root = await realpath(resolve(staticDirectory, 'menu'))
    const file = await realpath(resolve(staticDirectory, '.' + value))
    if (!file.startsWith(root + sep)) return null
    const info = await stat(file)
    if (!info.isFile() || info.size > MAX_INPUT) return null
    const bytes = await readFile(file)
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
      mimeType: /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg' }
  } catch { return null }
}
