import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
}

const pad = (n: number): string => String(n).padStart(2, '0')

export function dayStamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function timeStamp(d = new Date()): string {
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * 粘贴图片落盘，返回"相对文档所在目录"的 POSIX 风格路径。
 * markdown 渲染器是按文档位置解析图片的，所以相对基准必须是文档目录而不是工作根。
 */
export function savePastedImage(
  root: string,
  assetsDir: string,
  docPath: string | null,
  mime: string,
  bytes: Buffer
): string {
  const day = dayStamp()
  const dir = join(root, assetsDir, 'img', day)
  mkdirSync(dir, { recursive: true })

  const ext = EXT_BY_MIME[mime] ?? '.png'
  const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 8)
  const abs = join(dir, `${timeStamp()}-${hash}${ext}`)
  if (!existsSync(abs)) writeFileSync(abs, bytes)

  const baseDir = docPath ? dirname(docPath) : join(root, day)
  return relative(baseDir, abs).split(sep).join('/')
}
