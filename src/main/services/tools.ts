import { spawn } from 'node:child_process'
import { Script } from 'node:vm'
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { dayStamp } from './assets'
import { decodeText, encodeText } from './encoding'
import type { Encoding, Eol } from '@shared/types'
import { assertInside, listTree, looksBinary } from './files'
import { deleteSession, listSessions } from './sessions'
import { readMemory, remember, searchMemory } from './memory'
import { TOOL_DEFS } from './toolSchemas'

export { TOOL_DEFS }

export interface ToolContext {
  root: string
  assetsDir: string
  /** 应用数据目录（向量索引和模型缓存放这里） */
  userData?: string
  /** 记忆检索是否用向量（关掉走 BM25） */
  memorySemantic?: boolean
  /** 让渲染进程把文件在编辑器里打开 */
  openInEditor?(path: string): void
  /**
   * 落盘前请用户确认（界面上展示 diff）。
   * 不提供就直接写——定时任务等无人值守场景就是这么用的。
   */
  approve?(request: PatchRequest): Promise<boolean>
  /**
   * 访问工作区外的文件前，问用户要一次权限。
   * 返回 'deny' 拒绝、'read' 只读、'write' 可读写；不提供就当拒绝。
   */
  requestAccess?(path: string, mode: 'read' | 'write'): Promise<'deny' | 'read' | 'write'>
  /** 读取编辑器当前选区（拿不到就返回 null） */
  getSelection?(): Promise<{ text: string; from: number; to: number; path: string | null } | null>
  /** 用新内容替换编辑器里的选区（可撤销） */
  replaceSelection?(text: string): Promise<boolean>
  /** 操作编辑器界面：state / setAppearance / closeTabs / openSettings / switchTab */
  appControl?(action: string, payload?: unknown): Promise<{ ok: boolean; data?: unknown; text: string }>
  /** 危险操作前确认（原生对话框），不提供就直接拒绝 */
  confirm?(title: string, detail: string): Promise<boolean>
  /** 调用外部 MCP 工具前确认（按服务器策略触发） */
  confirmMcpCall?(server: string, tool: string, args: unknown): Promise<boolean>
  /**
   * 写 知识库/ 或 记忆/ 前的授权闸门（这两个目录是「归档区」，模型不能随手写）。
   * 返回 allow 本次放行、session 本轮放行、deny 拒绝；不提供就当拒绝。
   */
  archiveWrite?(path: string, summary: string): Promise<'allow' | 'session' | 'deny'>
  /**
   * 执行脚本前请用户确认（界面上展示代码）。
   * 不提供就直接拒绝——脚本能读写整台机器，必须有人看着。
   */
  approveScript?(request: ScriptRequest): Promise<boolean>
}

/** 需要用户确认才能执行的一段脚本 */
export interface ScriptRequest {
  /** 脚本源码 */
  code: string
  /** 超时时间（毫秒） */
  timeoutMs: number
  /** 脚本落在工作区的相对路径，便于用户事后查看 */
  scriptPath: string
}

/** 需要用户确认的一次改动 */
export interface PatchRequest {
  /** 相对工作区的路径 */
  path: string
  before: string
  after: string
  /** 改动摘要，例如「替换 1 处」 */
  summary: string
}

export interface ToolResult {
  ok: boolean
  text: string
}

const MAX_READ = 24_000
const MAX_SEARCH_FILE = 1_000_000
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.sql', '.json', '.jsonc', '.js', '.ts', '.mjs', '.cjs',
  '.py', '.sh', '.ps1', '.bat', '.yml', '.yaml', '.ini', '.conf', '.log', '.csv', '.tsv',
  '.html', '.css', '.xml', '.toml', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp',
])

/** 暴露给模型的工具定义（OpenAI function-calling 格式） */

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 在沙箱里跑用户/模型给的变换代码，2 秒超时 */
function runTextTransform(code: string, text: string): string {
  // 把调用也放进脚本里，这样 timeout 管得住死循环
  const source = `(function (text) {\n${code}\n})(__input)`
  const script = new Script(source, { filename: 'transform.js' })
  const result = script.runInNewContext({ __input: text }, { timeout: 2000 })
  if (typeof result !== 'string') throw new Error('code 必须 return 一个字符串')
  return result
}

/** 文本统计：行/词/字/中文/去重/最长行 */
function summarizeText(text: string, where: string): string {
  const lines = text.split('\n')
  const nonEmpty = lines.filter((line) => line.trim()).length
  const words = (text.match(/[A-Za-z0-9_]+/g) ?? []).length
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const unique = new Set(lines).size
  let longest = 0
  let longestLine = 0
  lines.forEach((line, index) => {
    if (line.length > longest) {
      longest = line.length
      longestLine = index + 1
    }
  })
  return [
    `${where}：`,
    `  行数 ${lines.length}（非空 ${nonEmpty}）`,
    `  去重后行数 ${unique}`,
    `  字符 ${text.length}，英文/数字词 ${words}，中文 ${cjk}`,
    `  最长行 ${longest} 字符（第 ${longestLine} 行）`,
  ].join('\n')
}

/** 用 Electron 自带的 Node 跑一段脚本（打包后 process.execPath 就是 app 自身） */
function runNodeScript(
  scriptPath: string,
  cwd: string,
  timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_NO_ATTACH_CONSOLE: '1',
        NODE_OPTIONS: '',
      },
    })

    const CAP = 24_000
    let stdout = ''
    let stderr = ''
    let timedOut = false

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < CAP) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < CAP) stderr += chunk.toString('utf8')
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `${stderr}\n启动失败：${String(err)}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    })
  })
}

function insideRoot(root: string, target: string): boolean {
  const r = resolve(root)
  const t = resolve(target)
  return t === r || t.startsWith(r + sep)
}

/** 展示用路径：工作区内显示相对路径，工作区外显示绝对路径（避免出现 ../../..） */
function displayPath(ctx: ToolContext, p: string): string {
  return insideRoot(ctx.root, p) ? relative(ctx.root, p).split(sep).join('/') : p
}

/**
 * 解析 agent 传来的路径：
 * - 工作区内：直接放行
 * - 工作区外：向用户申请一次权限（拒绝就抛错；只读授权不能写）
 * 授权由主进程记住，同一文件后续调用不会再问。
 */
/** 工作区里的「今天」目录名（和 AGENTS.md 约定一致：2026-11-03） */
function todayDirName(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 新建笔记时补默认目录：
 * 用户/模型只给了文件名（如 未命名-1.md）就落到 <工作区>/<今天>/ 下，
 * 避免笔记散落在工作区根目录。显式给了目录的路径不干预。
 */
function withDefaultNoteDir(root: string, rawPath: string): string {
  const trimmed = rawPath.trim()
  if (!trimmed) return trimmed
  const normalized = trimmed.replace(/\\/g, '/')
  if (normalized.includes('/')) return trimmed
  if (!/\.(md|markdown|txt)$/i.test(normalized)) return trimmed
  // 根目录已经有同名文件（例如 AGENTS.md）：保持原位，别复制出一份到日期目录
  if (existsSync(join(root, trimmed))) return trimmed
  return `${todayDirName()}/${trimmed}`
}

/** 归档区：知识库/ 与 记忆/。模型主动写这两个目录需要授权 */
const ARCHIVE_DIRS = ['知识库', '记忆']

function isArchivePath(root: string, target: string): boolean {
  const rel = target.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
  return ARCHIVE_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`))
}

/** 写归档区之前问一次；用户选「本轮都允许」后，本次会话内不再问 */
async function guardArchiveWrite(
  ctx: ToolContext,
  target: string,
  summary: string
): Promise<{ ok: true } | { ok: false; text: string }> {
  if (!isArchivePath(ctx.root, target)) return { ok: true }
  if (!ctx.archiveWrite) {
    return {
      ok: false,
      text: '写 知识库/ 或 记忆/ 需要用户授权，当前环境没有授权通道。请让用户用界面的「归档」按钮，或改用 propose_archive 提议。',
    }
  }
  const decision = await ctx.archiveWrite(target, summary)
  if (decision === 'deny') {
    return { ok: false, text: '用户拒绝了这次写入。不要换个路径重试，直接用 propose_archive 提议，或把内容放在回答里。' }
  }
  return { ok: true }
}

async function resolveToolPath(
  ctx: ToolContext,
  p: string | undefined,
  mode: 'read' | 'write' = 'read'
): Promise<string> {
  const target = p && p.trim() ? (isAbsolute(p.trim()) ? p.trim() : join(ctx.root, p.trim())) : ctx.root
  if (insideRoot(ctx.root, target)) return target

  const decision = ctx.requestAccess ? await ctx.requestAccess(target, mode) : 'deny'
  if (decision === 'deny') {
    throw new Error(
      `没有访问权限：${target} 在工作区之外，用户拒绝了这次申请。需要的话请用户用 Ctrl+O 打开，或再次征得同意。`
    )
  }
  if (mode === 'write' && decision === 'read') {
    throw new Error(`${target} 只拿到了只读权限，不能修改。`)
  }
  return target
}

export async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const args = (rawArgs ?? {}) as Record<string, unknown>

  try {
    switch (name) {
      case 'list_dir': {
        const dir = await resolveToolPath(ctx, args['path'] as string | undefined, 'read')
        const entries = await listTree(dir)
        const direct = entries.filter((e) => dirname(e.path) === dir)
        if (!direct.length) return { ok: true, text: `${dir} 是空目录。` }
        const lines = direct
          .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
          .map((e) => `${e.isDir ? '[目录]' : '[文件]'} ${e.name}${e.isDir ? '' : `  ${humanSize(e.size)}`}`)
        return { ok: true, text: `目录 ${dir}\n${lines.join('\n')}` }
      }

      case 'read_file': {
        const file = await resolveToolPath(ctx, args['path'] as string, 'read')
        const buf = await fs.readFile(file)
        if (looksBinary(buf)) return { ok: false, text: `${args['path']} 看起来是二进制文件，没有读取。` }
        const decoded = decodeText(buf)
        const allLines = decoded.text.split('\n')
        const offset = Math.max(1, Number(args['offset'] ?? 1))
        const limit = Math.min(Math.max(1, Number(args['limit'] ?? 2000)), 4000)
        const wantedEnd = Math.min(allLines.length, offset - 1 + limit)

        // 再按字符数兜一层：一次别把上下文撑爆，但要明确告诉模型"还有多少没读"
        let end = offset - 1
        let chars = 0
        while (end < wantedEnd) {
          const lineLen = allLines[end].length + 8
          if (chars + lineLen > MAX_READ && end > offset - 1) break
          chars += lineLen
          end += 1
        }

        const slice = allLines.slice(offset - 1, end)
        const numbered = slice
          .map((line, index) => `${String(offset + index).padStart(5)} | ${line}`)
          .join('\n')
        const tail =
          end < allLines.length
            ? `\n…（共 ${allLines.length} 行，已显示到第 ${end} 行；继续读请用 offset=${end + 1}）`
            : ''
        return {
          ok: true,
          text: `文件 ${args['path']}（${decoded.encoding}，${decoded.eol}，${allLines.length} 行）\n${numbered}${tail}`,
        }
      }

      case 'apply_patch': {
        const file = await resolveToolPath(ctx, args['path'] as string, 'write')
        const patchGate = await guardArchiveWrite(ctx, file, `修改 ${displayPath(ctx, file)}（apply_patch）`)
        if (!patchGate.ok) return { ok: false, text: patchGate.text }
        const oldText = String(args['old_text'] ?? '')
        const newText = String(args['new_text'] ?? '')
        const replaceAll = args['replace_all'] === true || args['replace_all'] === 'true'

        if (!oldText) return { ok: false, text: 'old_text 不能为空。要新建文件请用 write_new_file。' }

        let before = ''
        let meta: { encoding: Encoding; bom: boolean; eol: Eol } = { encoding: 'utf8', bom: false, eol: 'LF' }
        try {
          const decoded = decodeText(await fs.readFile(file))
          before = decoded.text
          // 保留原文件的编码 / BOM / 换行符，别把 CRLF 文件改成 LF
          meta = { encoding: decoded.encoding, bom: decoded.bom, eol: decoded.eol }
        } catch {
          return { ok: false, text: `${args['path']} 不存在，无法打补丁；新建文件请用 write_new_file。` }
        }

        const hits = before.split(oldText).length - 1
        if (hits === 0) {
          return {
            ok: false,
            text: '文件里找不到 old_text。请先用 read_file 确认原文（注意缩进和空白要完全一致）。',
          }
        }
        if (hits > 1 && !replaceAll) {
          return {
            ok: false,
            text: `old_text 在文件里出现了 ${hits} 次，无法确定改哪一处。请多带几行上下文让它唯一，或传 replace_all=true 全部替换。`,
          }
        }

        const after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText)
        const relPath = displayPath(ctx, file)
        const summary = `${replaceAll ? `替换全部 ${hits} 处` : '替换 1 处'}：${oldText.split('\n').length} 行 → ${
          newText === '' ? '删除' : `${newText.split('\n').length} 行`
        }`

        if (ctx.approve) {
          const ok = await ctx.approve({ path: relPath, before, after, summary })
          if (!ok) return { ok: false, text: `用户拒绝了这次对 ${relPath} 的修改，没有写入任何内容。` }
        }

        let backup = ''
        try {
          const historyDir = join(ctx.root, '.history')
          await fs.mkdir(historyDir, { recursive: true })
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          backup = join(historyDir, `${stamp}__${basename(file)}`)
          await fs.writeFile(backup, Buffer.from(before, 'utf8'))
        } catch {
          /* 备份失败不阻塞写入 */
        }

        await fs.writeFile(file, encodeText(after, meta).buffer)
        return {
          ok: true,
          text: `已 ${summary} → ${relPath}${backup ? `（原文件备份在 ${displayPath(ctx, backup)}）` : ''}`,
        }
      }

      case 'write_file': {
        const file = await resolveToolPath(ctx, withDefaultNoteDir(ctx.root, String(args['path'] ?? '')), 'write')
        const content = String(args['content'] ?? '')
        if (content.length > 2_000_000) return { ok: false, text: '内容超过 2MB，拒绝写入。' }

        const writeGate = await guardArchiveWrite(
          ctx,
          file,
          `写入 ${displayPath(ctx, file)}（${content.length} 字符）`
        )
        if (!writeGate.ok) return { ok: false, text: writeGate.text }

        const relPath = displayPath(ctx, file)
        let previous = ''
        try {
          previous = decodeText(await fs.readFile(file)).text
        } catch {
          /* 新文件 */
        }

        if (ctx.approve) {
          const ok = await ctx.approve({
            path: relPath,
            before: previous,
            after: content,
            summary: previous ? '整篇重写' : '新建文件',
          })
          if (!ok) return { ok: false, text: `用户拒绝了写入 ${relPath}，没有做任何修改。` }
        }

        let backup = ''
        try {
          const existing = await fs.readFile(file)
          const historyDir = join(ctx.root, '.history')
          await fs.mkdir(historyDir, { recursive: true })
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          backup = join(historyDir, `${stamp}__${basename(file)}`)
          await fs.writeFile(backup, existing)
        } catch {
          /* 新文件，不需要备份 */
        }

        await fs.mkdir(dirname(file), { recursive: true })
        const meta = { encoding: 'utf8' as const, bom: false, eol: 'LF' as const }
        await fs.writeFile(file, encodeText(content, meta).buffer)
        return {
          ok: true,
          text: `已写入 ${displayPath(ctx, file)}（${content.length} 字符）${
            backup ? `，原文件备份在 ${displayPath(ctx, backup)}` : ''
          }`,
        }
      }

      case 'write_new_file': {
        // 归档区（知识库/记忆）需要用户明确授权
        // 注意：先粗判，真正路径在下面 resolveToolPath 后再复核
        // 只给文件名时自动落到「今天」目录，别散在工作区根目录
        const notePath = withDefaultNoteDir(ctx.root, String(args['path'] ?? ''))
        const target = await resolveToolPath(ctx, notePath, 'write')
        const content = String(args['content'] ?? '')
        if (content.length > 2_000_000) return { ok: false, text: '内容超过 2MB，拒绝写入。' }

        const { existsSync } = await import('node:fs')
        if (existsSync(target)) {
          return {
            ok: false,
            text: `目标已存在：${args['path']}。按规则只能新建、不能改写已有文件，请换一个文件名。`,
          }
        }

        const gate = await guardArchiveWrite(ctx, target, `新建 ${displayPath(ctx, target)}（${content.length} 字符）`)
        if (!gate.ok) return { ok: false, text: gate.text }

        await fs.mkdir(dirname(target), { recursive: true })
        await fs.writeFile(target, encodeText(content, { encoding: 'utf8', bom: false, eol: 'LF' }).buffer)
        return {
          ok: true,
          text: `已新建 ${displayPath(ctx, target)}（${content.length} 字符）`,
        }
      }

      case 'replace_in_file': {
        const file = await resolveToolPath(ctx, args['path'] as string, 'write')
        const pattern = String(args['pattern'] ?? '')
        if (!pattern) return { ok: false, text: 'pattern 不能为空' }
        const replacement = String(args['replacement'] ?? '')
        const ignoreCase = args['ignore_case'] === true

        let re: RegExp
        try {
          re = new RegExp(pattern, ignoreCase ? 'gim' : 'gm')
        } catch {
          return { ok: false, text: `正则写错了：${pattern}` }
        }

        const buf = await fs.readFile(file)
        if (looksBinary(buf)) return { ok: false, text: `${displayPath(ctx, file)} 看起来是二进制文件。` }
        const decoded = decodeText(buf)
        const before = decoded.text

        // 逐行统计命中，同时攒一份"只含变化行"的预览（大文件也不会把确认框撑爆）
        const lines = before.split('\n')
        const previewBefore: string[] = []
        const previewAfter: string[] = []
        let hits = 0
        for (const line of lines) {
          re.lastIndex = 0
          if (!re.test(line)) continue
          re.lastIndex = 0
          const next = line.replace(re, replacement)
          if (next === line) continue
          hits += 1
          if (previewBefore.length < 300) {
            previewBefore.push(line)
            previewAfter.push(next)
          }
        }

        if (hits === 0) return { ok: false, text: `没有匹配 /${pattern}/，文件没动。` }

        const after = before.replace(re, replacement)
        if (after === before) return { ok: false, text: '替换后内容没有变化，文件没动。' }

        const dispPath = displayPath(ctx, file)
        if (ctx.approve) {
          const ok = await ctx.approve({
            path: dispPath,
            before: previewBefore.join('\n'),
            after: previewAfter.join('\n'),
            summary: `替换 ${hits} 处${previewBefore.length < hits ? `（预览前 ${previewBefore.length} 处）` : ''}`,
          })
          if (!ok) return { ok: false, text: `用户拒绝了替换 ${dispPath}，没有做任何修改。` }
        }

        let backup = ''
        try {
          const dir = join(ctx.root, '.history')
          await fs.mkdir(dir, { recursive: true })
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          backup = join(dir, `${stamp}__${basename(file)}`)
          await fs.writeFile(backup, buf)
        } catch {
          /* 备份失败不影响主流程 */
        }

        // decodeText 返回的是扁平结构，meta 要自己拼
        const meta = { encoding: decoded.encoding, bom: decoded.bom, eol: decoded.eol }
        const encoded = encodeText(after, meta)
        if (encoded.lossy) {
          return { ok: false, text: `当前编码（${decoded.encoding}）无法表示替换后的内容，文件没动。请改用 UTF-8 再试。` }
        }
        await fs.writeFile(file, encoded.buffer)
        const tail = backup ? `，原文件备份在 ${displayPath(ctx, backup)}` : ''
        return { ok: true, text: `已在 ${dispPath} 替换 ${hits} 处（预览前 ${previewBefore.length} 处）${tail}` }
      }

      case 'run_script': {
        const code = String(args['code'] ?? '')
        if (!code.trim()) return { ok: false, text: 'code 不能为空' }
        if (code.length > 200_000) return { ok: false, text: '脚本超过 200KB，拆小一点。' }

        const timeoutMs = Math.min(Math.max(1000, Number(args['timeout_ms'] ?? 20_000)), 120_000)
        if (!ctx.approveScript) {
          return { ok: false, text: '当前场景不允许运行脚本（无人值守），请改用 read_file / count_in_file。' }
        }

        // 模型有时写 require、有时写 import：按语法选扩展名，两种都能跑
        const isEsm = /^\s*(import|export)\s/m.test(code)
        const scriptRel = `.tmp/agent-scripts/run-${Date.now().toString(36)}.${isEsm ? 'mjs' : 'cjs'}`
        const scriptAbs = join(ctx.root, scriptRel)
        await fs.mkdir(dirname(scriptAbs), { recursive: true })
        await fs.writeFile(scriptAbs, code, 'utf8')

        const approved = await ctx.approveScript({ code, timeoutMs, scriptPath: scriptRel })
        if (!approved) return { ok: false, text: '用户拒绝了这次脚本执行，没有运行。' }

        const run = await runNodeScript(scriptAbs, ctx.root, timeoutMs)
        const chunks: string[] = []
        chunks.push(`${run.timedOut ? '超时被终止' : `退出码 ${run.code}`}（脚本：${scriptRel}）`)
        if (run.stdout.trim()) chunks.push('--- stdout ---', run.stdout.trim())
        if (run.stderr.trim()) chunks.push('--- stderr ---', run.stderr.trim())
        if (!run.stdout.trim() && !run.stderr.trim()) chunks.push('（没有任何输出）')
        return { ok: !run.timedOut && run.code === 0, text: chunks.join('\n') }
      }

      case 'list_images': {
        const base = await resolveToolPath(ctx, args['dir'] as string | undefined, 'read')
        const limit = Math.min(Math.max(Number(args['limit'] ?? 40), 1), 200)
        const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
        const found: Array<{ rel: string; size: number }> = []

        const walk = async (dir: string, depth: number): Promise<void> => {
          if (found.length >= limit || depth > 4) return
          let entries: Array<{ name: string; isDirectory(): boolean }>
          try {
            entries = await fs.readdir(dir, { withFileTypes: true })
          } catch {
            return
          }
          for (const entry of entries) {
            if (found.length >= limit) return
            if (entry.name.startsWith('.')) continue
            const full = join(dir, entry.name)
            if (entry.isDirectory()) {
              await walk(full, depth + 1)
              continue
            }
            if (!IMAGE_EXT.has(extname(entry.name).toLowerCase())) continue
            try {
              const stat = await fs.stat(full)
              if (stat.size > 16 * 1024 * 1024) continue
              found.push({ rel: displayPath(ctx, full), size: stat.size })
            } catch {
              /* ignore */
            }
          }
        }

        await walk(base, 0)
        if (found.length === 0) return { ok: true, text: '工作区里没有找到图片。' }
        const lines = found.map((item) => `${item.rel}  ${humanSize(item.size)}`)
        return { ok: true, text: `找到 ${found.length} 张图片：\n${lines.join('\n')}` }
      }

      case 'app_state': {
        const reply = await ctx.appControl?.('state')
        if (!reply) return { ok: false, text: '当前环境不支持读取编辑器状态。' }
        if (!reply.ok) return { ok: false, text: reply.text }
        return { ok: true, text: reply.text }
      }

      case 'set_appearance': {
        const patch: Record<string, unknown> = {}
        if (args['theme'] === 'dark' || args['theme'] === 'light') patch['theme'] = args['theme']
        if (typeof args['bgPreset'] === 'number') patch['bgPreset'] = Math.min(Math.max(Number(args['bgPreset']), 0), 5)
        if (typeof args['bgOpacity'] === 'number') patch['bgOpacity'] = Math.min(Math.max(Number(args['bgOpacity']), 0.05), 0.9)
        if (typeof args['bgBlur'] === 'number') patch['bgBlur'] = Math.min(Math.max(Number(args['bgBlur']), 0), 24)
        if (typeof args['bgDim'] === 'number') patch['bgDim'] = Math.min(Math.max(Number(args['bgDim']), 0), 0.85)
        if (typeof args['bgImage'] === 'string') {
          const raw = args['bgImage'].trim()
          if (!raw) {
            patch['bgImage'] = ''
          } else {
            const file = await resolveToolPath(ctx, raw, 'read')
            const ext = extname(file).toLowerCase()
            if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) {
              return { ok: false, text: `${raw} 不是图片文件。` }
            }
            const stat = await fs.stat(file)
            if (stat.size > 16 * 1024 * 1024) return { ok: false, text: '图片超过 16MB，先压缩一下。' }
            // config 里存相对工作区的路径
            patch['bgImage'] = displayPath(ctx, file)
            patch['bgPreset'] = 0
          }
        }
        if (Object.keys(patch).length === 0) return { ok: false, text: '没有要改的项。' }

        const reply = await ctx.appControl?.('setAppearance', patch)
        if (!reply) return { ok: false, text: '当前环境不支持修改外观。' }
        return { ok: reply.ok, text: reply.text }
      }

      case 'close_tabs': {
        const scope = String(args['scope'] ?? 'others')
        if (!['today', 'others', 'all', 'match'].includes(scope)) return { ok: false, text: `scope 不认识：${scope}` }
        const reply = await ctx.appControl?.('closeTabs', {
          scope,
          pattern: args['pattern'] ? String(args['pattern']) : '',
          includeDirty: args['includeDirty'] === true,
        })
        if (!reply) return { ok: false, text: '当前环境不支持关闭标签。' }
        return { ok: reply.ok, text: reply.text }
      }

      case 'open_settings': {
        const section = String(args['section'] ?? '')
        const reply = await ctx.appControl?.('openSettings', { section })
        if (!reply) return { ok: false, text: '当前环境不支持打开设置。' }
        return { ok: reply.ok, text: reply.text }
      }

      case 'remember': {
        const kindRaw = String(args['kind'] ?? 'fact')
        if (kindRaw !== 'fact' && kindRaw !== 'log' && kindRaw !== 'template') {
          return { ok: false, text: 'kind 只能是 fact / log / template' }
        }
        try {
          const result = remember(ctx.root, kindRaw, String(args['text'] ?? ''))
          const hint =
            kindRaw === 'fact'
              ? '（已写进 MEMORY.md，之后每轮对话都会带上）'
              : kindRaw === 'template'
                ? '（模板不进上下文，需要时用 read_file 读这个路径）'
                : '（写进当月日志，只注入最近几条）'
          return { ok: true, text: `已记到 ${result.path}：${result.text}${hint}` }
        } catch (err) {
          return { ok: false, text: err instanceof Error ? err.message : String(err) }
        }
      }

      case 'recall': {
        const query = String(args['query'] ?? '').trim()
        const limit = Math.min(Math.max(Number(args['limit'] ?? 10), 1), 50)
        let hits = searchMemory(ctx.root, query, limit)
        // 开了语义检索就先用向量；模型/索引不可用时静默回落到 BM25
        if (ctx.memorySemantic && ctx.userData && query) {
          try {
            const { semanticSearch } = await import('./semanticIndex')
            const semantic = await semanticSearch(ctx.root, ctx.userData, query, limit)
            if (semantic && semantic.length > 0) hits = semantic
          } catch {
            /* 回落 BM25 */
          }
        }
        if (hits.length === 0) return { ok: true, text: `记忆里没找到「${query}」。` }
        const lines = hits.map((hit) => `${hit.path}:${hit.line}  ${hit.text}`)
        return { ok: true, text: `记忆里找到 ${hits.length} 条：\n${lines.join('\n')}` }
      }

      case 'propose_mcp_server': {
        const raw = String(args['json'] ?? '').trim()
        if (!raw) return { ok: false, text: 'json 是空的' }
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>
        } catch (err) {
          return { ok: false, text: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}。让用户检查后再贴一次。` }
        }
        const source = (parsed['mcpServers'] as Record<string, unknown> | undefined) ?? parsed
        const names = Object.keys(source)
        const invalid = names.filter((name) => {
          const entry = source[name] as { command?: unknown; url?: unknown } | null
          const hasCommand = !!entry && typeof entry.command === 'string' && entry.command.trim().length > 0
          const hasUrl = !!entry && typeof entry.url === 'string' && entry.url.trim().length > 0
          return !hasCommand && !hasUrl
        })
        if (names.length === 0) return { ok: false, text: '没解析出任何服务器（缺 mcpServers 或为空）' }
        if (invalid.length > 0) {
          return { ok: false, text: `这些服务器既没有 command 也没有 url：${invalid.join(', ')}` }
        }
        if (!ctx.appControl) return { ok: false, text: '当前环境打不开确认框，请让用户去设置里手动添加' }

        const result = await ctx.appControl('proposeMcp', { json: raw, names })
        return {
          ok: true,
          text: result.ok
            ? `已解析出 ${names.length} 台服务器（${names.join('、')}），确认框已打开。等用户点「添加并连接」后才会写入配置；不要自己改配置。`
            : `确认框没打开：${result.text}`,
        }
      }

      case 'propose_archive': {
        const target = String(args['target'] ?? 'knowledge') === 'memory' ? 'memory' : 'knowledge'
        const title = String(args['title'] ?? '').trim() || '未命名'
        const content = String(args['content'] ?? '')
        if (!content.trim()) return { ok: false, text: 'content 是空的，没东西可归档。' }
        if (!ctx.appControl) {
          return { ok: false, text: '当前环境没法打开归档面板，请让用户用界面的「归档」按钮。' }
        }
        const result = await ctx.appControl('proposeArchive', {
          target,
          title,
          content,
          category: String(args['category'] ?? ''),
          memoryKind: String(args['memoryKind'] ?? 'log'),
        })
        return {
          ok: true,
          text: result.ok
            ? `已打开归档面板（${target === 'memory' ? '记忆' : '知识库'}｜${title}），等用户确认后才会写盘。不要自己再写文件。`
            : `归档面板没打开：${result.text}`,
        }
      }

      case 'clear_history': {
        const scope = String(args['scope'] ?? 'older')
        if (!['older', 'all'].includes(scope)) return { ok: false, text: `scope 不认识：${scope}` }
        const days = Math.min(Math.max(Number(args['days'] ?? 30), 1), 3650)
        const all = await listSessions()
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
        const doomed = scope === 'all' ? all : all.filter((session) => session.updatedAt < cutoff)
        if (doomed.length === 0) {
          return { ok: true, text: `没有需要清理的会话（共 ${all.length} 个）。` }
        }

        const label = scope === 'all' ? `全部 ${doomed.length} 个会话` : `${days} 天前的 ${doomed.length} 个会话`
        const ok = ctx.confirm ? await ctx.confirm('清理历史对话记录', `将删除${label}，此操作不可恢复。`) : false
        if (!ok) return { ok: false, text: '用户取消了清理，没有删除任何记录。' }

        let removed = 0
        for (const session of doomed) {
          try {
            deleteSession(session.id)
            removed += 1
          } catch {
            /* 单个失败不影响其它 */
          }
        }
        const left = await listSessions()
        return { ok: true, text: `已删除 ${removed} 个会话，还剩 ${left.length} 个。` }
      }

      case 'switch_tab': {
        const match = String(args['match'] ?? '')
        if (!match) return { ok: false, text: 'match 不能为空' }
        const reply = await ctx.appControl?.('switchTab', { match })
        if (!reply) return { ok: false, text: '当前环境不支持切换标签。' }
        return { ok: reply.ok, text: reply.text }
      }

      case 'transform_selection': {
        const code = String(args['code'] ?? '').trim()
        if (!code) return { ok: false, text: 'code 不能为空' }
        if (!ctx.getSelection || !ctx.replaceSelection) {
          return { ok: false, text: '当前环境拿不到编辑器选区。' }
        }

        const selection = await ctx.getSelection()
        if (!selection || !selection.text) {
          return { ok: false, text: '用户当前没有选中文本，先让他选一段再试。' }
        }

        let output = ''
        try {
          output = runTextTransform(code, selection.text)
        } catch (err) {
          return { ok: false, text: `变换代码出错：${err instanceof Error ? err.message : String(err)}` }
        }
        if (typeof output !== 'string') return { ok: false, text: 'code 必须 return 一个字符串。' }
        if (output === selection.text) return { ok: false, text: '变换后内容没有变化。' }

        if (ctx.approve) {
          const ok = await ctx.approve({
            path: '当前选区',
            before: selection.text.slice(0, 20000),
            after: output.slice(0, 20000),
            summary: args['note'] ? String(args['note']) : `选区替换（${selection.text.length} → ${output.length} 字符）`,
          })
          if (!ok) return { ok: false, text: '用户拒绝了这次替换，选区没动。' }
        }

        const applied = await ctx.replaceSelection(output)
        if (!applied) return { ok: false, text: '替换失败：编辑器没接受这次修改。' }
        return { ok: true, text: `已替换选区：${selection.text.length} → ${output.length} 字符（Ctrl+Z 可撤销）` }
      }

      case 'text_stats': {
        const target = args['path'] ? String(args['path']) : ''
        let text = ''
        let where = ''
        if (target) {
          const file = await resolveToolPath(ctx, target, 'read')
          const buf = await fs.readFile(file)
          if (looksBinary(buf)) return { ok: false, text: `${displayPath(ctx, file)} 看起来是二进制文件。` }
          text = decodeText(buf).text
          where = displayPath(ctx, file)
        } else {
          const selection = await ctx.getSelection?.()
          if (!selection || !selection.text.trim()) {
            return { ok: false, text: '当前没有选中文本，也没有给路径。' }
          }
          text = selection.text
          where = '当前选区'
        }
        return { ok: true, text: summarizeText(text, where) }
      }

      case 'count_in_file': {
        const file = await resolveToolPath(ctx, args['path'] as string, 'read')
        const pattern = String(args['pattern'] ?? '').trim()
        const ignoreCase = args['ignore_case'] !== false
        const sample = Math.min(Math.max(0, Number(args['sample'] ?? 20)), 300)

        const st = await fs.stat(file)
        if (st.size > 128 * 1024 * 1024) return { ok: false, text: `${displayPath(ctx, file)} 超过 128MB，先切分再看。` }
        const buf = await fs.readFile(file)
        if (looksBinary(buf)) return { ok: false, text: `${displayPath(ctx, file)} 看起来是二进制文件。` }
        const text = decodeText(buf).text
        const allLines = text.split('\n')

        const head = `${displayPath(ctx, file)}：${allLines.length} 行，${humanSize(st.size)}`
        if (!pattern) return { ok: true, text: head }

        let re: RegExp
        try {
          re = new RegExp(pattern, ignoreCase ? 'gi' : 'g')
        } catch {
          return { ok: false, text: `正则写错了：${pattern}` }
        }

        let matchedLines = 0
        let matchedCount = 0
        const samples: string[] = []
        for (let i = 0; i < allLines.length; i++) {
          const line = allLines[i]
          re.lastIndex = 0
          const hits = line.match(re)
          if (!hits) continue
          matchedLines += 1
          matchedCount += hits.length
          if (samples.length < sample) samples.push(`${i + 1}: ${line.trim().slice(0, 120)}`)
        }

        const parts = [head, `匹配 /${pattern}/ ：${matchedLines} 行，共 ${matchedCount} 次`]
        if (samples.length) parts.push('前几条：', ...samples)
        return { ok: true, text: parts.join('\n') }
      }

      case 'search_files': {
        const pattern = String(args['pattern'] ?? '')
        if (!pattern) return { ok: false, text: 'pattern 不能为空' }
        const re = new RegExp(pattern, 'i')
        const base = await resolveToolPath(ctx, args['path'] as string | undefined, 'read')
        const max = Math.min(Number(args['max_results'] ?? 40), 100)
        const all = await listTree(base)
        const matches: string[] = []

        for (const entry of all) {
          if (entry.isDir || matches.length >= max) continue
          const ext = extname(entry.name).toLowerCase()
          if (!TEXT_EXT.has(ext) || entry.size > MAX_SEARCH_FILE) continue
          let text: string
          try {
            const buf = await fs.readFile(entry.path)
            if (looksBinary(buf)) continue
            text = decodeText(buf).text
          } catch {
            continue
          }
          const lines = text.split('\n')
          for (let i = 0; i < lines.length && matches.length < max; i++) {
            if (re.test(lines[i])) {
              const rel = relative(ctx.root, entry.path).split(sep).join('/')
              matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 160)}`)
            }
          }
        }

        return {
          ok: true,
          text: matches.length ? `命中 ${matches.length} 条：\n${matches.join('\n')}` : `没有匹配「${pattern}」的内容。`,
        }
      }

      case 'open_in_editor': {
        const file = await resolveToolPath(ctx, args['path'] as string, 'read')
        await fs.access(file)
        ctx.openInEditor?.(file)
        return { ok: true, text: `已在编辑器中打开 ${displayPath(ctx, file)}` }
      }

      default:
        return { ok: false, text: `未知工具：${name}` }
    }
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) }
  }
}

export function buildSystemPrompt(ctx: ToolContext): string {
  const today = dayStamp()
  const lines = [
    '你是内嵌在「TextHarness」文本编辑器里的编码 agent，可以直接读写用户的工作区。',
    '',
    `工作区根目录：${ctx.root}`,
    `今天的日期目录：${join(ctx.root, today)}（新笔记默认放这里）`,
    `图片图库：${join(ctx.root, ctx.assetsDir, 'img', today)}`,
    '',
    '按场景选工具（选错会白耗步数）：',
    '- 数数量 / 探有没有匹配 → count_in_file',
    '- 改 1~3 处具体内容 → apply_patch',
    '- 按规则批量改（"把所有 X 删掉 / 改成 Y"）→ replace_in_file，一次改完所有命中',
    '- 整篇重写 → write_file',
    '- 大文件多步处理、生成新文件、跨文件统计 → run_script',
    '- 找文件 → search_files；看内容 → read_file（大文件配 offset）',
    '',
    '用户可能直接贴图或拖图进对话框，你能看到图片内容，直接根据图回答，不要说自己没有视觉能力。',
    '用户说"用我那张图当背景" → list_images 找图，再 set_appearance({ bgImage })。',
    '',
    '要留档时用 propose_archive 提议（界面会弹归档面板，用户确认才写），不要直接用 write_file 写 知识库/ 或 记忆/。',
    '只有用户明确说"存/记/归档"才提议；用户只是提问时，回答完就结束，不要顺手建文件。',
    '',
    '你还能操作编辑器本身（不是文件）：',
    '- 用户问"我开了几个页面/这个文件改过没/我什么主题" → app_state',
    '- 用户说"换成深色/背景太亮/换个背景" → 直接 set_appearance，不要只给操作步骤',
    '- 用户说"关掉今天的页面/关掉其他标签" → close_tabs（未保存的默认跳过，别硬关）',
    '- 用户说"打开设置改模型" → open_settings，让用户自己填 Key',
    '',
    '判断标准：',
    '- 改动超过 3 处、或能用一条正则描述 → 用 replace_in_file（有预览，比脚本安全）',
    '- 需要计算、聚合、生成新文件时才用 run_script',
    '- 改完用 count_in_file 复查数量，不要把整篇读回来',
    '- 工作区外的文件照常调工具，界面会弹窗授权；不要一上来就说"我读不到"',
    '- 大文件读不完会告诉你还剩多少行，用 offset 继续；只为统计就别读全文',
    '',
    '纪律：',
    '- 同一个文件不要用同样的参数重复调用同一个工具',
    '- 动手前想清楚这一批要改什么；方向错了直接说明，不要盲目试工具',

    '',
    '新建笔记（.md/.markdown/.txt）时默认写到「今天」目录，例如 2026-11-03/未命名-1.md；不要直接放在工作区根目录。',
    '外部工具命名：MCP 服务器提供的工具叫「服务器名__工具名」（两个下划线），例如 db-kb__query；它们只在服务器连上后才出现在工具清单里。',
    '引用格式：提到工作区里的文件时写成 `相对路径:行号`（例如 知识库/MySQL/索引.md:12），',
    '界面上会渲染成可点击的链接，用户点一下就能跳到那一行。',
    '',
    '回答风格：中文、直接、可执行。代码用 markdown 代码块并注明语言。不要客套。',
  ]

  // 项目规则：工作区根目录的 AGENTS.md 会原样进系统提示
  const agentsPath = join(ctx.root, 'AGENTS.md')
  try {
    if (existsSync(agentsPath)) {
      const raw = readFileSync(agentsPath, 'utf8').replace(/^\uFEFF/, '')
      const trimmed = raw.trim()
      if (trimmed) {
        const clipped = trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}\n…（AGENTS.md 太长，已截断）` : trimmed
        lines.push('', '---', '以下是工作区 AGENTS.md 里的项目约定，必须遵守：', clipped)
      }
    }
  } catch {
    /* 读不到就当没有 */
  }

  // 长期记忆：每次对话都注入，是常数开销，所以有截断
  try {
    const memory = readMemory(ctx.root)
    if (memory.facts) {
      lines.push('', '---', '以下是长期记忆（用户偏好/环境/禁忌），必须遵守：', memory.facts)
    }
    if (memory.recentLogs.length > 0) {
      lines.push('', '最近几次会话的结论：', ...memory.recentLogs.map((line) => line))
    }
    if (memory.templates.length > 0) {
      const names = memory.templates.slice(0, 12).map((item) => `${item.title} → ${item.path}`)
      lines.push(
        '',
        `记忆/模板 里有 ${memory.templates.length} 个模板（需要时 read_file 读取，不用猜内容）：`,
        ...names.map((name) => `- ${name}`)
      )
    }
    if (memory.facts || memory.recentLogs.length > 0) {
      lines.push(
        '',
        '记忆分三档，别混用：',
        '- fact：一两句稳定事实（偏好/环境/禁忌/约定），上限 200 字，写 MEMORY.md，每轮都带上',
        '- log：一次会话的结论，上限 800 字，写当月日志',
        '- template：多字段模板、表单、清单、长格式 → 写 记忆/模板/，不占上下文，用时 read_file',
        '判断口诀：每轮都用得上 → fact；只在特定任务用 → template；一次性结论 → log。',
        '用户贴一段长格式让你"记住"时，默认存成 template，不要塞 fact。',
        '不要在 MEMORY.md 里写「某模板在哪」这种指针：模板目录会自动列在系统提示里，指针只会让记忆变胖。',
        '',
        '要补充记忆用 remember；要查更早的记录用 recall。'
      )
    }
  } catch {
    /* 读不到就当没有记忆 */
  }

  return lines.join('\n')
}


