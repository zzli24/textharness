/**
 * Markdown 即时渲染（Typora 风格）：文档仍然是纯 Markdown 文本，只在显示层做装饰。
 *
 * 规则：
 *  - 光标所在的整行还原成源码（能看到 `##`、`**`）
 *  - 其余行渲染成排版后的样子：标题字号、加粗、行内代码、链接、图片、代码块、表格、公式
 *  - 表格只读渲染，双击 / 点「编辑表格」交给 CSV 表格视图去改（文档内容仍是 Markdown）
 *
 * 所有装饰都按「行」为最小单位重算，避免和列编辑、行号、折叠等扩展互相干扰。
 */

import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import { EditorState, StateField, type Extension } from '@codemirror/state'
import katex from 'katex'

export interface LiveMarkdownOptions {
  /** 相对图片路径的候选基准目录 */
  getBaseDirs: () => string[]
  /** 双击表格 / 点「编辑表格」时打开 CSV 视图 */
  onOpenTable?: (rows: string[][]) => void
}

let options: LiveMarkdownOptions = { getBaseDirs: () => [] }

export function configureLiveMarkdown(next: LiveMarkdownOptions): void {
  options = next
}

/* ---------------- 小工具 ---------------- */

function resolveRelPath(baseDir: string, rel: string): string | null {
  if (!baseDir) return null
  const sep = baseDir.includes('\\') ? '\\' : '/'
  const parts = `${baseDir}${sep}${rel}`.split(/[\\/]+/)
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return (baseDir.startsWith('/') ? '/' : '') + out.join(sep)
}

function selectionTouchesLine(state: EditorState, lineFrom: number, lineTo: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.from <= lineTo && range.to >= lineFrom) return true
  }
  return false
}

/* ---------------- Widget ---------------- */

class CodeHeaderWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly code: string,
    readonly hasCode: boolean
  ) {
    super()
  }

  eq(other: CodeHeaderWidget): boolean {
    return other.lang === this.lang && other.code === this.code && other.hasCode === this.hasCode
  }

  toDOM(): HTMLElement {
    const head = document.createElement('div')
    head.className = this.hasCode ? 'cm-md-code-head' : 'cm-md-code-head cm-md-code-head-only'
    const name = document.createElement('span')
    name.className = 'cm-md-code-lang'
    name.textContent = this.lang ? this.lang.toUpperCase() : 'CODE'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'cm-md-code-copy'
    copy.textContent = '复制'
    copy.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void navigator.clipboard.writeText(this.code)
      copy.textContent = '已复制'
      window.setTimeout(() => {
        copy.textContent = '复制'
      }, 1200)
    })
    head.append(name, copy)
    return head
  }

  ignoreEvent(): boolean {
    return false
  }
}

class TableWidget extends WidgetType {
  constructor(readonly rows: string[][]) {
    super()
  }

  eq(other: TableWidget): boolean {
    return JSON.stringify(other.rows) === JSON.stringify(this.rows)
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-md-table-wrap'
    wrap.title = '双击表格可以用表格视图编辑'

    const bar = document.createElement('div')
    bar.className = 'cm-md-table-bar'
    const hint = document.createElement('span')
    hint.textContent = `表格 ${this.rows.length} 行 × ${Math.max(...this.rows.map((r) => r.length))} 列`
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'cm-md-table-edit'
    edit.textContent = '编辑表格'
    edit.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      options.onOpenTable?.(this.rows.map((row) => [...row]))
    })
    bar.append(hint, edit)

    const scroll = document.createElement('div')
    scroll.className = 'cm-md-table-scroll'
    const table = document.createElement('table')
    table.className = 'cm-md-table'
    const head = document.createElement('thead')
    const headRow = document.createElement('tr')
    for (const cell of this.rows[0] ?? []) {
      const th = document.createElement('th')
      th.textContent = cell
      headRow.appendChild(th)
    }
    head.appendChild(headRow)
    table.appendChild(head)
    const body = document.createElement('tbody')
    for (const row of this.rows.slice(1)) {
      const tr = document.createElement('tr')
      for (const cell of row) {
        const td = document.createElement('td')
        td.textContent = cell
        tr.appendChild(td)
      }
      body.appendChild(tr)
    }
    table.appendChild(body)
    scroll.appendChild(table)

    wrap.append(bar, scroll)
    wrap.addEventListener('dblclick', (event) => {
      event.preventDefault()
      options.onOpenTable?.(this.rows.map((row) => [...row]))
    })
    return wrap
  }

  ignoreEvent(): boolean {
    return false
  }
}

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean
  ) {
    super()
  }

  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display
  }

  toDOM(): HTMLElement {
    const el = document.createElement(this.display ? 'div' : 'span')
    el.className = this.display ? 'cm-md-math-block' : 'cm-md-math-inline'
    try {
      el.innerHTML = katex.renderToString(this.tex, { displayMode: this.display, throwOnError: false })
    } catch {
      el.textContent = this.display ? `$$${this.tex}$$` : `$${this.tex}$`
      el.classList.add('cm-md-error')
    }
    return el
  }
}

class MermaidWidget extends WidgetType {
  constructor(readonly code: string) {
    super()
  }

  eq(other: MermaidWidget): boolean {
    return other.code === this.code
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-md-mermaid'
    wrap.textContent = 'Mermaid 渲染中…'
    const dark = document.documentElement.dataset['theme'] === 'dark'
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default' })
        const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`
        const { svg } = await mermaid.render(id, this.code)
        wrap.innerHTML = svg
      } catch (err) {
        wrap.classList.add('cm-md-error')
        wrap.textContent = `Mermaid 渲染失败：${err instanceof Error ? err.message : String(err)}`
      }
    })()
    return wrap
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string
  ) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-md-image'
    const img = document.createElement('img')
    img.alt = this.alt
    img.loading = 'lazy'

    const raw = decodeURI(this.src.trim())
    const fail = (): void => {
      wrap.textContent = `图片无法加载：${this.alt || raw}`
      wrap.classList.add('cm-md-error')
    }
    img.onerror = fail

    // 1) 网络图片 / data URL / blob / file:// —— 直接用
    if (/^(https?:|data:|blob:|file:)/i.test(raw)) {
      img.src = raw
      wrap.appendChild(img)
      return wrap
    }

    // 2) 绝对路径：交给 th-asset 协议（它会校验是否在工作区内）
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/')) {
      img.onerror = () => {
        img.onerror = fail
        img.src = `file:///${raw.replace(/\\/g, '/').replace(/^\/+/, '')}`
      }
      img.src = `th-asset://local/${encodeURIComponent(raw)}`
      wrap.appendChild(img)
      return wrap
    }

    // 3) 相对路径：按文档目录 → 工作区根 依次试
    const candidates = options
      .getBaseDirs()
      .map((dir) => resolveRelPath(dir, raw))
      .filter((candidate): candidate is string => Boolean(candidate))
      .filter((candidate, index, all) => all.indexOf(candidate) === index)

    if (candidates.length === 0) {
      img.src = raw
      wrap.appendChild(img)
      return wrap
    }

    let index = 0
    const show = (i: number): void => {
      img.src = `th-asset://local/${encodeURIComponent(candidates[i])}`
    }
    img.onerror = () => {
      index += 1
      if (index < candidates.length) {
        show(index)
      } else if (candidates.length > 0) {
        // 都失败：最后试一下原始路径（可能是 http 相对地址）
        img.onerror = fail
        img.src = raw
      } else {
        fail()
      }
    }
    show(0)
    wrap.appendChild(img)
    return wrap
  }

  ignoreEvent(): boolean {
    return false
  }
}

/* ---------------- 装饰构建 ---------------- */

interface Replacement {
  from: number
  to: number
  deco: Decoration
}

function buildDecorations(state: EditorState): DecorationSet {
  const out: Replacement[] = []
  const doc = state.doc
  const push = (from: number, to: number, deco: Decoration): void => {
    if (to < from) return
    out.push({ from, to, deco })
  }
  const hide = (from: number, to: number): void => {
    if (to > from) push(from, to, Decoration.replace({}))
  }

  let i = 1
  while (i <= doc.lines) {
    const line = doc.line(i)
    const text = line.text
    const active = selectionTouchesLine(state, line.from, line.to)

    /* ---- 围栏代码块 ---- */
    const fenceOpen = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(text)
    if (fenceOpen) {
      const fenceChar = fenceOpen[1][0]
      const lang = (fenceOpen[2] ?? '').toLowerCase()
      let end = i + 1
      while (end <= doc.lines) {
        const probe = doc.line(end).text
        if (new RegExp(`^\\s{0,3}\\${fenceChar}{3,}\\s*$`).test(probe)) break
        end += 1
      }
      const close = Math.min(end, doc.lines)
      const codeLines: string[] = []
      for (let k = i + 1; k < close; k += 1) codeLines.push(doc.line(k).text)
      const code = codeLines.join('\n')
      let blockActive = false
      for (let k = i; k <= close; k += 1) {
        if (selectionTouchesLine(state, doc.line(k).from, doc.line(k).to)) {
          blockActive = true
          break
        }
      }

      if (!blockActive) {
        if (lang === 'mermaid') {
          const from = line.from
          const to = doc.line(close).to
          push(from, to, Decoration.replace({ widget: new MermaidWidget(code), block: true }))
          i = close + 1
          continue
        }
        // 头部：语言 + 复制（作为卡片顶栏）
        const hasCode = close > i + 1
        push(line.from, line.from, Decoration.line({ class: 'cm-md-code-head-line' }))
        push(
          line.from,
          line.to,
          Decoration.replace({
            widget: new CodeHeaderWidget(lang, code, hasCode),
            block: true,
          })
        )
        if (close > i && close <= doc.lines) {
          const closeLine = doc.line(close)
          push(closeLine.from, closeLine.to, Decoration.replace({}))
          push(closeLine.from, closeLine.from, Decoration.line({ class: 'cm-md-code-close' }))
        }
        const firstCode = i + 1
        const lastCode = close - 1
        for (let k = firstCode; k <= lastCode; k += 1) {
          const codeLine = doc.line(k)
          const classes = ['cm-md-codeblock']
          if (k === firstCode) classes.push('cm-md-code-first')
          if (k === lastCode) classes.push('cm-md-code-last')
          push(codeLine.from, codeLine.from, Decoration.line({ class: classes.join(' ') }))
        }
        i = close + 1
        continue
      }
      // 光标在代码块里：整块保持源码，只加一点背景
      for (let k = i; k <= close; k += 1) {
        push(doc.line(k).from, doc.line(k).from, Decoration.line({ class: 'cm-md-codeblock-active' }))
      }
      i = close + 1
      continue
    }

    /* ---- 公式块 $$ ... $$ ---- */
    const trimmed = text.trim()
    if (trimmed.startsWith('$$')) {
      const single = /^\s*\$\$(.+)\$\$\s*$/.exec(text)
      if (single) {
        if (!active) push(line.from, line.to, Decoration.replace({ widget: new MathWidget(single[1], true), block: true }))
        i += 1
        continue
      }
      if (trimmed === '$$') {
        let end = i + 1
        while (end <= doc.lines && doc.line(end).text.trim() !== '$$') end += 1
        const close = Math.min(end, doc.lines)
        const tex = []
        for (let k = i + 1; k < close; k += 1) tex.push(doc.line(k).text)
        const blockActive =
          selectionTouchesLine(state, line.from, line.to) ||
          selectionTouchesLine(state, doc.line(close).from, doc.line(close).to)
        if (!blockActive) {
          push(line.from, doc.line(close).to, Decoration.replace({ widget: new MathWidget(tex.join('\n'), true), block: true }))
          i = close + 1
          continue
        }
        i = close + 1
        continue
      }
    }

    /* ---- 表格 ---- */
    if (/^\s*\|/.test(text) && i < doc.lines) {
      const next = doc.line(i + 1).text
      if (/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(next) && next.includes('-')) {
        const rows: string[][] = []
        let end = i
        while (end <= doc.lines && /^\s*\|/.test(doc.line(end).text)) {
          const raw = doc.line(end).text.trim().replace(/^\|/, '').replace(/\|$/, '')
          rows.push(raw.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|')))
          end += 1
        }
        const tableEnd = end - 1
        const blockActive = selectionTouchesLine(state, line.from, doc.line(tableEnd).to)
        if (!blockActive) {
          // 去掉分隔行（第二行 |---|）
          const dataRows = rows.filter(
            (row, index) => index !== 1 || !row.every((cell) => /^:?-{1,}:?$/.test(cell) || cell === '')
          )
          push(line.from, doc.line(tableEnd).to, Decoration.replace({ widget: new TableWidget(dataRows), block: true }))
          i = tableEnd + 1
          continue
        }
        i = tableEnd + 1
        continue
      }
    }

    /* ---- 标题 ---- */
    const heading = /^(#{1,6})\s+(.*)$/.exec(text)
    if (heading && !active) {
      const level = heading[1].length
      push(line.from, line.from, Decoration.line({ class: `cm-md-h${level}` }))
      hide(line.from, line.from + heading[1].length + 1)
      // 标题里的行内标记仍要渲染
      pushInline(out, line, text, 0, active)
      i += 1
      continue
    }

    /* ---- 引用 / 列表 ---- */
    if (!active) {
      const quote = /^(\s*>\s?)/.exec(text)
      if (quote) {
        push(line.from, line.from, Decoration.line({ class: 'cm-md-quote' }))
        hide(line.from, line.from + quote[1].length)
      } else if (/^\s{0,3}([-*+]|\d+[.)])\s+/.test(text)) {
        push(line.from, line.from, Decoration.line({ class: 'cm-md-list' }))
      }
    }

    /* ---- 行内 ---- */
    if (!active) pushInline(out, line, text, 0, active)

    i += 1
  }

  // Decoration.set 要求按位置排序
  out.sort((a, b) => a.from - b.from || a.to - b.to)
  return Decoration.set(
    out.map((item) => item.deco.range(item.from, item.to)),
    true
  )
}

/** 行内：行内代码 / 图片 / 链接 / 加粗 / 斜体 / 删除线 / 行内公式 */
function pushInline(
  out: Replacement[],
  line: { from: number; to: number },
  text: string,
  offset: number,
  active: boolean
): void {
  if (active) return
  const push = (from: number, to: number, deco: Decoration): void => {
    out.push({ from: line.from + from, to: line.from + to, deco })
  }
  const hide = (from: number, to: number): void => {
    if (to > from) push(from, to, Decoration.replace({}))
  }

  const pattern =
    /(`[^`\n]+`)|(!\[([^\]]*)\]\(([^)\s]+)\))|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*\n]+)\*\*)|(__([^_\n]+)__)|(\*([^*\n]+)\*)|(_([^_\n]+)_)|(~~([^~\n]+)~~)|(\$([^$\n]+)\$)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index + offset
    const end = start + match[0].length
    if (start < offset) continue

    if (match[1]) {
      // 行内代码
      hide(start, start + 1)
      hide(end - 1, end)
      push(start + 1, end - 1, Decoration.mark({ class: 'cm-md-inline-code' }))
      continue
    }
    if (match[2]) {
      // 图片
      const alt = match[3] ?? ''
      const src = match[4] ?? ''
      push(start, end, Decoration.replace({ widget: new ImageWidget(src, alt) }))
      continue
    }
    if (match[5]) {
      // 链接
      const label = match[6] ?? ''
      const href = match[7] ?? ''
      const labelStart = start + 1
      hide(start, labelStart)
      hide(labelStart + label.length, end)
      push(labelStart, labelStart + label.length, Decoration.mark({ class: 'cm-md-link', attributes: { 'data-href': href } }))
      continue
    }
    if (match[8]) {
      hide(start, start + 2)
      hide(end - 2, end)
      push(start + 2, end - 2, Decoration.mark({ class: 'cm-md-strong' }))
      continue
    }
    if (match[10]) {
      hide(start, start + 2)
      hide(end - 2, end)
      push(start + 2, end - 2, Decoration.mark({ class: 'cm-md-strong' }))
      continue
    }
    if (match[12]) {
      hide(start, start + 1)
      hide(end - 1, end)
      push(start + 1, end - 1, Decoration.mark({ class: 'cm-md-em' }))
      continue
    }
    if (match[14]) {
      hide(start, start + 1)
      hide(end - 1, end)
      push(start + 1, end - 1, Decoration.mark({ class: 'cm-md-em' }))
      continue
    }
    if (match[16]) {
      hide(start, start + 2)
      hide(end - 2, end)
      push(start + 2, end - 2, Decoration.mark({ class: 'cm-md-strike' }))
      continue
    }
    if (match[18]) {
      push(start, end, Decoration.replace({ widget: new MathWidget(match[19] ?? '', false) }))
      continue
    }
  }
}

/* ---------------- 插件挂载 ---------------- */

/**
 * 装饰必须由 StateField 提供：CM6 不允许插件给「整块替换」类装饰
 * （Block decorations may not be specified via plugins），表格/公式/代码块都是块级 widget。
 */
const liveDecorationsField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (value, tr) => (tr.docChanged || tr.selection ? buildDecorations(tr.state) : value),
  provide: (field) => EditorView.decorations.from(field),
})

export function liveMarkdownExtension(): Extension {
  return [
    liveDecorationsField,
    // Ctrl/Cmd + 点链接：用系统浏览器打开
    EditorView.domEventHandlers({
      click: (event) => {
        const target = event.target as HTMLElement | null
        const link = target?.closest('.cm-md-link') as HTMLElement | null
        if (!link || !(event.ctrlKey || event.metaKey)) return false
        const href = link.dataset['href']
        if (!href) return false
        event.preventDefault()
        const api = (window as unknown as { th?: { app?: { openUrl?: (url: string) => Promise<void> } } }).th
        void api?.app?.openUrl?.(href)
        return true
      },
    }),
  ]
}


