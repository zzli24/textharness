import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from '@shared/types'

let cached: AppConfig | null = null

/**
 * 确保工作区可写。
 * Windows 的"受控文件夹访问"会拦住未签名程序写 Documents，加密盘、只读盘同理。
 * 这种情况下不能直接崩，退到 userData/workspace 并让调用方提示用户。
 */
function ensureWritable(dir: string): string {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, '.th-write-probe')
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
    return dir
  } catch {
    const fallback = join(app.getPath('userData'), 'workspace')
    try {
      mkdirSync(fallback, { recursive: true })
    } catch {
      /* 实在不行就先返回原路径，让上层报错 */
      return dir
    }
    return fallback
  }
}

function defaults(): AppConfig {
  return {
    workspaceRoot: join(app.getPath('documents'), 'TextHarness'),
    assetsDir: '.assets',
    defaultEncoding: 'utf8',
    theme: 'dark',
    aiWidth: 420,
    sideWidth: 180,
    llmBaseUrl: '',
    llmModel: '',
    llmApiKey: '',
    llmReasoning: 'auto',
    catchUpOnLaunch: true,
    bgImage: '',
    bgPreset: 0,
    bgOpacity: 0.4,
    bgBlur: 0,
    bgDim: 0.45,
    tasks: [
      {
        id: 'draft-kb',
        name: '草稿知识整理',
        enabled: true,
        // 应用 1 小时没有交互后，把草稿里的知识点整理进「知识库/」
        trigger: { kind: 'idle', minutes: 60 },
        lastRunAt: null,
      },
    ],
  }
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export function loadConfig(): AppConfig {
  if (cached) return cached
  let cfg: AppConfig
  try {
    // 有些编辑器/脚本会写出 UTF-8 BOM，JSON.parse 会直接抛错
    const raw = existsSync(configPath())
      ? JSON.parse(readFileSync(configPath(), 'utf8').replace(/^\uFEFF/, ''))
      : {}
    cfg = { ...defaults(), ...raw }
  } catch {
    cfg = defaults()
  }
  // 防御：config.json 被手动改坏、或被 undefined 覆盖过时，别让调度器直接崩
  if (!Array.isArray(cfg.tasks)) cfg.tasks = defaults().tasks
  cached = cfg
  const usable = ensureWritable(cfg.workspaceRoot)
  if (usable !== cfg.workspaceRoot) {
    cfg = { ...cfg, workspaceRoot: usable }
    cached = cfg
    try {
      writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8')
    } catch {
      /* ignore */
    }
  }
  return cfg
}

export function patchConfig(patch: Partial<AppConfig>): AppConfig {
  // undefined 不参与覆盖：前端传 { key: undefined } 时不能把已有值抹掉
  const clean: Partial<AppConfig> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (clean as Record<string, unknown>)[key] = value
  }
  const next: AppConfig = { ...loadConfig(), ...clean }
  if (!Array.isArray(next.tasks)) next.tasks = defaults().tasks
  cached = next
  try {
    writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* 写失败不阻塞运行 */
  }
  try {
    const usable = ensureWritable(next.workspaceRoot)
    if (usable !== next.workspaceRoot) next.workspaceRoot = usable
  } catch {
    /* ignore */
  }
  return next
}
