import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type {
  FileMeta,
  ReplaceResult,
  SearchHit,
  SearchOptions,
  SearchResult,
} from '@shared/types'
import { decodeText, encodeText } from './encoding'
import { looksBinary } from './files'

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.npm-cache',
  'out',
  'dist',
  '.history',
  '.tasks',
  '.assets',
])

const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_FILES = 3000
const MAX_DEPTH = 8
const MAX_LINE_CHARS = 300

function buildRegExp(options: SearchOptions): RegExp {
  const flags = `g${options.caseSensitive ? '' : 'i'}`
  let pattern = options.regex ? options.query : options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (options.wholeWord) pattern = `\\b(?:${pattern})\\b`
  return new RegExp(pattern, flags)
}

async function walk(
  root: string,
  dir: string,
  depth: number,
  out: string[]
): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }

  for (const name of entries) {
    if (out.length >= MAX_FILES) return
    if (name.startsWith('.') && name !== '.') {
      if (SKIP_DIRS.has(name)) continue
    }
    const full = join(dir, name)
    let info
    try {
      info = await stat(full)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue
      await walk(root, full, depth + 1, out)
    } else if (info.isFile() && info.size <= MAX_FILE_BYTES) {
      out.push(full)
    }
  }
}

/** 工作区内所有可打开的文件（快速打开用） */
export async function listFiles(root: string): Promise<string[]> {
  const files: string[] = []
  await walk(root, root, 0, files)
  return files.map((file) => relative(root, file).split(sep).join('/')).sort((a, b) => a.localeCompare(b))
}

export async function searchInFiles(root: string, options: SearchOptions): Promise<SearchResult> {
  if (!options.query) return { hits: [], scannedFiles: 0, truncated: false }

  let re: RegExp
  try {
    re = buildRegExp(options)
  } catch (err) {
    return { hits: [], scannedFiles: 0, truncated: false, error: `正则无效：${String(err)}` }
  }

  const maxHits = options.maxHits ?? 400
  const files: string[] = []
  await walk(root, root, 0, files)

  const hits: SearchHit[] = []
  let truncated = false

  for (const file of files) {
    if (hits.length >= maxHits) {
      truncated = true
      break
    }
    let buf: Buffer
    try {
      buf = await readFile(file)
    } catch {
      continue
    }
    if (looksBinary(buf)) continue

    const decoded = decodeText(buf)
    const lines = decoded.text.split(/\r\n|\r|\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.length > 8000) continue
      re.lastIndex = 0
      const match = re.exec(line)
      if (!match) continue
      hits.push({
        path: file,
        rel: relative(root, file).split(sep).join('/'),
        line: i + 1,
        column: match.index + 1,
        length: match[0].length,
        text: line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line.trim(),
      })
      if (hits.length >= maxHits) {
        truncated = true
        break
      }
      if (hits.length > 0 && i > 200000) break
    }
  }

  return { hits, scannedFiles: files.length, truncated }
}

function backupPath(root: string, file: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const rel = relative(root, file)
  return join(root, '.history', stamp, rel)
}

/**
 * 在整个文件集里替换。只处理明确列出的文件，写入前先备份到 .history。
 */
export async function replaceInFiles(
  root: string,
  paths: string[],
  options: SearchOptions,
  replacement: string
): Promise<ReplaceResult> {
  const result: ReplaceResult = { files: 0, replacements: 0, failed: [] }

  let re: RegExp
  try {
    re = buildRegExp(options)
  } catch (err) {
    result.failed.push(`正则无效：${String(err)}`)
    return result
  }

  const rootAbs = resolve(root)

  for (const file of paths) {
    const abs = resolve(file)
    if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
      result.failed.push(file)
      continue
    }

    try {
      const buf = await readFile(abs)
      if (looksBinary(buf)) continue
      const decoded = decodeText(buf)
      re.lastIndex = 0
      const matches = decoded.text.match(re)
      if (!matches || matches.length === 0) continue

      const next = decoded.text.replace(re, replacement)
      const meta: FileMeta = {
        encoding: decoded.encoding,
        bom: decoded.bom,
        eol: decoded.eol,
      }
      const encoded = encodeText(next, meta)

      const backup = backupPath(root, abs)
      await mkdir(dirname(backup), { recursive: true })
      await writeFile(backup, buf)
      await writeFile(abs, encoded.buffer)

      result.files += 1
      result.replacements += matches.length
    } catch {
      result.failed.push(file)
    }
  }

  return result
}
