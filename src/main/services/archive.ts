import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { remember, type MemoryKind } from './memory'
import type { ArchiveRequest, ArchiveResult } from '@shared/types'

export type { ArchiveRequest, ArchiveResult }

/**
 * 归档服务：把一段内容落到 知识库/ 或 记忆/。
 *
 * 只做三件事：
 *  1. 知识库：生成路径（分类/标题.md），处理重名
 *  2. 记忆：fact / log / template 三种
 *  3. 撤销：记录写入前的状态，撤销时回滚
 *
 * 界面上所有“归档”入口（聊天勾选、编辑器右键、AI 提议）都走这里，
 * 避免出现两套路径规则。
 */


const KNOWLEDGE_DIR = '知识库'

function slug(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
  return cleaned || '未命名'
}

function today(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 列出 知识库/ 下的一级分类 */
export function listKnowledgeCategories(root: string): string[] {
  const dir = join(root, KNOWLEDGE_DIR)
  if (!existsSync(dir)) return []
  try {
    const { readdirSync, statSync, existsSync: exists } = require('node:fs') as typeof import('node:fs')
    const out: string[] = []
    // 递归两层以上也支持：拿到的是相对 知识库/ 的路径（如 运维/MySQL）
    const walk = (current: string, prefix: string, depth: number): void => {
      if (depth > 4) return
      for (const name of readdirSync(current)) {
        if (name.startsWith('.')) continue
        const full = join(current, name)
        try {
          if (!statSync(full).isDirectory()) continue
        } catch {
          continue
        }
        const rel = prefix ? `${prefix}/${name}` : name
        if (exists(join(full, '')) || true) out.push(rel)
        walk(full, rel, depth + 1)
      }
    }
    walk(dir, '', 0)
    return out.sort()
  } catch {
    return []
  }
}

/** 列出 知识库/ 下所有 markdown，返回相对路径（知识库 开头） */
export function listKnowledgeNotes(root: string, limit = 400): string[] {
  const dir = join(root, KNOWLEDGE_DIR)
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (current: string, prefix: string, depth: number): void => {
    if (out.length >= limit || depth > 6) return
    try {
      const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
      for (const name of readdirSync(current)) {
        if (name.startsWith('.')) continue
        const full = join(current, name)
        const stat = statSync(full)
        if (stat.isDirectory()) walk(full, `${prefix}${name}/`, depth + 1)
        else if (name.endsWith('.md')) out.push(`${KNOWLEDGE_DIR}/${prefix}${name}`)
        if (out.length >= limit) return
      }
    } catch {
      /* 跳过读不到的目录 */
    }
  }
  walk(dir, '', 0)
  return out.sort()
}

/** 把一段内容追加到已有文档末尾（不覆盖原文），返回撤销信息 */
export function appendToNote(
  root: string,
  relPath: string,
  section: string
): { ok: boolean; path: string; undo?: ArchiveResult['undo']; text: string } {
  const target = join(root, relPath)
  if (!existsSync(target)) return { ok: false, path: relPath, text: `找不到目标文档：${relPath}` }
  const previous = readFileSync(target, 'utf8')
  const merged = `${previous.trimEnd()}\n\n---\n\n${section.trim()}\n`
  writeFileSync(target, merged, 'utf8')
  return {
    ok: true,
    path: relPath,
    undo: { path: target, action: 'restore', previous },
    text: `已追加到 ${relPath}`,
  }
}

/** 列出 markdown 里的标题（含层级和行号），给「插入到某个小节之后」用 */
export function listHeadings(markdown: string): Array<{ level: number; text: string; line: number }> {
  const out: Array<{ level: number; text: string; line: number }> = []
  const lines = markdown.split('\n')
  let inFence = false
  lines.forEach((line, index) => {
    if (/^```/.test(line.trim())) inFence = !inFence
    if (inFence) return
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (match) out.push({ level: match[1].length, text: match[2], line: index })
  })
  return out
}

/**
 * 把一段内容插到指定标题之后（找该标题下一个同级或更高级标题，插在它前面）。
 * 找不到标题就退化为追加到文末。
 */
export function insertAfterHeading(markdown: string, headingLine: number, section: string): string {
  const lines = markdown.split('\n')
  const headings = listHeadings(markdown)
  const target = headings.find((item) => item.line === headingLine)
  if (!target) return `${markdown.trimEnd()}\n\n${section.trim()}\n`

  let insertAt = lines.length
  for (const item of headings) {
    if (item.line > target.line && item.level <= target.level) {
      insertAt = item.line
      break
    }
  }
  const before = lines.slice(0, insertAt).join('\n').trimEnd()
  const after = lines.slice(insertAt).join('\n')
  const merged = `${before}\n\n${section.trim()}\n`
  return after.trim() ? `${merged}\n${after.replace(/^\n+/, '')}` : merged
}

function uniquePath(dir: string, base: string): string {
  let candidate = join(dir, `${base}.md`)
  let index = 2
  while (existsSync(candidate)) {
    candidate = join(dir, `${base}-${index}.md`)
    index += 1
  }
  return candidate
}

export function archiveWrite(root: string, request: ArchiveRequest): ArchiveResult {
  const title = request.title.trim() || '未命名'
  const body = request.content

  if (request.target === 'memory') {
    const kind: MemoryKind = request.memoryKind ?? 'log'
    const result = remember(root, kind, body)
    return {
      ok: true,
      path: result.path,
      text: `已写入 ${result.path}`,
    }
  }

  // 知识库
  const category = (request.category ?? '').trim() || '未分类'
  const dir = join(root, KNOWLEDGE_DIR, category)
  mkdirSync(dir, { recursive: true })

  const existing = join(dir, `${slug(title)}.md`)
  let target = existing
  let undo: ArchiveResult['undo']

  if (existsSync(existing)) {
    if (request.onConflict === 'append') {
      const previous = readFileSync(existing, 'utf8')
      const appended = `${previous.trimEnd()}\n\n---\n\n${body.trim()}\n`
      writeFileSync(existing, appended, 'utf8')
      return {
        ok: true,
        path: `${KNOWLEDGE_DIR}/${category}/${basename(existing)}`,
        undo: { path: existing, action: 'restore', previous },
        text: `已追加到 ${KNOWLEDGE_DIR}/${category}/${basename(existing)}`,
      }
    }
    if (request.onConflict === 'overwrite') {
      const previous = readFileSync(existing, 'utf8')
      const frontmatter = [
        '---',
        `title: ${title}`,
        `date: ${today()}`,
        request.source ? `source: ${request.source}` : '',
        '---',
        '',
      ]
        .filter((line) => line !== '')
        .join('\n')
      writeFileSync(existing, `${frontmatter}\n${body.trim()}\n`, 'utf8')
      return {
        ok: true,
        path: `${KNOWLEDGE_DIR}/${category}/${basename(existing)}`,
        undo: { path: existing, action: 'restore', previous },
        text: `已覆盖 ${KNOWLEDGE_DIR}/${category}/${basename(existing)}`,
      }
    }
    // 默认改名
    target = uniquePath(dir, slug(title))
  }

  const frontmatter = [
    '---',
    `title: ${title}`,
    `date: ${today()}`,
    request.source ? `source: ${request.source}` : '',
    '---',
  ]
    .filter((line) => line !== '')
    .join('\n')
  writeFileSync(target, `${frontmatter}\n\n# ${title}\n\n${body.trim()}\n`, 'utf8')
  undo = { path: target, action: 'delete' }
  return {
    ok: true,
    path: `${KNOWLEDGE_DIR}/${category}/${basename(target)}`,
    undo,
    text: `已写入 ${KNOWLEDGE_DIR}/${category}/${basename(target)}`,
  }
}

/** 撤销一次归档 */
export function archiveUndo(root: string, undo: ArchiveResult['undo']): boolean {
  if (!undo) return false
  try {
    if (undo.action === 'delete') {
      if (existsSync(undo.path)) {
        const { unlinkSync } = require('node:fs') as typeof import('node:fs')
        unlinkSync(undo.path)
      }
      return true
    }
    if (undo.action === 'restore' && typeof undo.previous === 'string') {
      mkdirSync(dirname(undo.path), { recursive: true })
      writeFileSync(undo.path, undo.previous, 'utf8')
      return true
    }
    return false
  } catch {
    void root
    return false
  }
}
