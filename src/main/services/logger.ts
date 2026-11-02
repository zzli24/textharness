import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 主进程日志。
 *
 * 以前只有设了 TH_LOG 环境变量才写日志，用户遇到白屏/启动失败时什么也拿不到。
 * 现在默认写到 <userData>/logs/main.log，并在超过 2MB 时轮转，最多保留 3 个文件。
 * 仍然支持 TH_LOG 覆盖（开发和排障时方便）。
 */

const MAX_BYTES = 2 * 1024 * 1024
const KEEP = 3

let logPath: string | null = null

export function initLogger(): string {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, 'main.log')
    if (existsSync(target) && statSync(target).size > MAX_BYTES) {
      // main.log → main.1.log → main.2.log
      for (let i = KEEP - 1; i >= 1; i -= 1) {
        const from = i === 1 ? target : `${target}.${i - 1}`
        const to = `${target}.${i}`
        if (existsSync(from)) {
          try {
            renameSync(from, to)
          } catch {
            /* 被占用就跳过这轮 */
          }
        }
      }
    }
    logPath = target
  } catch {
    logPath = null
  }
  return logPath ?? ''
}

export function currentLogPath(): string | null {
  return logPath
}

export function trace(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`

  if (logPath) {
    try {
      appendFileSync(logPath, line, 'utf8')
    } catch {
      /* 磁盘满/无权限时不要因为日志把主流程带崩 */
    }
  }

  const override = process.env['TH_LOG']
  if (override) {
    try {
      appendFileSync(override, line, 'utf8')
    } catch {
      /* ignore */
    }
  }
}
