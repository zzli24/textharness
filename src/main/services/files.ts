import { existsSync, promises as fs } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import type { FileContent, FileMeta, FileStat, SaveResult, TreeNode } from '@shared/types'
import { decodeText, encodeText } from './encoding'

/** 单文件读取上限：超过后按"大文件"拒绝，避免主进程卡死 */
const MAX_READ = 64 * 1024 * 1024
const MAX_DEPTH = 6
const MAX_NODES = 5000
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.npm-cache', 'out', 'dist'])

export function assertInside(root: string, target: string): string {
  const r = resolve(root)
  const t = resolve(target)
  if (t !== r && !t.startsWith(r + sep)) {
    throw new Error(`路径越界：${target}`)
  }
  return t
}

export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export interface ReadOptions {
  /** 只读取前 N 字节（大文件只读模式） */
  maxBytes?: number
}

export async function statFile(path: string): Promise<FileStat> {
  try {
    const st = await fs.stat(path)
    return { exists: true, size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() }
  } catch {
    return { exists: false, size: 0, mtimeMs: 0, isDirectory: false }
  }
}

export async function readFileContent(path: string, options: ReadOptions = {}): Promise<FileContent> {
  const st = await fs.stat(path)
  if (st.isDirectory()) throw new Error('这是一个文件夹')

  const limit = options.maxBytes ?? MAX_READ
  const truncated = st.size > limit
  if (truncated && !options.maxBytes) {
    throw new Error(`文件 ${(st.size / 1048576).toFixed(1)} MB，超过 ${limit / 1048576} MB 上限`)
  }

  const buf = truncated ? (await fs.readFile(path)).subarray(0, limit) : await fs.readFile(path)
  if (looksBinary(buf)) throw new Error('这不是文本文件（检测到二进制内容）')
  const d = decodeText(buf)
  return {
    path,
    text: d.text,
    encoding: d.encoding,
    bom: d.bom,
    eol: d.eol,
    size: st.size,
    readonly: truncated,
    truncated,
  }
}

export async function writeFileContent(
  path: string,
  text: string,
  meta: FileMeta,
  dryRun = false
): Promise<SaveResult> {
  const { buffer, lossy } = encodeText(text, meta)
  // dryRun：只做编码往返检查，不落盘。让上层能在"会丢字"时先问用户。
  if (!dryRun) {
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, buffer)
  }
  return { ok: true, lossy, path }
}

/** 扁平返回，渲染进程按父路径自己组树 */
export async function listTree(root: string): Promise<TreeNode[]> {
  const out: TreeNode[] = []
  const walk = async (dir: string, level: number): Promise<void> => {
    if (level > MAX_DEPTH || out.length >= MAX_NODES) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= MAX_NODES) return
      const name = entry.name
      if (IGNORED_DIRS.has(name)) continue
      // 隐藏目录（.assets 图库、.history 备份、.tasks 任务日志等）不在树里显示
      if (name.startsWith('.')) continue
      const full = join(dir, name)
      let st
      try {
        st = await fs.stat(full)
      } catch {
        continue
      }
      out.push({ name, path: full, isDir: entry.isDirectory(), size: st.size, mtime: st.mtimeMs })
      if (entry.isDirectory() && level < MAX_DEPTH) await walk(full, level + 1)
    }
  }
  await walk(root, 1)
  return out
}

export async function createEntry(parent: string, name: string, isDir: boolean): Promise<string> {  if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('文件名包含非法字符')
  const target = join(parent, name)
  if (existsSync(target)) throw new Error('同名文件或文件夹已存在')
  if (isDir) {
    await fs.mkdir(target, { recursive: false })
  } else {
    await fs.mkdir(dirname(target), { recursive: true })
    await fs.writeFile(target, '', 'utf8')
  }
  return target
}

export async function renameEntry(from: string, to: string): Promise<string> {
  if (existsSync(to)) throw new Error('目标名称已存在')
  await fs.rename(from, to)
  return to
}

export async function removeEntry(path: string): Promise<void> {
  await fs.rm(path, { recursive: true, force: true })
}

export async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true })
}

/** 在 dir 下找一个不冲突的文件名：a.md → a-2.md → a-3.md */
export async function nextAvailablePath(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  let candidate = join(dir, name)
  let index = 2
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem}-${index}${ext}`)
    index += 1
    if (index > 999) throw new Error('同名文件过多，换个名字吧')
  }
  return candidate
}
