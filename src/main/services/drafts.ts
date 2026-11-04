import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 归档草稿队列。
 *
 * 「先让 AI 总结」时不再立刻写盘：先生成草稿，等用户确认。
 * 草稿存在 <userData>/archive-drafts.json，不进工作区（避免污染，也别让 agent 读到）。
 */

export type DraftStatus = 'running' | 'pending' | 'written' | 'discarded' | 'failed'

export interface ArchiveDraft {
  id: string
  status: DraftStatus
  title: string
  /** 总结后的正文；总结失败时是原文 */
  content: string
  /** knowledge | memory */
  target: 'knowledge' | 'memory'
  category?: string
  memoryKind?: 'fact' | 'log' | 'template'
  source: string
  /** 追加到已有文档时，目标文件的相对路径（知识库/xxx.md） */
  mergeInto?: string
  /** append=只在文末追加；rewrite=AI 重组整篇后覆盖 */
  mode?: 'append' | 'rewrite'
  /** rewrite 模式下：原文档内容（用于 diff 与撤销） */
  baseContent?: string
  createdAt: number
  updatedAt: number
  error?: string
  /** 是否已经过 AI 总结 */
  summarized: boolean
}

let cache: ArchiveDraft[] | null = null

function filePath(userData: string): string {
  return join(userData, 'archive-drafts.json')
}

export function loadDrafts(userData: string): ArchiveDraft[] {
  if (cache) return cache
  const file = filePath(userData)
  if (!existsSync(file)) {
    cache = []
    return cache
  }
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as ArchiveDraft[]
    cache = Array.isArray(parsed) ? parsed : []
  } catch {
    cache = []
  }
  return cache
}

function persist(userData: string): void {
  if (!cache) return
  try {
    writeFileSync(filePath(userData), JSON.stringify(cache, null, 2), 'utf8')
  } catch {
    /* 写不进去也不影响内存里的队列 */
  }
}

export function createDraft(userData: string, input: Omit<ArchiveDraft, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'summarized'> & { summarized?: boolean; status?: DraftStatus }): ArchiveDraft {
  const list = loadDrafts(userData)
  const now = Date.now()
  const draft: ArchiveDraft = {
    ...input,
    id: `d_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    status: input.status ?? 'pending',
    summarized: input.summarized ?? false,
    createdAt: now,
    updatedAt: now,
  }
  list.unshift(draft)
  // 只保留最近 50 条，避免无限增长
  cache = list.slice(0, 50)
  persist(userData)
  return draft
}

export function updateDraft(userData: string, id: string, patch: Partial<ArchiveDraft>): ArchiveDraft | null {
  const list = loadDrafts(userData)
  const index = list.findIndex((item) => item.id === id)
  if (index < 0) return null
  list[index] = { ...list[index], ...patch, updatedAt: Date.now() }
  cache = list
  persist(userData)
  return list[index]
}

export function getDraft(userData: string, id: string): ArchiveDraft | null {
  return loadDrafts(userData).find((item) => item.id === id) ?? null
}

export function pendingCount(userData: string): number {
  return loadDrafts(userData).filter((item) => item.status === 'pending' || item.status === 'running').length
}
