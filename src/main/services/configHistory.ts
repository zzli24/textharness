import { existsSync, mkdirSync } from 'node:fs'
import { copyFile, readdir, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'

/**
 * 配置文件的历史备份。
 *
 * agent 能改外观/工具开关之后，「改坏配置」成了真实风险。
 * 每次写配置前存一份到 <userData>/.config-history/，最多留 30 份。
 */

const KEEP = 30

export async function backupConfig(configPath: string, userDataDir: string): Promise<void> {
  try {
    if (!existsSync(configPath)) return
    const dir = join(userDataDir, '.config-history')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await copyFile(configPath, join(dir, `${stamp}__${basename(configPath)}`))
    await prune(dir)
  } catch {
    /* 备份失败不能影响主流程 */
  }
}

async function prune(dir: string): Promise<void> {
  try {
    const files = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()
    const extra = files.slice(0, Math.max(0, files.length - KEEP))
    for (const name of extra) {
      await unlink(join(dir, name)).catch(() => undefined)
    }
  } catch {
    /* ignore */
  }
}
