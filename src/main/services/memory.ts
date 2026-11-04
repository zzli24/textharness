import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 本地记忆系统。
 *
 * 刻意不用向量库、不用 Python、不引入新依赖：
 *   <工作区>/记忆/MEMORY.md        长期事实（偏好/环境/禁忌），每轮注入
 *   <工作区>/记忆/日志/YYYY-MM.md   会话日志，按月一个文件，只注入最近几条
 *
 * 为什么不做「记忆库」而是目录约定：记忆文件必须是用户能打开、能改、能 git 的普通 Markdown，
 * 和知识库的区别只是「谁写」和「是否常驻上下文」，不需要另一套存储。
 */

export const MEMORY_DIR = '记忆'
export const MEMORY_FILE = 'MEMORY.md'
export const LOG_DIR = '日志'

/** 注入时的上限：记忆是常数开销，不能无限膨胀 */
const FACT_CLIP = 2400
/** 一条「长期事实」最多这么长：再长就不是事实，是文档 */
const FACT_MAX = 200
/** 一条日志最多这么长 */
const LOG_MAX = 800
/** 模板/清单放这里，不进上下文 */
export const TEMPLATE_DIR = '模板'
const LOG_LINES = 8
const LOG_CLIP = 1200

export interface MemorySnapshot {
  /** MEMORY.md 原文（可能被截断） */
  facts: string
  /** 最近几条日志（已按时间倒序） */
  recentLogs: string[]
  /** 是否已经存在记忆目录 */
  exists: boolean
  /** MEMORY.md 的完整原文（给设置页编辑用，不截断） */
  factsFull: string
  /** 模板文件清单（模板目录自动生成，不写进 MEMORY.md） */
  templates: Array<{ path: string; title: string }>
}

function memoryRoot(root: string): string {
  return join(root, MEMORY_DIR)
}

function memoryPath(root: string): string {
  return join(memoryRoot(root), MEMORY_FILE)
}

function logDir(root: string): string {
  return join(memoryRoot(root), LOG_DIR)
}

function monthStamp(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
}

function dayStamp(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getMonth() + 1}-${pad(date.getDate())}`
}

/** 确保目录存在 */
export function ensureMemoryDir(root: string): string {
  const dir = memoryRoot(root)
  mkdirSync(join(dir, LOG_DIR), { recursive: true })
  const file = memoryPath(root)
  if (!existsSync(file)) {
    writeFileSync(
      file,
      [
        '# 长期记忆',
        '',
        '> 这份文件每轮对话都会进系统提示，只写「长期有效」的事实：偏好、环境、禁忌、约定。',
        '> 一次性的结论写进 `记忆/日志/`，不要堆在这里。',
        '',
        '## 偏好',
        '',
        '## 环境',
        '',
        '## 禁忌',
        '',
      ].join('\n'),
      'utf8'
    )
  }
  return dir
}

/** 读记忆：给系统提示注入用 */
export function readMemory(root: string): MemorySnapshot {
  const file = memoryPath(root)
  const dir = logDir(root)
  const exists = existsSync(file)
  const raw = exists ? readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : ''
  const factsFull = raw.trim()
  const facts = factsFull.length > FACT_CLIP ? `${factsFull.slice(0, FACT_CLIP)}\n…（记忆太长，已截断，完整内容在 记忆/${MEMORY_FILE}）` : factsFull

  const recentLogs: string[] = []
  try {
    if (existsSync(dir)) {
      const files = readdirSync(dir)
        .filter((name) => name.endsWith('.md'))
        .sort()
        .reverse()
      // 从最新月份往前取，凑够 LOG_LINES 条
      for (const name of files) {
        const content = readFileSync(join(dir, name), 'utf8').replace(/^\uFEFF/, '')
        const lines = content
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith('- '))
          .reverse()
        for (const line of lines) {
          recentLogs.push(line)
          if (recentLogs.length >= LOG_LINES) break
        }
        if (recentLogs.length >= LOG_LINES) break
      }
    }
  } catch {
    /* 读不到就当没有 */
  }

  // 模板清单：目录名自动生成，不需要在 MEMORY.md 里记「某模板在哪」
  const templates: Array<{ path: string; title: string }> = []
  try {
    const dir = join(memoryRoot(root), TEMPLATE_DIR)
    if (existsSync(dir)) {
      for (const name of readdirSync(dir).filter((item) => item.endsWith('.md')).sort()) {
        const full = join(dir, name)
        const firstLine = readFileSync(full, 'utf8').split('\n')[0] ?? ''
        templates.push({
          path: `${MEMORY_DIR}/${TEMPLATE_DIR}/${name}`,
          title: firstLine.replace(/^#+\s*/, '').trim() || name.replace(/\.md$/, ''),
        })
      }
    }
  } catch {
    /* 读不到就当没有模板 */
  }

  return { facts, recentLogs, exists: exists && factsFull.length > 0, factsFull, templates }
}

export interface RememberResult {
  path: string
  text: string
}

/**
 * 写记忆。
 *  - kind='fact'：追加到 MEMORY.md（长期事实）
 *  - kind='log'：追加到 记忆/日志/YYYY-MM.md（会话结论）
 */
export type MemoryKind = 'fact' | 'log' | 'template'

/** 把标题变成安全的文件名 */
function slugify(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 60)
  return cleaned || '未命名'
}

/**
 * 写记忆。
 *  - fact：一两句长期事实（上限 200 字），进每轮上下文
 *  - log：一次会话的结论（上限 800 字），只注入最近几条
 *  - template：多字段模板/清单，落到 记忆/模板/，不进上下文，用时再读
 */
export function remember(root: string, kind: MemoryKind, text: string): RememberResult {
  ensureMemoryDir(root)
  const raw = text.trim()
  if (!raw) throw new Error('要记的内容是空的')
  const body = raw.replace(/\s*\n\s*/g, ' ')

  if (kind === 'fact') {
    if (body.length > FACT_MAX) {
      throw new Error(
        `这条有 ${body.length} 字，太长，长期记忆只放一两句事实（上限 ${FACT_MAX} 字）。` +
          '模板、字段清单、表单格式请用 kind=template 存到 记忆/模板/，不要塞进 MEMORY.md。'
      )
    }
    const file = memoryPath(root)
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    // 不往用户的「## 禁忌」之类小节里乱塞：统一追加到文件末尾的「## 记录」
    const chunk = current.includes('## 记录')
      ? `- ${body}\n`
      : `${current.endsWith('\n') ? '' : '\n'}\n## 记录\n\n- ${body}\n`
    appendFileSync(file, chunk, 'utf8')
    return { path: `${MEMORY_DIR}/${MEMORY_FILE}`, text: body }
  }

  if (kind === 'template') {
    const dir = join(memoryRoot(root), TEMPLATE_DIR)
    mkdirSync(dir, { recursive: true })
    const titleLine = raw.split('\n').find((line) => line.trim().length > 0) ?? '未命名模板'
    const title = titleLine.replace(/^#+\s*/, '').slice(0, 60)
    const name = `${slugify(title)}.md`
    const file = join(dir, name)
    const head = `# ${title}\n\n> 模板文件，不参与每轮上下文；需要时用 read_file 读。\n\n`
    writeFileSync(file, `${head}${raw}\n`, 'utf8')
    return { path: `${MEMORY_DIR}/${TEMPLATE_DIR}/${name}`, text: title }
  }

  if (body.length > LOG_MAX) {
    throw new Error(
      `这条有 ${body.length} 字，日志最多 ${LOG_MAX} 字。长内容请用 kind=template 存成模板文件。`
    )
  }

  const file = join(logDir(root), `${monthStamp()}.md`)
  if (!existsSync(file)) {
    writeFileSync(file, `# ${monthStamp()} 会话日志\n\n`, 'utf8')
  }
  const line = `- ${dayStamp()} ${body}\n`
  appendFileSync(file, line, 'utf8')
  return { path: `${MEMORY_DIR}/${LOG_DIR}/${monthStamp()}.md`, text: body }
}

export interface MemoryHit {
  path: string
  line: number
  text: string
}

/** 在记忆目录里找：先精确包含，再按词命中数排序 */
/**
 * 检索用的切词：英文按词，中文按 2-gram（不引第三方分词器，够用且零依赖）。
 */
function tokenizeForSearch(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []
  const ascii = lower.match(/[a-z0-9_./-]{2,}/g) ?? []
  tokens.push(...ascii)
  // 中文连续段落切 2-gram
  const cjkChunks = lower.match(/[\u4e00-\u9fa5]+/g) ?? []
  for (const chunk of cjkChunks) {
    if (chunk.length === 1) tokens.push(chunk)
    for (let i = 0; i + 1 < chunk.length; i += 1) tokens.push(chunk.slice(i, i + 2))
  }
  return tokens
}

interface DocUnit {
  path: string
  line: number
  text: string
  tokens: string[]
  length: number
}

/** 记忆目录的 mtime 指纹，用来判断 BM25 缓存是否失效 */
function docsSignature(root: string): string {
  const dir = memoryRoot(root)
  if (!existsSync(dir)) return ''
  const parts: string[] = []
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full, `${prefix}${name}/`)
        continue
      }
      if (name.endsWith('.md')) parts.push(`${prefix}${name}:${Math.round(stat.mtimeMs)}`)
    }
  }
  try {
    walk(dir, '')
  } catch {
    return ''
  }
  return parts.sort().join('|')
}

/** BM25 文档缓存：记忆目录没变就不用每次重扫 */
const docsCache = new Map<string, { signature: string; docs: DocUnit[] }>()

function getDocs(root: string): DocUnit[] {
  const signature = docsSignature(root)
  const cached = docsCache.get(root)
  if (cached && cached.signature === signature) return cached.docs
  const docs = collectDocs(root)
  docsCache.set(root, { signature, docs })
  return docs
}

/** 建一次索引（记忆文件一般几百行，够快） */
function collectDocs(root: string): DocUnit[] {
  const dir = memoryRoot(root)
  if (!existsSync(dir)) return []
  const docs: DocUnit[] = []
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full, `${prefix}${name}/`)
        continue
      }
      if (!name.endsWith('.md') || stat.size > 512 * 1024) continue
      const lines = readFileSync(full, 'utf8').replace(/^\uFEFF/, '').split('\n')
      lines.forEach((line, index) => {
        const text = line.trim()
        if (!text) return
        // 标题/引用/分隔线不进索引：它们太短，会把真正的内容挤下去
        if (/^#{1,6}\s/.test(text)) return
        if (/^>/.test(text)) return
        if (/^([-*_])\1{2,}$/.test(text)) return
        const cleaned = text.replace(/^[-*+]\s+/, '').replace(/^\[[ x]\]\s*/, '')
        const tokens = tokenizeForSearch(cleaned)
        if (tokens.length === 0) return
        docs.push({ path: `${MEMORY_DIR}/${prefix}${name}`, line: index + 1, text: cleaned.slice(0, 240), tokens, length: tokens.length })
      })
    }
  }
  walk(dir, '')
  return docs
}

/**
 * BM25 检索：比「包含 + 半词命中」稳得多，中文靠 2-gram 兜住。
 * 语义检索（向量）在 semanticIndex.ts 里，可用时优先，不可用回落到这里。
 */
export function searchMemory(root: string, query: string, limit = 20): MemoryHit[] {
  const queryTokens = tokenizeForSearch(query)
  if (queryTokens.length === 0) return []
  const docs = getDocs(root)
  if (docs.length === 0) return []

  const k1 = 1.2
  const b = 0.75
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length
  const df = new Map<string, number>()
  for (const doc of docs) {
    for (const token of new Set(doc.tokens)) df.set(token, (df.get(token) ?? 0) + 1)
  }

  const scored = docs.map((doc) => {
    const counts = new Map<string, number>()
    for (const token of doc.tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
    let score = 0
    for (const token of queryTokens) {
      const tf = counts.get(token)
      if (!tf) continue
      const idf = Math.log(1 + (docs.length - (df.get(token) ?? 0) + 0.5) / ((df.get(token) ?? 0) + 0.5))
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / (avgLength || 1))))
    }
    return { doc, score }
  })

  return scored
    .filter((item) => item.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, limit)
    .map((item) => ({ path: item.doc.path, line: item.doc.line, text: item.doc.text }))
}

/** 覆盖写 MEMORY.md（设置页编辑用） */
export function writeMemoryFile(root: string, content: string): void {
  ensureMemoryDir(root)
  writeFileSync(memoryPath(root), content, 'utf8')
}

/** 记忆目录里的文件清单（设置页展示用） */
export function listMemoryFiles(root: string): Array<{ path: string; size: number; mtime: number }> {
  const dir = memoryRoot(root)
  if (!existsSync(dir)) return []
  const out: Array<{ path: string; size: number; mtime: number }> = []
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name)
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full, `${prefix}${name}/`)
      else if (name.endsWith('.md')) out.push({ path: `${MEMORY_DIR}/${prefix}${name}`, size: stat.size, mtime: stat.mtimeMs })
    }
  }
  try {
    walk(dir, '')
  } catch {
    return []
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

export { LOG_CLIP }
