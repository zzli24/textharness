import type { TreeNode } from '@shared/types'

export interface TreeApi {
  refresh(): Promise<void>
  setFilter(text: string): void
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
  let menu: HTMLElement | null = null
  const collapsed = new Set<string>()
  /** 第一次拿到目录树时把所有文件夹折叠起来：不然一屏全是展开的，很乱 */
  let collapsedOnce = false

  function closeMenu(): void {
    menu?.remove()
    menu = null
  }

  function visibleSet(): Set<string> {
    if (!filter) return new Set(all.map((n) => n.path))
    const keep = new Set<string>()
    const byPath = new Map(all.map((n) => [n.path, n]))
    const needle = filter.toLowerCase()
    for (const node of all) {
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
    const children = new Map<string, TreeNode[]>()
    for (const node of all) {
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
        twisty.textContent = node.isDir ? (collapsed.has(node.path) ? '▸' : '▾') : ''

        const icon = document.createElement('span')
        icon.textContent = node.isDir ? '📁' : '📄'

        const name = document.createElement('span')
        name.className = 'name'
        name.textContent = node.name

        row.append(twisty, icon, name)
        host.appendChild(row)

        if (node.isDir) {
          if (!collapsed.has(node.path)) walk(node.path, depth + 1)
        }
      }
    }

    walk(opts.root(), 0)
    if (all.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'row is-file'
      empty.style.paddingLeft = '12px'
      empty.textContent = '（空目录）'
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

  const api: TreeApi = { refresh, setFilter, revealPath, closeMenu }
  return api
}
