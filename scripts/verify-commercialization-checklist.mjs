import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export function verifyChecklist(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!text.startsWith('# M-BOX 商业化待处理清单\n') || /[\uFFFD\uE000-\uF8FF]|鍟嗕笟|鍘嗗彶|鏈嶅姟/.test(text)) {
    throw new Error('商业化清单存在乱码或标题异常，请从可读 Git 历史恢复')
  }
  const ids = new Set([...text.matchAll(/SYS-(\d+)/g)].map(match => Number(match[1])))
  for (let id = 1; id <= 252; id++) if (!ids.has(id)) throw new Error(`商业化清单丢失历史 SYS-${id}`)
  if (!/^最后更新：`\d{4}-\d{2}-\d{2} \d{2}:\d{2} CST`$/m.test(text)) throw new Error('清单更新时间必须为北京时间')
  return { verified: true, historicalIssueCount: ids.size }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(verifyChecklist(await readFile('docs/commercialization-pending-checklist.md')))}\n`)
}
