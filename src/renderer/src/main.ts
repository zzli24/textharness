import { fileIconEl } from './fileIcons'
import { setBaselineEffect } from './editorDiff'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type {
  AppConfig,
  Encoding,
  FileMeta,
  SavedEditorState,
  SavedEditorTab,
  SearchHit,
  SearchOptions,
  TreeNode,
} from '@shared/types'
import { redo, undo } from '@codemirror/commands'
import { openSearchPanel as openInTextPanel } from '@codemirror/search'
import * as ed from './editor'
import { createTree, type TreeApi } from './tree'
import { askTable, askText, confirmDialog, createModal, openMcpAddDialog, openSettings } from './dialogs'
import { openArchivePanel } from './archivePanel'
import { openDraftsPanel } from './draftsPanel'
import { openDiff } from './diffView'
import { requestAccess, requestScriptApproval } from './approval'
import { describeChange } from './recipes'
import { closeToolsPanel, openToolsPanel } from './toolsPanel'
import { createGrid, detectDelimiter, markdownToRows, rowsToMarkdown, serializeCsv, type GridApi } from './gridView'
import { applyStall, applyUpdateEvent, chipAction, DOWNLOAD_PAGE, initialChip, type ChipState } from './updateChip'
import { configureLiveMarkdown } from './liveMarkdown'
import { createCardPanel, type CardPanel } from './cardPanel'
import 'katex/dist/katex.min.css'
import { createChat, type ChatApi } from './aiChat'

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`缺少元素 #${id}`)
  return el as T
}

const uid = (): string => Math.random().toString(36).slice(2, 10)
const IS_MAC = window.th.platform === 'darwin'
const MOD = IS_MAC ? 'Cmd' : 'Ctrl'
const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p
const dirName = (p: string): string => p.replace(/[\\/][^\\/]*$/, '')
const joinPath = (dir: string, name: string): string => {
  const sep = dir.includes('\\') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`
}

const resolveRelativePath = (base: string, rel: string): string => {
  const sep = base.includes('\\') ? '\\' : '/'
  const parts = `${base}${sep}${rel}`.split(/[\\/]+/)
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return (base.startsWith('/') ? '/' : '') + out.join(sep)
}

const pad = (n: number): string => String(n).padStart(2, '0')
const today = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const ENCODING_LABEL: Record<Encoding, string> = {
  utf8: 'UTF-8',
  gb18030: 'GBK',
  utf16le: 'UTF-16 LE',
  utf16be: 'UTF-16 BE',
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

let toastTimer: number | undefined
/** 状态栏的更新芯片：有新版才出现；任何状态下点击都有明确动作 */
function setupUpdater(): void {
  const chip = document.getElementById('st-update') as HTMLButtonElement | null
  const label = document.getElementById('st-update-text')
  if (!chip || !label) return

  let state: ChipState = initialChip()

  const paint = (): void => {
    label.textContent = state.label
    chip.title = state.title
    chip.classList.toggle('hidden', !state.visible)
  }

  const openDownload = (): void => {
    void window.th.app.openUrl(state.url || DOWNLOAD_PAGE)
  }

  chip.addEventListener('click', () => {
    const action = chipAction(state)
    if (action === 'install') {
      // 安装可能起不来（包被清理、被安全软件拦住），失败就退到下载页
      void window.th.ai.updateInstall().then((result) => {
        if (result.ok) return
        toast(`安装没启动：${result.reason ?? '未知原因'}，已打开下载页`)
        openDownload()
      })
      return
    }
    if (action === 'open-download') {
      toast(
        state.mode === 'available' || state.mode === 'downloading'
          ? '后台还在下载；已打开下载页，也可以直接手动安装'
          : '已打开下载页'
      )
      openDownload()
      return
    }
    void window.th.ai.updateCheck()
    toast('已开始检查更新')
  })

  window.th.ai.onUpdateEvent((event) => {
    state = applyUpdateEvent(state, event)
    paint()
    if (event.kind === 'downloaded') toast(`v${event.version} 已下载，点状态栏「重启更新」即可`)
    if (event.kind === 'error') toast(`自动更新失败：${event.message}`)
  })

  // 下载长时间没进展 → 给一个手动下载的出口，别让用户点了没反应
  window.setInterval(() => {
    const next = applyStall(state)
    if (next !== state) {
      state = next
      paint()
    }
  }, 5000)
}

/** 状态栏「即时渲染」开关：Markdown 文档才显示 */
function setupLiveMarkdownToggle(): void {
  const button = document.getElementById('st-live-md') as HTMLButtonElement | null
  if (!button) return

  configureLiveMarkdown({
    getBaseDirs: () => {
      const doc = activeDoc()
      // 与 hooksFor 保持一致：已保存文档按所在目录，未命名文档按当天目录
      return doc?.path
        ? [dirName(doc.path), cfg.workspaceRoot]
        : [joinPath(cfg.workspaceRoot, today()), cfg.workspaceRoot]
    },
    onOpenTable: openMarkdownTableAsGrid,
  })

  const refresh = (): void => {
    const doc = activeDoc()
    const isMd = docIsMarkdown(doc)
    button.classList.toggle('hidden', !isMd)
    button.classList.toggle('active', isMd && cfg.liveMarkdown !== false)
    button.title =
      cfg.liveMarkdown !== false
        ? '即时渲染：开（光标所在行显示源码；点一下切回源码模式）'
        : '即时渲染：关（当前是纯源码模式；点一下打开即时渲染）'
  }

  const toggle = (): void => {
    const doc = activeDoc()
    if (!docIsMarkdown(doc)) return
    cfg.liveMarkdown = cfg.liveMarkdown === false
    void window.th.config.patch({ liveMarkdown: cfg.liveMarkdown })
    for (const item of docs) {
      if (docIsMarkdown(item)) {
        item.state = ed.setLiveMarkdown(item.state, cfg.liveMarkdown !== false)
      }
    }
    const current = activeDoc()
    if (current && current.kind === 'text') view.setState(current.state)
    refresh()
    updateMdLiveClass()
    toast(cfg.liveMarkdown !== false ? '已开启即时渲染' : '已切换到源码模式')
  }

  button.addEventListener('click', toggle)
  document.addEventListener('th:doc-changed', refresh)
  refresh()
}

/** 右侧卡片面板：把当前 Markdown 变成可导出的卡片 */
function setupCardPanel(): void {
  const button = document.getElementById('st-card') as HTMLButtonElement | null
  if (!button) return

  cardPanel = createCardPanel({
    onOpenChange: (open) => {
      button.classList.toggle('active', open)
    },
    getDoc: () => {
      const doc = activeDoc()
      if (!doc || !docIsMarkdown(doc)) return null
      return { title: doc.title, path: doc.path, text: doc.state.doc.toString() }
    },
    resolveImage: (src, doc) => {
      if (/^(https?:|data:|file:)/i.test(src)) return src
      const base = doc.path ? dirName(doc.path) : joinPath(cfg.workspaceRoot, today())
      const abs = resolveRelativePath(base, decodeURI(src))
      return abs ? `th-asset://local/${encodeURIComponent(abs)}` : null
    },
  })

  const refresh = (): void => {
    const on = docIsMarkdown(activeDoc())
    button.classList.toggle('hidden', !on)
    button.classList.toggle('active', on && cardPanel?.isOpen() === true)
    if (cardPanel?.isOpen()) cardPanel.refresh()
  }

  button.addEventListener('click', () => {
    if (!docIsMarkdown(activeDoc())) return
    cardPanel?.toggle()
    button.classList.toggle('active', cardPanel?.isOpen() === true)
  })

  document.addEventListener('th:doc-changed', refresh)
  refresh()
}

function toast(message: string): void {
  document.querySelector('.toast')?.remove()
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = message
  document.body.appendChild(el)
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => el.remove(), 3200)
}

/* ------------------------------------------------------------------ */
/* 选区诊断浮层（Ctrl+Alt+D）                                            */
/* ------------------------------------------------------------------ */

function setupSelectionDebug(): void {
  const panel = document.createElement('pre')
  panel.id = 'debug-overlay'
  panel.style.cssText = [
    'position:fixed',
    'left:14px',
    'bottom:34px',
    'max-width:70%',
    'max-height:46%',
    'overflow:auto',
    'margin:0',
    'padding:8px 10px',
    'background:rgba(0,0,0,0.85)',
    'color:#8ef58e',
    'font:11px/1.55 Consolas,monospace',
    'border-radius:6px',
    'border:1px solid #2f6b2f',
    'z-index:9999',
    'white-space:pre-wrap',
    'pointer-events:none',
    'display:none',
  ].join(';')
  document.body.appendChild(panel)

  const lines: string[] = []
  let visible = false

  const log = (text: string): void => {
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    lines.push(`${stamp} ${text}`)
    while (lines.length > 14) lines.shift()
    panel.textContent = lines.join('\n')
  }

  // Ctrl+Alt+A：把编辑器选区送进归档面板
  document.addEventListener(
    'keydown',
    (event) => {
      if (!event.ctrlKey || !event.altKey || event.key.toLowerCase() !== 'a') return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('#ai-composer') || target.closest('.modal') || target.closest('.overlay'))) return
      event.preventDefault()
      archiveSelection()
    },
    true
  )

  document.addEventListener(
    'keydown',
    (event) => {
      if (!event.ctrlKey || !event.altKey || event.key.toLowerCase() !== 'd') return
      event.preventDefault()
      visible = !visible
      panel.style.display = visible ? 'block' : 'none'
      if (visible) log('诊断已开启（再按 Ctrl+Alt+D 关闭）')
    },
    true
  )

  document.addEventListener(
    'mousedown',
    (event) => {
      if (!visible) return
      const target = event.target as HTMLElement | null
      log(`mousedown (${event.clientX},${event.clientY}) → ${target?.className || target?.tagName || '?'}`)
    },
    true
  )

  document.addEventListener(
    'mouseup',
    (event) => {
      if (!visible) return
      log(`mouseup   (${event.clientX},${event.clientY})`)
    },
    true
  )

  document.addEventListener('selectionchange', () => {
    if (!visible) return
    const sel = window.getSelection()
    const text = sel ? sel.toString() : ''
    log(`selection len=${text.length} "${text.slice(0, 16).replace(/\n/g, '⏎')}"`)
  })

  window.setInterval(() => {
    if (!visible || !view) return
    const main = view.state.selection.main
    const columnOn = view.dom.classList.contains('col-mode')
    log(`cm from=${main.from} to=${main.to} ranges=${view.state.selection.ranges.length} col=${columnOn}`)
  }, 1500)
}

/* ------------------------------------------------------------------ */
/* 文档模型                                                             */
/* ------------------------------------------------------------------ */

interface Doc {
  id: string
  path: string | null
  title: string
  /** text = 普通文本；grid = CSV/TSV 表格视图 */
  kind: 'text' | 'grid'
  /** 表格文档的分隔符 */
  delimiter: string
  /** 表格文档是否切到了源码视图 */
  srcView: boolean
  state: EditorState
  meta: FileMeta
  dirty: boolean
  /** 磁盘快照，用于检测外部修改 */
  diskMtime: number
  diskSize: number
  /** 已经就"文件被删除"提示过，避免每轮重复弹 */
  extDeleted: boolean
  extBusy: boolean
  /** 大文件只读加载：只能另存为，不能覆盖原文件 */
  readonly: boolean
}

const docs: Doc[] = []
let activeId: string | null = null
let cfg: AppConfig
let view: EditorView
let tree: TreeApi
let chat: ChatApi
let untitledSeq = 0
let menu: HTMLElement | null = null
let cardPanel: CardPanel | null = null

const activeDoc = (): Doc | null => docs.find((d) => d.id === activeId) ?? null

/** 大文件阈值：超过就提示，可只读加载前面一段 */
function isCsvPath(path: string | null): boolean {
  return !!path && /\.(csv|tsv)$/i.test(path)
}

const LARGE_FILE_BYTES = 8 * 1024 * 1024
const TRUNCATE_BYTES = 3 * 1024 * 1024

function hooksFor(doc: Doc): ed.EditorHooks {
  return {
    getDocPath: () => doc.path,
    isInWorkspace: (path: string) => {
      // 统一分隔符再比：外部传进来的路径可能用 /，工作区配置里是 \
      const norm = (value: string) => value.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
      const root = norm(cfg.workspaceRoot)
      const target = norm(path)
      return target === root || target.startsWith(`${root}/`)
    },
    getBaseDirs: () =>
      // 已保存文档先按所在目录解析；再退回工作区根，
      // 这样「.assets/img/...」和「../.assets/img/...」两种写法都能命中
      doc.path
        ? [dirName(doc.path), cfg.workspaceRoot]
        : [joinPath(cfg.workspaceRoot, today()), cfg.workspaceRoot],
    liveMarkdown: cfg.liveMarkdown !== false,
    isMarkdown: ed.isMarkdownFile(doc.path ?? doc.title),
    onUpdate: ({ docChanged, state }) => {
      // ★ 必须把最新的 EditorState 写回文档对象，否则切标签/保存拿到的都是旧状态
      doc.state = state
      if (docChanged) cardPanel?.refresh()
      if (docChanged && !doc.dirty) {
        doc.dirty = true
        renderTabs()
        pushDirty()
      }
      if (doc.id === activeId) updateStatus()
    },
  }
}

function makeDoc(path: string | null, text: string, meta: FileMeta, title: string): Doc {
  const doc: Doc = {
    id: uid(),
    path,
    title,
    kind: 'text',
    delimiter: ',',
    srcView: false,
    state: null as unknown as EditorState,
    meta,
    dirty: false,
    diskMtime: 0,
    diskSize: 0,
    extDeleted: false,
    extBusy: false,
    readonly: false,
  }
  doc.state = ed.createState(text, path, cfg.theme === 'dark', hooksFor(doc))
  return doc
}

function applyFeishuFont(path: string | null): void {
  const root = (cfg.workspaceRoot ?? '').replace(/[\\/]+$/, '')
  const normalized = (path ?? '').replace(/\\/g, '/')
  const normalizedRoot = root.replace(/\\/g, '/')
  const rel = normalized.startsWith(normalizedRoot + '/')
    ? normalized.slice(normalizedRoot.length + 1)
    : ''
  document.body.classList.toggle('th-feishu-doc', rel.split('/')[0] === '飞书')
}

function openDoc(doc: Doc): void {
  // 切走之前，把当前编辑器状态存回上一篇文档（表格文档不归编辑器管）
  const previous = activeDoc()
  if (previous && previous.id !== doc.id && previous.kind === 'text') previous.state = view.state

  if (!docs.includes(doc)) docs.push(doc)
  activeId = doc.id
  applyFeishuFont(doc.path)

  if (doc.kind === 'grid' && !doc.srcView) {
    openGridDoc(doc)
  } else {
    closeGrid()
    // 列模式是全局开关，切到哪篇都保持同样配置
    doc.state = ed.setColumnMode(doc.state, ed.isColumnMode())
    view.setState(doc.state)
    view.focus()
  }

  renderTabs()
  updateStatus()
  schedulePersist()
  document.dispatchEvent(new CustomEvent('th:doc-changed'))
}

/* ---------------- CSV 表格文档 ---------------- */

let gridApi: GridApi | null = null
let gridDocId: string | null = null

function openGridDoc(doc: Doc): void {
  const host = $('grid-host')
  host.textContent = ''
  host.classList.add('active')
  $('editor-host').classList.add('hidden-by-grid')

  gridDocId = doc.id
  gridApi = createGrid(
    host,
    doc.delimiter,
    (text) => {
      // 网格改动 → 写回 EditorState，保存/脏标记/会话恢复都走原有逻辑
      doc.state = doc.state.update({
        changes: { from: 0, to: doc.state.doc.length, insert: text },
      }).state
      if (!doc.dirty) {
        doc.dirty = true
        renderTabs()
        pushDirty()
      }
      if (doc.id === activeId) updateStatus()
      schedulePersist()
    },
    {
      onCopyMarkdown: (rows) => {
        void window.th.app.copyText(rowsToMarkdown(rows)).then(() => toast('已复制 Markdown 表格'))
      },
    }
  )
  gridApi.setText(doc.state.doc.toString())
  gridApi.focus()
}

function closeGrid(): void {
  gridApi = null
  gridDocId = null
  $('grid-host').classList.remove('active')
  $('grid-host').textContent = ''
  $('editor-host').classList.remove('hidden-by-grid')
}

/** 表格文档在「表格」和「源码」之间切换 */
function toggleGridView(): void {
  const doc = activeDoc()
  if (!doc || doc.kind !== 'grid') return
  if (!doc.srcView) {
    // 当前是表格视图：先把 view 里可能残留的内容丢掉，切换到源码前不动
    doc.srcView = true
  } else {
    // 从源码切回表格：把编辑器里的内容收回文档状态
    doc.state = view.state
    doc.srcView = false
  }
  openDoc(doc)
}

/** 把选中的 Markdown 表格转成 CSV 标签 */
function markdownSelectionToGrid(): void {
  const rows = markdownToRows(selectedText())
  if (!rows) {
    toast('先在笔记里选中一个 Markdown 表格（以 | 开头的连续行）')
    return
  }
  untitledSeq += 1
  const title = `未命名-${untitledSeq}.csv`
  const doc = makeDoc(
    null,
    rows.map((row) => row.join(',')).join('\n'),
    { encoding: cfg.defaultEncoding, bom: false, eol: 'CRLF' },
    title
  )
  doc.kind = 'grid'
  doc.delimiter = ','
  openDoc(doc)
  toast('已转成表格标签')
}
/** 新建一个表格标签 */
/** 这篇文档是否按 Markdown 渲染（未命名文档没有 path，用标题判断） */
function docIsMarkdown(doc: Doc | null): boolean {
  return !!doc && doc.kind === 'text' && ed.isMarkdownFile(doc.path ?? doc.title)
}

/** Markdown 即时渲染里双击表格 → 用 CSV 表格视图编辑 */
function openMarkdownTableAsGrid(rows: string[][]): void {
  untitledSeq += 1
  const doc = makeDoc(
    null,
    serializeCsv(rows, ','),
    { encoding: cfg.defaultEncoding, bom: false, eol: 'CRLF' },
    `未命名-${untitledSeq}.csv`
  )
  doc.kind = 'grid'
  doc.delimiter = ','
  openDoc(doc)
  toast('已打开表格视图；保存后可复制回 Markdown')
}

function newGridDoc(rows = 3, cols = 3): void {
  untitledSeq += 1
  const title = `未命名-${untitledSeq}.csv`
  const doc = makeDoc(
    null,
    Array.from({ length: rows }, () => Array.from({ length: cols }, () => '').join(',')).join('\n'),
    { encoding: cfg.defaultEncoding, bom: false, eol: 'CRLF' },
    title
  )
  doc.kind = 'grid'
  doc.delimiter = ','
  openDoc(doc)
}

/** 打开已有的 CSV/TSV 文件（表格视图） */
function makeGridDoc(path: string, file: Awaited<ReturnType<typeof window.th.fs.read>>): Doc {
  const doc = makeDoc(
    file.path,
    file.text,
    { encoding: file.encoding, bom: file.bom, eol: file.eol },
    baseName(path)
  )
  doc.kind = 'grid'
  doc.delimiter = detectDelimiter(file.text, path.split('.').pop()?.toLowerCase())
  return doc
}

function makeUntitled(): Doc {
  untitledSeq += 1
  return makeDoc(
    null,
    '',
    { encoding: cfg.defaultEncoding, bom: false, eol: 'CRLF' },
    `未命名-${untitledSeq}.md`
  )
}

/* ------------------------------------------------------------------ */
/* Tab 栏                                                               */
/* ------------------------------------------------------------------ */

function renderTabs(): void {
  const tabs = $('tabs')
  tabs.textContent = ''
  for (const doc of docs) {
    const tab = document.createElement('div')
    tab.className = [doc.id === activeId ? 'tab active' : 'tab', doc.dirty ? 'dirty' : ''].filter(Boolean).join(' ')
    tab.title = doc.path ?? '未保存的临时文件'

    const title = document.createElement('span')
    title.className = 'title'
    const isExternal = !!doc.path && !doc.path.toLowerCase().startsWith(cfg.workspaceRoot.toLowerCase())
    title.textContent = `${doc.dirty ? '● ' : ''}${isExternal ? '↗ ' : ''}${doc.title}`
    if (isExternal) tab.title = `工作区外文件：${doc.path}`

    tab.appendChild(fileIconEl(doc.path ?? doc.title, false, 13))

    const close = document.createElement('button')
    close.className = 'close'
    close.textContent = '×'
    close.title = '关闭'
    // 按下就阻止冒泡：否则父级的 mousedown 会重建标签栏，click 永远轮不到这个按钮
    close.addEventListener('mousedown', (event) => event.stopPropagation())
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      void closeDoc(doc.id)
    })

    tab.append(title, close)
    // 标签也能拖：拖到右侧 = 并排编辑
    tab.draggable = true
    tab.addEventListener('dragstart', (event) => {
      if (!event.dataTransfer) return
      event.dataTransfer.effectAllowed = 'copy'
      event.dataTransfer.setData('application/x-th-tab', doc.id)
      if (doc.path) event.dataTransfer.setData('application/x-th-path', doc.path)
      document.body.classList.add('dragging-file')
    })
    tab.addEventListener('dragend', () => document.body.classList.remove('dragging-file'))
    // 用 click 而不是 mousedown：否则一按住就切过去，拖到右栏时左右都是同一篇
    tab.addEventListener('click', (event) => {
      if ((event.target as HTMLElement | null)?.closest('.close')) return
      openDoc(doc)
    })
    tab.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      showTabMenu(doc, event)
    })
    tabs.appendChild(tab)
  }

  ensureActiveTabVisible()
  updateTabsNav()
}

/** 把当前标签滚进可视区（标签多的时候很容易跑到视野外） */
function ensureActiveTabVisible(): void {
  const tabs = document.getElementById('tabs')
  const activeTab = tabs?.querySelector<HTMLElement>('.tab.active')
  if (!tabs || !activeTab || tabs.clientWidth === 0) return
  const box = tabs.getBoundingClientRect()
  const rect = activeTab.getBoundingClientRect()
  if (rect.left < box.left) tabs.scrollLeft -= box.left - rect.left + 10
  else if (rect.right > box.right) tabs.scrollLeft += rect.right - box.right + 10
}

/** 标签栏溢出时才显示左右箭头 */
function updateTabsNav(): void {
  const tabs = $('tabs')
  const prev = $<HTMLButtonElement>('tabs-prev')
  const next = $<HTMLButtonElement>('tabs-next')
  const overflow = tabs.scrollWidth > tabs.clientWidth + 2
  document.getElementById('tabbar')?.classList.toggle('has-overflow', overflow)
  prev.disabled = !overflow || tabs.scrollLeft <= 1
  next.disabled = !overflow || tabs.scrollLeft >= tabs.scrollWidth - tabs.clientWidth - 1
}

function scrollTabs(delta: number): void {
  const tabs = $('tabs')
  tabs.scrollBy({ left: delta, behavior: 'smooth' })
  window.setTimeout(updateTabsNav, 180)
}

/* ---------------- Tab 右键菜单 ---------------- */

async function closeMany(list: Doc[]): Promise<void> {
  if (list.length === 0) return
  const dirty = list.filter((doc) => doc.dirty)
  if (dirty.length > 0) {
    const choice = await confirmDialog({
      title: '关闭多个标签',
      message: `要关闭 ${list.length} 个标签，其中 ${dirty.length} 个有未保存的修改。`,
      detail: dirty.map((doc) => doc.title).join('、'),
      buttons: ['取消', '仍然关闭'],
      defaultId: 0,
      cancelId: 0,
    })
    if (choice === 0) return
  }

  for (const doc of list) {
    const index = docs.findIndex((item) => item.id === doc.id)
    if (index >= 0) docs.splice(index, 1)
  }

  if (!docs.some((doc) => doc.id === activeId)) {
    const next = docs[docs.length - 1] ?? makeUntitled()
    if (!docs.includes(next)) docs.push(next)
    activeId = null
    openDoc(next)
    return
  }

  renderTabs()
  updateStatus()
  pushDirty()
  schedulePersist()
}

async function renameDoc(doc: Doc): Promise<void> {
  if (!doc.path) return
  const oldPath = doc.path
  const name = await askText('重命名文件', baseName(oldPath))
  if (!name || name === baseName(oldPath)) return

  const target = joinPath(dirName(oldPath), name)
  try {
    await window.th.fs.rename(oldPath, target)
    doc.path = target
    doc.title = baseName(target)
    // 路径变了，相对链接的基准也要重建
    doc.state = ed.createState(doc.state.doc.toString(), target, cfg.theme === 'dark', hooksFor(doc))
    if (doc.id === activeId) view.setState(doc.state)
    renderTabs()
    updateStatus()
    void tree.refresh()
    schedulePersist()
    toast(`已重命名为 ${name}`)
  } catch (err) {
    toast(`重命名失败：${errorMessage(err)}`)
  }
}

async function trashDoc(doc: Doc): Promise<void> {
  if (!doc.path) return
  const choice = await confirmDialog({
    title: '移到回收站',
    message: `把「${doc.title}」移到回收站？`,
    detail: doc.path,
    buttons: ['取消', '移到回收站'],
    defaultId: 0,
    cancelId: 0,
  })
  if (choice === 0) return

  try {
    await window.th.fs.trash(doc.path)
    doc.dirty = false
    doc.extDeleted = true
    await closeDoc(doc.id)
    void tree.refresh()
    toast(`已移到回收站：${doc.title}`)
  } catch (err) {
    toast(`删除失败：${errorMessage(err)}`)
  }
}

function showTabMenu(doc: Doc, event: MouseEvent): void {
  const index = docs.indexOf(doc)
  const items: Array<[string, () => void]> = [
    ['关闭', () => void closeDoc(doc.id)],
    ['关闭其他', () => void closeMany(docs.filter((item) => item.id !== doc.id))],
    ['关闭左侧', () => void closeMany(docs.slice(0, index))],
    ['关闭右侧', () => void closeMany(docs.slice(index + 1))],
    ['关闭所有未修改', () => void closeMany(docs.filter((item) => item.id !== doc.id && !item.dirty))],
    ['保存', () => void saveDoc(doc)],
    ['另存为…', () => void saveDoc(doc, true)],
  ]

  if (doc.path) {
    items.push(
      ['重命名…', () => void renameDoc(doc)],
      ['重新加载', () => void reloadDoc(doc)],
      ['在资源管理器中显示', () => void window.th.fs.reveal(doc.path as string)],
      ['复制完整路径', () => void window.th.app.copyText(doc.path as string)],
      ['复制文件名', () => void window.th.app.copyText(baseName(doc.path as string))],
      ['移到回收站', () => void trashDoc(doc)]
    )
  }

  showMenu(event.clientX, event.clientY, items)
}

async function closeDoc(id: string): Promise<void> {
  const index = docs.findIndex((d) => d.id === id)
  if (index < 0) return
  const doc = docs[index]

  if (doc.dirty) {
    const choice = await confirmDialog({
      title: '关闭标签',
      message: `「${doc.title}」有未保存的修改。`,
      detail: '直接关闭会丢失这些修改。',
      buttons: ['取消', '保存并关闭', '直接关闭'],
      defaultId: 1,
      cancelId: 0,
    })
    if (choice === 0) return
    if (choice === 1) {
      const saved = await saveDoc(doc)
      if (!saved) return
    }
  }

  const now = docs.findIndex((d) => d.id === id)
  if (now < 0) {
    renderTabs()
    return
  }
  docs.splice(now, 1)
  if (activeId === id) {
    const next = docs[Math.min(now, docs.length - 1)]
    if (next) {
      activeId = null
      openDoc(next)
    } else {
      activeId = null
      openDoc(makeUntitled())
    }
  }
  renderTabs()
  updateStatus()
  pushDirty()
  schedulePersist()
}

/* ------------------------------------------------------------------ */
/* 状态栏                                                               */
/* ------------------------------------------------------------------ */

function pushDirty(): void {
  window.th.app.setDirty(docs.filter((d) => d.dirty).length)
}

function updateStatus(): void {
  updateMdLiveClass()
  const doc = activeDoc()
  if (!doc) return
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.head)

  $('st-path').textContent = doc.path ?? '未命名（保存时自动归入当日目录）'
  if (doc.kind === 'grid') {
    const counts = gridApi?.cellCount() ?? { rows: 0, cols: 0 }
    $('st-pos').textContent = `${counts.rows} 行 × ${counts.cols} 列`
    $('st-lines').textContent = `${doc.state.doc.lines} 行 CSV`
  } else {
    $('st-pos').textContent = `Ln ${line.number}, Col ${sel.head - line.from + 1}`
    $('st-lines').textContent = `${view.state.doc.lines} 行`
  }
  $('st-dirty').textContent = doc.dirty ? '未保存' : ''
  const sourceBtn = document.getElementById('st-source') as HTMLButtonElement | null
  if (sourceBtn) {
    const isGrid = doc.kind === 'grid'
    sourceBtn.style.display = isGrid ? '' : 'none'
    const jsonBtn = document.getElementById('st-json') as HTMLButtonElement | null
    if (jsonBtn) jsonBtn.style.display = isGrid ? 'none' : ''
    sourceBtn.title = isGrid && doc.srcView ? '切回表格视图' : '查看原始 CSV 源码'
  }
  $<HTMLSelectElement>('st-encoding').value = doc.meta.encoding
  $('st-eol').textContent = doc.meta.eol
  ;( $('st-eol') as HTMLElement).classList.toggle('dirty', doc.dirty)

  const columnBtn = $('st-column')
  const columnOn = ed.isColumnMode()
  columnBtn.classList.toggle('active', columnOn)
  // 图标按钮：只切状态和 tooltip，别把 SVG 冲掉
  columnBtn.title = columnOn
    ? '列选择模式已开启：拖拽变成矩形选择（再点一次关闭）'
    : '列选择模式（点击开启，也可以按住 Alt 拖拽）'
}

/* ------------------------------------------------------------------ */
/* 打开 / 保存                                                          */
/* ------------------------------------------------------------------ */

/**
 * 打开工作区外的文件：主进程默认不让读，
 * 但这是用户亲手点/拖/命令行带进来的，先授权再打开。
 */
async function openExternal(path: string): Promise<void> {
  try {
    const ok = await window.th.fs.allow(path)
    if (!ok) {
      toast(`找不到文件：${path}`)
      return
    }
    await openPath(path)
  } catch (err) {
    toast(errorMessage(err))
  }
}
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i

/** 图片文件的预览（不塞进编辑器，避免二进制报错） */
async function openImagePreview(path: string): Promise<void> {
  const data = await window.th.fs.readImageData(path)
  if (!data) {
    toast('读不到这张图')
    return
  }
  const overlay = document.createElement('div')
  overlay.className = 'overlay'
  const modal = document.createElement('div')
  modal.className = 'modal image-preview'

  const head = document.createElement('div')
  head.className = 'image-preview-head'
  const name = document.createElement('strong')
  name.textContent = data.name
  const spacer = document.createElement('span')
  spacer.style.flex = '1'
  const close = document.createElement('button')
  close.className = 'icon-btn'
  close.textContent = '✕'
  close.addEventListener('click', () => overlay.remove())
  head.append(name, spacer, close)

  const body = document.createElement('div')
  body.className = 'image-preview-body'
  const img = document.createElement('img')
  img.src = data.dataUrl
  img.alt = data.name
  body.appendChild(img)

  const foot = document.createElement('div')
  foot.className = 'archive-foot'
  const hint = document.createElement('span')
  hint.className = 'archive-hint'
  hint.textContent = baseName(path)
  img.addEventListener('load', () => {
    void window.th.fs.stat(path).then((stat) => {
      const kb = stat.exists ? Math.max(1, Math.round(stat.size / 1024)) : 0
      hint.textContent = `${img.naturalWidth}×${img.naturalHeight}${kb ? ` · ${kb} KB` : ''}`
    })
  })
  const asBg = document.createElement('button')
  asBg.className = 'btn small'
  asBg.textContent = '设为背景'
  asBg.addEventListener('click', async () => {
    // 背景图只认工作区内的相对路径：外面的图先导入 .assets
    let rel = path
    const root = cfg.workspaceRoot.replace(/\\/g, '/')
    const normalized = path.replace(/\\/g, '/')
    if (normalized.startsWith(root)) {
      rel = normalized.slice(root.length + 1)
    } else {
      const imported = await window.th.fs.importImage(path)
      if (!imported) {
        toast('导入图片失败')
        return
      }
      rel = imported.path
    }
    const updated = { ...cfg, bgImage: rel, bgPreset: 0, bgOpacity: 0.6 }
    cfg = updated
    applyBackground(updated)
    void window.th.config.patch({ bgImage: rel, bgPreset: 0, bgOpacity: 0.6 })
    overlay.remove()
    toast('已设为背景')
  })
  const reveal = document.createElement('button')
  reveal.className = 'btn small'
  reveal.textContent = '在资源管理器显示'
  reveal.addEventListener('click', () => void window.th.fs.reveal(path))
  foot.append(hint, asBg, reveal)

  modal.append(head, body, foot)
  overlay.appendChild(modal)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove()
  })
  document.body.appendChild(overlay)
}

async function openPath(path: string, line?: number): Promise<void> {
  applyFeishuFont(path)
  // 图片走预览，不进编辑器（二进制内容会报错）
  if (IMAGE_EXT.test(path)) {
    await openImagePreview(path)
    return
  }
  const existing = docs.find((d) => d.path === path)
  if (existing) {
    openDoc(existing)
    focusLine(existing, line)
    return
  }
  try {
    const stat = await window.th.fs.stat(path)
    if (!stat.exists) {
      toast('文件不存在')
      return
    }

    let options: { maxBytes?: number } | undefined
    if (stat.size > LARGE_FILE_BYTES) {
      const mb = (stat.size / 1048576).toFixed(1)
      const choice = await confirmDialog({
        title: '文件太大',
        message: `${baseName(path)} 有 ${mb} MB，直接打开可能卡顿。`,
        detail: `可以只读加载前 ${TRUNCATE_BYTES / 1048576} MB，编辑后另存为新文件。`,
        buttons: ['取消', '只读打开'],
        defaultId: 1,
        cancelId: 0,
      })
      if (choice === 0) return
      options = { maxBytes: TRUNCATE_BYTES }
    }

    const file = await window.th.fs.read(path, options)
    const doc = isCsvPath(path)
      ? makeGridDoc(path, file)
      : makeDoc(
          file.path,
          file.text,
          { encoding: file.encoding, bom: file.bom, eol: file.eol },
          baseName(path)
        )
    doc.diskMtime = stat.mtimeMs
    doc.diskSize = stat.size
    doc.readonly = file.readonly
    openDoc(doc)
    // 工作区内的文件：顺手展开树里的上级目录，别让用户自己一层层找
    if (doc.path && doc.path.toLowerCase().startsWith(cfg.workspaceRoot.toLowerCase())) {
      tree?.revealPath(doc.path)
    }
    focusLine(doc, line)
    if (file.truncated) {
      toast(`只读加载了前 ${TRUNCATE_BYTES / 1048576} MB（原文件 ${(stat.size / 1048576).toFixed(1)} MB）`)
    }
  } catch (err) {
    toast(errorMessage(err))
  }
}

async function saveDoc(doc: Doc | null, saveAs = false): Promise<boolean> {
  if (!doc) return false

  let target = doc.path

  // 只读片段（大文件截断加载）绝不能覆盖原文件
  if (doc.readonly && !saveAs) {
    const choose = await confirmDialog({
      title: '只读片段',
      message: '这个文档是只读加载的文件片段，直接保存会截断原文件。',
      detail: '请改用「另存为」保存到新文件。',
      buttons: ['取消', '另存为'],
      defaultId: 1,
      cancelId: 0,
    })
    if (choose === 0) return false
    saveAs = true
  }

  if (saveAs) {
    const dir = doc.path ? dirName(doc.path) : joinPath(cfg.workspaceRoot, today())
    const suggested = joinPath(dir, doc.path ? baseName(doc.path) : doc.title)
    const picked = await window.th.fs.pickSave(suggested)
    if (!picked) return false
    target = picked
  } else if (!target) {
    // 未命名文档：直接落进「当日日期目录」，不弹对话框（这是产品默认行为）
    const dir = joinPath(cfg.workspaceRoot, today())
    try {
      await window.th.fs.ensureDir(dir)
      target = await window.th.fs.nextPath(dir, doc.title)
    } catch (err) {
      toast(`无法创建当日目录：${errorMessage(err)}`)
      return false
    }
  }

  // 活跃文档以编辑器里的实时状态为准，其余用各自保存的状态
  const text =
    doc.kind === 'grid' ? doc.state.doc.toString() : (doc.id === activeId ? view.state : doc.state).doc.toString()
  try {
    // 先干跑一次，确认编码不会丢字；确认后真正落盘
    const check = await window.th.fs.write(target, text, doc.meta, true)
    if (check.lossy) {
      const choice = await confirmDialog({
        title: '编码不兼容',
        message: `当前编码（${ENCODING_LABEL[doc.meta.encoding]}）无法表示文件里的部分字符，继续保存会丢字。`,
        detail: '建议改存为 UTF-8（在右下角编码下拉框里切换后重试）。',
        buttons: ['取消', '仍然保存'],
        defaultId: 0,
        cancelId: 0,
      })
      if (choice !== 1) return false
    }
    await window.th.fs.write(target, text, doc.meta, false)

    doc.path = target
    doc.title = baseName(target)
    doc.dirty = false
    // 保存成功：改动标记的基线推进到刚写入的内容
    if (doc.id === activeId) {
      view.dispatch({ effects: setBaselineEffect.of(text) })
    } else {
      doc.state = ed.withBaseline(doc.state, text)
    }
    doc.readonly = false
    // 刷新磁盘快照，否则自己的保存会被误判成"外部修改"
    try {
      const stat = await window.th.fs.stat(target)
      doc.diskMtime = stat.mtimeMs
      doc.diskSize = stat.size
      doc.extDeleted = false
    } catch {
      /* 忽略 */
    }
    renderTabs()
    updateStatus()
    pushDirty()
    toast(`已保存到 ${target}`)
    void tree.refresh()
    return true
  } catch (err) {
    toast(`保存失败：${errorMessage(err)}`)
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 外部变更监测（文件被别的程序改 / 被删除）                            */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* 双栏编辑：把文件拖到编辑器右半边 → 并排显示，对比按钮直接用这两栏 */
/* ------------------------------------------------------------------ */

let splitDoc: Doc | null = null
let splitView: EditorView | null = null
type PaneSide = 'left' | 'right'
let focusPane: PaneSide = 'left'

const splitIsOpen = (): boolean => splitDoc !== null

function splitHooks(doc: Doc): ed.EditorHooks {
  return {
    getDocPath: () => doc.path,
    getBaseDirs: () => (doc.path ? [dirName(doc.path), cfg.workspaceRoot] : [cfg.workspaceRoot]),
    onUpdate: ({ docChanged, state }) => {
      doc.state = state
      if (docChanged && !doc.dirty) {
        doc.dirty = true
        $('split-dirty').hidden = false
        // 右栏用的可能是左侧已打开的同一篇，标签上的 ● 也要跟着亮
        if (docs.includes(doc)) {
          renderTabs()
          pushDirty()
        }
      }
    },
  }
}

function closeSplitNow(): void {
  $('split-resizer').hidden = true
  $('pane-left').style.flex = ''
  $('pane-right').style.flex = ''
  splitView?.destroy()
  splitView = null
  splitDoc = null
  focusPane = 'left'
  $('pane-right').hidden = true
  $('split-title').textContent = '右侧文档'
  $('split-dirty').hidden = true
  // 左侧头只在双栏时存在
  document.getElementById('left-pane-head')?.remove()
  view.focus()
}

function closeSplit(): void {
  if (!splitDoc) return
  if (splitDoc.dirty) {
    void confirmDialog({
      title: '关闭右侧文档',
      message: `「${$('split-title').textContent ?? ''}」还没保存，确定关闭吗？`,
      buttons: ['取消', '关闭'],
      defaultId: 1,
      cancelId: 0,
    }).then((choice) => {
      if (choice === 1) closeSplitNow()
    })
    return
  }
  closeSplitNow()
}

/** 左侧栏头（双栏时显示当前标签名，保证两栏文本起点对齐） */
function ensureLeftHead(): HTMLElement {
  let head = document.getElementById('left-pane-head')
  if (!head) {
    head = document.createElement('div')
    head.id = 'left-pane-head'
    head.className = 'pane-head'
    const label = document.createElement('span')
    label.className = 'pane-label'
    label.textContent = '左'
    const name = document.createElement('span')
    name.id = 'left-pane-title'
    head.append(label, name)
    $('pane-left').insertBefore(head, view.dom)
  }
  return head
}

/** 用已经打开的文档填右栏（拖标签时用，保留未保存的编辑内容） */
/* 并排编辑：右栏宽度可拖动，比例记在配置里 */
const SPLIT_MIN_LEFT = 320
const SPLIT_MIN_RIGHT = 300

function clampSplitRatio(ratio: number): number {
  const host = $('editor-host').getBoundingClientRect().width || 1
  const minLeft = Math.min(SPLIT_MIN_LEFT / host, 0.35)
  const minRight = Math.min(SPLIT_MIN_RIGHT / host, 0.35)
  return Math.min(Math.max(ratio, minLeft), 1 - minRight)
}

function applySplitRatio(ratio = cfg.splitRatio ?? 0.5): void {
  const left = $('pane-left')
  const right = $('pane-right')
  const resizer = $('split-resizer')
  if (right.hidden) return
  const value = clampSplitRatio(ratio)
  // 用 flex-basis 控制，左栏自动让位，窗口缩放时也按比例保持
  left.style.flex = `1 1 ${(1 - value) * 100}%`
  right.style.flex = `0 0 ${value * 100}%`
  resizer.hidden = false
}

function setupSplitResizer(): void {
  const resizer = $('split-resizer')
  const host = $('editor-host')

  const drag = (event: PointerEvent): void => {
    event.preventDefault()
    resizer.setPointerCapture(event.pointerId)
    resizer.classList.add('dragging')
    document.body.classList.add('split-dragging')

    const rect = host.getBoundingClientRect()
    const move = (moveEvent: PointerEvent): void => {
      const ratio = (rect.right - moveEvent.clientX) / rect.width
      applySplitRatio(ratio)
    }
    const up = (): void => {
      resizer.classList.remove('dragging')
      document.body.classList.remove('split-dragging')
      resizer.removeEventListener('pointermove', move)
      resizer.removeEventListener('pointerup', up)
      resizer.removeEventListener('pointercancel', up)
      // 松手才写配置，避免拖动过程里频繁落盘
      const width = $('pane-right').getBoundingClientRect().width
      const total = host.getBoundingClientRect().width || 1
      const ratio = Math.round((width / total) * 100) / 100
      cfg = { ...cfg, splitRatio: ratio }
      void window.th.config.patch({ splitRatio: ratio })
    }

    resizer.addEventListener('pointermove', move)
    resizer.addEventListener('pointerup', up)
    resizer.addEventListener('pointercancel', up)
  }

  // pointerdown 里 preventDefault 会把 dblclick 吞掉，双击复位自己判
  const reset = (): void => {
    applySplitRatio(0.5)
    cfg = { ...cfg, splitRatio: 0.5 }
    void window.th.config.patch({ splitRatio: 0.5 })
  }
  let lastDownAt = 0
  resizer.addEventListener('pointerdown', (event) => {
    const now = Date.now()
    if (now - lastDownAt < 350) {
      lastDownAt = 0
      reset()
      return
    }
    lastDownAt = now
    drag(event)
  })
  // 窗口缩放时重新夹紧，别让某一栏缩到看不见
  window.addEventListener('resize', () => {
    if (!splitIsOpen()) return
    const total = host.getBoundingClientRect().width || 1
    const width = $('pane-right').getBoundingClientRect().width
    applySplitRatio(width / total)
  })
}

function openSplitDoc(doc: Doc): void {
  if (doc.kind !== 'text') {
    toast('表格文档暂时只能开在左侧')
    return
  }
  // 左栏始终保持不动，右栏只是"再看一份"
  const current = doc.id === activeId ? view.state : doc.state
  const state = ed.createState(current.doc.toString(), doc.path, cfg.theme === 'dark', splitHooks(doc))
  // 右栏用的是同一份 Doc，编辑要写回它
  if (!splitView) {
    splitView = ed.createView($('split-host'), state)
    splitView.dom.addEventListener('mousedown', () => {
      focusPane = 'right'
    })
  } else {
    splitView.setState(state)
  }
  splitDoc = doc
  focusPane = 'right'
  ensureLeftHead()
  const leftTitle = document.getElementById('left-pane-title')
  const leftDoc = activeDoc()
  if (leftTitle && leftDoc) leftTitle.textContent = baseName(leftDoc.path ?? leftDoc.title)
  $('pane-right').hidden = false
  applySplitRatio()
  $('split-title').textContent = doc.title
  $('split-title').title = doc.path ?? ''
  $('split-dirty').hidden = !doc.dirty
  splitView.focus()
}

/** 在右栏打开一个文件（拖拽、对比都会用到） */
async function openSplitFile(path: string): Promise<void> {
  if (splitDoc?.path === path) {
    splitView?.focus()
    return
  }
  try {
    const stat = await window.th.fs.stat(path)
    if (stat.isDirectory) return
    if (stat.size > LARGE_FILE_BYTES) {
      toast('右侧只支持 8 MB 以内的文本文件')
      return
    }
    const file = await window.th.fs.read(path)
    // fs.read 返回的是扁平结构，meta 要自己拼
    const meta = { encoding: file.encoding, bom: file.bom, eol: file.eol }
    const doc = makeDoc(path, file.text, meta, baseName(path))
    const state = ed.createState(file.text, path, cfg.theme === 'dark', splitHooks(doc))
    doc.state = state

    if (!splitView) {
      splitView = ed.createView($('split-host'), state)
      splitView.dom.addEventListener('mousedown', () => {
        focusPane = 'right'
      })
    } else {
      splitView.setState(state)
    }

    splitDoc = doc
    focusPane = 'right'
    ensureLeftHead()
    const leftTitle = document.getElementById('left-pane-title')
    const leftDoc = activeDoc()
    if (leftTitle && leftDoc) leftTitle.textContent = baseName(leftDoc.path ?? leftDoc.title)
    $('pane-right').hidden = false
    applySplitRatio()
    $('split-title').textContent = baseName(path)
    $('split-title').title = path
    $('split-dirty').hidden = true
    splitView.focus()
  } catch (err) {
    toast(errorMessage(err))
  }
}

async function saveSplit(): Promise<void> {
  if (!splitDoc || !splitDoc.path) return
  const text = splitView ? splitView.state.doc.toString() : splitDoc.state.doc.toString()
  try {
    await window.th.fs.write(splitDoc.path, text, splitDoc.meta, false)
    splitDoc.dirty = false
    $('split-dirty').hidden = true
    if (docs.includes(splitDoc)) {
      renderTabs()
      pushDirty()
    }
    try {
      const stat = await window.th.fs.stat(splitDoc.path)
      splitDoc.diskMtime = stat.mtimeMs
      splitDoc.diskSize = stat.size
    } catch {
      /* 忽略 */
    }
    toast(`已保存 ${baseName(splitDoc.path)}`)
  } catch (err) {
    toast(errorMessage(err))
  }
}

/** 两栏文本 + 文件名，供对比窗预填 */
function splitPair(): { leftText: string; rightText: string; leftName: string; rightName: string } | null {
  const left = activeDoc()
  if (!left || !splitDoc) return null
  const leftText = (left.id === activeId ? view.state : left.state).doc.toString()
  const rightText = splitView ? splitView.state.doc.toString() : splitDoc.state.doc.toString()
  return {
    leftText,
    rightText,
    leftName: baseName(left.path ?? left.title),
    rightName: baseName(splitDoc.path ?? splitDoc.title),
  }
}

/** 拖拽：右半边 = 并排编辑，左半边 = 正常打开 */
function setupDropZone(): void {
  // 挂在整个窗口上：在侧栏、AI 面板上松手也能打开
  const main = $('app')
  const isRightHalf = (x: number): boolean => {
    const rect = main.getBoundingClientRect()
    return x > rect.left + rect.width * 0.62
  }

    const insideComposer = (target: EventTarget | null): boolean =>
      target instanceof Element && !!target.closest('#ai-composer')

  main.addEventListener(
    'dragover',
    (event) => {
      // 落在 AI 输入区的拖拽交给聊天框自己处理（附图），不要当文件打开
      if (insideComposer(event.target)) return
      const types = Array.from(event.dataTransfer?.types ?? [])
      if (!types.includes('application/x-th-path') && !types.includes('application/x-th-tab') && !types.includes('Files')) return
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      main.classList.toggle('drop-target', isRightHalf(event.clientX))
    },
    true
  )

  main.addEventListener(
    'dragleave',
    (event) => {
      if (!main.contains(event.relatedTarget as Node | null)) main.classList.remove('drop-target')
    },
    true
  )

  main.addEventListener(
    'drop',
    (event) => {
      const droppedFiles = Array.from(event.dataTransfer?.files ?? [])
      const onlyImages =
        droppedFiles.length > 0 &&
        droppedFiles.every(
          (file) => /^image\//.test(file.type) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)
        )
      // 输入框里的拖放由对话面板自己处理：
      //  - 图片：加附件
      //  - 文本/页签：不拦
      // 但「把 .sql 之类的文件拖进输入框」应该当打开文件处理，不能直接吃掉
      if (insideComposer(event.target) && (droppedFiles.length === 0 || onlyImages)) return
      const tabId = event.dataTransfer?.getData('application/x-th-tab') ?? ''
      const path = event.dataTransfer?.getData('application/x-th-path') ?? ''
      main.classList.remove('drop-target')

      // 从资源管理器拖进来的真实文件：先授权再打开（工作区外的文件也允许）
      const dropped = droppedFiles
      if (!tabId && !path && dropped.length > 0) {
        event.preventDefault()
        event.stopPropagation()
        // Electron 32+ 没有 File.path 了，必须走 webUtils
        const abs = window.th.app.pathForFile(dropped[0])
        if (!abs) {
          toast('拿不到拖入文件的路径，试试用 Ctrl+O 打开')
          return
        }
        if (dropped.length > 1) toast(`一次只打开第一个文件（共 ${dropped.length} 个）`)
        void openExternal(abs)
        return
      }
      if (!tabId && !path) return
      event.preventDefault()
      event.stopPropagation()
      const right = isRightHalf(event.clientX)
      if (tabId) {
        const doc = docs.find((d) => d.id === tabId)
        if (!doc) return
        if (right) openSplitDoc(doc)
        else openDoc(doc)
        return
      }
      if (right) void openSplitFile(path)
      else void openPath(path)
    },
    true
  )
}
async function reloadDoc(doc: Doc): Promise<void> {
  if (!doc.path) return
  try {
    const file = await window.th.fs.read(doc.path)
    doc.meta = { encoding: file.encoding, bom: file.bom, eol: file.eol }
    doc.state = ed.createState(file.text, doc.path, cfg.theme === 'dark', hooksFor(doc))
    doc.dirty = false
    doc.extDeleted = false
    if (doc.id === activeId) view.setState(doc.state)
    const stat = await window.th.fs.stat(doc.path)
    doc.diskMtime = stat.mtimeMs
    doc.diskSize = stat.size
    renderTabs()
    updateStatus()
    pushDirty()
  } catch (err) {
    toast(`重新加载失败：${errorMessage(err)}`)
  }
}

async function checkExternalChanges(): Promise<void> {
  if (document.hidden) return
  for (const doc of docs) {
    if (!doc.path || doc.extBusy) continue
    doc.extBusy = true
    try {
      const stat = await window.th.fs.stat(doc.path)

      if (!stat.exists) {
        if (doc.extDeleted) continue
        doc.extDeleted = true
        const choice = await confirmDialog({
          title: '文件已删除',
          message: `${doc.title} 已从磁盘上删除。`,
          detail: '保留窗口内容可以继续编辑，保存时会重新创建这个文件。',
          buttons: ['关闭标签', '保留内容'],
          defaultId: 1,
          cancelId: 0,
        })
        if (choice === 0) await closeDoc(doc.id)
        continue
      }

      if (doc.extDeleted) {
        // 文件又回来了
        doc.extDeleted = false
        doc.diskMtime = stat.mtimeMs
        doc.diskSize = stat.size
        continue
      }

      if (stat.mtimeMs === doc.diskMtime && stat.size === doc.diskSize) continue

      // 外部改动了
      if (doc.dirty) {
        const choice = await confirmDialog({
          title: '文件已被修改',
          message: `${doc.title} 在磁盘上被其他程序修改了。`,
          detail: '你本地也有未保存的修改：重新加载会用磁盘上的版本覆盖（本地改动丢失），保留则继续用你改的版本。',
          buttons: ['保留本地修改', '重新加载'],
          // 蓝色给「重新加载」；回车/Esc 仍是保留本地，避免手滑丢改动
          primaryId: 1,
          defaultId: 0,
          cancelId: 0,
        })
        if (choice === 1) {
          await reloadDoc(doc)
        } else {
          doc.diskMtime = stat.mtimeMs
          doc.diskSize = stat.size
        }
      } else {
        const choice = await confirmDialog({
          title: '文件已被修改',
          message: `${doc.title} 在磁盘上被其他程序修改了。`,
          detail: '是否重新加载？',
          buttons: ['否', '是'],
          defaultId: 1,
          cancelId: 0,
        })
        if (choice === 1) {
          await reloadDoc(doc)
        } else {
          doc.diskMtime = stat.mtimeMs
          doc.diskSize = stat.size
        }
      }
    } finally {
      doc.extBusy = false
    }
  }
}

/* ------------------------------------------------------------------ */
/* 标签页恢复 / 崩溃快照                                                */
/* ------------------------------------------------------------------ */

let persistTimer: number | null = null

/** 保存编辑器状态。withText=true 时把未保存内容也快照进去（崩溃恢复用） */
function schedulePersist(withText = false): void {
  if (persistTimer) window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    persistTimer = null
    // 未改动过的「欢迎」模板不进快照，否则每次启动都会多一个"未保存"标签
    const source = docs.filter((doc) => !(doc.path === null && !doc.dirty && doc.title === '欢迎.md'))
    const tabs: SavedEditorTab[] = source.map((doc) => {
      const liveState = doc.kind === 'grid' || doc.id !== activeId ? doc.state : view.state
      const includeText = withText && (doc.dirty || !doc.path)
      const tab: SavedEditorTab = { path: doc.path, title: doc.title, dirty: doc.dirty }
      if (includeText) tab.text = liveState.doc.toString()
      return tab
    })
    const activeIndex = Math.max(
      0,
      source.findIndex((doc) => doc.id === activeId)
    )
    void window.th.state.save({ tabs, activeIndex, cleanExit: false }).catch(() => undefined)
  }, withText ? 250 : 400)
}

async function restoreEditorState(): Promise<boolean> {
  let saved: SavedEditorState | null = null
  try {
    saved = await window.th.state.load()
  } catch {
    return false
  }
  if (!saved || saved.tabs.length === 0) return false

  let restored = 0
  let recoveredText = 0

  for (const tab of saved.tabs) {
    if (tab.path) {
      try {
        const stat = await window.th.fs.stat(tab.path)
        if (!stat.exists) continue
        const file = await window.th.fs.read(tab.path)
        // 有未保存快照就用快照，别让崩溃丢掉改动
        const useSnapshot = Boolean(tab.dirty && tab.text !== undefined)
        const doc = makeDoc(
          file.path,
          useSnapshot ? (tab.text as string) : file.text,
          { encoding: file.encoding, bom: file.bom, eol: file.eol },
          baseName(tab.path)
        )
        if (isCsvPath(tab.path)) {
          doc.kind = 'grid'
          doc.delimiter = detectDelimiter(doc.state.doc.toString(), tab.path.split('.').pop()?.toLowerCase())
        }
        doc.diskMtime = stat.mtimeMs
        doc.diskSize = stat.size
        doc.readonly = file.readonly
        if (useSnapshot) {
          doc.dirty = true
          recoveredText += 1
        }
        docs.push(doc)
        restored += 1
      } catch {
        /* 打不开就跳过 */
      }
    } else if (tab.text !== undefined) {
      const doc = makeDoc(null, tab.text, { encoding: cfg.defaultEncoding, bom: false, eol: 'LF' }, tab.title)
      if (isCsvPath(tab.title)) {
        doc.kind = 'grid'
        doc.delimiter = detectDelimiter(tab.text, tab.title.split('.').pop()?.toLowerCase())
      }
      if (tab.text.trim().length > 0) {
        doc.dirty = true
        recoveredText += 1
      }
      docs.push(doc)
      restored += 1
    }
  }

  if (restored === 0) return false

  const index = Math.min(Math.max(0, saved.activeIndex), docs.length - 1)
  openDoc(docs[index])
  renderTabs()
  pushDirty()

  if (!saved.cleanExit) {
    toast(`上次异常退出，已恢复 ${restored} 个标签${recoveredText ? `（含 ${recoveredText} 个未保存修改）` : ''}`)
  }
  return true
}

/* ------------------------------------------------------------------ */
/* 文件夹搜索 / 快速打开                                                */
/* ------------------------------------------------------------------ */

function mkBtn(label: string, primary = false): HTMLButtonElement {
  const el = document.createElement('button')
  el.className = primary ? 'btn primary' : 'btn'
  el.textContent = label
  return el
}

function labeledInput(label: string, placeholder: string): { wrap: HTMLLabelElement; input: HTMLInputElement } {
  const wrap = document.createElement('label')
  wrap.textContent = label
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = placeholder
  input.spellcheck = false
  wrap.appendChild(input)
  return { wrap, input }
}

function checkboxField(label: string): { wrap: HTMLLabelElement; input: HTMLInputElement } {
  const wrap = document.createElement('label')
  wrap.className = 'inline-check'
  const input = document.createElement('input')
  input.type = 'checkbox'
  wrap.append(input, document.createTextNode(label))
  return { wrap, input }
}

function focusLine(doc: Doc, line?: number): void {
  if (!line || doc.id !== activeId) return
  const state = view.state
  const target = Math.max(1, Math.min(line, state.doc.lines))
  const pos = state.doc.line(target).from
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
  view.focus()
  schedulePersist()
}

/** 打开新面板前先关掉旧面板，避免弹窗叠加 */
function closeOverlays(): void {
  document.querySelectorAll('.overlay').forEach((el) => el.remove())
}

function openSearchPanel(): void {
  closeOverlays()
  const parts = createModal('文件夹搜索', { tall: true })
  const q = labeledInput('查找内容', '支持正则；回车开始搜索')
  const r = labeledInput('替换为', '留空则只做查找')

  const optionsRow = document.createElement('div')
  optionsRow.className = 'option-row'
  const optCase = checkboxField('区分大小写')
  const optRegex = checkboxField('正则')
  const optWord = checkboxField('全词匹配')
  optionsRow.append(optCase.wrap, optRegex.wrap, optWord.wrap)

  const status = document.createElement('div')
  status.className = 'search-status'
  const results = document.createElement('div')
  results.className = 'search-results'

  parts.body.append(q.wrap, r.wrap, optionsRow, status, results)

  let lastHits: SearchHit[] = []

  const collect = (): SearchOptions => ({
    query: q.input.value,
    caseSensitive: optCase.input.checked,
    regex: optRegex.input.checked,
    wholeWord: optWord.input.checked,
  })

  const doSearch = async (): Promise<void> => {
    if (!q.input.value.trim()) {
      status.textContent = '请输入要查找的内容'
      return
    }
    status.textContent = '搜索中…'
    results.textContent = ''
    const result = await window.th.search.files(collect())
    lastHits = result.hits

    if (result.error) {
      status.textContent = result.error
      return
    }
    status.textContent =
      result.hits.length === 0
        ? `在 ${result.scannedFiles} 个文件里没找到`
        : `找到 ${result.hits.length} 处，扫描 ${result.scannedFiles} 个文件${result.truncated ? '（结果已截断）' : ''}`

    for (const hit of result.hits) {
      const row = document.createElement('div')
      row.className = 'search-hit'
      const loc = document.createElement('span')
      loc.className = 'hit-loc'
      // 文件名:行号，完整相对路径放 title 里
      loc.textContent = `${baseName(hit.rel)}:${hit.line}`
      loc.title = `${hit.rel}:${hit.line}`
      const text = document.createElement('span')
      text.className = 'hit-text'
      text.textContent = hit.text
      text.title = hit.text
      row.append(loc, text)
      row.addEventListener('click', () => {
        parts.close()
        void openPath(hit.path, hit.line)
      })
      results.appendChild(row)
    }
  }

  const doReplace = async (): Promise<void> => {
    if (lastHits.length === 0) {
      status.textContent = '先搜索一次再替换'
      return
    }
    const paths = [...new Set(lastHits.map((hit) => hit.path))]
    const choice = await confirmDialog({
      title: '全部替换',
      message: `将在 ${paths.length} 个文件的 ${lastHits.length} 处替换「${q.input.value}」。`,
      detail: '替换前会自动备份到 .history/ 目录，可用「另存为」外的任何方式回滚。',
      buttons: ['取消', '开始替换'],
      defaultId: 1,
      cancelId: 0,
    })
    if (choice === 0) return

    const res = await window.th.search.replace(paths, collect(), r.input.value)
    status.textContent = `已替换 ${res.replacements} 处，涉及 ${res.files} 个文件${
      res.failed.length ? `，${res.failed.length} 个失败` : ''
    }`
    parts.body.scrollTop = 0
    void tree.refresh()
    await doSearch()
  }

  const searchBtn = mkBtn('查找全部')
  searchBtn.addEventListener('click', () => void doSearch())
  const replaceBtn = mkBtn('全部替换', true)
  replaceBtn.addEventListener('click', () => void doReplace())
  const closeBtn = mkBtn('关闭')
  closeBtn.addEventListener('click', () => parts.close())
  parts.foot.append(searchBtn, replaceBtn, closeBtn)

  q.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void doSearch()
    }
  })
  parts.root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') parts.close()
  })

  q.input.focus()
}

function fuzzyMatch(haystack: string, needle: string): boolean {
  if (!needle) return true
  let i = 0
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1
    if (i === needle.length) return true
  }
  return false
}

async function openQuickOpen(): Promise<void> {
  closeOverlays()
  const parts = createModal('快速打开', { tall: true })
  const q = labeledInput('文件', '输入片段即可，↑↓ 选择，回车打开')
  const list = document.createElement('div')
  list.className = 'quick-list'
  parts.body.append(q.wrap, list)

  const closeBtn = mkBtn('关闭')
  closeBtn.addEventListener('click', () => parts.close())
  parts.foot.append(closeBtn)

  const files = await window.th.fs.files()
  let filtered: string[] = []
  let cursor = 0

  const pick = (rel: string): void => {
    parts.close()
    void openPath(joinPath(cfg.workspaceRoot, rel))
  }

  const render = (): void => {
    const needle = q.input.value.trim().toLowerCase()
    filtered = files.filter((file) => fuzzyMatch(file.toLowerCase(), needle)).slice(0, 40)
    list.textContent = ''

    if (filtered.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'quick-empty'
      empty.textContent = files.length === 0 ? '工作区里没有文件' : '没有匹配的文件'
      list.appendChild(empty)
      return
    }

    filtered.forEach((rel, index) => {
      const row = document.createElement('div')
      row.className = index === cursor ? 'quick-item active' : 'quick-item'
      row.textContent = rel
      row.addEventListener('click', () => pick(rel))
      list.appendChild(row)
    })
  }

  q.input.addEventListener('input', () => {
    cursor = 0
    render()
  })
  q.input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      cursor = Math.min(cursor + 1, Math.max(0, filtered.length - 1))
      render()
      event.preventDefault()
    } else if (event.key === 'ArrowUp') {
      cursor = Math.max(0, cursor - 1)
      render()
      event.preventDefault()
    } else if (event.key === 'Enter') {
      const target = filtered[cursor]
      if (target) pick(target)
      event.preventDefault()
    } else if (event.key === 'Escape') {
      parts.close()
    }
  })

  render()
  q.input.focus()
}

/* ------------------------------------------------------------------ */
/* 编辑器右键菜单                                                        */
/* ------------------------------------------------------------------ */

function selectedText(): string {
  const ranges = view.state.selection.ranges.filter((range) => !range.empty)
  if (ranges.length === 0) return ''
  return ranges.map((range) => view.state.sliceDoc(range.from, range.to)).join('\n')
}

function deleteSelection(): void {
  const ranges = view.state.selection.ranges.filter((range) => !range.empty)
  if (ranges.length > 0) {
    view.dispatch({ changes: ranges.map((range) => ({ from: range.from, to: range.to, insert: '' })) })
    return
  }
  const pos = view.state.selection.main.head
  if (pos < view.state.doc.length) view.dispatch({ changes: { from: pos, to: pos + 1 } })
}

async function copySelection(): Promise<void> {
  const text = selectedText()
  if (text) await window.th.app.copyText(text)
}

async function cutSelection(): Promise<void> {
  const text = selectedText()
  if (!text) return
  await window.th.app.copyText(text)
  deleteSelection()
}

async function pasteClipboard(): Promise<void> {
  const text = await window.th.app.readText()
  if (!text) return
  const ranges = view.state.selection.ranges
  view.dispatch({
    changes: ranges.map((range) => ({ from: range.from, to: range.to, insert: text })),
    selection: { anchor: view.state.selection.main.from + text.length },
  })
}

/** 对选中内容（没选中就是整个文档）做行级处理 */
function transformLines(fn: (lines: string[]) => string[]): void {
  const sel = view.state.selection.main
  const hasSelection = !sel.empty
  const from = hasSelection ? sel.from : 0
  const to = hasSelection ? sel.to : view.state.doc.length
  const text = view.state.sliceDoc(from, to)
  if (!text) {
    toast('没有可处理的内容')
    return
  }

  const next = fn(text.split('\n')).join('\n')
  if (next === text) {
    toast('内容没有变化')
    return
  }

  view.dispatch({
    changes: { from, to, insert: next },
    selection: { anchor: from, head: from + next.length },
  })
  view.focus()
  toast(hasSelection ? '已处理选中内容' : '已处理整个文档')
}

function transformChars(fn: (text: string) => string): void {
  const sel = view.state.selection.main
  const hasSelection = !sel.empty
  const from = hasSelection ? sel.from : 0
  const to = hasSelection ? sel.to : view.state.doc.length
  const text = view.state.sliceDoc(from, to)
  if (!text) {
    toast('没有可处理的内容')
    return
  }
  const next = fn(text)
  if (next === text) {
    toast('内容没有变化')
    return
  }
  view.dispatch({
    changes: { from, to, insert: next },
    selection: { anchor: from, head: from + next.length },
  })
  view.focus()
}

/** 数字优先的排序比较：9 排在 10 前面 */
function compareLines(a: string, b: string): number {
  const na = Number(a.trim())
  const nb = Number(b.trim())
  if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' })
}

function sortLines(desc: boolean): void {
  transformLines((lines) => [...lines].sort((a, b) => (desc ? -compareLines(a, b) : compareLines(a, b))))
}

function sortLinesByLength(desc = false): void {
  transformLines((lines) =>
    [...lines].sort((a, b) => (desc ? b.length - a.length : a.length - b.length) || compareLines(a, b))
  )
}

function dedupeLines(): void {
  transformLines((lines) => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const line of lines) {
      const key = line.trimEnd()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(line)
    }
    return out
  })
}

async function newGridFromDialog(): Promise<void> {
  const spec = await askTable()
  if (!spec) return
  newGridDoc(spec.rows, spec.cols)
}
/** 编辑器选区 → 归档面板（Ctrl+Alt+A） */
function archiveSelection(): void {
  const sel = view.state.selection.main
  if (sel.empty) {
    toast('先选中要归档的内容')
    return
  }
  const text = view.state.sliceDoc(sel.from, sel.to)
  const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? ''
  openArchivePanel(
    {
      target: 'knowledge',
      title: firstLine.replace(/^#+\s*/, '').trim().slice(0, 30),
      content: text,
      source: 'editor',
    },
    { toast: (message: string) => toast(message) }
  )
}

function showEditorMenu(event: MouseEvent): void {
  event.preventDefault()
  const columnOn = ed.isColumnMode()
  showMenu(event.clientX, event.clientY, [
    ['剪切', () => void cutSelection()],
    ['复制', () => void copySelection()],
    ['粘贴', () => void pasteClipboard()],
    ['删除', deleteSelection],
    ['全选', () => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })],
    ['---', () => undefined],
    ['撤消', () => undo(view)],
    ['重做', () => redo(view)],
    ['---', () => undefined],
    ['归档选中内容…', archiveSelection],
    ['---', () => undefined],
    ['新建表格标签', () => void newGridFromDialog()],
    ['在本文中查找 / 替换', () => openInTextSearch()],
    ['---', () => undefined],
    [
      '文本处理',
      null,
      [
        ['转换为大写', () => transformChars((text) => text.toUpperCase())],
        ['转换为小写', () => transformChars((text) => text.toLowerCase())],
        ['首字母大写', () => transformChars((text) => text.replace(/\b\w/g, (ch) => ch.toUpperCase()))],
        ['---', () => undefined],
        ['升序排列', () => sortLines(false)],
        ['降序排列', () => sortLines(true)],
        ['按长度排序', () => sortLinesByLength()],
        ['---', () => undefined],
        ['删除重复行', () => dedupeLines()],
        ['---', () => undefined],
        ['格式化 JSON', () => formatJson(false)],
        ['压缩 JSON 为一行', () => formatJson(true)],
        ['---', () => undefined],
        ['选中表格转为 CSV 标签', () => markdownSelectionToGrid()],
      ],
    ],
    ['---', () => undefined],
    [`${columnOn ? '关闭' : '开启'}列选择`, () => $('st-column').click()],
  ])
}

/* ------------------------------------------------------------------ */
/* 文件树                                                               */
/* ------------------------------------------------------------------ */

function closeMenu(): void {
  menu?.remove()
  menu = null
  // 子菜单是独立挂在 body 上的，必须一起清掉，否则点完还赖在屏幕上
  for (const el of Array.from(document.querySelectorAll('.ctx-menu'))) el.remove()
}

/** 从 "position N" 反推行列，给出人能看懂的报错位置 */
function describeJsonError(text: string, message: string): string {
  // V8 的报错有两种：带 line/column，或只带一段源码片段，先把噪音去掉
  const clean = message
    .replace(/,\s*"[\s\S]*"\s*is not valid JSON\s*$/, '')
    .replace(/\s*in JSON at position \d+.*$/, '')
    .trim()
  const lineCol = /line (\d+) column (\d+)/.exec(message)
  if (lineCol) return `第 ${lineCol[1]} 行第 ${lineCol[2]} 列附近：${clean}`
  const posMatch = /position (\d+)/.exec(message)
  if (posMatch) {
    const pos = Math.min(Number(posMatch[1]), text.length)
    const before = text.slice(0, pos)
    const line = before.split('\n').length
    const col = pos - before.lastIndexOf('\n')
    return `第 ${line} 行第 ${col} 列附近：${clean}`
  }
  return clean || message
}
/** 格式化 / 压缩 JSON；有选中就只处理选中部分 */
function formatJson(minify = false): void {
  const doc = activeDoc()
  if (!doc) return
  if (doc.kind === 'grid') {
    toast('表格标签请切到「源码」后再格式化')
    return
  }
  const sel = view.state.selection.main
  const hasSelection = !sel.empty
  const from = hasSelection ? sel.from : 0
  const to = hasSelection ? sel.to : view.state.doc.length
  const text = view.state.sliceDoc(from, to)
  if (!text.trim()) {
    toast('没有可处理的内容')
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    toast(`JSON 格式有误：` + describeJsonError(text, message))
    return
  }
  const next = minify ? JSON.stringify(parsed) : JSON.stringify(parsed, null, 2)
  if (next === text) {
    toast(minify ? 'JSON 已经是单行状态' : 'JSON 已经是格式化状态')
    return
  }
  view.dispatch({
    changes: { from, to, insert: next },
    selection: { anchor: from, head: from + next.length },
  })
  view.focus()
  const scope = hasSelection ? '选中部分' : '整个文档'
  toast(`已` + (minify ? '压缩' : '格式化') + ` JSON（` + scope + `，` + text.length.toLocaleString() + ` → ` + next.length.toLocaleString() + ` 字符）`)
}
/** 在当前文档里查找（CodeMirror 自带面板，不动工作区） */
function openInTextSearch(): void {
  openInTextPanel(view)
}

/** 菜单项：label + 动作；带 children 就是子菜单；label 为 '---' 是分隔线 */
export type MenuItem = [label: string, action: (() => void) | null, children?: MenuItem[]]

function closeSubmenus(): void {
  for (const el of Array.from(document.querySelectorAll('.ctx-menu.submenu'))) el.remove()
}

function fillMenu(box: HTMLElement, items: MenuItem[], depth: number): void {
  for (const item of items) {
    const label = item[0]
    const action = item[1]
    const children = item[2]

    if (label === '---') {
      const hr = document.createElement('div')
      hr.className = 'ctx-sep'
      box.appendChild(hr)
      continue
    }

    const btn = document.createElement('button')
    btn.textContent = label

    if (children && children.length > 0) {
      btn.classList.add('has-sub')
      const arrow = document.createElement('span')
      arrow.className = 'ctx-arrow'
      arrow.textContent = '▸'
      btn.appendChild(arrow)

      const openChildren = (): void => {
        closeSubmenus()
        const sub = document.createElement('div')
        sub.className = 'ctx-menu submenu'
        fillMenu(sub, children, depth + 1)
        document.body.appendChild(sub)
        const rect = btn.getBoundingClientRect()
        const width = sub.offsetWidth
        const left = rect.right + width + 8 > window.innerWidth ? rect.left - width - 2 : rect.right + 2
        sub.style.left = `${Math.max(4, left)}px`
        sub.style.top = `${Math.max(4, Math.min(rect.top - 4, window.innerHeight - sub.offsetHeight - 8))}px`
        if (sub.offsetHeight > window.innerHeight - 16) {
          sub.style.maxHeight = `${window.innerHeight - 16}px`
          sub.style.overflowY = 'auto'
          sub.style.top = '8px'
        }
      }

      btn.addEventListener('mouseenter', openChildren)
      btn.addEventListener('click', (event) => {
        event.stopPropagation()
        openChildren()
      })
      box.appendChild(btn)
      continue
    }

    btn.addEventListener('mouseenter', () => {
      if (depth === 0) closeSubmenus()
    })
    btn.addEventListener('click', () => {
      closeSubmenus()
      closeMenu()
      action?.()
    })
    box.appendChild(btn)
  }
}

function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu()
  closeSubmenus()
  const el = document.createElement('div')
  el.className = 'ctx-menu'
  fillMenu(el, items, 0)
  el.style.left = `${x}px`
  el.style.top = `${y}px`
  el.style.visibility = 'hidden'
  document.body.appendChild(el)

  // 贴边修正：右边放不下就往左收，下面放不下就往上翻（原来直接被窗口裁掉）
  const margin = 6
  const rect = el.getBoundingClientRect()
  const maxLeft = window.innerWidth - rect.width - margin
  const maxTop = window.innerHeight - rect.height - margin
  el.style.left = `${Math.max(margin, Math.min(x, maxLeft))}px`
  el.style.top = `${Math.max(margin, Math.min(y, maxTop))}px`

  // 菜单比窗口还高时，限制高度并允许滚动
  if (rect.height > window.innerHeight - margin * 2) {
    el.style.maxHeight = `${window.innerHeight - margin * 2}px`
    el.style.overflowY = 'auto'
    el.style.top = `${margin}px`
  }

  el.style.visibility = 'visible'
  menu = el
}

async function createIn(dir: string, isDir: boolean): Promise<void> {
  const name = await askText(isDir ? '新建文件夹' : '新建文件', isDir ? '新建文件夹' : `未命名-${++untitledSeq}.md`)
  if (!name) return
  try {
    const created = await window.th.fs.create(dir, name, isDir)
    await tree.refresh()
    if (!isDir) await openPath(created)
  } catch (err) {
    toast(errorMessage(err))
  }
}

async function handleTreeMenu(node: TreeNode | null, event: MouseEvent, api: TreeApi): Promise<void> {
  const targetDir = node ? (node.isDir ? node.path : dirName(node.path)) : cfg.workspaceRoot
  const items: Array<[string, () => void]> = []

  items.push(['新建文件', () => void createIn(targetDir, false)])
  items.push(['新建文件夹', () => void createIn(targetDir, true)])

  if (node) {
    items.push([
      '重命名',
      () => {
        void (async () => {
          const next = await askText('重命名', node.name)
          if (!next || next === node.name) return
          try {
            await window.th.fs.rename(node.path, joinPath(dirName(node.path), next))
            await tree.refresh()
          } catch (err) {
            toast(errorMessage(err))
          }
        })()
      },
    ])
    items.push([
      '删除',
      () => {
        void (async () => {
          const answer = await confirmDialog({
            title: '删除',
            message: `确定删除「${node.name}」？`,
            detail: '此操作不可撤销。',
            buttons: ['取消', '删除'],
            defaultId: 0,
            cancelId: 0,
          })
          if (answer !== 1) return
          try {
            const affected = docs.filter((d) => d.path && d.path.startsWith(node.path))
            for (const doc of affected) {
              const index = docs.indexOf(doc)
              if (index >= 0) docs.splice(index, 1)
            }
            if (!activeDoc() && docs.length === 0) openDoc(makeUntitled())
            await window.th.fs.remove(node.path)
            await tree.refresh()
            renderTabs()
          } catch (err) {
            toast(errorMessage(err))
          }
        })()
      },
    ])
    if (!node.isDir) {
      items.push(['在资源管理器中显示', () => void window.th.fs.reveal(node.path)])
      items.push(['打开', () => void openPath(node.path)])
    }
  } else {
    items.push(['刷新', () => void api.refresh()])
    items.push(['在资源管理器中显示工作目录', () => void window.th.fs.reveal(cfg.workspaceRoot)])
  }

  showMenu(event.clientX, event.clientY, items)
}

/* ------------------------------------------------------------------ */
/* AI 面板                                                              */
/* ------------------------------------------------------------------ */

function insertAtCursor(text: string): void {
  if (!text) return
  const sel = view.state.selection.main
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length },
  })
  view.focus()
}

/* ------------------------------------------------------------------ */
/* 栏宽拖拽                                                             */
/* ------------------------------------------------------------------ */

function setupResizers(): void {
  const app = $('app')
  const root = document.documentElement

  const bind = (id: string, which: 'side' | 'ai'): void => {
    const handle = $(id)
    handle.addEventListener('pointerdown', (event) => {
      if (app.classList.contains(which === 'side' ? 'side-collapsed' : 'ai-collapsed')) return
      event.preventDefault()
      handle.classList.add('dragging')
      handle.setPointerCapture(event.pointerId)

      const startX = event.clientX
      const panel = which === 'side' ? $('sidebar') : $('ai-slot')
      const startWidth = panel.getBoundingClientRect().width
      const varName = which === 'side' ? '--side-w' : '--ai-w'
      const min = which === 'side' ? 140 : 300
      const max = which === 'side' ? 480 : 900

      const onMove = (moveEvent: PointerEvent): void => {
        const delta = moveEvent.clientX - startX
        const next = which === 'side' ? startWidth + delta : startWidth - delta
        const clamped = Math.round(Math.min(Math.max(next, min), max))
        root.style.setProperty(varName, `${clamped}px`)
      }
      const onUp = (): void => {
        handle.classList.remove('dragging')
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onUp)
        const width = Math.round(parseFloat(getComputedStyle(root).getPropertyValue(varName)) || 0)
        void window.th.config.patch(which === 'side' ? { sideWidth: width } : { aiWidth: width })
      }

      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
    })
  }

  bind('side-resizer', 'side')
  bind('ai-resizer', 'ai')
} 

/* ------------------------------------------------------------------ */
/* 主题 / 设置                                                          */
/* ------------------------------------------------------------------ */

/** 显示/隐藏文件树，并同步活动栏高亮 */
function toggleSidebar(force?: boolean): void {
  const app = $('app')
  const collapsed = force === undefined ? !app.classList.contains('side-collapsed') : force
  app.classList.toggle('side-collapsed', collapsed)
  syncActivity()
  schedulePersist()
}

/** 显示/隐藏 AI 面板 */
function toggleAiPanel(force?: boolean): void {
  const app = $('app')
  const collapsed = force === undefined ? !app.classList.contains('ai-collapsed') : force
  app.classList.toggle('ai-collapsed', collapsed)
  syncActivity()
  schedulePersist()
}

/** 活动栏高亮：面板开着才算激活 */
function syncActivity(): void {
  const app = $('app')
  const files = document.getElementById('act-files')
  const ai = document.getElementById('act-ai')
  files?.classList.toggle('active', !app.classList.contains('side-collapsed'))
  ai?.classList.toggle('active', !app.classList.contains('ai-collapsed'))
}
/** 内置背景预设（文件名与 src/renderer/public/bg 对应） */
export const BG_PRESETS = [
  { id: 1, name: '深夜蓝', file: 'bg/1-deep-blue.jpg' },
  { id: 2, name: '暮色紫', file: 'bg/2-dusk-purple.jpg' },
  { id: 3, name: '晨曦橙', file: 'bg/3-dawn-warm.jpg' },
  { id: 4, name: '森林青', file: 'bg/4-forest-teal.jpg' },
  { id: 5, name: '石墨灰', file: 'bg/5-graphite.jpg' },
]

/** 应用背景图相关的 CSS 变量（整窗铺满） */
function applyBackground(next: AppConfig): void {
  const root = document.documentElement
  const preset = BG_PRESETS.find((item) => item.id === next.bgPreset)
  if (!preset && !next.bgImage) {
    root.classList.remove('has-bg')
    root.style.removeProperty('--bg-image')
    return
  }
  // 相对路径放进 CSS 变量后浏览器按样式表目录解析（assets/），先转绝对 URL
  const url = preset
    ? `url("${new URL(preset.file, location.href).href}")`
    : `url("th-asset://local/${encodeURIComponent(joinPath(next.workspaceRoot, next.bgImage))}")`
  root.style.setProperty('--bg-image', url)
  root.style.setProperty('--bg-opacity', String(next.bgOpacity))
  root.style.setProperty('--bg-blur', `${next.bgBlur}px`)
  root.style.setProperty('--bg-dim', String(next.bgDim))
  root.style.setProperty('--bg-dim-color', next.theme === 'light' ? '#ffffff' : '#000000')
  root.classList.add('has-bg')
}
function applyTheme(theme: 'dark' | 'light'): void {
  document.documentElement.dataset['theme'] = theme
  for (const doc of docs) doc.state = ed.applyTheme(doc.state, theme === 'dark')
  const current = activeDoc()
  if (view && current) view.setState(current.state)
}

const MD_THEME_IDS = ['github', 'bear', 'typo', 'vue', 'solarized', 'dracula', 'custom'] as const

/**
 * 切换 Markdown 渲染主题。
 * 主题只改一组 CSS 变量（mdThemes.css），不需要重建编辑器状态；
 * custom 时额外读工作区里的 md-theme.css 注入。
 */
async function applyMdTheme(themeId: string): Promise<void> {
  const id = (MD_THEME_IDS as readonly string[]).includes(themeId) ? themeId : 'github'
  document.documentElement.dataset['mdTheme'] = id
  document.getElementById('md-custom-css')?.remove()
  updateMdLiveClass()
  if (id !== 'custom') return
  const path = joinPath(cfg.workspaceRoot, 'md-theme.css')
  try {
    const file = await window.th.fs.read(path)
    const style = document.createElement('style')
    style.id = 'md-custom-css'
    style.textContent = file.text
    document.head.appendChild(style)
  } catch {
    // 没这个文件就保持基础 token（等同 GitHub 风格）
  }
}

/** 只有「Markdown + 即时渲染 + 非源码视图」时才启用主题排版 */
function updateMdLiveClass(): void {
  const doc = activeDoc()
  const host = document.getElementById('editor-host')
  if (!host) return
  const on = !!doc && doc.kind === 'text' && !doc.srcView && docIsMarkdown(doc) && cfg.liveMarkdown !== false
  host.classList.toggle('md-live', on)
  host.classList.toggle('md-gutter', on && cfg.mdLineNumbers === true)
}

async function openSettingsFlow(): Promise<void> {
  const next = await openSettings(cfg)
  if (!next) return
  cfg = await window.th.config.patch(next)
  applyTheme(cfg.theme)
  void applyMdTheme(cfg.mdTheme)
  applyBackground(cfg)
  document.documentElement.style.setProperty('--side-w', `${cfg.sideWidth}px`)
  document.documentElement.style.setProperty('--ai-w', `${cfg.aiWidth}px`)

  const chip = $('ai-workspace')
  chip.textContent = baseName(cfg.workspaceRoot)
  chip.title = `agent 工作区：${cfg.workspaceRoot}`

  // 模型配置可能被改过，刷新徽标与可用状态
  void chat.refreshModel()

  void tree.refresh()
}

/* ------------------------------------------------------------------ */
/* 启动                                                                 */
/* ------------------------------------------------------------------ */

const WELCOME = `# TextHarness

一个本地优先的轻量文本编辑器，右侧是一个能直接读写工作区的 agent。

## 已经能用的东西

- **多标签**：双击顶部空白新建标签，\`${MOD}+S\` 保存，\`${MOD}+W\` 关闭
- **保存**：未命名文档按 \`${MOD}+S\` 直接存进当天日期目录，不弹对话框；
  想换个位置用 \`${MOD}+Shift+S\` 另存为
- **列选择**：点右下角「列」开启列模式，或按住 \`Alt\` 拖拽；
  框出的矩形可以整列复制，粘贴时会按行分发到每个光标
- **图片粘贴**：直接在下面按 \`${MOD}+V\` 粘贴截图，会自动存到
  \`.assets/img/<日期>/\`，并插入 markdown 链接，鼠标悬停可预览
- **编码**：自动识别 UTF-8 / GBK / UTF-16，右下角可手动切换
- **日期归档**：未命名文件保存时默认落到当天的日期文件夹
- **AI agent**：它有自己的工具——列目录、读文件、写文件、正则搜索、
  在编辑器打开文件。直接说"把今天的慢查询整理成笔记"就行，不用自己找文件。
- **可拖拽**：左右两条分隔线都能拖，点「折叠」收起

> 提示：把鼠标移到下面这张图片链接上试试预览（示例图会在首次启动时生成）。

![](.assets/img/${today()}/demo.png)
`

async function boot(): Promise<void> {
  cfg = await window.th.config.get()
  document.documentElement.dataset['theme'] = cfg.theme
  void applyMdTheme(cfg.mdTheme)
  applyBackground(cfg)
  // 状态栏显示版本，排查问题时能确认用户跑的是哪一版
  void window.th.app
    .version()
    .then((version) => {
      const el = document.getElementById('st-version')
      if (el) el.textContent = `v${version}`
    })
    .catch(() => undefined)
  document.documentElement.style.setProperty('--side-w', `${cfg.sideWidth}px`)
  document.documentElement.style.setProperty('--ai-w', `${cfg.aiWidth}px`)

  view = ed.createView($('pane-left'), ed.createState('', null, cfg.theme === 'dark', {
    getDocPath: () => null,
    getBaseDirs: () => [cfg.workspaceRoot],
    onUpdate: () => undefined,
  }))
  // 列参考线间距 = 4 个字符宽
  document.documentElement.style.setProperty('--col-guide', `${Math.round(view.defaultCharacterWidth * 4)}px`)

  // 编辑器右键菜单（剪切/复制/粘贴/插入表格/查找…）
  view.contentDOM.addEventListener('contextmenu', (event) => showEditorMenu(event))

  tree = createTree($('tree'), {
    root: () => cfg.workspaceRoot,
    onOpen: (path) => void openPath(path),
    onError: toast,
    onMenu: (node, event, api) => void handleTreeMenu(node, event, api),
  })
  void tree.refresh()

  const sourceTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.source-tab'))
  const feishuPanel = $('feishu-search-panel')
  const feishuSearchInput = $<HTMLInputElement>('feishu-search-input')
  const feishuSearchResults = $('feishu-search-results')
  let searchSeq = 0
  let searchTimer: number | undefined
  const applySource = (source: string): void => {
    for (const tab of sourceTabs) tab.classList.toggle('on', tab.dataset['source'] === source)
    feishuPanel.hidden = source !== 'feishu'
    if (source === 'feishu') {
      tree.setScope('飞书', { emptyText: '（还没有拉取飞书文档，点上面的按钮搜索）' })
    } else {
      tree.setScope('', { exclude: ['飞书', '钉钉'] })
    }
  }
  for (const tab of sourceTabs) {
    tab.addEventListener('click', () => applySource(tab.dataset['source'] ?? 'local'))
  }
  const renderSearchResults = (items: Array<{ title: string; ref: string; type: string }>): void => {
    feishuSearchResults.textContent = ''
    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = 'feishu-search-status'
      empty.textContent = '没有搜到相关文档'
      feishuSearchResults.appendChild(empty)
      return
    }
    for (const item of items.slice(0, 20)) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'feishu-result'
      const title = document.createElement('span')
      title.className = 'feishu-result-title'
      title.textContent = item.title
      const meta = document.createElement('span')
      meta.className = 'feishu-result-meta'
      meta.textContent = item.type || '飞书文档'
      row.append(title, meta)
      row.addEventListener('click', () => {
        row.disabled = true
        meta.textContent = '正在拉取…'
        void window.th.app.feishuPull(item.ref).then((result) => {
          if (!result.ok) {
            meta.textContent = '拉取失败：' + (result.error ?? '未知错误')
            row.disabled = false
            return
          }
          feishuSearchResults.textContent = ''
          feishuSearchInput.value = ''
          document.dispatchEvent(new CustomEvent('th:refresh-tree'))
          if (result.path) {
            window.dispatchEvent(new CustomEvent('th:open-path', { detail: result.path }))
          }
        })
      })
      feishuSearchResults.appendChild(row)
    }
  }

  const runFeishuSearch = (): void => {
    const query = feishuSearchInput.value.trim().slice(0, 30)
    if (!query) {
      feishuSearchResults.textContent = ''
      return
    }
    const seq = ++searchSeq
    const status = document.createElement('div')
    status.className = 'feishu-search-status'
    status.textContent = '搜索中…'
    feishuSearchResults.textContent = ''
    feishuSearchResults.appendChild(status)
    void window.th.app.feishuSearch(query).then((result) => {
      if (seq !== searchSeq) return
      if (!result.ok) {
        status.textContent = '搜索失败：' + (result.error ?? '请先登录飞书')
        return
      }
      renderSearchResults(result.items)
    })
  }

  feishuSearchInput.addEventListener('input', () => {
    if (searchTimer) window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(runFeishuSearch, 300)
  })
  feishuSearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (searchTimer) window.clearTimeout(searchTimer)
      runFeishuSearch()
    }
  })
  applySource('local')

  const restored = await restoreEditorState()
  if (!restored) {
    openDoc(makeDoc(null, WELCOME, { encoding: 'utf8', bom: false, eol: 'LF' }, '欢迎.md'))
  }

  /* Tab 栏空白双击新建 */
  $('tabs-spacer').addEventListener('dblclick', () => openDoc(makeUntitled()))

  /* 侧边栏（折叠交给左侧活动栏 / Ctrl+B） */

  // Ctrl+B 切换文件栏：万一折叠按钮不好点，还能用键盘叫回来
  document.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || event.altKey || event.shiftKey) return
    if (event.key.toLowerCase() !== 'b') return
    event.preventDefault()
    toggleSidebar()
  })
  $('btn-new-file').addEventListener('click', () => {
    void createIn(joinPath(cfg.workspaceRoot, today()), false)
  })
  $('btn-search-files').addEventListener('click', () => openSearchPanel())
  $('btn-quick-open').addEventListener('click', () => void openQuickOpen())
  // 设置入口在左侧活动栏底部（齿轮）

  const filter = $<HTMLInputElement>('tree-filter')
  filter.addEventListener('input', () => tree.setFilter(filter.value))

  /* 编码 / 换行符 */
  $('st-encoding').addEventListener('change', (event) => {
    const doc = activeDoc()
    if (!doc) return
    doc.meta.encoding = (event.target as HTMLSelectElement).value as Encoding
    doc.dirty = true
    renderTabs()
    updateStatus()
    pushDirty()
  })
  $('st-eol').addEventListener('click', () => {
    const doc = activeDoc()
    if (!doc) return
    doc.meta.eol = doc.meta.eol === 'CRLF' ? 'LF' : 'CRLF'
    doc.dirty = true
    updateStatus()
    pushDirty()
  })

  $('st-json').addEventListener('click', () => formatJson(false))

  $('st-source').addEventListener('click', () => toggleGridView())

  $('st-newgrid').addEventListener('click', () => void newGridFromDialog())

  /* 双栏编辑：右侧栏的保存/关闭 + 拖拽落点 */
  $('split-save').addEventListener('click', () => void saveSplit())
  $('split-close').addEventListener('click', () => closeSplit())
  /* ---------- 应用控制：agent 操作编辑器本身 ---------- */
  window.th.editor.onAppRpc(({ id, action, payload }) => {
    const reply = (ok: boolean, text: string, data?: unknown): void => {
      window.th.editor.appReply({ id, ok, text, data })
    }

    try {
      switch (action) {
        case 'state': {
          const tabs = docs.map((doc) => ({
            title: doc.title,
            path: doc.path,
            dirty: doc.dirty,
            active: doc.id === activeId,
            kind: doc.kind,
          }))
          const sel = view.state.selection.main
          const active = activeDoc()
          const info = {
            tabs,
            activeTab: active ? { title: active.title, path: active.path, dirty: active.dirty } : null,
            cursor: { line: view.state.doc.lineAt(sel.head).number, column: sel.head - view.state.doc.lineAt(sel.head).from + 1 },
            selection: sel.empty ? '' : view.state.sliceDoc(sel.from, sel.to).slice(0, 500),
            docLines: view.state.doc.lines,
            settings: {
              theme: cfg.theme,
              bgPreset: cfg.bgPreset,
              bgOpacity: cfg.bgOpacity,
              bgBlur: cfg.bgBlur,
              bgDim: cfg.bgDim,
              splitRatio: cfg.splitRatio,
              workspace: cfg.workspaceRoot,
            },
            ui: { splitOpen: splitIsOpen(), aiOpen: !$('app').classList.contains('ai-collapsed') },
          }
          const lines = [
            `当前有 ${tabs.length} 个标签：`,
            ...tabs.map((tab, index) => `  ${index + 1}. ${tab.active ? '▶ ' : '  '}${tab.title}${tab.dirty ? '（未保存）' : ''}${tab.path ? `  ${tab.path}` : ''}`),
            `主题：${cfg.theme === 'dark' ? '深色' : '浅色'}；背景预设：${cfg.bgPreset > 0 ? cfg.bgPreset : '无'}；不透明度 ${Math.round(cfg.bgOpacity * 100)}%`,
            `工作区：${cfg.workspaceRoot}`,
            `分栏：${splitIsOpen() ? '开' : '关'}；AI 面板：${$('app').classList.contains('ai-collapsed') ? '收起' : '展开'}`,
            `当前文档：${view.state.doc.lines} 行，光标第 ${info.cursor.line} 行`,
          ]
          reply(true, lines.join('\n'), info)
          return
        }

        case 'setAppearance': {
          const patch = (payload ?? {}) as Partial<AppConfig>
          const next: AppConfig = { ...cfg, ...patch }
          cfg = next
          applyTheme(next.theme)
          void applyMdTheme(next.mdTheme)
          applyBackground(next)
          void window.th.config.patch(patch)
          const parts: string[] = []
          if (patch.theme) parts.push(`主题 → ${patch.theme === 'dark' ? '深色' : '浅色'}`)
          if (typeof patch.bgImage === 'string') {
            parts.push(patch.bgImage ? `背景图 → ${patch.bgImage.split(/[\\/]/).pop()}` : '背景图 → 已清除')
          }
          if (typeof patch.bgPreset === 'number') parts.push(`背景 → ${patch.bgPreset === 0 ? '无' : `预设 ${patch.bgPreset}`}`)
          if (typeof patch.bgOpacity === 'number') parts.push(`不透明度 → ${Math.round(patch.bgOpacity * 100)}%`)
          if (typeof patch.bgBlur === 'number') parts.push(`模糊 → ${patch.bgBlur}px`)
          if (typeof patch.bgDim === 'number') parts.push(`暗化 → ${Math.round(patch.bgDim * 100)}%`)
          reply(true, `已修改：${parts.join('，') || '（无变化）'}`)
          return
        }

        case 'closeTabs': {
          const { scope, pattern, includeDirty } = (payload ?? {}) as {
            scope: 'today' | 'others' | 'all' | 'match'
            pattern?: string
            includeDirty?: boolean
          }
          const today = new Date()
          const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
          const matched = docs.filter((doc) => {
            if (scope === 'all') return true
            if (scope === 'others') return doc.id !== activeId
            if (scope === 'match') {
              const needle = (pattern ?? '').toLowerCase()
              if (!needle) return false
              return `${doc.title}`.toLowerCase().includes(needle) || (doc.path ?? '').toLowerCase().includes(needle)
            }
            // today：路径里带日期目录，或者今天新建的未保存文档
            return (doc.path ?? '').includes(stamp) || (!doc.path && doc.dirty)
          })

          const closed: string[] = []
          const skipped: string[] = []
          for (const doc of matched) {
            if (doc.dirty && !includeDirty) {
              skipped.push(doc.title)
              continue
            }
            const index = docs.findIndex((d) => d.id === doc.id)
            if (index < 0) continue
            docs.splice(index, 1)
            closed.push(doc.title)
            if (activeId === doc.id) {
              activeId = null
              const next = docs[Math.min(index, docs.length - 1)]
              if (next) openDoc(next)
            }
          }
          if (docs.length === 0) openDoc(makeUntitled())
          renderTabs()
          updateStatus()
          pushDirty()
          schedulePersist()

          const summary = [
            closed.length > 0 ? `关闭了 ${closed.length} 个：${closed.join('、')}` : '没有关闭任何标签',
            skipped.length > 0 ? `跳过 ${skipped.length} 个未保存的：${skipped.join('、')}` : '',
          ]
            .filter(Boolean)
            .join('；')
          reply(true, summary)
          return
        }

        case 'proposeMcp': {
          const mcpPayload = (payload ?? {}) as { json?: string }
          openMcpAddDialog({
            initialJson: mcpPayload.json,
            commit: (servers: Array<{ name: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; transport?: 'stdio' | 'http' | 'sse' }>) => {
              void (async () => {
                const current = await window.th.config.get()
                const next = [...(current.mcpServers ?? [])]
                for (const server of servers) {
                  const index = next.findIndex((item) => item.name === server.name)
                  const entry = { ...server, enabled: true, policy: 'confirm-write' as const }
                  if (index >= 0) next[index] = { ...next[index], ...entry }
                  else next.push(entry)
                }
                await window.th.config.patch({ mcpServers: next })
                toast(`已添加 ${servers.length} 台 MCP 服务器，正在连接…`)
                const status = await window.th.mcp.reconnect('')
                const failed = status.filter((item) => !item.connected)
                toast(
                  failed.length === 0
                    ? 'MCP 服务器已连接'
                    : `有 ${failed.length} 台没连上：${failed.map((item) => item.name).join('、')}（设置里可看错误）`
                )
              })()
            },
          })
          return { ok: true, text: '已打开 MCP 添加确认框' }
        }
        case 'proposeArchive': {
          const p = (payload ?? {}) as {
            target?: 'knowledge' | 'memory'
            title?: string
            content?: string
            category?: string
            memoryKind?: 'fact' | 'log' | 'template'
          }
          openArchivePanel(
            {
              target: p.target ?? 'knowledge',
              title: p.title ?? '',
              content: p.content ?? '',
              category: p.category ?? '',
              memoryKind: p.memoryKind ?? 'log',
              source: 'ai',
            },
            {
              toast: (message: string) => toast(message),
            }
          )
          return { ok: true, text: '已打开归档面板' }
        }
        case 'openSettings': {
          const { section } = (payload ?? {}) as { section?: string }
          if (section) localStorage.setItem('th.settings.section', section)
          void openSettingsFlow()
          reply(true, `已打开设置${section ? `（${section}）` : ''}`)
          return
        }

        case 'switchTab': {
          const { match } = (payload ?? {}) as { match?: string }
          const needle = (match ?? '').toLowerCase()
          const doc = docs.find(
            (item) => item.title.toLowerCase().includes(needle) || (item.path ?? '').toLowerCase().includes(needle)
          )
          if (!doc) {
            reply(false, `没有找到匹配「${match}」的标签`)
            return
          }
          openDoc(doc)
          reply(true, `已切换到「${doc.title}」`)
          return
        }

        default:
          reply(false, `不认识的操作：${action}`)
      }
    } catch (err) {
      reply(false, `操作失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // 主进程的 transform_selection 要拿选区、替换选区
  window.th.editor.onSelectionRequest(({ id }) => {
    const doc = activeDoc()
    const sel = view.state.selection.main
    const text = sel.empty ? '' : view.state.sliceDoc(sel.from, sel.to)
    window.th.editor.selectionReply({ id, text, from: sel.from, to: sel.to, path: doc?.path ?? null })
  })

  window.th.editor.onSelectionReplace(({ id, text, from, to }) => {
    try {
      const length = view.state.doc.length
      const start = Math.min(Math.max(from, 0), length)
      const end = Math.min(Math.max(to, start), length)
      view.dispatch({
        changes: { from: start, to: end, insert: text },
        selection: { anchor: start + text.length },
      })
      view.focus()
      window.th.editor.selectionReplaced({ id, ok: true })
    } catch {
      window.th.editor.selectionReplaced({ id, ok: false })
    }
  })

  setupSplitResizer()
  setupUpdater()
setupLiveMarkdownToggle()
setupCardPanel()
  setupDropZone()

  $('st-diff').addEventListener('click', () => {
    // 双栏模式下：直接把左右两栏填进去，点「对比」即可出结果
    const pair = splitPair()
    if (pair) {
      openDiff({
        leftText: pair.leftText,
        rightText: pair.rightText,
        leftName: pair.leftName,
        rightName: pair.rightName,
      })
      return
    }
    // 否则：有选中文字就把它作为"原始文本"，方便直接对比当前选区
    const selected = selectedText()
    openDiff(selected ? { leftText: selected, leftName: '当前选中' } : {})
  })

  /* 标签栏：滚轮左右滚动 + 左右箭头 */
  const tabsEl = $('tabs')
  tabsEl.addEventListener(
    'wheel',
    (event) => {
      if (tabsEl.scrollWidth <= tabsEl.clientWidth) return
      const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX
      if (delta === 0) return
      event.preventDefault()
      tabsEl.scrollLeft += delta
      window.setTimeout(updateTabsNav, 60)
    },
    { passive: false }
  )
  tabsEl.addEventListener('scroll', () => updateTabsNav())
  window.addEventListener('resize', () => {
    ensureActiveTabVisible()
    updateTabsNav()
  })
  $('tabs-prev').addEventListener('click', () => scrollTabs(-260))
  $('tabs-next').addEventListener('click', () => scrollTabs(260))

  $('st-column').addEventListener('click', () => {
    const doc = activeDoc()
    if (!doc) return
    const next = !ed.isColumnMode()
    doc.state = ed.setColumnMode(doc.state, next)
    view.setState(doc.state)
    updateStatus()
    toast(next ? '列选择模式已开启：拖拽即可框选（复制/粘贴按列处理）' : '列选择模式已关闭（仍可按住 Alt 拖拽）')
  })

  /* AI 面板 */
  chat = createChat({
    onModelChanged: (name) => {
      cfg = { ...cfg, llmModel: name }
      // 顺便记到当前服务商名下，设置页切回来时能恢复
      const key = (cfg.llmBaseUrl || '').trim().replace(/\/+$/, '') || '__custom__'
      const profiles = { ...(cfg.providerProfiles ?? {}) }
      profiles[key] = { apiKey: cfg.llmApiKey, model: name }
      cfg = { ...cfg, providerProfiles: profiles }
      void window.th.config.patch({ providerProfiles: profiles })
    },
    getSelectionText: () => {
      const sel = view.state.selection.main
      return sel.empty ? '' : view.state.sliceDoc(sel.from, sel.to)
    },
    getActiveFile: () => {
      const doc = activeDoc()
      return doc ? { title: doc.title, path: doc.path, content: doc.state.doc.toString() } : null
    },
    onInsert: insertAtCursor,
    onError: toast,
    getWorkspaceLabel: () => cfg.workspaceRoot,
    onNeedConfig: () => void openSettingsFlow(),
  })
  void chat.init()
  void chat.restoreLast()

  const wsChip = $('ai-workspace')
  wsChip.textContent = baseName(cfg.workspaceRoot)
  wsChip.title = `agent 工作区：${cfg.workspaceRoot}`

  // agent 想跑脚本 → 先看代码再决定
  window.th.ai.onScriptApproval((request) => {
    void requestScriptApproval(request).then((ok) => {
      window.th.ai.approvalResult(request.id, ok)
      toast(ok ? '脚本已放行' : '已拒绝执行脚本')
    })
  })

  // agent 想访问工作区外的文件 → 弹授权框
  window.th.ai.onAccessRequest((request) => {
    void requestAccess(request).then((decision) => {
      window.th.ai.accessResult(request.id, decision)
      if (decision === 'deny') toast('已拒绝 agent 的访问申请')
      else toast(decision === 'write' ? '已允许 agent 读写这个文件' : '已允许 agent 只读这个文件')
    })
  })
  window.th.ai.onOpenFile((path) => {
    void openExternal(path)
    toast(`已打开 ${baseName(path)}`)
  })
  // 双击关联文件启动：主进程先把路径存着，这里取一次
  void window.th.app.takePendingFile().then((path) => {
    if (!path) return
    void openExternal(path)
    toast(`已打开 ${baseName(path)}`)
  })

  // 归档/追加写入后，静默重载已打开的同名文档，避免弹「文件已被修改」
  window.addEventListener('th:reload-path', ((event: CustomEvent<string | { path: string }>) => {
    const detail = event.detail
    const rel = typeof detail === 'string' ? detail : detail?.path
    if (!rel) return
    const normalized = rel.replace(/\\/g, '/')
    const doc = docs.find((item) => item.path && item.path.replace(/\\/g, '/').endsWith(normalized))
    if (!doc || doc.kind !== 'text') return
    void (async () => {
      try {
        if (doc.dirty) return
        const file = await window.th.fs.read(doc.path as string)
        doc.state = doc.state.update({ changes: { from: 0, to: doc.state.doc.length, insert: file.text } }).state
        if (doc.id === activeDoc()?.id) view.setState(doc.state)
        const stat = await window.th.fs.stat(doc.path as string)
        doc.diskMtime = stat.mtimeMs
        doc.diskSize = stat.size
        renderTabs()
      } catch {
        /* 文件没了就跳过 */
      }
    })()
  }) as EventListener)
  // 对话里点 `路径:行号` → 打开那个文件并跳到对应行
  document.addEventListener('th:md-theme-changed', () => void applyMdTheme(cfg.mdTheme))
  document.addEventListener('th:refresh-tree', () => void tree.refresh())
  window.addEventListener('th:open-path', ((event: CustomEvent<string | { path: string; line?: number }>) => {
    const detail = event.detail
    const raw = typeof detail === 'string' ? detail : (detail?.path ?? '')
    if (!raw) return
    const absolute = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/') ? raw : joinPath(cfg.workspaceRoot, raw)
    void openPath(absolute, typeof detail === 'string' ? undefined : detail.line)
  }) as EventListener)

  $('ai-hide').addEventListener('click', () => toggleAiPanel(true))

  /* ---------- 左侧活动栏 ---------- */
  const activityButtons: Array<[string, () => void]> = [
    ['act-files', () => toggleSidebar()],
    ['act-diff', () => openDiff(selectedText() ? { leftText: selectedText(), leftName: '当前选中' } : {})],
    ['act-grid', () => void newGridFromDialog()],
    ['act-ai', () => toggleAiPanel()],
    ['act-settings', () => void openSettingsFlow()],
  ]
  for (const [id, action] of activityButtons) {
    $(id).addEventListener('click', action)
  }
  // Ctrl+J 切换 AI 面板，和 Ctrl+B（文件栏）配对
  document.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || event.altKey || event.shiftKey) return
    if (event.key.toLowerCase() !== 'j') return
    event.preventDefault()
    toggleAiPanel()
  })

  // 状态栏「工具」按钮：零延迟配方面板

  $('st-tools').addEventListener('click', (event) => {
    const anchor = event.currentTarget as HTMLElement
    openToolsPanel(anchor, {
      getSelection: () => {
        const sel = view.state.selection.main
        if (!sel.empty) return view.state.sliceDoc(sel.from, sel.to)
        const doc = activeDoc()
        return doc ? view.state.doc.toString() : ''
      },
      applyText: (text) => {
        const doc = activeDoc()
        if (!doc || doc.kind !== 'text') {
          toast('表格文档暂不支持，先切到源码视图')
          return false
        }
        const sel = view.state.selection.main
        const whole = sel.empty
        const before = whole ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to)
        if (before === text) {
          toast('内容没有变化')
          return false
        }
        // 没有选区时替换整篇；有选区时只替换选区
        const from = whole ? 0 : sel.from
        const to = whole ? view.state.doc.length : sel.to
        // 光标按比例挪到新内容里，避免整篇替换后直接跳到末尾
        const ratio = before.length > 0 ? sel.head / before.length : 0
        const anchor = Math.min(Math.max(Math.round(ratio * text.length), 0), text.length)
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + anchor },
        })
        view.focus()
        toast(`${whole ? '整篇' : '选区'}｜${describeChange(before, text)}`)
        return true
      },
      askAgent: (prompt) => {
        toggleAiPanel(false)
        const input = document.getElementById('ai-input') as HTMLTextAreaElement | null
        if (input) {
          input.value = prompt
          input.focus()
        }
      },
    })
  })

  document.addEventListener('th:toast', (event) => {
    const message = (event as CustomEvent<string>).detail
    if (message) toast(message)
  })

  /* 归档草稿：头部图标 + badge */
  const draftsBtn = $('ai-drafts')
  const draftsBadge = $('ai-drafts-badge')
  const refreshDrafts = (): void => {
    void window.th.archive.draftList().then(({ pending }) => {
      draftsBadge.hidden = pending === 0
      draftsBadge.textContent = String(pending)
      draftsBtn.title = pending > 0 ? `归档草稿：${pending} 条待确认` : '归档草稿'
    })
  }
  draftsBtn.addEventListener('click', () => {
    void openDraftsPanel({ toast: (message: string) => toast(message), onChanged: refreshDrafts })
  })
  window.th.archive.onDraftChanged(() => refreshDrafts())
  refreshDrafts()

  setupResizers()

  /* 快捷键 */
  document.addEventListener(
    'keydown',
    (event) => {
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()

      if (key === 's') {
        event.preventDefault()
        // 焦点在右栏就保存右栏，否则保存当前标签
        if (focusPane === 'right' && splitIsOpen()) void saveSplit()
        else void saveDoc(activeDoc(), event.shiftKey)
      } else if (key === 'o') {
        event.preventDefault()
        void window.th.fs.pickOpen().then((picked) => {
          if (picked) void openPath(picked)
        })
      } else if (key === 'n') {
        event.preventDefault()
        openDoc(makeUntitled())
      } else if (key === 'w') {
        event.preventDefault()
        const doc = activeDoc()
        if (doc) void closeDoc(doc.id)
      } else if (key === ',') {
        event.preventDefault()
        void openSettingsFlow()
      } else if (key === 'p' && !event.shiftKey) {
        event.preventDefault()
        void openQuickOpen()
      } else if (key === 'f' && event.shiftKey) {
        event.preventDefault()
        openSearchPanel()
      }
    },
    true
  )

  document.addEventListener('mousedown', (event) => {
    // 子菜单是独立挂在 body 上的，不能用 menu.contains 判断，
    // 否则在子菜单上按下鼠标时菜单会先被关掉，click 永远轮不到那个按钮
    const target = event.target as HTMLElement | null
    if (menu && !target?.closest('.ctx-menu')) closeMenu()
  })

  // 滚轮时先收起菜单：否则鼠标停在菜单上，编辑器就滚不动
  document.addEventListener(
    'wheel',
    () => {
      if (menu) closeMenu()
    },
    { passive: true }
  )

  // Esc 关菜单
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu) {
      closeMenu()
      event.stopPropagation()
    }
  })

  /* 交互心跳：供后台任务判断"闲置多久" */
  let lastPing = 0
  const ping = (): void => {
    const now = Date.now()
    if (now - lastPing < 10_000) return
    lastPing = now
    window.th.app.activity()
  }
  document.addEventListener('pointerdown', ping, true)
  document.addEventListener('keydown', ping, true)

  /* 拖拽时把悬停缩略图藏起来：即使有元素挡着也绝不会吃掉这次拖拽 */
  document.addEventListener(
    'pointerdown',
    () => document.body.classList.add('th-selecting'),
    true
  )
  document.addEventListener('pointerup', () => document.body.classList.remove('th-selecting'), true)
  window.addEventListener('blur', () => document.body.classList.remove('th-selecting'))

  /* 每 4 秒检查一次：打开的文件是否被别的程序改了 / 删了 */
  setInterval(() => void checkExternalChanges(), 4000)

  // 会话恢复完成后标签栏才拿到真实宽度，再校正一次位置
  window.setTimeout(() => {
    ensureActiveTabVisible()
    updateTabsNav()
  }, 400)

  syncActivity()

  setupSelectionDebug()

  /* 每 10 秒把未保存内容写进恢复快照（崩溃/强杀后可还原） */
  setInterval(() => {
    if (docs.some((doc) => doc.dirty || !doc.path)) schedulePersist(true)
  }, 10_000)

  /* Ctrl + 滚轮缩放编辑器字号 */
  const applyEditorFont = (size: number, force = false): void => {
    // 8px 是还能看清的最小值；到边界就别再弹提示了
    const clamped = Math.max(8, Math.min(28, size))
    if (!force && clamped === cfg.editorFontSize) return
    cfg = { ...cfg, editorFontSize: clamped }
    document.documentElement.style.setProperty('--editor-font', `${clamped}px`)
    void window.th.config.patch({ editorFontSize: clamped })
    toast(`编辑器字号 ${clamped}px`)
  }
  // 启动时要强制应用（否则等于默认值时不会写 CSS 变量）
  applyEditorFont(cfg.editorFontSize ?? 13, true)
  document.addEventListener('th:zoom-editor', (event) => {
    const delta = Number((event as CustomEvent<number>).detail) || 0
    if (delta === 0) return
    applyEditorFont((cfg.editorFontSize ?? 13) + delta)
  })

  /* 主进程的确认请求（MCP 工具调用、归档写入）：用应用内弹窗，跟主题一致 */
  window.th.ai.onConfirm((request) => {
    void confirmDialog({
      title: request.title,
      message: request.message,
      detail: request.detail,
      buttons: request.buttons,
      primaryId: request.primaryId,
      defaultId: request.defaultId,
      cancelId: request.cancelId,
    }).then((index) => window.th.ai.replyConfirm(request.id, index))
  })

  /* 定时任务状态提示 */
  window.th.tasks.onEvent((event) => {
    if (event.phase === 'start') {
      toast(`后台任务「${event.name}」开始运行`)
    } else if (event.phase === 'done') {
      toast(`任务「${event.name}」完成：${(event.message ?? '').replace(/\s+/g, ' ').slice(0, 90)}`)
      void tree.refresh()
    } else if (event.phase === 'error') {
      toast(`任务「${event.name}」失败：${event.message ?? ''}`)
    }
  })
}

void boot()
