import type { TreeNode } from '@shared/types'
import { fileIconEl } from './fileIcons'

/** 图片文件默认显示在树里（点开是预览）；需要时可关掉 */
export interface TreeOptions {
  hideImages?: boolean
}

export interface TreeApi {
  refresh(): Promise<void>
  setFilter(text: string): void
  /** 只显示某个子目录（如「飞书」）；scope 为空时显示本地，排除指定顶层目录 */
  setScope(scope: string, options?: { exclude?: string[]; emptyText?: string }): void
  /** 给文件行加状态点（路径 → synced / modified / missing），比如飞书同步状态 */
  setBadges(badges: Map<string, string>): void
  /** 展开某个文件的所有上级目录（打开外部/深层文件时用） */
  revealPath(path: string): void
  closeMenu(): void
}

export interface TreeOptions {
  root(): string
  onOpen(path: string): void
  onError(message: string): void
  onMenu(node: TreeNode | null, event: MouseEvent, api: TreeApi): void
}

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/

function parentOf(path: string): string {
  return path.replace(/[\\/][^\\/]+$/, '')
}

function compare(a: TreeNode, b: TreeNode): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  if (a.isDir && DATE_DIR.test(a.name) && DATE_DIR.test(b.name)) {
    return b.name.localeCompare(a.name)
  }
  return a.name.localeCompare(b.name, 'zh-CN')
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function createTree(host: HTMLElement, opts: TreeOptions): TreeApi {
  let all: TreeNode[] = []
  let filter = ''
  let scope = ''
  let scopeExclude: string[] = []
  let emptyText = '（空目录）'
  let badges = new Map<string, string>()
  const badgeKey = (path: string): string => path.replace(/\\/g, '/').toLowerCase()
  let menu: HTMLElement | null = null
  const collapsed = new Set<string>()
  /** 第一次拿到目录树时把所有文件夹折叠起来：不然一屏全是展开的，很乱 */
  let collapsedOnce = false

  /** 配置里的根目录可能写成 C:/a/b，文件树返回的是 C:\a\b：统一成文件树的写法再比较 */
  function nativeRoot(): string {
    const root = opts.root().replace(/[\\/]+$/, '')
    const sample = all[0]?.path ?? ''
    return sample.includes('\\') ? root.replace(/\//g, '\\') : root
  }

  function closeMenu(): void {
    menu?.remove()
    menu = null
  }

  function scopeBase(): string {
    const root = nativeRoot()
    if (!scope) return root
    const sep = root.includes('\\') ? '\\' : '/'
    return root + sep + scope
  }

  function inScope(path: string): boolean {
    const root = nativeRoot()
    if (scope) {
      const base = scopeBase()
      return path === base || path.startsWith(base + (base.includes('\\') ? '\\' : '/'))
    }
    if (!scopeExclude.length) return true
    const sep = root.includes('\\') ? '\\' : '/'
    if (path === root) return true
    const rel = path.slice(root.length + 1)
    const top = rel.split(/[\\/]/)[0]
    return !scopeExclude.includes(top)
  }

  function scopedAll(): TreeNode[] {
    return all.filter((node) => inScope(node.path))
  }

  function visibleSet(): Set<string> {
    const baseAll = scopedAll()
    if (!filter) return new Set(baseAll.map((n) => n.path))
    const keep = new Set<string>()
    const byPath = new Map(baseAll.map((n) => [n.path, n]))
    const needle = filter.toLowerCase()
    for (const node of baseAll) {
      if (!node.name.toLowerCase().includes(needle)) continue
      keep.add(node.path)
      let cursor = parentOf(node.path)
      while (byPath.has(cursor)) {
        keep.add(cursor)
        cursor = parentOf(cursor)
      }
    }
    return keep
  }

  function render(): void {
    host.textContent = ''
    const visible = visibleSet()
    const baseAll = scopedAll()
    const children = new Map<string, TreeNode[]>()
    for (const node of baseAll) {
      if (!visible.has(node.path)) continue
      const parent = parentOf(node.path)
      const list = children.get(parent)
      if (list) list.push(node)
      else children.set(parent, [node])
    }
    for (const list of children.values()) list.sort(compare)

    const walk = (dir: string, depth: number): void => {
      const list = children.get(dir)
      if (!list) return
      for (const node of list) {
        const row = document.createElement('div')
        row.className = `row ${node.isDir ? 'is-dir' : 'is-file'}`
        row.style.paddingLeft = `${8 + depth * 12}px`
        row.dataset['path'] = node.path
        if (!node.isDir && activePath && node.path === activePath) row.style.background = 'var(--bg-3)'
        // 文件可以拖到编辑器右半边 → 并排编辑
        if (!node.isDir) {
          row.draggable = true
          row.addEventListener('dragstart', (event) => {
            if (!event.dataTransfer) return
            event.dataTransfer.effectAllowed = 'copy'
            event.dataTransfer.setData('application/x-th-path', node.path)
            event.dataTransfer.setData('text/plain', node.path)
            document.body.classList.add('dragging-file')
          })
          row.addEventListener('dragend', () => document.body.classList.remove('dragging-file'))
        }

        const twisty = document.createElement('span')
        twisty.className = 'twisty'
        const expanded = node.isDir && !collapsed.has(node.path)
        if (node.isDir) {
          // 悬停才出现的实心三角（平时让位给图标，避免每行都挤一个箭头）
          twisty.innerHTML =
            '<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M5.5 3.5l6 4.5-6 4.5z"/></svg>'
          if (expanded) twisty.classList.add('open')
          twisty.title = expanded ? '收起' : '展开'
        }

        const icon = fileIconEl(node.name, node.isDir, 14, expanded)

        const name = document.createElement('span')
        name.className = 'name'
        name.textContent = node.name

        row.append(twisty, icon, name)
        const badge = node.isDir ? undefined : badges.get(badgeKey(node.path))
        if (badge) {
          const dot = document.createElement('span')
          dot.className = 'tree-badge tree-badge-' + badge
          dot.title = badge === 'modified' ? '本地已修改，还没回写飞书' : badge === 'missing' ? '文件已不存在' : '已和飞书同步'
          row.appendChild(dot)
        }
        host.appendChild(row)

        if (node.isDir) {
          if (!collapsed.has(node.path)) walk(node.path, depth + 1)
        }
      }
    }

    const root = nativeRoot()
    const sep = root.includes('\\') ? '\\' : '/'
    walk(scope ? root + sep + scope : root, 0)
    if (baseAll.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'row is-file'
      empty.style.paddingLeft = '12px'
      empty.textContent = emptyText
      host.appendChild(empty)
    }
  }

  let activePath: string | null = null

  host.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest('.row') as HTMLElement | null
    if (!row || !row.dataset['path']) return
    const path = row.dataset['path']
    const node = all.find((n) => n.path === path)
    if (!node) return
    if (node.isDir) {
      if (collapsed.has(path)) collapsed.delete(path)
      else collapsed.add(path)
      render()
    } else {
      activePath = path
      opts.onOpen(path)
      render()
    }
  })

  host.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    const row = (event.target as HTMLElement).closest('.row') as HTMLElement | null
    const path = row?.dataset['path'] ?? null
    const node = path ? (all.find((n) => n.path === path) ?? null) : null
    if (path) activePath = path
    opts.onMenu(node, event, api)
  })

  document.addEventListener('mousedown', (event) => {
    if (menu && !menu.contains(event.target as Node)) closeMenu()
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu()
  })

  async function refresh(): Promise<void> {
    try {
      all = await window.th.fs.tree(opts.root())
      if (!collapsedOnce) {
        for (const node of all) if (node.isDir) collapsed.add(node.path)
        collapsedOnce = true
      }
      render()
    } catch (err) {
      opts.onError(`读取目录失败：${errorMessage(err)}`)
    }
  }

  function setFilter(text: string): void {
    filter = text.trim()
    render()
  }

  function revealPath(path: string): void {
    let cursor = parentOf(path)
    let changed = false
    while (cursor && cursor !== parentOf(cursor)) {
      if (collapsed.delete(cursor)) changed = true
      cursor = parentOf(cursor)
    }
    if (changed) render()
  }

  const api: TreeApi = {
    refresh,
    setFilter,
    setScope(nextScope: string, options?: { exclude?: string[]; emptyText?: string }) {
      scope = nextScope
      scopeExclude = options?.exclude ?? []
      emptyText = options?.emptyText ?? '（空目录）'
      render()
    },
    setBadges(next: Map<string, string>) {
      badges = new Map(Array.from(next, ([k, v]) => [badgeKey(k), v]))
      render()
    },
    revealPath,
    closeMenu,
  }
  return api
}
