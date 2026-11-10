import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config'

/**
 * 飞书集成：封装官方 @larksuite/cli（lark-cli）。
 *
 * - CLI 不打包进安装包，检测全局安装或用 npm 装
 * - 只做四件事：状态、登录、拉取文档、整篇回写
 * - 所有命令都走 --as user，读/写风险由 CLI 自己标注
 */

const CLI_VERSION = '1.0.99'
const CLI_NAME = 'lark-cli'

export interface FeishuProgress {
  phase: 'install' | 'config' | 'login' | 'fetch' | 'push'
  message: string
  url?: string
  percent?: number
}

export interface FeishuStatus {
  installed: boolean
  configured: boolean
  cliPath?: string
  version?: string
  identity?: string
  error?: string
}

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

function cliCandidates(): string[] {
  const appData = process.env['APPDATA'] ?? ''
  const userProfile = process.env['USERPROFILE'] ?? ''
  return [
    process.env['LARK_CLI_PATH'] ?? '',
    appData ? join(appData, 'npm', 'lark-cli.cmd') : '',
    userProfile ? join(userProfile, 'AppData', 'Roaming', 'npm', 'lark-cli.cmd') : '',
    join(app.getPath('userData'), 'tools', 'lark-cli', 'lark-cli.cmd'),
  ].filter(Boolean)
}

export function findLarkCli(): string | null {
  for (const candidate of cliCandidates()) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

function quoteArg(value: string): string {
  if (!/[\s"&|<>^]/.test(value)) return value
  return '"' + value.replace(/"/g, '\\"') + '"'
}

/** 跑一条 lark-cli 命令；Windows 的 .cmd 需要经过 cmd.exe */
export function runLarkCli(
  args: string[],
  options: { timeoutMs?: number; onLine?: (line: string) => void; cwd?: string } = {}
): Promise<CliResult> {
  const cli = findLarkCli()
  if (!cli) return Promise.resolve({ code: -1, stdout: '', stderr: 'lark-cli 未安装' })
  const timeoutMs = options.timeoutMs ?? 120_000
  const command = [quoteArg(cli), ...args.map(quoteArg)].join(' ')

  return new Promise((resolve) => {
    const child =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/s', '/c', command], { windowsHide: true, cwd: options.cwd })
        : spawn(cli, args, { windowsHide: true, cwd: options.cwd })
    let stdout = ''
    let stderr = ''
    let finished = false
    const timer = setTimeout(() => {
      if (finished) return
      finished = true
      child.kill()
      resolve({ code: -1, stdout, stderr: stderr + '\n命令超时' })
    }, timeoutMs)

    let lineBuf = ''
    const handle = (chunk: Buffer, isErr: boolean): void => {
      const text = chunk.toString('utf8')
      if (isErr) stderr += text
      else stdout += text
      if (!options.onLine) return
      lineBuf += text
      const parts = lineBuf.split(/\r?\n/)
      lineBuf = parts.pop() ?? ''
      for (const line of parts) {
        const trimmed = line.trim()
        if (trimmed) options.onLine(trimmed)
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => handle(chunk, false))
    child.stderr?.on('data', (chunk: Buffer) => handle(chunk, true))
    child.on('error', (err) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + '\n' + String(err) })
    })
    child.on('close', (code) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown
  } catch {
    return null
  }
}

export async function feishuStatus(): Promise<FeishuStatus> {
  const cli = findLarkCli()
  if (!cli) return { installed: false, configured: false }
  const result = await runLarkCli(['auth', 'status'], { timeoutMs: 20_000 })
  const data = extractJson(result.stdout + '\n' + result.stderr) as
    | { ok?: boolean; identity?: string; error?: { message?: string } }
    | null
  return {
    installed: true,
    configured: data?.ok === true,
    cliPath: cli,
    version: CLI_VERSION,
    identity: data?.identity,
    error: data?.ok === true ? undefined : data?.error?.message ?? result.stderr.slice(0, 200),
  }
}

export async function installLarkCli(
  onProgress: (progress: FeishuProgress) => void
): Promise<{ ok: boolean; error?: string }> {
  if (findLarkCli()) return { ok: true }
  onProgress({ phase: 'install', message: '正在通过 npm 安装 lark-cli…' })
  const result = await runLarkCli(['--version'], { timeoutMs: 10_000 }).catch(() => null)
  // 没有 CLI 时只能走 npm；直接装固定版本，避免 @latest 漂移
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const child = spawn(npm, ['install', '-g', `@larksuite/cli@${CLI_VERSION}`], {
    windowsHide: true,
  })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  const code = await new Promise<number>((resolve) => {
    child.on('error', () => resolve(-1))
    child.on('close', (value) => resolve(value ?? -1))
  })
  if (!findLarkCli()) {
    return { ok: false, error: `安装失败：${output.slice(-300)}` }
  }
  onProgress({ phase: 'install', message: 'lark-cli 安装完成' })
  void result
  return { ok: true }
}

/** config init + auth login：把授权 URL 交给浏览器，等用户完成 */
export async function loginFeishu(
  onProgress: (progress: FeishuProgress) => void
): Promise<{ ok: boolean; error?: string }> {
  if (!findLarkCli()) return { ok: false, error: 'lark-cli 未安装' }
  const status = await feishuStatus()
  if (status.configured) return { ok: true }

  let opened = false
  const handleLine = (line: string): void => {
    const match = /https?:\/\/[^\s'"<>]+/.exec(line)
    if (match && !opened && /lark|feishu|open\.larksuite|accounts/.test(match[0])) {
      opened = true
      onProgress({ phase: 'login', message: '已打开授权页面，请在浏览器完成登录', url: match[0] })
      void shell.openExternal(match[0])
    } else if (line && !/^[█▀▄\s]+$/.test(line)) {
      onProgress({ phase: 'login', message: line.slice(0, 160) })
    }
  }

  onProgress({ phase: 'config', message: '正在初始化飞书应用（首次需要创建）…' })
  const init = await runLarkCli(['config', 'init', '--new'], {
    timeoutMs: 300_000,
    onLine: handleLine,
  })
  if (init.code !== 0) {
    return { ok: false, error: (init.stderr || init.stdout).slice(-400) || '初始化失败' }
  }

  opened = false
  onProgress({ phase: 'login', message: '正在登录飞书账号…' })
  // 只申请当前功能需要的域：文档读写 + 云空间读取；不要把 CLI 的全部 51 项权限都要过来
  const login = await runLarkCli(['auth', 'login', '--domain', 'docs,drive'], {
    timeoutMs: 300_000,
    onLine: handleLine,
  })
  if (login.code !== 0) {
    return { ok: false, error: (login.stderr || login.stdout).slice(-400) || '登录失败' }
  }
  const after = await feishuStatus()
  return after.configured ? { ok: true } : { ok: false, error: after.error ?? '登录未完成' }
}

export interface FeishuDocument {
  token: string
  revision: number
  content: string
  title: string
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim() || '飞书文档'
}

function titleFromMarkdown(markdown: string, fallback: string): string {
  const first = markdown.split('\n').find((line) => line.trim().startsWith('#'))
  return first ? first.replace(/^#+\s*/, '').trim() : fallback
}

export async function fetchFeishuDoc(doc: string): Promise<FeishuDocument> {
  const result = await runLarkCli(
    ['docs', '+fetch', '--doc', doc, '--doc-format', 'markdown', '--as', 'user'],
    { timeoutMs: 120_000 }
  )
  const data = extractJson(result.stdout + '\n' + result.stderr) as
    | {
        ok?: boolean
        data?: { document?: { document_id?: string; revision_id?: number; content?: string } }
        error?: { message?: string }
      }
    | null
  if (result.code !== 0 || !data?.ok || !data.data?.document?.content) {
    throw new Error(data?.error?.message ?? result.stderr.slice(-300) ?? '拉取失败')
  }
  const document = data.data.document
  const content = document.content ?? ''
  return {
    token: document.document_id ?? doc,
    revision: document.revision_id ?? -1,
    content,
    title: titleFromMarkdown(content, document.document_id ?? '飞书文档'),
  }
}

interface FeishuMap {
  docs: Record<string, { path: string; revision: number; title: string }>
}

async function readMap(workspaceRoot: string): Promise<FeishuMap> {
  const file = join(workspaceRoot, '.feishu.json')
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as FeishuMap
    return parsed && typeof parsed === 'object' && parsed.docs ? parsed : { docs: {} }
  } catch {
    return { docs: {} }
  }
}

async function writeMap(workspaceRoot: string, map: FeishuMap): Promise<void> {
  await fs.writeFile(join(workspaceRoot, '.feishu.json'), JSON.stringify(map, null, 2), 'utf8')
}

/** 拉取到工作区 飞书/ 目录，并记录 token → path 的映射 */
export async function pullFeishuDoc(
  doc: string
): Promise<{ ok: boolean; path?: string; title?: string; revision?: number; error?: string }> {
  const config = loadConfig()
  try {
    const fetched = await fetchFeishuDoc(doc)
    const dir = join(config.workspaceRoot, '飞书')
    await fs.mkdir(dir, { recursive: true })
    const file = join(dir, safeFileName(fetched.title) + '.md')
    await fs.writeFile(file, fetched.content, 'utf8')
    const map = await readMap(config.workspaceRoot)
    map.docs[fetched.token] = {
      path: file,
      revision: fetched.revision,
      title: fetched.title,
    }
    await writeMap(config.workspaceRoot, map)
    return { ok: true, path: file, title: fetched.title, revision: fetched.revision }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 整篇覆盖回写；调用前必须让用户确认（会丢失评论/图片等） */
export async function pushFeishuDoc(
  path: string,
  doc?: string
): Promise<{ ok: boolean; revision?: number; error?: string }> {
  const config = loadConfig()
  try {
    const content = await fs.readFile(path, 'utf8')
    const map = await readMap(config.workspaceRoot)
    const token =
      doc ??
      Object.entries(map.docs).find(([, value]) => value.path === path)?.[0] ??
      ''
    if (!token) return { ok: false, error: '找不到这篇文档对应的飞书 token，请在集成面板先拉取一次' }
    if (content.length > 20_000) {
      return { ok: false, error: '文档太长（超过 2 万字符），当前整篇覆盖模式暂不支持，请分段回写' }
    }
    const tempDir = await fs.mkdtemp(join(app.getPath('temp'), 'th-feishu-'))
    let result
    try {
      await fs.writeFile(join(tempDir, '_content.md'), content, 'utf8')
      result = await runLarkCli(
        [
          'docs',
          '+update',
          '--doc',
          token,
          '--command',
          'overwrite',
          '--doc-format',
          'markdown',
          '--content',
          '@./_content.md',
          '--as',
          'user',
        ],
        { timeoutMs: 120_000, cwd: tempDir }
      )
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
    const data = extractJson(result.stdout + '\n' + result.stderr) as
      | { ok?: boolean; data?: { document?: { revision_id?: number } }; error?: { message?: string } }
      | null
    if (result.code !== 0 || !data?.ok) {
      return { ok: false, error: data?.error?.message ?? result.stderr.slice(-300) ?? '回写失败' }
    }
    const revision = data.data?.document?.revision_id
    if (revision) {
      const entry = map.docs[token]
      if (entry) {
        entry.revision = revision
        await writeMap(config.workspaceRoot, map)
      }
    }
    return { ok: true, revision }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
