import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
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
  appId?: string
  version?: string
  identity?: string
  sheetsReady?: boolean
  sheetsScopeUrl?: string
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

/**
 * 跑一条 lark-cli 命令。
 * lark-cli 读写本地凭据时会加文件锁，几条命令同时跑（比如切到飞书时查状态 + 搜索 + 刷新）
 * 会报 "failed to acquire key storage lock"。所以：
 *  - 非交互命令排队一条一条跑
 *  - 碰到锁冲突自动重试两次
 * 交互命令（登录 / 安装，带 onLine 回调）不进队列，避免把搜索堵住。
 */
let cliQueue: Promise<unknown> = Promise.resolve()

export function runLarkCli(
  args: string[],
  options: { timeoutMs?: number; onLine?: (line: string) => void; cwd?: string; input?: string } = {}
): Promise<CliResult> {
  const attempt = async (): Promise<CliResult> => {
    let result = await runLarkCliOnce(args, options)
    for (let retry = 1; retry <= 2 && /acquire key storage lock|storage lock/i.test(result.stdout + result.stderr); retry += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400 * retry))
      result = await runLarkCliOnce(args, options)
    }
    return result
  }
  if (options.onLine) return attempt()
  const run = cliQueue.then(attempt, attempt)
  cliQueue = run.catch(() => undefined)
  return run
}

/** 从 lark-cli 的 JSON 输出里取出人能看懂的错误 */
export function cliErrorText(result: CliResult, fallback: string): string {
  const data = extractJson(result.stdout + '\n' + result.stderr) as
    | { error?: { message?: string; hint?: string } }
    | null
  const message = data?.error?.message
  if (message) {
    if (/acquire key storage lock/i.test(message)) return '飞书凭据被占用，请稍后再试'
    return data?.error?.hint ? message + '（' + data.error.hint + '）' : message
  }
  const text = (result.stderr || result.stdout).trim()
  return text ? text.slice(-200) : fallback
}

function runLarkCliOnce(
  args: string[],
  options: { timeoutMs?: number; onLine?: (line: string) => void; cwd?: string; input?: string } = {}
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
    if (options.input !== undefined) {
      child.stdin?.write(options.input)
      child.stdin?.end()
    }
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
  const [result, configResult] = await Promise.all([
    runLarkCli(['auth', 'status'], { timeoutMs: 20_000 }),
    runLarkCli(['config', 'show'], { timeoutMs: 15_000 }),
  ])
  const configData = extractJson(configResult.stdout + '\n' + configResult.stderr) as
    | { appId?: string }
    | null
  const data = extractJson(result.stdout + '\n' + result.stderr) as
    | {
        ok?: boolean
        identity?: string
        identities?: {
          user?: {
            status?: string
            tokenStatus?: string
            userName?: string
            available?: boolean
            scope?: string
          }
        }
        error?: { message?: string }
      }
    | null
  // auth status 成功时不一定带 ok:true，而是 identities.user.status = ready / tokenStatus = valid
  const user = data?.identities?.user
  const configured =
    data?.ok === true || user?.status === 'ready' || user?.tokenStatus === 'valid'
  const sheetsReady = (user?.scope ?? '').includes('sheets:spreadsheet:read')
  return {
    installed: true,
    configured,
    cliPath: cli,
    version: CLI_VERSION,
    appId: configData?.appId,
    identity: user?.userName ?? data?.identity,
    sheetsReady,
    sheetsScopeUrl: configData?.appId
      ? 'https://open.feishu.cn/page/scope-apply?clientID=' +
        encodeURIComponent(configData.appId) +
        '&scopes=sheets%3Aspreadsheet%3Aread'
      : undefined,
    error: configured ? undefined : data?.error?.message ?? result.stderr.slice(0, 200),
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
async function hasFeishuApp(): Promise<boolean> {
  const result = await runLarkCli(['config', 'show'], { timeoutMs: 15_000 })
  const data = extractJson(result.stdout + '\n' + result.stderr) as { appId?: string } | null
  return typeof data?.appId === 'string' && data.appId.startsWith('cli_')
}
export async function loginFeishu(
  onProgress: (progress: FeishuProgress) => void
): Promise<{ ok: boolean; error?: string }> {
  if (!findLarkCli()) return { ok: false, error: 'lark-cli 未安装' }
  const status = await feishuStatus()
  if (status.configured && status.sheetsReady !== false) return { ok: true }

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

  if (await hasFeishuApp()) {
    onProgress({ phase: 'config', message: '已检测到飞书应用，跳过创建，直接登录…' })
  } else {
    onProgress({ phase: 'config', message: '正在初始化飞书应用（首次需要创建）…' })
    const init = await runLarkCli(['config', 'init', '--new'], {
      timeoutMs: 300_000,
      onLine: handleLine,
    })
    if (init.code !== 0) {
      return { ok: false, error: (init.stderr || init.stdout).slice(-400) || '初始化失败' }
    }
  }

  opened = false
  onProgress({ phase: 'login', message: '正在登录飞书账号…' })
  // 只申请当前功能需要的域：文档/云空间/表格读取；不要把 CLI 的全部权限都要过来
  const login = await runLarkCli(['auth', 'login', '--domain', 'docs,drive,sheets'], {
    timeoutMs: 300_000,
    onLine: handleLine,
  })
  if (login.code !== 0) {
    return { ok: false, error: (login.stderr || login.stdout).slice(-400) || '登录失败' }
  }
  const after = await feishuStatus()
  return after.configured ? { ok: true } : { ok: false, error: after.error ?? '登录未完成' }
}


export async function switchFeishuApp(
  mode: 'new' | 'bind',
  payload: { appId?: string; appSecret?: string },
  onProgress: (progress: FeishuProgress) => void
): Promise<{ ok: boolean; error?: string }> {
  if (!findLarkCli()) return { ok: false, error: 'lark-cli 未安装' }
  onProgress({ phase: 'config', message: '正在清除当前应用和登录状态…' })
  await runLarkCli(['config', 'remove'], { timeoutMs: 30_000 })

  let opened = false
  const handleLine = (line: string): void => {
    const match = /https?:\/\/[^\s'"<>]+/.exec(line)
    if (match && !opened && /lark|feishu|open\.larksuite|accounts/.test(match[0])) {
      opened = true
      onProgress({ phase: 'config', message: '已打开应用配置页面，请在浏览器完成', url: match[0] })
      void shell.openExternal(match[0])
    } else if (line && !/^[█▀▄\s]+$/.test(line)) {
      onProgress({ phase: 'config', message: line.slice(0, 160) })
    }
  }

  if (mode === 'new') {
    onProgress({ phase: 'config', message: '正在打开飞书应用创建页面…' })
    const init = await runLarkCli(['config', 'init', '--new'], {
      timeoutMs: 300_000,
      onLine: handleLine,
    })
    if (init.code !== 0) {
      return { ok: false, error: (init.stderr || init.stdout).slice(-400) || '创建应用失败' }
    }
  } else {
    const appId = payload.appId?.trim()
    const appSecret = payload.appSecret?.trim()
    if (!appId || !appSecret) return { ok: false, error: '需要 App ID 和 App Secret' }
    onProgress({ phase: 'config', message: '正在绑定已有应用…' })
    const init = await runLarkCli(
      ['config', 'init', '--app-id', appId, '--app-secret-stdin'],
      { timeoutMs: 60_000, input: appSecret + '\n' }
    )
    if (init.code !== 0) {
      return { ok: false, error: (init.stderr || init.stdout).slice(-400) || '绑定应用失败' }
    }
  }

  return loginFeishu(onProgress)
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
  // 飞书返回的 <title> 才是真正的文档标题
  const tagged = /<title>([\s\S]*?)<\/title>/.exec(markdown)?.[1]?.trim()
  if (tagged) return tagged
  const first = markdown.split('\n').find((line) => line.trim().startsWith('#'))
  return first ? first.replace(/^#+\s*/, '').trim() : fallback
}


export interface FeishuSearchItem {
  title: string
  ref: string
  type: string
}

function stripHighlight(text: string): string {
  return text.replace(/<\/?hb?>/g, '').replace(/<[^>]+>/g, '').trim()
}

function findResultArray(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return []
  const obj = value as Record<string, unknown>
  if (Array.isArray(obj['results'])) return obj['results'] as Array<Record<string, unknown>>
  for (const child of Object.values(obj)) {
    const found = findResultArray(child)
    if (found.length) return found
  }
  return []
}

/** 搜索云空间里的文档/Wiki/表格；返回可直接喂给 docs +fetch 的 ref */
export async function searchFeishuDocs(
  query: string
): Promise<{ ok: boolean; items: FeishuSearchItem[]; error?: string }> {
  const result = await runLarkCli(
    ['drive', '+search', '--query', query, '--format', 'json', '--page-size', '20', '--as', 'user'],
    { timeoutMs: 60_000 }
  )
  const data = extractJson(result.stdout + '\n' + result.stderr)
  const results = findResultArray(data)
  if (result.code !== 0 && !results.length) {
    return { ok: false, items: [], error: cliErrorText(result, '搜索失败') }
  }
  const items: FeishuSearchItem[] = []
  for (const item of results) {
    const meta = (item['result_meta'] ?? {}) as Record<string, unknown>
    const title = stripHighlight(
      String(item['title_highlighted'] ?? item['title'] ?? meta['title'] ?? '未命名')
    )
    const url = String(meta['url'] ?? item['url'] ?? item['doc_url'] ?? '')
    const token = String(meta['token'] ?? item['token'] ?? item['obj_token'] ?? '')
    const type = String(meta['doc_types'] ?? item['entity_type'] ?? item['doc_type'] ?? '')
    const ref = url || token
    if (ref) items.push({ title, ref, type })
  }
  return { ok: true, items }
}

/** 批量拉取；单个失败不阻断其余 */
export async function pullFeishuDocs(
  refs: string[],
  onProgress?: (message: string, index: number, total: number) => void
): Promise<Array<{ ok: boolean; path?: string; title?: string; error?: string }>> {
  const results: Array<{ ok: boolean; path?: string; title?: string; error?: string }> = []
  for (let i = 0; i < refs.length; i += 1) {
    onProgress?.('正在拉取 ' + (i + 1) + '/' + refs.length + '…', i + 1, refs.length)
    const picked = await pullFeishuDoc(refs[i])
    results.push({
      ok: picked.ok,
      path: picked.path,
      title: picked.title,
      error: picked.error,
    })
  }
  return results
}


function sheetCellText(cell: unknown): string {
  if (cell === null || cell === undefined) return ''
  if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
    return String(cell)
  }
  if (typeof cell !== 'object') return ''
  const obj = cell as Record<string, unknown>
  if (typeof obj['text'] === 'string') return obj['text']
  if (typeof obj['value'] === 'string' || typeof obj['value'] === 'number') return String(obj['value'])
  if (Array.isArray(obj['segments'])) {
    return obj['segments']
      .map((segment) => (segment && typeof segment === 'object' ? String((segment as Record<string, unknown>)['text'] ?? '') : ''))
      .join('')
  }
  return ''
}

function findSheetValues(node: unknown): unknown[][] | null {
  if (Array.isArray(node)) {
    if (node.length && Array.isArray(node[0])) return node as unknown[][]
    // ranges 数组：元素是对象，不是行数组；要逐个往下找
    for (const item of node) {
      const found = findSheetValues(item)
      if (found) return found
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  const obj = node as Record<string, unknown>
  if (Array.isArray(obj['values'])) {
    const values = obj['values']
    if (values.length && Array.isArray(values[0])) return values as unknown[][]
  }
  // +cells-get 返回的是 ranges[].cells：二维数组，每个单元格是 { value, cell_styles }
  if (Array.isArray(obj['cells'])) {
    const cells = obj['cells']
    if (cells.length && Array.isArray(cells[0])) return cells as unknown[][]
  }
  for (const child of Object.values(obj)) {
    const found = findSheetValues(child)
    if (found) return found
  }
  return null
}

function tableToMarkdown(values: unknown[][]): string {
  const rows = values.map((row) => row.map((cell) => sheetCellText(cell)))
  while (rows.length && rows[rows.length - 1].every((cell) => !cell.trim())) rows.pop()
  if (!rows.length) return '> 飞书内嵌表格没有数据'
  const cols = Math.max(...rows.map((row) => row.length))
  for (const row of rows) while (row.length < cols) row.push('')
  const clean = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n+/g, '<br>').trim()
  const header = rows[0].map((cell, index) => clean(cell) || '列' + (index + 1))
  const body = rows.slice(1, 101)
  const lines = [
    '| ' + header.join(' | ') + ' |',
    '| ' + header.map(() => '---').join(' | ') + ' |',
    ...body.map((row) => '| ' + row.map(clean).join(' | ') + ' |'),
  ]
  if (rows.length > 101) lines.push('', '> 表格超过 100 行，已截断')
  return lines.join('\n')
}

async function readEmbeddedSheet(token: string, sheetId: string): Promise<string> {
  const result = await runLarkCli(
    [
      'sheets',
      '+cells-get',
      '--spreadsheet-token',
      token,
      '--sheet-id',
      sheetId,
      '--range',
      'A1:Z300',
      '--format',
      'json',
      '--as',
      'user',
    ],
    { timeoutMs: 60_000 }
  )
  const data = extractJson(result.stdout + '\n' + result.stderr)
  const values = findSheetValues(data)
  if (!values) {
    const error = extractJson(result.stdout + '\n' + result.stderr) as
      | { error?: { message?: string; missing_scopes?: string[] } }
      | null
    const missing = error?.error?.missing_scopes?.join(', ')
    throw new Error(
      missing ? '缺少表格权限（' + missing + '），请重新点「登录飞书」授权' : '表格读取失败'
    )
  }
  return tableToMarkdown(values)
}

async function expandEmbeddedSheets(markdown: string): Promise<string> {
  const matches = Array.from(markdown.matchAll(/<sheet\b([^>]*?)(?:\/>|><\/sheet>)/g))
  let expanded = markdown
  for (const match of matches.slice(0, 8)) {
    const attrs = match[1]
    const token = /token="([^"]+)"/.exec(attrs)?.[1]
    const sheetId = /sheet-id="([^"]+)"/.exec(attrs)?.[1]
    if (!token || !sheetId) continue
    try {
      const table = await readEmbeddedSheet(token, sheetId)
      expanded = expanded.replace(match[0], '\n\n' + table + '\n\n')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expanded = expanded.replace(
        match[0],
        '\n\n> 内嵌表格读取失败：' + message + '\n\n'
      )
    }
  }
  return expanded
}


/**
 * 飞书 Markdown 里残留的 XML 块转成本地好读的 Markdown：
 *  - <title>标题</title>             → 删除（正文第一行已经有 H1，没有时补一个）
 *  - <callout emoji="💡">…</callout> → > [!NOTE] 💡 引用块（即时渲染里显示为高亮框）
 *  - <blockquote><p>…</p></blockquote> → > …
 *  - <cite title="x" doc-id="y">     → [x](https://feishu.cn/docx/y)
 *  - <figure><source name="a.yml">   → 📎 a.yml（附件，保留文件名）
 * 代码块里的内容不动。
 */
export function normalizeFeishuMarkdown(markdown: string): string {
  const parts = markdown.split(/(^\s*```[\s\S]*?^\s*```[^\n]*$)/m)
  const convert = (text: string): string => {
    let out = text

    const title = /<title>([\s\S]*?)<\/title>\s*/.exec(out)
    if (title) {
      out = out.replace(title[0], '')
      // 飞书文档标题不在正文里；正文第一个 H1 往往是「一、xxx」这种章节标题，不能当文档标题
      const name = title[1].trim()
      const firstH1 = /^\s*#\s+(.+)$/m.exec(out)?.[1]?.trim()
      if (name && firstH1 !== name) out = '# ' + name + '\n\n' + out
    }

    out = out.replace(/<callout\b([^>]*)>([\s\S]*?)<\/callout>/g, (_m, attrs: string, body: string) => {
      const emoji = /emoji="([^"]*)"/.exec(attrs)?.[1] ?? '💡'
      const inner = body
        .replace(/<\/?p>/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      const lines = inner.split('\n').map((line) => (line.trim() ? '> ' + line : '>'))
      return '\n> [!NOTE] ' + emoji + '\n' + lines.join('\n') + '\n'
    })

    out = out.replace(/<blockquote>([\s\S]*?)<\/blockquote>/g, (_m, body: string) => {
      const inner = body.replace(/<\/?p>/g, '\n').replace(/\n{2,}/g, '\n').trim()
      return inner
        .split('\n')
        .map((line) => '> ' + line.trim())
        .join('\n')
    })

    out = out.replace(/<cite\b([^>]*)>(?:<\/cite>)?/g, (_m, attrs: string) => {
      const name = /title="([^"]*)"/.exec(attrs)?.[1] ?? '飞书文档'
      const id = /doc-id="([^"]*)"/.exec(attrs)?.[1]
      const type = /file-type="([^"]*)"/.exec(attrs)?.[1] ?? 'docx'
      return id ? '[' + name + '](https://feishu.cn/' + type + '/' + id + ')' : name
    })

    out = out.replace(/<figure\b[^>]*>([\s\S]*?)<\/figure>/g, (_m, body: string) => {
      const names = Array.from(body.matchAll(/<source\b[^>]*name="([^"]*)"/g)).map((m) => m[1])
      return names.length ? names.map((name) => '📎 附件：' + name).join('\n') : ''
    })

    return out.replace(/\n{4,}/g, '\n\n\n')
  }
  return parts.map((part, index) => (index % 2 === 1 ? part : convert(part))).join('')
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
    throw new Error(cliErrorText(result, '拉取失败'))
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

interface FeishuMapEntry {
  path: string
  revision: number
  title: string
  /** 拉取 / 回写时本地内容的 sha1：和当前文件比较，判断本地是否改过 */
  hash?: string
  url?: string
  pulledAt?: number
}

interface FeishuMap {
  docs: Record<string, FeishuMapEntry>
}

function hashText(text: string): string {
  return createHash('sha1').update(text.replace(/\r\n/g, '\n')).digest('hex')
}

function normPath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

function docUrlOf(token: string, ref: string): string {
  if (/^https?:\/\//.test(ref)) return ref.split('#')[0]
  return 'https://feishu.cn/docx/' + token
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
): Promise<{ ok: boolean; path?: string; title?: string; revision?: number; backup?: string; error?: string }> {
  const config = loadConfig()
  try {
    const fetched = await fetchFeishuDoc(doc)
    const content = normalizeFeishuMarkdown(await expandEmbeddedSheets(fetched.content))
    const dir = join(config.workspaceRoot, '飞书')
    await fs.mkdir(dir, { recursive: true })
    const map = await readMap(config.workspaceRoot)
    const existing = map.docs[fetched.token]

    // 同一篇文档：沿用原来的文件（即使改过名）；不同文档但标题相同：另起文件名，不覆盖别人的
    let file = existing?.path ?? join(dir, safeFileName(fetched.title) + '.md')
    if (!existing) {
      const taken = new Set(Object.values(map.docs).map((entry) => normPath(entry.path)))
      let n = 2
      const base = safeFileName(fetched.title)
      while (taken.has(normPath(file))) {
        file = join(dir, base + ' (' + n + ').md')
        n += 1
      }
    }

    // 本地改过还没回写：先留一份备份，避免拉取直接覆盖掉修改
    let backup: string | undefined
    if (existing?.hash) {
      const current = await fs.readFile(file, 'utf8').catch(() => null)
      if (current !== null && hashText(current) !== existing.hash) {
        backup = file.replace(/\.md$/i, '') + '.本地修改-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '') + '.md'
        await fs.writeFile(backup, current, 'utf8')
      }
    }

    await fs.writeFile(file, content, 'utf8')
    map.docs[fetched.token] = {
      path: file,
      revision: fetched.revision,
      title: fetched.title,
      hash: hashText(content),
      url: docUrlOf(fetched.token, doc),
      pulledAt: Date.now(),
    }
    await writeMap(config.workspaceRoot, map)
    return { ok: true, path: file, title: fetched.title, revision: fetched.revision, backup }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 回写前把本地写法还原成飞书能识别的块：
 *  > [!NOTE] 💡   →   <callout emoji="💡">…</callout>
 * 其他内容原样上传。代码块里的内容不动。
 */
export function toFeishuMarkdown(markdown: string): string {
  const icons: Record<string, string> = { note: '💡', tip: '✅', important: '📌', warning: '⚠️', caution: '⛔' }
  const parts = markdown.split(/(^\s*```[\s\S]*?^\s*```[^\n]*$)/m)
  const convert = (text: string): string => {
    const lines = text.split('\n')
    const out: string[] = []
    for (let i = 0; i < lines.length; i += 1) {
      const head = /^\s*>\s?\[!(note|tip|important|warning|caution)\]\s*(.*)$/i.exec(lines[i])
      if (!head) {
        out.push(lines[i])
        continue
      }
      const rest = head[2].trim()
      const emojiMatch = /^(\p{Extended_Pictographic}\uFE0F?)\s*(.*)$/u.exec(rest)
      const emoji = emojiMatch?.[1] ?? icons[head[1].toLowerCase()] ?? '💡'
      const body: string[] = []
      const first = emojiMatch ? emojiMatch[2] : rest
      if (first) body.push(first)
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) {
        i += 1
        body.push(lines[i].replace(/^\s*>\s?/, ''))
      }
      out.push('<callout emoji="' + emoji + '">', ...body, '</callout>')
    }
    return out.join('\n')
  }
  return parts.map((part, index) => (index % 2 === 1 ? part : convert(part))).join('')
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
      await fs.writeFile(join(tempDir, '_content.md'), toFeishuMarkdown(content), 'utf8')
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
      return { ok: false, error: cliErrorText(result, '回写失败') }
    }
    const revision = data.data?.document?.revision_id
    const entry = map.docs[token]
    if (entry) {
      if (revision) entry.revision = revision
      entry.hash = hashText(content)
      await writeMap(config.workspaceRoot, map)
    }
    return { ok: true, revision }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}


export type FeishuSyncState = 'synced' | 'modified' | 'missing'

export interface FeishuDocInfo {
  token: string
  path: string
  title: string
  revision: number
  url: string
  pulledAt?: number
  state: FeishuSyncState
}

async function infoOf(token: string, entry: FeishuMapEntry): Promise<FeishuDocInfo> {
  const current = await fs.readFile(entry.path, 'utf8').catch(() => null)
  let state: FeishuSyncState = 'synced'
  if (current === null) state = 'missing'
  else if (entry.hash && hashText(current) !== entry.hash) state = 'modified'
  return {
    token,
    path: entry.path,
    title: entry.title,
    revision: entry.revision,
    url: entry.url ?? docUrlOf(token, token),
    pulledAt: entry.pulledAt,
    state,
  }
}

/** 已拉取的飞书文档 + 本地同步状态（不访问网络） */
export async function listFeishuDocs(): Promise<FeishuDocInfo[]> {
  const config = loadConfig()
  const map = await readMap(config.workspaceRoot)
  const out: FeishuDocInfo[] = []
  for (const [token, entry] of Object.entries(map.docs)) out.push(await infoOf(token, entry))
  return out
}

/** 某个本地文件对应的飞书文档；不是飞书文档返回 null */
export async function feishuDocInfo(path: string): Promise<FeishuDocInfo | null> {
  const config = loadConfig()
  const map = await readMap(config.workspaceRoot)
  const wanted = normPath(path)
  const hit = Object.entries(map.docs).find(([, entry]) => normPath(entry.path) === wanted)
  return hit ? infoOf(hit[0], hit[1]) : null
}

/** 取云端最新内容（展开内嵌表格），给「查看差异 / 回写前确认」用 */
export async function feishuRemoteContent(
  path: string
): Promise<{ ok: boolean; content?: string; revision?: number; error?: string }> {
  try {
    const info = await feishuDocInfo(path)
    if (!info) return { ok: false, error: '这篇不是从飞书拉取的文档' }
    const fetched = await fetchFeishuDoc(info.token)
    const content = normalizeFeishuMarkdown(await expandEmbeddedSheets(fetched.content))
    return { ok: true, content, revision: fetched.revision }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
