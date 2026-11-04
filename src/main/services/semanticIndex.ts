/**
 * 记忆的语义检索（本地模型，不联网推理）。
 *
 * 用 @xenova/transformers 在进程内跑 bge-small-zh-v1.5：
 *  - 模型首次使用时下载到 <userData>/models，之后离线可用
 *  - 索引存 <userData>/memory-index.json（行级分块 + 向量）
 *  - 任何一步失败都返回 null，调用方回落到 BM25（memory.ts 里的 searchMemory）
 *
 * 之所以不放 SQLite：记忆量级是几百到几千行，JSON + 内存余弦足够，少一个原生依赖。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const MEMORY_DIR = '记忆'
const MODEL = 'Xenova/bge-small-zh-v1.5'
/** 改切词/分块逻辑时自增，让旧索引自动失效 */
const INDEX_VERSION = 2
const INDEX_FILE = 'memory-index.json'

interface IndexedLine {
  path: string
  line: number
  text: string
  vector: number[]
}

interface StoredIndex {
  model: string
  builtAt: number
  /** 建索引时各文件的 mtime，用来判断要不要重建 */
  signature: string
  lines: IndexedLine[]
}

type Extractor = (text: string | string[], options: Record<string, unknown>) => Promise<{
  data: Float32Array
  dims: number[]
}>

let extractorPromise: Promise<Extractor | null> | null = null
let indexCache: StoredIndex | null = null
let disabledReason: string | null = null

function indexPath(userData: string): string {
  return join(userData, INDEX_FILE)
}

/** 懒加载模型；失败只记一次原因，不重复尝试 */
async function getExtractor(userData: string): Promise<Extractor | null> {
  if (disabledReason) return null
  if (!extractorPromise) {
    extractorPromise = (async () => {
      try {
        const transformers = await import('@xenova/transformers')
        transformers.env.cacheDir = join(userData, 'models')
        transformers.env.allowLocalModels = true
        transformers.env.allowRemoteModels = true
        // 国内直连 huggingface 经常 ECONNRESET，默认走镜像；可用环境变量覆盖
        transformers.env.remoteHost = process.env.TH_HF_MIRROR ?? 'https://hf-mirror.com'
        const pipe = await transformers.pipeline('feature-extraction', MODEL)
        return pipe as unknown as Extractor
      } catch (err) {
        disabledReason = err instanceof Error ? err.message.slice(0, 200) : String(err)
        return null
      }
    })()
  }
  return extractorPromise
}

/** 记忆目录里所有行的 mtime 指纹 */
function memorySignature(root: string): string {
  const dir = join(root, MEMORY_DIR)
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

function collectLines(root: string): Array<{ path: string; line: number; text: string }> {
  const dir = join(root, MEMORY_DIR)
  if (!existsSync(dir)) return []
  const out: Array<{ path: string; line: number; text: string }> = []
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full, `${prefix}${name}/`)
        continue
      }
      if (!name.endsWith('.md') || stat.size > 512 * 1024) continue
      readFileSync(full, 'utf8')
        .replace(/^\uFEFF/, '')
        .split('\n')
        .forEach((line, index) => {
          const text = line.trim()
          // 标题、引用说明、分隔线不参与语义索引：它们没有检索价值，还会抢排名
          if (/^#{1,6}\s/.test(text)) return
          if (/^>/.test(text)) return
          if (/^([-*_])\1{2,}$/.test(text)) return
          const cleaned = text.replace(/^[-*+]\s+/, '').replace(/^\[[ x]\]\s*/, '')
          if (cleaned.length < 4) return
          out.push({ path: `${MEMORY_DIR}/${prefix}${name}`, line: index + 1, text: cleaned.slice(0, 240) })
        })
    }
  }
  walk(dir, '')
  return out
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

async function embed(extractor: Extractor, texts: string[]): Promise<number[][]> {
  const result: number[][] = []
  for (const text of texts) {
    const output = await extractor(text, { pooling: 'mean', normalize: true })
    result.push(Array.from(output.data))
  }
  return result
}

/** 建索引（幂等：签名没变就直接复用磁盘上的） */
export async function buildSemanticIndex(
  root: string,
  userData: string
): Promise<{ ok: boolean; lines?: number; reason?: string }> {
  const extractor = await getExtractor(userData)
  if (!extractor) return { ok: false, reason: disabledReason ?? '模型不可用' }

  const signature = `v${INDEX_VERSION}|${memorySignature(root)}`
  const cached = readIndex(userData)
  if (cached && cached.signature === signature && cached.model === MODEL) {
    return { ok: true, lines: cached.lines.length }
  }

  const rows = collectLines(root)
  if (rows.length === 0) return { ok: false, reason: '记忆目录还没有内容' }

  const vectors = await embed(extractor, rows.map((row) => row.text))
  const index: StoredIndex = {
    model: MODEL,
    builtAt: Date.now(),
    signature,
    lines: rows.map((row, i) => ({ ...row, vector: vectors[i] })),
  }
  mkdirSync(join(userData), { recursive: true })
  writeFileSync(indexPath(userData), JSON.stringify(index), 'utf8')
  indexCache = index
  return { ok: true, lines: index.lines.length }
}

function readIndex(userData: string): StoredIndex | null {
  if (indexCache) return indexCache
  const file = indexPath(userData)
  if (!existsSync(file)) return null
  try {
    indexCache = JSON.parse(readFileSync(file, 'utf8')) as StoredIndex
    return indexCache
  } catch {
    return null
  }
}

/** 语义检索：索引过期会先用旧索引兜住，不阻塞对话 */
export async function semanticSearch(
  root: string,
  userData: string,
  query: string,
  limit = 20
): Promise<Array<{ path: string; line: number; text: string }> | null> {
  const extractor = await getExtractor(userData)
  if (!extractor) return null
  let index = readIndex(userData)
  if (!index) {
    const built = await buildSemanticIndex(root, userData)
    if (!built.ok) return null
    index = readIndex(userData)
    if (!index) return null
  }
  const [vector] = await embed(extractor, [query])
  return index.lines
    .map((row) => ({ row, score: cosine(vector, row.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row }) => ({ path: row.path, line: row.line, text: row.text }))
}

/** 模块是否被打进包（devDependencies 不进安装包，这里能提前判断） */
function moduleAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    createRequire(import.meta.url).resolve('@xenova/transformers')
    return true
  } catch {
    return false
  }
}

export function semanticStatus(): { available: boolean; reason?: string } {
  if (!moduleAvailable()) {
    return { available: false, reason: '这个版本没有内置本地模型，检索走 BM25 关键词' }
  }
  return { available: !disabledReason, reason: disabledReason ?? undefined }
}
