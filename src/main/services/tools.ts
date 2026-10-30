import { existsSync, promises as fs, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { dayStamp } from './assets'
import { decodeText, encodeText, type Encoding, type Eol } from './encoding'
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

function resolveInRoot(ctx: ToolContext, p: string | undefined): string {
  const target = p && p.trim() ? join(ctx.root, p.trim()) : ctx.root
  return assertInside(ctx.root, target)
}

export async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const args = (rawArgs ?? {}) as Record<string, unknown>

  try {
    switch (name) {
      case 'list_dir': {
        const dir = resolveInRoot(ctx, args['path'] as string | undefined)
        const entries = await listTree(dir)
        const direct = entries.filter((e) => dirname(e.path) === dir)
        if (!direct.length) return { ok: true, text: `${dir} 是空目录。` }
        const lines = direct
          .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
          .map((e) => `${e.isDir ? '[目录]' : '[文件]'} ${e.name}${e.isDir ? '' : `  ${humanSize(e.size)}`}`)
        return { ok: true, text: `目录 ${dir}\n${lines.join('\n')}` }
      }

      case 'read_file': {
        const file = resolveInRoot(ctx, args['path'] as string)
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
        const file = resolveInRoot(ctx, args['path'] as string)
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
        const relPath = relative(ctx.root, file).split(sep).join('/')
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
          text: `已 ${summary} → ${relPath}${backup ? `（原文件备份在 ${relative(ctx.root, backup).split(sep).join('/')}）` : ''}`,
        }
      }

      case 'write_file': {
        const file = resolveInRoot(ctx, args['path'] as string)
        const content = String(args['content'] ?? '')
        if (content.length > 2_000_000) return { ok: false, text: '内容超过 2MB，拒绝写入。' }

        const relPath = relative(ctx.root, file).split(sep).join('/')
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
          text: `已写入 ${relative(ctx.root, file).split(sep).join('/')}（${content.length} 字符）${
            backup ? `，原文件备份在 ${relative(ctx.root, backup).split(sep).join('/')}` : ''
          }`,
        }
      }

      case 'write_new_file': {
        const target = resolveInRoot(ctx, args['path'] as string)
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
          text: `已新建 ${relative(ctx.root, target).split(sep).join('/')}（${content.length} 字符）`,
        }
      }

      case 'search_files': {
        const pattern = String(args['pattern'] ?? '')
        if (!pattern) return { ok: false, text: 'pattern 不能为空' }
        const re = new RegExp(pattern, 'i')
        const base = resolveInRoot(ctx, args['path'] as string | undefined)
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
        const file = resolveInRoot(ctx, args['path'] as string)
        await fs.access(file)
        ctx.openInEditor?.(file)
        return { ok: true, text: `已在编辑器中打开 ${relative(ctx.root, file).split(sep).join('/')}` }
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
    '工作方式：',
    '- 需要看文件就调用 read_file / list_dir，不要凭猜测回答。',
    '- 改已有文件优先用 apply_patch（只发改动的那几行）；只有整篇重写时才用 write_file。',
    '- 需要落盘就直接写到工作区，路径用相对路径；新建笔记默认写进日期目录。',
    '- 不确定位置时先用 search_files 找，再读。',
    '- 用户让你改代码时，改完用 open_in_editor 帮他打开。',
    '- 所有路径都限制在工作区内，越界会被拒绝。',
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


