import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'

const PREFIX = '/native-updates/staff'
const APK = /^MBOX-Staff-[A-Za-z0-9][A-Za-z0-9._-]{0,39}-build[1-9][0-9]{0,9}-[a-f0-9]{12,64}\.apk$/
const MAX_APK_BYTES = 256 * 1024 * 1024

export function registerNativeUpdateDistribution(app: FastifyInstance, directory: string | null): void {
  const missing = (reply: import('fastify').FastifyReply) => reply.header('cache-control', 'no-store')
    .code(404).send({ error: { code: 'NATIVE_UPDATE_NOT_FOUND', message: '此更新文件尚未发布' } })
  // Reserve the complete prefix, including invalid paths. None may reach the
  // application's HTML fallback or expose arbitrary files from the mount.
  app.route<{ Params: { '*': string } }>({
    method: ['GET', 'HEAD'], url: `${PREFIX}/*`,
    async handler(request, reply) {
      const name = request.params['*']
      const manifest = name === 'stable.json' || name === 'preview.json'
      if (directory === null || (!manifest && (!APK.test(name) || name.includes('..')))) return missing(reply)
      const root = resolve(directory)
      let file: Awaited<ReturnType<typeof open>> | undefined
      try {
        const rootStat = await lstat(root)
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root) return missing(reply)
        // O_NOFOLLOW prevents a swap of a checked public filename to a symlink.
        file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW)
        const stat = await file.stat()
        if (!stat.isFile() || stat.size <= 0 || stat.size > (manifest ? 65_536 : MAX_APK_BYTES)) return missing(reply)
        reply.header('x-content-type-options', 'nosniff')
        if (manifest) {
          const bytes = await file.readFile()
          const feed: unknown = JSON.parse(bytes.toString('utf8'))
          if (typeof feed !== 'object' || feed === null || !('schemaVersion' in feed) || feed.schemaVersion !== 1
            || !('channel' in feed) || feed.channel !== name.slice(0, -5) || !('releases' in feed) || !Array.isArray(feed.releases)) return missing(reply)
          return reply.header('cache-control', 'no-store').type('application/json; charset=utf-8')
            .header('content-length', bytes.length).send(request.method === 'HEAD' ? undefined : bytes)
        }
        reply.type('application/vnd.android.package-archive')
          .header('cache-control', 'public, max-age=31536000, immutable')
          .header('content-length', stat.size)
          .header('etag', `"${name}"`)
        if (request.method === 'HEAD') return reply.send()
        const stream = file.createReadStream({ autoClose: true })
        file = undefined // The response stream now owns this descriptor.
        return reply.send(stream)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || error instanceof SyntaxError) return missing(reply)
        request.log.error({ err: error }, 'native update file could not be read')
        return reply.header('cache-control', 'no-store').code(503).send({ error: { code: 'NATIVE_UPDATE_UNAVAILABLE', message: '更新文件暂时无法读取' } })
      } finally {
        await file?.close()
      }
    },
  })
  app.route({ method: ['GET', 'HEAD'], url: PREFIX, handler: (_request, reply) => missing(reply) })
  for (const url of [PREFIX, `${PREFIX}/*`]) app.route({
    method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], url,
    handler: (_request, reply) => reply.header('allow', 'GET, HEAD').header('cache-control', 'no-store')
      .code(405).send({ error: { code: 'NATIVE_UPDATE_READ_ONLY', message: '更新文件仅供读取' } }),
  })
}
