import { bracketGuides, indentGuides, rainbowBrackets } from './editorGuides'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  hoverTooltip,
  keymap,
  lineNumbers,
  type Panel,
  placeholder,
  rectangularSelection,
} from '@codemirror/view'
import {
  copyLineDown,
  copyLineUp,
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  moveLineDown,
  moveLineUp,
} from '@codemirror/commands'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeAnyWord,
  completionKeymap,
} from '@codemirror/autocomplete'
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  highlightSelectionMatches,
  replaceAll,
  replaceNext,
  search,
  searchKeymap,
  SearchQuery,
  selectMatches,
  selectNextOccurrence,
  setSearchQuery,
} from '@codemirror/search'
import {
  LanguageDescription,
  bracketMatching,
  codeFolding,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { json, jsonParseLinter } from '@codemirror/lang-json'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { liveMarkdownExtension } from './liveMarkdown'
import { MySQL, sql } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { lintGutter, linter, openLintPanel, type LintSource } from '@codemirror/lint'
import { javascript } from '@codemirror/lang-javascript'
import { changeMarkers, withBaseline } from './editorDiff'

export { withBaseline }

/** 主题是全局的，用 Compartment 让所有文档的 state 都能被重配置 */
const themeCompartment = new Compartment()

/** 列选择模式开关：开启后普通拖拽也是矩形选择，不必按 Alt */
const columnCompartment = new Compartment()
/** Markdown 即时渲染开关：按文档重配置 */
const liveMdCompartment = new Compartment()
let columnModeOn = false

export function columnExtension(enabled: boolean): Extension {
  // 注意：rectangularSelection 只接受 { eventFilter } 配置对象，
  // 传函数会被当成空配置忽略掉（踩过）。
  // class 必须通过 editorAttributes 注入：手动改 view.dom.classList
  // 会在下一次 state 更新时被 CM6 重写掉。
  return [
    rectangularSelection({ eventFilter: (event: MouseEvent) => enabled || event.altKey }),
    EditorView.editorAttributes.of(enabled ? { class: 'col-mode' } : {}),
  ]
}

export function isColumnMode(): boolean {
  return columnModeOn
}

/** Markdown 文件判断（和语言选择保持一致） */
export function isMarkdownFile(path: string | null): boolean {
  const ext = (path ?? '').toLowerCase().split('.').pop() ?? ''
  return ext === 'md' || ext === 'markdown'
}

/** 切换即时渲染：只对 Markdown 文档生效 */
export function setLiveMarkdown(state: EditorState, enabled: boolean): EditorState {
  return state.update({
    effects: liveMdCompartment.reconfigure(enabled ? liveMarkdownExtension() : []),
  }).state
}

export function setColumnMode(state: EditorState, enabled: boolean): EditorState {
  columnModeOn = enabled
  return state.update({ effects: columnCompartment.reconfigure(columnExtension(enabled)) }).state
}

const lightTheme = EditorView.theme(
  {
    '&': { color: '#1f2328', backgroundColor: '#ffffff' },
    '.cm-content': { caretColor: '#0969da' },
    '.cm-gutters': { backgroundColor: '#f6f8fa', color: '#8c959f', border: 'none' },
    // ★ 必须半透明：当前行背景画在选区图层之上，用实色会把选区整条盖住
    '.cm-activeLine': { backgroundColor: 'rgba(9, 105, 218, 0.05)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(9, 105, 218, 0.06)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: '#b6d7ff',
    },
  },
  { dark: false }
)

export function themeExtension(dark: boolean): Extension {
  return dark ? oneDark : [lightTheme, syntaxHighlighting(defaultHighlightStyle, { fallback: true })]
}

export function applyTheme(state: EditorState, dark: boolean): EditorState {
  return state.update({ effects: themeCompartment.reconfigure(themeExtension(dark)) }).state
}

/** JSON 解析错误默认是零长度区间（只有点没有下划线），补成 1 个字符宽 */
const jsonDiagnostics: LintSource = (view) => {
  const found = jsonParseLinter()(view)
  const length = view.state.doc.length
  return found.map((item) => (item.from === item.to ? { ...item, to: Math.min(length, item.from + 1) } : item))
}

/** Markdown 里 ``` 代码块能高亮的语言（只挂已装的语言包） */
const markdownCodeLanguages = [
  LanguageDescription.of({ name: 'json', alias: ['jsonc'], load: async () => json() }),
  LanguageDescription.of({ name: 'sql', alias: ['mysql'], load: async () => sql({ dialect: MySQL }) }),
  LanguageDescription.of({
    name: 'javascript',
    alias: ['js', 'ts', 'typescript'],
    load: async () => javascript({ typescript: true, jsx: true }),
  }),
]

function languageFor(path: string | null): Extension {
  if (!path) return []
  const ext = path.toLowerCase().split('.').pop() ?? ''
  // SQL：按 MySQL 方言做关键字补全（大写）
  if (ext === 'sql' || ext === 'ddl') return sql({ dialect: MySQL, upperCaseKeywords: true })
  // JSON：语法错误直接用波浪线标出来，不用等保存
  if (ext === 'json' || ext === 'jsonc') return [json(), linter(jsonDiagnostics, { delay: 350 })]
  if (ext === 'md' || ext === 'markdown') {
    return markdown({ base: markdownLanguage, codeLanguages: markdownCodeLanguages })
  }
  return []
}

/** 文档类文件默认软换行，代码不换行 */
function wrapsByDefault(path: string | null): boolean {
  if (!path) return false
  const ext = path.toLowerCase().split('.').pop() ?? ''
  return ['md', 'markdown', 'txt', 'log', 'csv', 'tsv'].includes(ext)
}

/* ------------------------------------------------------------------ *
 * 粘贴图片 → 自动入库 → 插入 markdown 链接
 * ------------------------------------------------------------------ */
const pasteNotice = (message: string): void => {
  document.dispatchEvent(new CustomEvent('th:toast', { detail: message, bubbles: true }))
}

function imagePaste(hooks: EditorHooks): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const items = event.clipboardData?.items
      if (!items) return false
      const images = Array.from(items).filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
      if (images.length === 0) return false

      // 必须拦掉默认行为，否则会插入二进制垃圾
      event.preventDefault()

      // 图片只能存进工作区的 .assets：工作区外的文档直接提示，不写盘
      const docPath = hooks.getDocPath()
      if (docPath && hooks.isInWorkspace && !hooks.isInWorkspace(docPath)) {
        pasteNotice('这篇文档在工作区外，图片只能存进工作区的 .assets/。先用 Ctrl+S 另存到工作区，再粘贴图片。')
        return true
      }

      for (const item of images) {
        const file = item.getAsFile()
        if (!file) continue
        void file.arrayBuffer().then(async (buf) => {
          try {
            const rel = await window.th.assets.save({
              docPath: hooks.getDocPath(),
              mime: file.type,
              bytes: new Uint8Array(buf),
            })
            const sel = view.state.selection.main
            const md = `![](${encodeURI(rel)})`
            view.dispatch({
              changes: { from: sel.from, to: sel.to, insert: md },
              selection: { anchor: sel.from + md.length },
            })
          } catch (err) {
            console.error('[paste-image] failed', err)
            const message = err instanceof Error ? err.message : String(err)
            pasteNotice(
              message.includes('越界') || message.includes('工作区')
                ? '图片没存成：目标文档不在工作区，图片只能落到工作区的 .assets/。'
                : `图片没存成：${message.slice(0, 120)}`
            )
          }
        })
      }
      return true
    },
  })
}

/* ------------------------------------------------------------------ *
 * 图片链接 hover 预览
 * 渲染进程不知道绝对路径，这里按"文档目录 + 相对路径"解析，
 * 真正的安全校验在主进程的 th-asset 协议里做。
 * ------------------------------------------------------------------ */
/** 查找/替换面板：替换掉 CodeMirror 自带那套英文 UI */
function createSearchPanel(view: EditorView): Panel {
  const dom = document.createElement('div')
  dom.className = 'th-search'

  const makeButton = (label: string, title: string): HTMLButtonElement => {
    const el = document.createElement('button')
    el.type = 'button'
    el.textContent = label
    el.title = title
    return el
  }

  const makeChip = (label: string, title: string): HTMLButtonElement => {
    const el = makeButton(label, title)
    el.className = 'th-chip'
    return el
  }

  const findInput = document.createElement('input')
  findInput.type = 'text'
  findInput.placeholder = '查找内容'
  findInput.spellcheck = false
  findInput.className = 'th-search-input'

  const replaceInput = document.createElement('input')
  replaceInput.type = 'text'
  replaceInput.placeholder = '替换为（留空则只查找）'
  replaceInput.spellcheck = false
  replaceInput.className = 'th-search-input'

  const count = document.createElement('span')
  count.className = 'th-search-count'

  const prevBtn = makeButton('↑', '上一个（Shift+Enter）')
  const nextBtn = makeButton('↓', '下一个（Enter）')
  const allBtn = makeButton('全选', '选中所有匹配')
  const caseChip = makeChip('Aa', '区分大小写')
  const regexChip = makeChip('.*', '正则表达式')
  const wordChip = makeChip('词', '全词匹配')
  const replaceBtn = makeButton('替换', '替换当前匹配')
  const replaceAllBtn = makeButton('全部替换', '替换所有匹配')
  const closeBtn = makeButton('×', '关闭（Esc）')
  closeBtn.className = 'th-search-close'

  const findRow = document.createElement('div')
  findRow.className = 'th-search-row'
  findRow.append(findInput, prevBtn, nextBtn, allBtn, count, caseChip, regexChip, wordChip, closeBtn)

  const replaceRow = document.createElement('div')
  replaceRow.className = 'th-search-row'
  replaceRow.append(replaceInput, replaceBtn, replaceAllBtn)

  dom.append(findRow, replaceRow)

  let query = new SearchQuery({ search: '' })

  const recount = (): void => {
    if (!query.search) {
      count.textContent = ''
      return
    }
    try {
      let total = 0
      const cursor = query.getCursor(view.state)
      while (!cursor.next().done) {
        total += 1
        if (total > 999) break
      }
      count.textContent = total === 0 ? '无结果' : `${total}${total > 999 ? '+' : ''} 处`
    } catch {
      count.textContent = '表达式有误'
    }
  }

  const apply = (): void => {
    query = new SearchQuery({
      search: findInput.value,
      caseSensitive: caseChip.classList.contains('active'),
      regexp: regexChip.classList.contains('active'),
      wholeWord: wordChip.classList.contains('active'),
      replace: replaceInput.value,
    })
    view.dispatch({ effects: setSearchQuery.of(query) })
    recount()
  }

  const step = (forward: boolean): void => {
    apply()
    if (query.search) {
      if (forward) findNext(view)
      else findPrevious(view)
    }
  }

  findInput.addEventListener('input', apply)
  replaceInput.addEventListener('input', apply)

  for (const chip of [caseChip, regexChip, wordChip]) {
    chip.addEventListener('click', () => {
      chip.classList.toggle('active')
      apply()
    })
  }

  prevBtn.addEventListener('click', () => step(false))
  nextBtn.addEventListener('click', () => step(true))
  allBtn.addEventListener('click', () => {
    apply()
    selectMatches(view)
  })
  replaceBtn.addEventListener('click', () => {
    apply()
    replaceNext(view)
    apply()
  })
  replaceAllBtn.addEventListener('click', () => {
    apply()
    replaceAll(view)
    apply()
  })
  closeBtn.addEventListener('click', () => closeSearchPanel(view))

  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      step(!event.shiftKey)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeSearchPanel(view)
    }
  })

  replaceInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      apply()
      replaceNext(view)
      apply()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeSearchPanel(view)
    }
  })

  return {
    dom,
    top: true,
    mount() {
      const existing = getSearchQuery(view.state)
      const selection = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)
      findInput.value = selection && !selection.includes('\n') ? selection : existing.search
      replaceInput.value = existing.replace
      caseChip.classList.toggle('active', existing.caseSensitive)
      regexChip.classList.toggle('active', existing.regexp)
      wordChip.classList.toggle('active', existing.wholeWord)
      findInput.select()
      // mount 时还在同一次 update 里，直接 dispatch 会抛
      // "Calls to EditorView.update are not allowed while an update is in progress"
      window.setTimeout(() => {
        if (dom.isConnected) apply()
      }, 0)
    },
    update(update) {
      if (update.docChanged) recount()
    },
  }
}

/** 把 markdown 里的相对路径按 baseDir 解析成绝对路径 */
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

function imageHover(getBaseDirs: () => string[]): Extension {
  return hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos)
    const re = /!\[[^\]]*\]\(([^)\s]+)\)/g
    let match: RegExpExecArray | null
    while ((match = re.exec(line.text)) !== null) {
      const start = line.from + match.index
      const end = start + match[0].length
      if (pos < start || pos > end) continue

      const rel = decodeURI(match[1])
      const candidates = getBaseDirs()
        .map((dir) => resolveRelPath(dir, rel))
        .filter((candidate): candidate is string => Boolean(candidate))
        .filter((candidate, index, all) => all.indexOf(candidate) === index)
      if (candidates.length === 0) return null

      return {
        pos: start,
        end,
        above: true,
        create: () => {
          const dom = document.createElement('div')
          dom.className = 'th-hover'
          const img = document.createElement('img')

          // 依次尝试候选路径：未命名文档的链接基准可能是当日目录，也可能是工作区根
          let index = 0
          const show = (i: number): void => {
            img.src = `th-asset://local/${encodeURIComponent(candidates[i])}`
          }
          img.onerror = () => {
            index += 1
            if (index < candidates.length) show(index)
            else {
              img.remove()
              dom.textContent = `图片无法加载：${rel}`
            }
          }
          show(0)
          dom.appendChild(img)
          return { dom }
        },
      }
    }
    return null
  })
}

export interface EditorHooks {
  getDocPath(): string | null
  /**
   * 相对链接的候选基准目录（按优先级）。
   * - 已保存文档：文档所在目录
   * - 未命名文档：当日目录（粘贴图片时就是按这个前提算的相对路径），再退回工作区根
   */
  getBaseDirs(): string[]
  /** 是否启用 Markdown 即时渲染 */
  liveMarkdown?: boolean
  /** 这篇文档按 Markdown 对待（未命名文档没有 path，用标题判断） */
  isMarkdown?: boolean
  /** 这篇文档是否在工作区内（决定能不能把图片存进 .assets） */
  isInWorkspace?(path: string): boolean
  onUpdate(update: { docChanged: boolean; selectionSet: boolean; state: EditorState }): void
}

export function createState(
  text: string,
  path: string | null,
  dark: boolean,
  hooks: EditorHooks
): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      // 语法问题在行号旁标红点
      lintGutter(),
      // 折叠后显示 {…}，一眼知道藏了一片
      codeFolding({ placeholderText: ' {…} ' }),
      // 行号旁的改动标记（新增绿 / 修改琥珀）
      changeMarkers(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      // Ctrl + 滚轮缩放字号（普通滚轮仍然是滚动）
      EditorView.domEventHandlers({
        wheel: (event) => {
          if (!event.ctrlKey && !event.metaKey) return false
          event.preventDefault()
          const delta = event.deltaY < 0 ? 1 : -1
          document.dispatchEvent(new CustomEvent('th:zoom-editor', { detail: delta, bubbles: true }))
          return true
        },
      }),
      indentOnInput(),
      bracketMatching(),
      // 缩进参考线与彩虹括号：JSON/SQL 这种嵌套结构看得清层级
      indentGuides(),
      rainbowBrackets(),
      bracketGuides(),
      closeBrackets(),
      autocompletion({
        activateOnTyping: true,
        maxRenderedOptions: 40,
        // 没有语言级补全源时，至少按文档里出现过的词补
        override: [completeAnyWord],
      }),
      highlightActiveLine(),
      highlightSelectionMatches(),
      columnCompartment.of(columnExtension(columnModeOn)),
      crosshairCursor(),
      search({ top: true, createPanel: (view) => createSearchPanel(view) }),
      keymap.of([
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
        // 编辑器常用操作
        { key: 'Alt-ArrowUp', run: moveLineUp },
        { key: 'Alt-ArrowDown', run: moveLineDown },
        { key: 'Shift-Alt-ArrowUp', run: copyLineUp },
        { key: 'Shift-Alt-ArrowDown', run: copyLineDown },
        { key: 'Mod-d', run: selectNextOccurrence },
        // 打开/关闭「问题」面板（JSON 语法错误列表）
        { key: 'Mod-Shift-m', run: openLintPanel },
        indentWithTab,
      ]),
      placeholder('在这里输入…（Ctrl+V 可直接粘贴截图，自动入库并插入图片链接）'),
      themeCompartment.of(themeExtension(dark)),
      imagePaste(hooks),
      imageHover(hooks.getBaseDirs),
      EditorView.updateListener.of((update) => {
        hooks.onUpdate({
          docChanged: update.docChanged,
          selectionSet: update.selectionSet,
          state: update.state,
        })
      }),
      wrapsByDefault(path) ? EditorView.lineWrapping : [],
      liveMdCompartment.of((hooks.isMarkdown ?? isMarkdownFile(path)) && hooks.liveMarkdown !== false ? liveMarkdownExtension() : []),
      languageFor(path),
    ],
  })
}

export function createView(parent: HTMLElement, state: EditorState): EditorView {
  return new EditorView({ parent, state })
}
