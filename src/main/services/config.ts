import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig, McpServerConfig } from '@shared/types'
import { backupConfig } from './configHistory'
import { trace } from './logger'

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
    autoCheckUpdate: true,
    splitRatio: 0.5,
    // 空数组表示用 defaultEnabledTools()，这样以后加工具不用改老配置
    providerProfiles: {},
    enabledTools: [],
    toolCap: 35,
    mcpServers: [],
    editorFontSize: 13,
    liveMarkdown: true,
    memorySemantic: false,
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
  if (!Array.isArray(cfg.enabledTools)) cfg.enabledTools = []
  if (!cfg.providerProfiles || typeof cfg.providerProfiles !== 'object') cfg.providerProfiles = {}
  if (typeof cfg.memorySemantic !== 'boolean') cfg.memorySemantic = false
  if (typeof cfg.editorFontSize !== 'number' || cfg.editorFontSize < 8 || cfg.editorFontSize > 28) {
    cfg.editorFontSize = 13
  }
  if (!Array.isArray(cfg.mcpServers)) cfg.mcpServers = [] as McpServerConfig[]
  if (typeof cfg.toolCap !== 'number' || cfg.toolCap < 5) cfg.toolCap = 35
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


/**
 * 写配置文件。
 *
 * Windows 上直接写目标文件偶尔会 EBUSY（杀软扫描、并发备份、编辑器占用），
 * 所以：先写 .tmp 再 rename 覆盖，失败重试几次；全失败就记日志（内存里仍然生效）。
 */
function writeConfigFile(config: AppConfig): void {
  const target = configPath()
  const temp = `${target}.tmp`
  const payload = JSON.stringify(config, null, 2)
  let lastError: unknown = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      writeFileSync(temp, payload, 'utf8')
      renameSync(temp, target)
      trace(`config 已写入 ${target}`)
      return
    } catch (err) {
      lastError = err
      // 退避一下再试，EBUSY 多半是瞬时的
      const until = Date.now() + 40 * (attempt + 1)
      while (Date.now() < until) {
        /* 忙等几十毫秒，避免引入异步把调用方改复杂 */
      }
    }
  }
  trace(`config 写入失败 ${target}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

export function patchConfig(patch: Partial<AppConfig>): AppConfig {
  // undefined 不参与覆盖：前端传 { key: undefined } 时不能把已有值抹掉
  const clean: Partial<AppConfig> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (clean as Record<string, unknown>)[key] = value
  }
  void backupConfig(configPath(), app.getPath('userData'))
  const next: AppConfig = { ...loadConfig(), ...clean }
  if (!Array.isArray(next.tasks)) next.tasks = defaults().tasks
  if (!Array.isArray(next.enabledTools)) next.enabledTools = []
  cached = next
  writeConfigFile(next)
  try {
    const usable = ensureWritable(next.workspaceRoot)
    if (usable !== next.workspaceRoot) next.workspaceRoot = usable
  } catch {
    /* ignore */
  }
  return next
}
