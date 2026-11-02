import { spawn } from 'node:child_process'
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { dayStamp } from './assets'
import { decodeText, encodeText } from './encoding'
import type { Encoding, Eol } from '@shared/types'
import { assertInside, listTree, looksBinary } from './files'

export interface ToolContext {
  root: string
  assetsDir: string
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
export const TOOL_DEFS = [
  {
    type: 'function' as const,
    function: {
      name: 'list_dir',
      description: '列出工作区某个目录下的文件和子目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的目录路径；留空表示工作区根目录' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_new_file',
      description:
        '在工作区里"新建"一个文件。如果目标已存在会直接失败——用于定时任务等只允许新增、不允许改写既有内容的场景。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的新文件路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'apply_patch',
      description:
        '精确修改已有文件里的某一段内容：把 old_text 替换成 new_text。比 write_file 更安全更省 token——只发改动部分，不用重抄整篇。old_text 必须在文件里唯一命中（不唯一就多带几行上下文）；确实要改多处时传 replace_all=true。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          old_text: { type: 'string', description: '要被替换的原文（尽量带上几行上下文，保证唯一）' },
          new_text: { type: 'string', description: '替换后的内容；传空字符串表示删除这段' },
          replace_all: { type: 'boolean', description: 'old_text 出现多次时是否全部替换，默认 false' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: '读取工作区内一个文本文件的内容，返回带行号的文本。文件较大时会分段返回，末尾会提示下一次该用哪个 offset 继续读；需要完整内容时请继续调用直到没有提示。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          offset: { type: 'number', description: '从第几行开始读（1 起），默认 1' },
          limit: { type: 'number', description: '最多读多少行，默认 2000（还会按字符数自动分段）' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description:
        '把内容写入工作区内的文件（不存在则创建，存在则覆盖）。覆盖前会自动备份到 .history。适合写笔记、脚本、SQL。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'replace_in_file',
      description:
        '按正则批量替换单个文件里的文本，一次调用改完所有命中。落盘前会把命中的前后对比给你看（工作区外的文件会先要写权限）。适合"把所有 X 改成 Y"这类规则化改动，比 apply_patch 一条条改省步数。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（工作区外用绝对路径）' },
          pattern: { type: 'string', description: '要匹配的正则表达式' },
          replacement: { type: 'string', description: '替换成什么；可用 $1 $2 引用分组，删掉命中就传空串' },
          ignore_case: { type: 'boolean', description: '是否忽略大小写，默认 false' },
        },
        required: ['path', 'pattern', 'replacement'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_script',
      description:
        '写一段 Node.js 脚本交给本机执行，适合处理大文件（整库 dump、日志、CSV）：统计、提取、批量改写、生成新文件。脚本通过 stdout 输出结果，运行时需要用户点一次确认。做批量文本处理时比反复调用 read_file 更省上下文。',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              '完整的 Node.js 脚本。require() 和 import 写法都支持（按出现的语法自动选择）。cwd 是工作区根目录，读写工作区外文件请用绝对路径。结果用 console.log 输出，尽量只打印摘要。',
          },
          timeout_ms: { type: 'number', description: '超时毫秒数，默认 20000，最大 120000' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'count_in_file',
      description:
        '在单个文件里统计：总行数、匹配某个正则的行数与次数，并可返回前若干条命中行。适合大文件（整库 dump、日志）里数 CREATE TABLE 之类，不用把全文读进上下文。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（工作区外会弹窗申请权限）' },
          pattern: { type: 'string', description: '正则表达式；留空则只统计总行数/大小' },
          ignore_case: { type: 'boolean', description: '是否忽略大小写，默认 true' },
          sample: { type: 'number', description: '返回前几条命中行，默认 20，最大 300' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_files',
      description: '在工作区里按正则搜索文本，返回命中的文件、行号和内容片段。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式' },
          path: { type: 'string', description: '限定搜索的子目录，留空表示整个工作区' },
          max_results: { type: 'number', description: '最多返回多少条，默认 40' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'open_in_editor',
      description: '把工作区里的一个文件在编辑器里打开（用户可见）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对工作区的文件路径' } },
        required: ['path'],
      },
    },
  },
]

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
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
        const file = await resolveToolPath(ctx, args['path'] as string, 'write')
        const content = String(args['content'] ?? '')
        if (content.length > 2_000_000) return { ok: false, text: '内容超过 2MB，拒绝写入。' }

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
        const target = await resolveToolPath(ctx, args['path'] as string, 'write')
        const content = String(args['content'] ?? '')
        if (content.length > 2_000_000) return { ok: false, text: '内容超过 2MB，拒绝写入。' }

        const { existsSync } = await import('node:fs')
        if (existsSync(target)) {
          return {
            ok: false,
            text: `目标已存在：${args['path']}。按规则只能新建、不能改写已有文件，请换一个文件名。`,
          }
        }

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

  return lines.join('\n')
}


