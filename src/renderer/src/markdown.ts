/**
 * 对话里的轻量 Markdown 渲染。
 *
 * 刻意做成"文档式"排版：标题、列表、代码卡片、表格，和 DSH 的对话观感一致。
 * 单独拆成模块，方便脚本直接跑测试（scripts/test-markdown.mjs）。
 */

const CITATION_EXT = 'md|markdown|txt|sql|json|csv|tsv|log|ts|js|mjs|py|sh|ps1|yml|yaml|ini|conf|html|css|go|rs|java'
// 1) 带目录的路径：目录段不含空格，文件名允许空格（用户的笔记名里常有空格）
// 2) 工作区根目录下的裸文件名：不允许空格，避免误吞普通词
const CITATION_RE = new RegExp(
  '(?<![\\w/:.-])(' +
    `(?:[^\\s/\\n]{1,24}/)+(?:[^/\\n]{1,80}?\\.(?:${CITATION_EXT}))` +
    `|[^\\s/\\n]{1,80}\\.(?:${CITATION_EXT})` +
    ')(?::(\\d+))?',
  'g'
)

/** 反引号里整段就是一个文件路径时，同样渲染成链接（模型很爱这么写） */
const CITATION_ONLY_RE = new RegExp(
  `^((?:[^\\s/\\n]{1,24}/)+(?:[^/\\n]{1,80}?\\.(?:${CITATION_EXT}))|[^\\s/\\n]{1,80}\\.(?:${CITATION_EXT}))(?::(\\d+))?$`
)

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 把 `路径:行号` 变成可点击跳转的链接 */
function linkCitations(text: string): string {
  return text.replace(CITATION_RE, (_match, path: string, line?: string) => {
    const attr = line ? ` data-line="${line}"` : ''
    return `<a class="cite" data-path="${path}"${attr}>${path}${line ? `:${line}` : ''}</a>`
  })
}

/** 行内格式：行内代码 / 加粗 / 文件引用链接 */
function inline(text: string): string {
  const parts = text.split(/(`[^`\n]+`)/)
  return parts
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`')) {
        const inner = part.slice(1, -1)
        // 整段就是文件路径时也做成链接，但保留等宽样式
        const only = CITATION_ONLY_RE.exec(inner)
        if (only) {
          const line = only[2]
          const attr = line ? ` data-line="${line}"` : ''
          return `<a class="cite code-cite" data-path="${only[1]}"${attr}>${inner}</a>`
        }
        return `<code>${inner}</code>`
      }
      return linkCitations(part)
    })
    .join('')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
}

/* ---------------- 表格 ---------------- */

/** 表格分隔行：|---|:--:|---:| */
function isTableDivider(line: string): boolean {
  const cells = splitTableRow(line)
  if (cells.length === 0) return false
  return cells.every((cell) => /^:?-{1,}:?$/.test(cell.trim()))
}

/** 拆一行表格：支持 `\|` 转义，去掉首尾的竖线 */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  if (!trimmed) return []
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

type Align = 'left' | 'center' | 'right'

function alignOf(cell: string): Align | null {
  const text = cell.trim()
  const left = text.startsWith(':')
  const right = text.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

function cellHtml(tag: 'th' | 'td', text: string, align: Align | null): string {
  const cls = align ? ` class="al-${align}"` : ''
  return `<${tag}${cls}>${inline(text)}</${tag}>`
}

function renderTable(header: string[], aligns: Array<Align | null>, body: string[][]): string {
  const cols = header.length
  const head = header.map((cell, index) => cellHtml('th', cell, aligns[index] ?? null)).join('')
  const rows = body
    .map((row) => {
      const cells = Array.from({ length: cols }, (_, index) => cellHtml('td', row[index] ?? '', aligns[index] ?? null))
      return `<tr>${cells.join('')}</tr>`
    })
    .join('')
  return (
    '<div class="md-table-wrap">' +
    '<div class="md-table-bar"><span>表格</span>' +
    '<button class="md-table-copy" type="button">复制表格</button></div>' +
    '<div class="md-table-scroll"><table class="md-table">' +
    `<thead><tr>${head}</tr></thead>` +
    (rows ? `<tbody>${rows}</tbody>` : '') +
    '</table></div></div>'
  )
}

/* ---------------- 主渲染 ---------------- */

export function renderMarkdown(source: string): string {
  const codeBlocks: string[] = []
  const withPlaceholders = source.replace(
    /```([\w+-]*)\r?\n?([\s\S]*?)```/g,
    (_match, lang: string, code: string) => {
      codeBlocks.push(code.replace(/\n$/, ''))
      return `\u0000CODE${codeBlocks.length - 1}\u0000\u0001${lang}\u0001`
    }
  )

  const lines = escapeHtml(withPlaceholders).split('\n')
  const out: string[] = []
  let list: string[] | null = null
  let listTag: 'ul' | 'ol' = 'ul'

  const flushList = (): void => {
    if (list) {
      out.push(`<${listTag}>${list.join('')}</${listTag}>`)
      list = null
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    const code = /^\u0000CODE(\d+)\u0000\u0001([^\u0001]*)\u0001$/.exec(line.trim())
    if (code) {
      flushList()
      const blockIndex = Number(code[1])
      const lang = code[2] ? code[2].toUpperCase() : '代码块'
      out.push(
        `<div class="code-card"><div class="code-head"><span>${escapeHtml(lang)}</span>` +
          `<button class="code-copy" type="button">复制</button></div>` +
          `<pre>${escapeHtml(codeBlocks[blockIndex])}</pre></div>`
      )
      continue
    }

    // 表格：当前行是表头，下一行是 |---| 分隔行
    if (line.trim().startsWith('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const header = splitTableRow(line)
      const aligns = splitTableRow(lines[index + 1]).map(alignOf)
      const body: string[][] = []
      let cursor = index + 2
      while (cursor < lines.length && lines[cursor].trim().startsWith('|')) {
        body.push(splitTableRow(lines[cursor]))
        cursor += 1
      }
      flushList()
      out.push(renderTable(header, aligns, body))
      index = cursor - 1
      continue
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line)
    if (heading) {
      flushList()
      const level = Math.min(heading[1].length + 1, 4)
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }

    const bullet = /^\s*[-*]\s+(.+)$/.exec(line)
    const ordered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line)
    if (bullet || ordered) {
      const tag: 'ul' | 'ol' = bullet ? 'ul' : 'ol'
      if (listTag !== tag) flushList()
      listTag = tag
      list ??= []
      list.push(`<li>${inline(bullet ? bullet[1] : ordered![2])}</li>`)
      continue
    }

    if (!line.trim()) {
      flushList()
      continue
    }

    flushList()
    out.push(`<p>${inline(line)}</p>`)
  }
  flushList()
  return out.join('')
}
