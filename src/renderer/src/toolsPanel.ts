import { RECIPES, RECIPE_GROUPS, joinExtractResult, type ExtractJoin, type Recipe } from './recipes'

/**
 * 状态栏的「工具」面板：零延迟配方 + 送给 agent 的入口。
 *
 * 不经过模型，点一下直接对选区/整篇生效，走 CodeMirror 事务（可撤销）。
 */

export interface ToolsPanelOptions {
  /** 选中文本；没有选区返回空串 */
  getSelection: () => string
  /** 应用一次变换；返回 false 表示被拒绝（比如表格文档） */
  applyText: (text: string) => boolean
  /** 打开 agent 面板并预填需求 */
  askAgent: (prompt: string) => void
}

const PIN_KEY = 'th.tools.pinned'
const JOIN_KEY = 'th.tools.extractJoin'

function pinnedIds(): string[] {
  try {
    const raw = localStorage.getItem(PIN_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function togglePin(id: string): void {
  const current = new Set(pinnedIds())
  if (current.has(id)) current.delete(id)
  else current.add(id)
  localStorage.setItem(PIN_KEY, JSON.stringify([...current]))
}

function extractJoin(): ExtractJoin {
  return localStorage.getItem(JOIN_KEY) === 'comma' ? 'comma' : 'newline'
}

let panel: HTMLElement | null = null

export function closeToolsPanel(): void {
  panel?.remove()
  panel = null
}

export function openToolsPanel(anchor: HTMLElement, options: ToolsPanelOptions): void {
  if (panel) {
    closeToolsPanel()
    return
  }

  const box = document.createElement('div')
  box.className = 'tools-panel'
  const rect = anchor.getBoundingClientRect()
  box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 360))}px`
  box.style.bottom = `${window.innerHeight - rect.top + 8}px`

  const head = document.createElement('div')
  head.className = 'tools-head'
  const search = document.createElement('input')
  search.type = 'search'
  search.className = 'tools-search'
  search.placeholder = '搜索工具…（去重 / 排序 / base64）'
  search.spellcheck = false
  head.appendChild(search)

  const body = document.createElement('div')
  body.className = 'tools-body'

  const hint = document.createElement('div')
  hint.className = 'tools-hint'
  hint.textContent = '对选中内容生效；没有选区就作用于整篇。'
  body.appendChild(hint)

  let query = ''
  const pins = new Set(pinnedIds())

  const apply = (recipe: Recipe): void => {
    const selection = options.getSelection()
    const source = selection || ''
    if (!source.trim()) {
      options.askAgent(`帮我${recipe.label}（当前没有选中文本，先确认要对哪个文件操作）`)
      closeToolsPanel()
      return
    }
    let output = ''
    try {
      output = recipe.apply(source)
    } catch (err) {
      console.error(err)
      hint.textContent = `这个变换失败了：${err instanceof Error ? err.message : String(err)}`
      return
    }
    if (recipe.group === '提取') {
      const joined = joinExtractResult(output, extractJoin())
      output = joined.text
      if (joined.count > 0) {
        hint.textContent = `命中 ${joined.count} 个${joined.unique < joined.count ? `（去重后 ${joined.unique} 个）` : ''}`
      }
    }
    if (!options.applyText(output)) return
    closeToolsPanel()
  }

  const renderList = (): void => {
    // 清掉旧列表（保留 hint）
    for (const el of Array.from(body.querySelectorAll('.tools-group, .tools-item, .tools-empty'))) el.remove()

    const matched = RECIPES.filter((recipe) => {
      if (!query) return true
      const haystack = [recipe.label, recipe.group, ...recipe.keywords].join(' ').toLowerCase()
      return haystack.includes(query)
    })

    if (matched.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'tools-empty'
      empty.textContent = '没有匹配的工具，试试交给 agent'
      body.appendChild(empty)
      return
    }

    const pinned = matched.filter((recipe) => pins.has(recipe.id))
    if (pinned.length > 0 && !query) {
      body.appendChild(buildGroup('常用', pinned))
    }

    for (const group of RECIPE_GROUPS) {
      const list = matched.filter((recipe) => recipe.group === group && !(pins.has(recipe.id) && !query))
      if (list.length === 0) continue
      body.appendChild(buildGroup(group, list))
    }
  }

  const buildGroup = (title: string, list: Recipe[]): HTMLElement => {
    const group = document.createElement('div')
    group.className = 'tools-group'
    const label = document.createElement('div')
    label.className = 'tools-group-label'
    label.textContent = title
    group.appendChild(label)

    for (const recipe of list) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'tools-item'
      item.dataset.recipe = recipe.id

      const name = document.createElement('span')
      name.className = 'tools-item-label'
      name.textContent = recipe.label

      const star = document.createElement('span')
      star.className = pins.has(recipe.id) ? 'tools-star on' : 'tools-star'
      star.textContent = '★'
      star.title = pins.has(recipe.id) ? '取消常用' : '设为常用'
      star.addEventListener('click', (event) => {
        event.stopPropagation()
        togglePin(recipe.id)
        if (pins.has(recipe.id)) pins.delete(recipe.id)
        else pins.add(recipe.id)
        renderList()
      })

      item.append(name, star)
      item.addEventListener('click', () => apply(recipe))
      group.appendChild(item)
    }
    return group
  }

  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase()
    renderList()
  })

  const foot = document.createElement('div')
  foot.className = 'tools-foot'
  const footLabel = document.createElement('span')
  footLabel.className = 'tools-foot-label'
  footLabel.textContent = '提取结果'
  const modes: Array<[ExtractJoin, string]> = [
    ['newline', '每行一个'],
    ['comma', '逗号分隔'],
  ]
  const modeBtns = modes.map(([mode, label]) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'tools-mode'
    btn.dataset.mode = mode
    btn.textContent = label
    if (extractJoin() === mode) btn.classList.add('on')
    btn.addEventListener('click', () => {
      localStorage.setItem(JOIN_KEY, mode)
      for (const other of modeBtns) other.classList.toggle('on', other === btn)
    })
    return btn
  })
  foot.append(footLabel, ...modeBtns)

  box.append(head, body, foot)
  document.body.appendChild(box)
  panel = box
  renderList()
  search.focus()

  const onDown = (event: MouseEvent): void => {
    if (!box.contains(event.target as Node) && event.target !== anchor) {
      closeToolsPanel()
      document.removeEventListener('mousedown', onDown, true)
    }
  }
  // 延后挂，避免当前这次点击立刻把自己关掉
  setTimeout(() => document.addEventListener('mousedown', onDown, true), 0)

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    closeToolsPanel()
    document.removeEventListener('keydown', onKey, true)
  }
  document.addEventListener('keydown', onKey, true)
}
