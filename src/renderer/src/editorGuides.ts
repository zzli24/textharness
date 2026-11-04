import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, type EditorState } from '@codemirror/state'

/**
 * 缩进参考线（VS Code 那种竖线）。
 *
 * 做法：按行算缩进层级，给整行挂一个 cm-guide-l{N} 类，
 * CSS 用 repeating-linear-gradient 在每 2ch 画一条 1px 竖线，
 * 线的条数由 background-size 限制成 N*2ch，不会多画到行尾。
 */

const MAX_LEVEL = 10

function buildIndentDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const unit = 2
  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos)
      const match = /^[ \t]*/.exec(line.text)
      const spaces = match ? match[0].replace(/\t/g, '  ').length : 0
      const level = Math.floor(spaces / unit)
      if (level > 0) {
        const levelClass = `cm-guide-l${Math.min(level, MAX_LEVEL)}`
        builder.add(line.from, line.from, Decoration.line({ class: levelClass }))
      }
      pos = line.to + 1
    }
  }
  return builder.finish()
}

export function indentGuides() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildIndentDecorations(view)
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildIndentDecorations(update.view)
        }
      }
    },
    { decorations: (value) => value.decorations }
  )
}

/**
 * 彩虹括号：按语法树里的嵌套深度给 { } [ ] ( ) 上色。
 * 只处理可见范围，长文件也不卡。
 */

const OPENERS = new Set(['{', '[', '('])
const CLOSERS = new Set(['}', ']', ')'])

function buildBracketDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const tree = syntaxTree(view.state)
  for (const { from, to } of view.visibleRanges) {
    const stack: string[] = []
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name
        if (node.from > to) return false
        if (!OPENERS.has(name) && !CLOSERS.has(name)) return
        if (OPENERS.has(name)) {
          const level = stack.length
          stack.push(name)
          builder.add(node.from, node.to, Decoration.mark({ class: `cm-bracket-l${(level % 4) + 1}` }))
          return
        }
        // 闭括号要和它的开括号同色
        stack.pop()
        const level = stack.length
        builder.add(node.from, node.to, Decoration.mark({ class: `cm-bracket-l${(level % 4) + 1}` }))
      },
    })
  }
  return builder.finish()
}

export function rainbowBrackets() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildBracketDecorations(view)
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildBracketDecorations(update.view)
        }
      }
    },
    { decorations: (value) => value.decorations }
  )
}

/**
 * 光标落在括号里时，像 VS Code 那样：
 *  - 这两个括号变成醒目的红色
 *  - 中间整段画一条红色虚线参考线（对齐闭括号所在列，止于闭括号上一行）
 */
const BRACKETS = new Set(['{', '[', '(', '}', ']', ')'])

/**
 * 只在光标「贴着」括号时才提示（VS Code 就是这个行为）：
 * 光标前一个字符或后一个字符是括号才触发，光标在块中间不打扰。
 */
function matchForward(state: EditorState, open: number, opener: string): number {
  const closer = opener === '{' ? '}' : opener === '[' ? ']' : ')'
  let depth = 0
  const len = Math.min(state.doc.length, open + 100_000)
  for (let i = open; i < len; i += 1) {
    const ch = state.doc.sliceString(i, i + 1)
    if (ch === opener) depth += 1
    else if (ch === closer) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function matchBackward(state: EditorState, close: number, closer: string): number {
  const opener = closer === '}' ? '{' : closer === ']' ? '[' : '('
  let depth = 0
  const min = Math.max(0, close - 100_000)
  for (let i = close; i >= min; i -= 1) {
    const ch = state.doc.sliceString(i, i + 1)
    if (ch === closer) depth += 1
    else if (ch === opener) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function bracketPairAt(view: EditorView): { open: number; close: number } | null {
  const { state } = view
  const pos = state.selection.main.head

  // 光标紧贴着的那两个位置：前一个字符、后一个字符
  for (const at of [pos, pos - 1]) {
    if (at < 0 || at >= state.doc.length) continue
    const ch = state.doc.sliceString(at, at + 1)
    if (!BRACKETS.has(ch)) continue
    if (OPENERS.has(ch)) {
      const close = matchForward(state, at, ch)
      if (close > at) return { open: at, close }
    } else {
      const open = matchBackward(state, at, ch)
      if (open >= 0) return { open, close: at }
    }
  }
  return null
}

function buildBracketGuides(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const pair = bracketPairAt(view)
  if (!pair) return builder.finish()

  const { state } = view
  const openLine = state.doc.lineAt(pair.open)
  const closeLine = state.doc.lineAt(pair.close)
  if (closeLine.number - openLine.number < 2) return builder.finish()

  // 参考线对齐到「闭括号」所在列：开括号常常跟在 key 后面（"x": {），
  // 按它定位会落在内容中间；闭括号才是这个块的缩进基准
  const column = pair.close - closeLine.from
  const charWidth = view.defaultCharacterWidth || 7.8
  // 背景相对内容盒定位，所以不要再加 padding
  const guideX = Math.round(column * charWidth)

  // RangeSetBuilder 要求按位置升序添加，否则 finish() 会直接抛异常；
  // 所以顺序是：开括号标记 → 中间各行 → 闭括号标记
  builder.add(pair.open, pair.open + 1, Decoration.mark({ class: 'cm-bracket-active' }))

  // 最后一行（闭括号那行）不画：画上去会从括号旁边溢出去
  for (let lineNo = openLine.number + 1; lineNo < closeLine.number; lineNo += 1) {
    const line = state.doc.line(lineNo)
    builder.add(
      line.from,
      line.from,
      Decoration.line({
        class: 'cm-bracket-guide-line',
        attributes: { style: `--guide-x:${guideX}px` },
      })
    )
  }

  builder.add(pair.close, pair.close + 1, Decoration.mark({ class: 'cm-bracket-active' }))
  return builder.finish()
}

export function bracketGuides() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildBracketGuides(view)
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildBracketGuides(update.view)
        }
      }
    },
    { decorations: (value) => value.decorations }
  )
}