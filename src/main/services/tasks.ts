import { appendFileSync, mkdirSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { AppConfig, TaskConfig, TaskEvent } from '@shared/types'
import { runAgent, type AgentMessage } from './agent'
import { loadConfig, patchConfig } from './config'

/** 定时任务只允许这几个工具：读 + 新建，绝不能改写既有文件 */
const TASK_TOOLS = ['list_dir', 'read_file', 'search_files', 'write_new_file']

/** 草稿目录扫描时跳过的：知识库本身、隐藏目录、依赖目录 */
const SKIP_DIRS = new Set(['知识库', 'node_modules', '.assets', '.history', '.tasks', '.git', 'out', 'dist'])
const DRAFT_EXT = new Set(['.md', '.txt', '.sql', '.log'])
const MAX_DRAFTS = 8

interface DraftEntry {
  rel: string
  /** 相对路径，给模型看 */
  mtime: number
}

/**
 * 只挑「上次运行之后新增或改过」的草稿。
 * 这样定时任务不会每次都把整个工作区重扫一遍，也不会重复整理老草稿。
 */
async function collectChangedDrafts(root: string, since: number): Promise<DraftEntry[]> {
  const found: DraftEntry[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const name = entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
        await walk(join(dir, name), depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
      if (!DRAFT_EXT.has(ext)) continue

      const full = join(dir, name)
      let st
      try {
        st = await stat(full)
      } catch {
        continue
      }
      // since 为 0（首次运行）时只看最近 7 天，避免把陈年老账全翻出来
      const cutoff = since > 0 ? since : Date.now() - 7 * 24 * 3600_000
      if (st.mtimeMs <= cutoff) continue
      found.push({ rel: relative(root, full).split(sep).join('/'), mtime: st.mtimeMs })
    }
  }

  await walk(root, 0)
  found.sort((a, b) => b.mtime - a.mtime)
  return found.slice(0, MAX_DRAFTS)
}

function stamp(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const TASK_SYSTEM_EXTRA = `你现在在后台执行一个定时任务，用户不在看着你。硬性约束：
- 绝对不允许修改、删除或覆盖任何已存在的文件。写文件只能用 write_new_file。
- 原稿只读，只能引用，不能改。
- 不要请求用户确认，直接把活干完；干不了就说明原因并停手。
- 最后用一段话总结你新建了哪些文件。`

/** 把「本次要处理的草稿」直接喂给模型，省掉 list_dir/search_files 这些步骤 */
function buildDraftPrompt(drafts: DraftEntry[], since: number): string {
  const list = drafts
    .map((d, i) => `${i + 1}. ${d.rel}（修改于 ${stamp(d.mtime)}）`)
    .join('\n')

  return `【定时任务：草稿知识整理】

下面是「上次运行（${since > 0 ? stamp(since) : '首次运行'}）之后新增或修改过」的草稿，已经扫描好了，**不要再 list_dir 或 search_files**：

${list}

请按这个流程做，预算最多 8 次工具调用：

1. 从列表里挑最有价值的 2–3 个，用 read_file 读（同一文件不要读两次）。
2. 提炼可复用的知识点（SQL 技巧、命令、配置项、排错结论等），按主题归类：
   知识库/<分类>/<简短标题>.md
   分类自拟，例如：SQL、PostgreSQL、Shell、运维排错。
3. 每篇写成这样：
   # <标题>
   > 来源：<草稿相对路径>（第 N 行附近）
   用 3-8 行把这个知识点讲清楚，脱离原稿也能看懂。
4. **最多新建 2 个知识文件**，只能用 write_new_file；目标已存在就换个名字，绝不覆盖。
5. 这些草稿里如果没什么值得沉淀的，就直接回答「本次没有需要沉淀的内容」，不要创建文件。
6. 完成后用一两句话说明新建了哪些文件，然后立即结束，不要再调用工具。`
}

export class TaskScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private startedAt = Date.now()
  private lastActivity = Date.now()
  private running = new Set<string>()
  private readonly emit: (event: TaskEvent) => void

  constructor(emit: (event: TaskEvent) => void) {
    this.emit = emit
  }

  start(): void {
    if (this.timer) return
    this.startedAt = Date.now()
    this.lastActivity = Date.now()
    this.timer = setInterval(() => void this.tick(), 30_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 渲染进程有交互时调用 */
  touch(): void {
    this.lastActivity = Date.now()
  }

  isRunning(id: string): boolean {
    return this.running.has(id)
  }

  /** 供 UI 展示：这个任务下次什么时候可能跑 */
  describe(task: TaskConfig): string {
    if (!task.enabled) return '已停用'
    if (this.running.has(task.id)) return '正在运行'
    if (task.trigger.kind === 'daily') return `每天 ${task.trigger.time}`
    const idleMin = task.trigger.minutes
    const since = Math.max(this.lastActivity, task.lastRunAt ?? 0)
    const next = since + idleMin * 60_000
    if (next <= Date.now()) return '等待触发'
    const minutes = Math.ceil((next - Date.now()) / 60_000)
    return `闲置 ${idleMin} 分钟后（约 ${minutes} 分钟后）`
  }

  private shouldRun(task: TaskConfig, cfg: AppConfig): boolean {
    const now = Date.now()

    if (task.trigger.kind === 'daily') {
      const [hour, minute] = task.trigger.time.split(':').map(Number)
      const target = new Date()
      target.setHours(hour, minute, 0, 0)
      if (now < target.getTime()) return false
      return !task.lastRunAt || task.lastRunAt < target.getTime()
    }

    const idleMs = task.trigger.minutes * 60_000
    const idleFor = now - this.lastActivity
    if (idleFor >= idleMs) {
      // 这个"闲置周期"里已经跑过就别重复
      return !task.lastRunAt || task.lastRunAt < this.lastActivity
    }

    // 启动补跑：应用关闭/闲置超过阈值，下次打开 90 秒后补一次
    if (!cfg.catchUpOnLaunch) return false
    const startedLongEnough = now - this.startedAt > 90_000
    const overdue = now - (task.lastRunAt ?? 0) >= idleMs
    return startedLongEnough && overdue
  }

  async tick(): Promise<void> {
    const cfg = loadConfig()
    for (const task of cfg.tasks) {
      if (!task.enabled || this.running.has(task.id)) continue
      if (!this.shouldRun(task, cfg)) continue
      await this.run(task, cfg)
    }
  }

  /** 手动触发（UI 的"立即运行"） */
  async runNow(id: string): Promise<void> {
    const cfg = loadConfig()
    const task = cfg.tasks.find((t) => t.id === id)
    if (!task) throw new Error('任务不存在')
    if (this.running.has(id)) throw new Error('该任务正在运行')
    await this.run(task, cfg)
  }

  private async run(task: TaskConfig, cfg: AppConfig): Promise<void> {
    this.running.add(task.id)
    this.emit({ id: task.id, name: task.name, phase: 'start' })

    const controller = new AbortController()
    let transcript = ''

    try {
      // 先自己扫一遍：只看上次运行之后新增/改过的草稿，没有就直接收工
      const since = task.lastRunAt ?? 0
      const drafts = await collectChangedDrafts(cfg.workspaceRoot, since)

      if (drafts.length === 0) {
        const summary = since > 0 ? '上次整理之后没有新增或更新的草稿。' : '没有找到最近 7 天内的草稿。'
        this.writeLog(cfg, task, 'ok', summary)
        this.patchTask(task.id, { lastRunAt: Date.now(), lastResult: summary })
        this.emit({ id: task.id, name: task.name, phase: 'done', message: summary })
        return
      }

      this.emit({
        id: task.id,
        name: task.name,
        phase: 'progress',
        message: `发现 ${drafts.length} 个新增/更新的草稿`,
      })

      const messages: AgentMessage[] = [
        { role: 'user', content: buildDraftPrompt(drafts, since) },
      ]

      const result = await runAgent({
        cfg,
        messages,
        signal: controller.signal,
        maxSteps: 16,
        allowedTools: TASK_TOOLS,
        systemExtra: TASK_SYSTEM_EXTRA,
        toolContext: {
          root: cfg.workspaceRoot,
          assetsDir: cfg.assetsDir,
        },
        events: {
          onDelta: (kind, text) => {
            if (kind === 'content') transcript += text
          },
          onTool: (event) => {
            if (event.phase === 'start') {
              this.emit({ id: task.id, name: task.name, phase: 'progress', message: `调用 ${event.name}` })
            }
          },
        },
      })

      const summary = (transcript.trim() || `完成（${result.steps} 步）`).slice(0, 900)
      this.writeLog(cfg, task, 'ok', summary)
      this.patchTask(task.id, { lastRunAt: Date.now(), lastResult: summary.slice(0, 120) })
      this.emit({ id: task.id, name: task.name, phase: 'done', message: summary })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.writeLog(cfg, task, 'error', message)
      this.patchTask(task.id, { lastRunAt: Date.now(), lastResult: `失败：${message.slice(0, 140)}` })
      this.emit({ id: task.id, name: task.name, phase: 'error', message })
    } finally {
      this.running.delete(task.id)
    }
  }

  private patchTask(id: string, patch: Partial<TaskConfig>): void {
    const cfg = loadConfig()
    const tasks = cfg.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task))
    patchConfig({ tasks })
  }

  private writeLog(cfg: AppConfig, task: TaskConfig, status: string, message: string): void {
    try {
      const dir = join(cfg.workspaceRoot, '.tasks')
      mkdirSync(dir, { recursive: true })
      const line = `${new Date().toISOString()} [${status}] ${task.name} (${task.id}) — ${message.replace(/\s+/g, ' ')}\n`
      appendFileSync(join(dir, 'run.log'), line, 'utf8')
    } catch {
      /* 日志失败不影响任务 */
    }
  }
}
