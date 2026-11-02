import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * 工作区里的「缓存目录」维护。
 *
 * .history/            每次写入/替换的备份，永不清理会一直涨
 * .tmp/agent-scripts/  agent 用 run_script 跑过的脚本，也一直堆着
 *
 * 策略（启动时跑一次，不阻塞窗口）：
 *   - .history：最多留 200 个文件，且只保留最近 30 天
 *   - .tmp/agent-scripts：最多留 50 个文件，且只保留最近 7 天
 */

const HISTORY_MAX_FILES = 200
const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const SCRIPT_MAX_FILES = 50
const SCRIPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface PruneRule {
  dir: string
  maxFiles: number
  maxAgeMs: number
}

async function pruneDir(rule: PruneRule): Promise<number> {
  let entries: Array<{ isFile(): boolean; name: string }>
  try {
    entries = await fs.readdir(rule.dir, { withFileTypes: true })
  } catch {
    return 0
  }

  const files: Array<{ path: string; mtime: number }> = []
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) return
      const full = join(rule.dir, entry.name)
      try {
        const st = await fs.stat(full)
        files.push({ path: full, mtime: st.mtimeMs })
      } catch {
        /* 被别的进程删掉了 */
      }
    })
  )

  files.sort((a, b) => b.mtime - a.mtime) // 新的在前
  const now = Date.now()
  let removed = 0

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]
    const tooMany = i >= rule.maxFiles
    const tooOld = now - file.mtime > rule.maxAgeMs
    if (!tooMany && !tooOld) continue
    try {
      await fs.unlink(file.path)
      removed += 1
    } catch {
      /* 忽略单个文件失败 */
    }
  }

  return removed
}

export interface PruneResult {
  historyRemoved: number
  scriptsRemoved: number
}

/** 清理工作区缓存，返回清掉的文件数 */
export async function pruneWorkspaceCaches(root: string): Promise<PruneResult> {
  const [historyRemoved, scriptsRemoved] = await Promise.all([
    pruneDir({ dir: join(root, '.history'), maxFiles: HISTORY_MAX_FILES, maxAgeMs: HISTORY_MAX_AGE_MS }),
    pruneDir({ dir: join(root, '.tmp', 'agent-scripts'), maxFiles: SCRIPT_MAX_FILES, maxAgeMs: SCRIPT_MAX_AGE_MS }),
  ])
  return { historyRemoved, scriptsRemoved }
}
