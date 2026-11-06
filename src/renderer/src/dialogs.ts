import type { AppConfig, Encoding } from '@shared/types'
import type { TaskView } from '@shared/api'
import { openCropDialog } from './cropDialog'

export interface ModalParts {
  root: HTMLDivElement
  body: HTMLDivElement
  foot: HTMLDivElement
  close(): void
}

export function createModal(title: string, options: { tall?: boolean } = {}): ModalParts {
  const overlay = document.createElement('div')
  overlay.className = 'overlay'

  const box = document.createElement('div')
  box.className = options.tall ? 'modal tall' : 'modal'

  const heading = document.createElement('h2')
  heading.textContent = title

  const body = document.createElement('div')
  body.className = 'body'

  const foot = document.createElement('div')
  foot.className = 'foot'

  box.append(heading, body, foot)
  overlay.appendChild(box)
  document.body.appendChild(overlay)

  return {
    root: overlay,
    body,
    foot,
    close() {
      overlay.remove()
    },
  }
}

function button(label: string, primary = false): HTMLButtonElement {
  const el = document.createElement('button')
  el.className = primary ? 'btn primary' : 'btn'
  el.textContent = label
  return el
}

function escapeText(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

export interface ConfirmSpec {
  title: string
  message: string
  detail?: string
  buttons: string[]
  /** 默认聚焦的按钮下标（也是回车触发的那个） */
  defaultId?: number
  /** 高亮成蓝色的按钮下标；不填就跟 defaultId 一致 */
  primaryId?: number
  cancelId?: number
}

/** 应用内确认框：返回被点击的按钮下标，Esc = cancelId */
export function confirmDialog(spec: ConfirmSpec): Promise<number> {
  return new Promise((resolve) => {
    const parts = createModal(spec.title)

    const message = document.createElement('div')
    message.className = 'confirm-message'
    message.textContent = spec.message
    parts.body.appendChild(message)

    if (spec.detail) {
      const detail = document.createElement('div')
      detail.className = 'confirm-detail'
      detail.textContent = spec.detail
      parts.body.appendChild(detail)
    }

    const finish = (index: number): void => {
      document.removeEventListener('keydown', onKey, true)
      parts.close()
      resolve(index)
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(spec.cancelId ?? spec.buttons.length - 1)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        finish(spec.defaultId ?? 0)
      }
    }

    spec.buttons.forEach((label, index) => {
      const el = button(label, index === (spec.primaryId ?? spec.defaultId ?? 0))
      el.dataset['index'] = String(index)
      el.addEventListener('click', () => finish(index))
      parts.foot.appendChild(el)
    })

    document.addEventListener('keydown', onKey, true)
    const focusTarget = parts.foot.querySelector<HTMLButtonElement>(
      `[data-index="${spec.defaultId ?? 0}"]`
    )
    focusTarget?.focus()
  })
}

export interface TableSpec {
  rows: number
  cols: number
}

/** 插入表格：问行数和列数 */
export function askTable(): Promise<TableSpec | null> {
  return new Promise((resolve) => {
    const parts = createModal('新建表格')

    const rowLabel = document.createElement('label')
    rowLabel.textContent = '行数（含表头）'
    const rowInput = document.createElement('input')
    rowInput.type = 'number'
    rowInput.min = '2'
    rowInput.max = '30'
    rowInput.value = '3'
    rowLabel.appendChild(rowInput)

    const colLabel = document.createElement('label')
    colLabel.textContent = '列数'
    const colInput = document.createElement('input')
    colInput.type = 'number'
    colInput.min = '1'
    colInput.max = '12'
    colInput.value = '3'
    colLabel.appendChild(colInput)

    const hint = document.createElement('div')
    hint.className = 'hint'
    hint.textContent = '会新建一个 CSV 表格标签，直接像 Excel 一样编辑'

    parts.body.append(rowLabel, colLabel, hint)

    const cancel = button('取消')
    const ok = button('确定', true)
    parts.foot.append(cancel, ok)

    let settled = false
    const finish = (value: TableSpec | null): void => {
      if (settled) return
      settled = true
      parts.close()
      resolve(value)
    }

    cancel.addEventListener('click', () => finish(null))
    ok.addEventListener('click', () => {
      const rows = Math.min(30, Math.max(2, Number(rowInput.value) || 3))
      const cols = Math.min(12, Math.max(1, Number(colInput.value) || 3))
      finish({ rows, cols })
    })
    parts.body.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        ok.click()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finish(null)
      }
    })

    rowInput.focus()
    rowInput.select()
  })
}

export function askText(title: string, defaultValue = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const parts = createModal(title)

    const input = document.createElement('input')
    input.type = 'text'
    input.value = defaultValue
    parts.body.appendChild(input)

    const cancel = button('取消')
    const ok = button('确定', true)
    parts.foot.append(cancel, ok)

    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      parts.close()
      resolve(value)
    }

    cancel.addEventListener('click', () => finish(null))
    ok.addEventListener('click', () => finish(input.value.trim() || null))
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finish(input.value.trim() || null)
      if (event.key === 'Escape') finish(null)
    })
    parts.root.addEventListener('mousedown', (event) => {
      if (event.target === parts.root) finish(null)
    })

    requestAnimationFrame(() => {
      input.focus()
      const dot = input.value.lastIndexOf('.')
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length)
    })
  })
}

export interface SettingsSection {
  id: string
  group: string
  label: string
  /** 搜索时额外匹配的关键词 */
  keywords: string[]
  build: (pane: HTMLElement) => void
}

export async function openSettings(current: AppConfig): Promise<AppConfig | null> {
  const [tasks, model, version] = await Promise.all([
    window.th.tasks.list().catch(() => [] as TaskView[]),
    window.th.ai.model().catch(() => null),
    window.th.app.version().catch(() => ''),
  ])

  return new Promise((resolve) => {
    /* ================= 外壳 ================= */
    const overlay = document.createElement('div')
    overlay.className = 'overlay'

    const box = document.createElement('div')
    box.className = 'modal settings-modal'

    const head = document.createElement('h2')
    head.className = 'set-head'
    const headText = document.createElement('span')
    headText.textContent = '设置'
    const closeBtn = document.createElement('button')
    closeBtn.className = 'set-close'
    closeBtn.type = 'button'
    closeBtn.textContent = '✕'
    closeBtn.title = '关闭（Esc）'
    head.append(headText, closeBtn)

    const body = document.createElement('div')
    body.className = 'set-body'

    const nav = document.createElement('nav')
    nav.className = 'set-nav'
    const search = document.createElement('input')
    search.type = 'search'
    search.className = 'set-search'
    search.placeholder = '搜索设置…'
    search.spellcheck = false
    const navList = document.createElement('div')
    navList.className = 'set-nav-list'
    nav.append(search, navList)

    const paneWrap = document.createElement('div')
    paneWrap.className = 'set-pane-wrap'
    body.append(nav, paneWrap)

    const foot = document.createElement('div')
    foot.className = 'foot set-foot'
    const footHint = document.createElement('div')
    footHint.className = 'set-foot-hint'
    footHint.textContent = 'Ctrl+, 打开 · Esc 关闭'
    const cancel = button('取消')
    const save = button('保存', true)
    foot.append(footHint, cancel, save)

    box.append(head, body, foot)
    overlay.appendChild(box)
    document.body.appendChild(overlay)

    let settled = false
    const finish = (value: AppConfig | null): void => {
      if (settled) return
      settled = true
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
      resolve(value)
    }

    /* ================= 可编辑状态 ================= */
    let workspaceRoot = current.workspaceRoot
    let defaultEncoding = current.defaultEncoding
    let mdTheme = current.mdTheme ?? 'github'
let mdLineNumbers = current.mdLineNumbers === true
let theme = current.theme
    let bgImage = current.bgImage
    let bgPreset = current.bgPreset ?? 0
    let bgOpacity = current.bgOpacity
    let bgBlur = current.bgBlur
    let bgDim = current.bgDim
    let apiKey = current.llmApiKey
    let baseUrl = current.llmBaseUrl
    let modelName = current.llmModel
    let reasoning = current.llmReasoning ?? 'auto'
    let autoCheckUpdate = current.autoCheckUpdate !== false
    const cfgDraft = current
    // 服务商 key（baseURL）→ 该服务商的 Key/模型；切服务商时自动存取
    const providerProfiles: Record<string, { apiKey: string; model: string }> = {
      ...(current.providerProfiles ?? {}),
    }
    /** 当前编辑中的服务商 key：baseURL 规范化；自定义中转站用 __custom__ */
    const profileKeyOf = (url: string): string => url.trim().replace(/\/+$/, '') || '__custom__'
    /** 把表单里正在编辑的 Key / 模型记到当前服务商名下 */
    const rememberProviderCreds = (): void => {
      providerProfiles[profileKeyOf(baseUrl)] = { apiKey: apiKey.trim(), model: modelName.trim() }
    }
    const toolState = { enabled: [...current.enabledTools], cap: current.toolCap }

    // 定时任务的勾选：保存时用这份，避免被打开面板时的旧快照覆盖
    const taskEnabled = new Map<string, boolean>()
    for (const task of tasks) taskEnabled.set(task.id, task.enabled)

    /* ================= 工具 ================= */
    const paneBase = (): HTMLElement => {
      const el = document.createElement('div')
      el.className = 'set-pane'
      return el
    }

    const title = (parent: HTMLElement, text: string): void => {
      const el = document.createElement('div')
      el.className = 'set-title'
      el.textContent = text
      parent.appendChild(el)
    }

    const desc = (parent: HTMLElement, text: string): void => {
      const el = document.createElement('p')
      el.className = 'set-desc'
      el.textContent = text
      parent.appendChild(el)
    }

    const field = (parent: HTMLElement, label: string): HTMLDivElement => {
      const row = document.createElement('div')
      row.className = 'set-field'
      const l = document.createElement('label')
      l.textContent = label
      const holder = document.createElement('div')
      holder.className = 'set-field-ctl'
      row.append(l, holder)
      parent.appendChild(row)
      return holder
    }

    const note = (parent: HTMLElement, text: string): void => {
      const el = document.createElement('p')
      el.className = 'set-note'
      el.textContent = text
      parent.appendChild(el)
    }

    /* ================= 各页面 ================= */
    const buildWorkspace = (pane: HTMLElement): void => {
      title(pane, '工作区')
      desc(pane, 'ai agent 只能读写这个目录；换目录后建议重启，索引和会话才会彻底切过去。')

      const rootCtl = field(pane, '工作目录')
      const rootInput = document.createElement('input')
      rootInput.type = 'text'
      rootInput.value = workspaceRoot
      rootInput.readOnly = true
      const pick = button('选择…')
      pick.addEventListener('click', () => {
        void window.th.config.pickDirectory().then((dir) => {
          if (!dir) return
          workspaceRoot = dir
          rootInput.value = dir
          // AGENTS.md 跟着新目录走，重开这个页面太麻烦，直接提示重开设置
          agentsHintRef.textContent = `项目约定将读取：${dir.replace(/[\\/]+$/, '')}/AGENTS.md`
        })
      })
      rootCtl.append(rootInput, pick)
      note(pane, '所有笔记、知识库、.history 备份和 .assets 图库都在这个目录下。')

      const galleryCtl = field(pane, '图库目录')
      const galleryInput = document.createElement('input')
      galleryInput.type = 'text'
      galleryInput.readOnly = true
      const galleryOpen = button('打开文件夹')
      galleryCtl.append(galleryInput, galleryOpen)
      void window.th.assets
        .info()
        .then((info) => {
          galleryInput.value = info.dir
          galleryInput.title = info.dir
          galleryOpen.addEventListener('click', () => void window.th.fs.openDir(info.dir))
        })
        .catch(() => {
          galleryInput.value = '读取失败'
        })
      note(pane, '粘贴的截图按日期分文件夹存放；编辑器里用相对路径引用，悬停可预览。')
    }

    const buildEditor = (pane: HTMLElement): void => {
      title(pane, '编辑器')
      desc(pane, '只影响「新建文件」的默认值；已有文件始终按它自己的编码和换行符保存。')

      const encCtl = field(pane, '默认编码')
      const encSelect = document.createElement('select')
      for (const [value, text] of [
        ['utf8', 'UTF-8'],
        ['gb18030', 'GBK'],
        ['utf16le', 'UTF-16 LE'],
        ['utf16be', 'UTF-16 BE'],
      ] as Array<[Encoding, string]>) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = text
        encSelect.appendChild(option)
      }
      encSelect.value = defaultEncoding
      encSelect.addEventListener('change', () => {
        defaultEncoding = encSelect.value as Encoding
      })
      encCtl.appendChild(encSelect)
      note(pane, '编码识别是自动的（UTF-8 / GBK / UTF-16 都能认），这里只决定新文件存成什么。')

      const themeCtl = field(pane, '主题')
      const themeSelect = document.createElement('select')
      for (const [value, text] of [
        ['dark', '深色'],
        ['light', '浅色'],
      ] as Array<['dark' | 'light', string]>) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = text
        themeSelect.appendChild(option)
      }
      themeSelect.value = theme
      themeSelect.addEventListener('change', () => {
        theme = themeSelect.value as AppConfig['theme']
      })
      themeCtl.appendChild(themeSelect)
      note(pane, '未命名文档保存时会自动落到当天日期目录，不用手动建文件夹。')
    }

    const buildLook = (pane: HTMLElement): void => {
      title(pane, '外观')
      desc(pane, '背景图整窗铺满，面板自动变半透明。自定义图片会复制到工作区的 .assets/bg/ 里。')

      const presets = [
        { id: 1, name: '深夜蓝', file: 'bg/1-deep-blue.jpg' },
        { id: 2, name: '暮色紫', file: 'bg/2-dusk-purple.jpg' },
        { id: 3, name: '晨曦橙', file: 'bg/3-dawn-warm.jpg' },
        { id: 4, name: '森林青', file: 'bg/4-forest-teal.jpg' },
        { id: 5, name: '石墨灰', file: 'bg/5-graphite.jpg' },
      ]

      const swatches = document.createElement('div')
      swatches.className = 'bg-swatches'
      pane.appendChild(swatches)

      const noneCell = document.createElement('button')
      noneCell.type = 'button'
      noneCell.className = 'bg-swatch bg-none'
      noneCell.title = '不使用背景图'
      noneCell.textContent = '无'
      noneCell.dataset['preset'] = '0'
      swatches.appendChild(noneCell)

      for (const preset of presets) {
        const cell = document.createElement('button')
        cell.type = 'button'
        cell.className = 'bg-swatch'
        cell.title = preset.name
        cell.dataset['preset'] = String(preset.id)
        cell.style.backgroundImage = `url("${new URL(preset.file, location.href).href}")`
        const tip = document.createElement('span')
        tip.className = 'bg-swatch-name'
        tip.textContent = preset.name
        cell.appendChild(tip)
        swatches.appendChild(cell)
      }

      const customRow = document.createElement('div')
      customRow.className = 'bg-custom'
      const customBtn = button('自定义图片…')
      const customName = document.createElement('span')
      customName.className = 'bg-custom-name'
      customRow.append(customBtn, customName)
      pane.appendChild(customRow)

      const syncSwatches = (): void => {
        for (const cell of Array.from(swatches.querySelectorAll<HTMLElement>('.bg-swatch'))) {
          const id = Number(cell.dataset['preset'])
          const active = bgPreset > 0 ? id === bgPreset : id === 0
          cell.classList.toggle('active', active)
        }
        if (bgPreset > 0) {
          customName.textContent = `当前：${presets.find((p) => p.id === bgPreset)?.name ?? '预设'}`
        } else if (bgImage) {
          customName.textContent = `当前：${bgImage.split('/').pop() ?? '自定义'}`
        } else {
          customName.textContent = '当前：无背景'
        }
      }

      swatches.addEventListener('click', (event) => {
        const cell = (event.target as HTMLElement | null)?.closest<HTMLElement>('.bg-swatch')
        if (!cell) return
        bgPreset = Number(cell.dataset['preset'] ?? '0')
        if (bgPreset > 0) bgImage = ''
        syncSwatches()
      })

      customBtn.addEventListener('click', () => {
        customName.textContent = '选择中…'
        void window.th.fs
          .pickImage()
          .then(async (source) => {
            if (!source) {
              syncSwatches()
              return
            }
            const info = await window.th.fs.readImageData(source)
            if (!info) {
              customName.textContent = '读取失败'
              return
            }
            customName.textContent = '拖动选取范围…'
            const cropped = await openCropDialog(info)
            if (!cropped) {
              syncSwatches()
              return
            }
            const saved = await window.th.fs.writeImage(cropped, info.name)
            bgImage = saved.path
            bgPreset = 0
            syncSwatches()
            customName.textContent = `已保存 ${saved.name}，点「保存」生效`
          })
          .catch((err: unknown) => {
            customName.textContent = `导入失败：${err instanceof Error ? err.message : String(err)}`
          })
      })

      const mdSection = document.createElement('div')
      mdSection.className = 'md-section'
      title(mdSection, 'Markdown 渲染')
      desc(mdSection, '只影响 .md 的即时渲染，源码模式不受影响；主题会跟随深色/浅色自动切换色板。')

      const mdThemes = [
        {
          id: 'github',
          name: 'GitHub',
          desc: '文档风 · 竖线表格 · 蓝链接',
          light: ['#ffffff', '#1f2328', '#0969da', '#d1d9e0'],
          dark: ['#0d1117', '#f0f6fc', '#4493f8', '#3d444d'],
        },
        {
          id: 'bear',
          name: 'Bear',
          desc: '暖白 · 大行距 · 弱边框',
          light: ['#ffffff', '#222222', '#2478c5', '#bfbfbf'],
          dark: ['#1f1f1f', '#e8e8e8', '#6cb6ff', '#4a4a4a'],
        },
        {
          id: 'typo',
          name: 'Typo',
          desc: '中文衬线标题 · 青色强调',
          light: ['#ffffff', '#333333', '#1abc9c', '#dddddd'],
          dark: ['#15171a', '#d7dbe0', '#2fd3b3', '#333a40'],
        },
        {
          id: 'vue',
          name: 'Vue',
          desc: '绿色强调 · 技术文档',
          light: ['#ffffff', '#34495e', '#42b983', '#eaecef'],
          dark: ['#1e2124', '#c8d0d8', '#4fd1a0', '#333a42'],
        },
        {
          id: 'solarized',
          name: 'Solarized',
          desc: '暖米 / 深青，官方成对色板',
          light: ['#fdf6e3', '#323e45', '#ac7514', '#93a1a1'],
          dark: ['#0b3742', '#9ba6a4', '#3fc6b4', '#03303a'],
        },
        {
          id: 'dracula',
          name: 'Dracula',
          desc: '深色霓虹 · Alucard 浅色',
          light: ['#f5f5f5', '#1f1f1f', '#644ac9', '#cfcfcf'],
          dark: ['#353846', '#f8f8f2', '#50fa7b', '#bd93f9'],
        },
        {
          id: 'custom',
          name: '自定义 CSS',
          desc: '工作区 md-theme.css',
          light: ['#ffffff', '#333333', '#5b8cff', '#dddddd'],
          dark: ['#1e1f22', '#e6e6e6', '#7aa2ff', '#3a3b40'],
        },
      ] as const

      const mdGrid = document.createElement('div')
      mdGrid.className = 'md-theme-grid'
      const mdCards: HTMLButtonElement[] = []
      for (const item of mdThemes) {
        const card = document.createElement('button')
        card.type = 'button'
        card.className = 'md-theme-card'
        card.dataset['theme'] = item.id

        const name = document.createElement('span')
        name.className = 'mdt-name'
        name.textContent = item.name
        const descEl = document.createElement('span')
        descEl.className = 'mdt-desc'
        descEl.textContent = item.desc
        card.append(name, descEl)

        if (item.id !== 'custom') {
          const swatches = document.createElement('span')
          swatches.className = 'mdt-swatches'
          for (const color of item.light) {
            const chip = document.createElement('i')
            chip.style.background = color
            swatches.appendChild(chip)
          }
          for (const color of item.dark) {
            const chip = document.createElement('i')
            chip.style.background = color
            swatches.appendChild(chip)
          }
          card.appendChild(swatches)
        }

        card.addEventListener('click', () => {
          mdTheme = item.id as typeof mdTheme
          syncMdCards()
        })
        mdCards.push(card)
        mdGrid.appendChild(card)
      }
      mdSection.appendChild(mdGrid)

      const syncMdCards = (): void => {
        for (const card of mdCards) {
          card.classList.toggle('active', card.dataset['theme'] === mdTheme)
        }
      }
      syncMdCards()

      const mdCustomRow = document.createElement('div')
      mdCustomRow.className = 'md-custom-row'
      const sep = current.workspaceRoot.includes('\\') ? '\\' : '/'
      const mdCssPath = `${current.workspaceRoot.replace(/[\\/]+$/, '')}${sep}md-theme.css`
      const pathCode = document.createElement('code')
      pathCode.textContent = 'md-theme.css'
      pathCode.title = mdCssPath
      const createBtn = button('创建 / 打开')
      const reloadBtn = button('重新加载')
      const hint = document.createElement('span')
      hint.textContent = '选「自定义 CSS」后生效；变量名见文件内注释。'
      mdCustomRow.append(pathCode, createBtn, reloadBtn, hint)
      mdSection.appendChild(mdCustomRow)

      const lineNumberRow = document.createElement('label')
      lineNumberRow.className = 'md-custom-row'
      const lineNumberBox = document.createElement('input')
      lineNumberBox.type = 'checkbox'
      lineNumberBox.checked = mdLineNumbers
      lineNumberBox.addEventListener('change', () => {
        mdLineNumbers = lineNumberBox.checked
      })
      const lineNumberText = document.createElement('span')
      lineNumberText.textContent = '即时渲染时显示行号（默认关，关掉排版更干净）'
      lineNumberRow.append(lineNumberBox, lineNumberText)
      mdSection.appendChild(lineNumberRow)
      pane.appendChild(mdSection)

      const MD_CSS_TEMPLATE = `/* TextHarness 自定义 Markdown 渲染样式
 * 在 设置 → 外观 → Markdown 渲染 里选「自定义 CSS」后生效。
 * 变量说明：
 *   --md-font / --md-heading-font   正文字体、标题字体
 *   --md-line                       行高
 *   --md-h1-size / --md-h2-size    标题字号（em）
 *   --md-fg / --md-head / --md-muted  正文 / 标题 / 弱化文字颜色
 *   --md-link / --md-accent           链接色 / 强调色
 *   --md-code-bg / --md-code-fg       代码块背景 / 文字
 *   --md-inline-bg                    行内代码背景
 *   --md-border                       边框（表格、图片、引用）
 *   --md-table-head-bg / --md-table-stripe  表头、斑马纹
 *   --md-table-vborder                表格竖线宽度（0 表示不要竖线）
 * 也可以直接写普通 CSS，例如：
 *   .cm-md-h1 { letter-spacing: 0.02em; }
 */

html[data-md-theme='custom'] {
  --md-font: 'Segoe UI', 'Microsoft YaHei', sans-serif;
  --md-line: 1.75;
  --md-fg: #333333;
  --md-head: #111111;
  --md-link: #5b8cff;
  --md-border: rgba(127, 127, 127, 0.35);
  --md-code-bg: rgba(127, 127, 127, 0.1);
  --md-table-head-bg: rgba(127, 127, 127, 0.08);
  --md-table-vborder: 1px;
}

html[data-md-theme='custom'][data-theme='dark'] {
  --md-fg: #d8dbe2;
  --md-head: #f2f4f8;
  --md-link: #7aa2ff;
  --md-border: rgba(255, 255, 255, 0.14);
  --md-code-bg: rgba(255, 255, 255, 0.07);
  --md-table-head-bg: rgba(255, 255, 255, 0.06);
}
`

      createBtn.addEventListener('click', () => {
        void (async () => {
          try {
            const stat = await window.th.fs.stat(mdCssPath).catch(() => null)
            if (!stat) {
              await window.th.fs.write(mdCssPath, MD_CSS_TEMPLATE, {
                encoding: current.defaultEncoding,
                bom: false,
                eol: 'LF',
              })
            }
            document.dispatchEvent(new CustomEvent('th:open-path', { detail: { path: mdCssPath }, bubbles: true }))
            hint.textContent = '已打开；改完点「重新加载」立即生效。'
          } catch (err) {
            hint.textContent = `创建失败：${err instanceof Error ? err.message : String(err)}`
          }
        })()
      })

      reloadBtn.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('th:md-theme-changed'))
        hint.textContent = '已重新加载自定义 CSS。'
      })

      const slider = (
        label: string,
        value: number,
        min: number,
        max: number,
        step: number,
        format: (v: number) => string,
        onInput: (v: number) => void
      ): void => {
        const row = document.createElement('div')
        row.className = 'look-slider'
        const name = document.createElement('span')
        name.textContent = label
        const range = document.createElement('input')
        range.type = 'range'
        range.min = String(min)
        range.max = String(max)
        range.step = String(step)
        range.value = String(value)
        const val = document.createElement('span')
        val.className = 'val'
        val.textContent = format(value)
        range.addEventListener('input', () => {
          const next = Number(range.value)
          val.textContent = format(next)
          onInput(next)
        })
        row.append(name, range, val)
        pane.appendChild(row)
      }

      slider('不透明度', bgOpacity, 0.05, 0.9, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => {
        bgOpacity = v
      })
      slider('模糊', bgBlur, 0, 24, 1, (v) => `${v}px`, (v) => {
        bgBlur = v
      })
      slider('暗化', bgDim, 0, 0.85, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => {
        bgDim = v
      })

      syncSwatches()
    }

    const buildModel = (pane: HTMLElement): void => {
      title(pane, '模型接入')
      desc(pane, 'Key 只存在这台机器的配置文件里，不会上传到任何地方。')

      const status = document.createElement('div')
      status.className = 'model-status'
      if (model) {
        status.innerHTML =
          `<strong>${escapeText(model.model || '未配置')}</strong>` +
          `<span class="sep">·</span>${escapeText(model.origin)}` +
          `<span class="sep">·</span>` +
          (model.hasKey
            ? '<span class="ok">Key 已就绪</span>'
            : '<span class="bad">未配置，AI 面板不可用</span>') +
          `<div class="model-url">${escapeText(model.baseURL)}</div>`
      } else {
        status.textContent = '读取失败'
      }
      pane.appendChild(status)

      /* 服务商预设：选中后自动填 Base URL */
      const PROVIDERS: Array<{ name: string; baseURL: string; model?: string; models?: string[] }> = [
        { name: 'DeepSeek 官方', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'] },
        { name: '阿里云百炼（通义千问）', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', models: ['qwen-plus', 'qwen-max', 'qwen-vl-max', 'qwen-turbo'] },
        { name: '月之暗面 Kimi', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-latest'] },
        { name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-4v-plus'] },
        { name: '小米 MiMo', baseURL: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-pro', models: ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro-ultraspeed'] },
      { name: '硅基流动 SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3', models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'THUDM/glm-4-9b-chat'] },
        { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'o4-mini'] },
        { name: '本地 Ollama', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', models: ['qwen2.5:7b', 'qwen2.5:14b', 'llama3.1:8b', 'llava:latest'] },
        { name: '自定义 / 中转站', baseURL: '' },
      ]

      const providerCtl = field(pane, '服务商')
      const providerSelect = document.createElement('select')
      for (const [index, provider] of PROVIDERS.entries()) {
        const option = document.createElement('option')
        option.value = String(index)
        option.textContent = provider.baseURL ? `${provider.name}（${provider.baseURL}）` : provider.name
        providerSelect.appendChild(option)
      }
      const currentBase = baseUrl.trim().replace(/\/+$/, '')
      const matched = PROVIDERS.findIndex((p) => p.baseURL && p.baseURL === currentBase)
      providerSelect.value = String(matched >= 0 ? matched : PROVIDERS.length - 1)
      providerCtl.appendChild(providerSelect)

      const mkInput = (label: string, value: string, placeholder: string, password = false): HTMLInputElement => {
        const ctl = field(pane, label)
        const input = document.createElement('input')
        input.type = password ? 'password' : 'text'
        input.value = value
        input.placeholder = placeholder
        input.spellcheck = false
        ctl.appendChild(input)
        return input
      }

      const baseUrlInput = mkInput('Base URL', baseUrl, 'https://api.deepseek.com/v1')
      baseUrlInput.addEventListener('input', () => {
        baseUrl = baseUrlInput.value
      })
      const modelInput = mkInput('模型名', modelName, 'deepseek-chat')
      // 用 datalist 做成「可下拉选，也能手填」：中转站的模型名列表拿不到，不能锁死
      const modelDatalist = document.createElement('datalist')
      modelDatalist.id = 'th-model-options'
      pane.appendChild(modelDatalist)
      modelInput.setAttribute('list', 'th-model-options')
      const refreshModelOptions = (models: string[] | undefined): void => {
        modelDatalist.textContent = ''
        for (const name of models ?? []) {
          const option = document.createElement('option')
          option.value = name
          modelDatalist.appendChild(option)
        }
      }
      modelInput.addEventListener('input', () => {
        modelName = modelInput.value
      })
      const seedModelOptions = (models: string[] | undefined): void => {
        const list = [...(models ?? [])]
        if (modelName && !list.includes(modelName)) list.unshift(modelName)
        refreshModelOptions(list)
      }
      seedModelOptions(PROVIDERS[Number(providerSelect.value)]?.models)
      // 再尝试拉当前服务商的实时模型列表（需要 Key，拿不到就用手写的静态列表）
      void window.th.ai
        .models()
        .then((result) => {
          if (result.models.length === 0) return
          const merged = [...result.models]
          for (const name of PROVIDERS[Number(providerSelect.value)]?.models ?? []) {
            if (!merged.includes(name)) merged.push(name)
          }
          if (modelName && !merged.includes(modelName)) merged.unshift(modelName)
          refreshModelOptions(merged)
        })
        .catch(() => undefined)

      const apiKeyInput = mkInput('API Key', apiKey, 'sk-…', true)
      apiKeyInput.addEventListener('input', () => {
        apiKey = apiKeyInput.value
      })

      note(pane, '每个服务商的 Key 和模型分开记住，切换服务商时自动换回来；都存在本机 config.json。')

      const reasoningCtl = field(pane, '推理等级')
      const reasoningSelect = document.createElement('select')
      for (const [value, text] of [
        ['auto', '自动（跟随模型，不额外发参数）'],
        ['low', '低（快，省钱）'],
        ['medium', '中'],
        ['high', '高（慢，想得更深）'],
      ] as Array<[AppConfig['llmReasoning'], string]>) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = text
        reasoningSelect.appendChild(option)
      }
      reasoningSelect.value = reasoning
      reasoningSelect.addEventListener('change', () => {
        reasoning = reasoningSelect.value as AppConfig['llmReasoning']
      })
      reasoningCtl.appendChild(reasoningSelect)
      note(pane, '选非「自动」时会多发一个 reasoning_effort 字段；部分中转不支持该参数会报 400，遇到就切回自动。')

      providerSelect.addEventListener('change', () => {
        rememberProviderCreds()

        const provider = PROVIDERS[Number(providerSelect.value)]
        if (!provider) return

        // 自定义 / 中转站：保留用户已填的地址，只按地址换 Key
        if (!provider.baseURL) {
          const saved = providerProfiles['__custom__']
          if (saved) {
            apiKey = saved.apiKey
            apiKeyInput.value = saved.apiKey
            if (saved.model) {
              modelName = saved.model
              modelInput.value = saved.model
            }
          }
          baseUrlInput.focus()
          return
        }

        baseUrl = provider.baseURL
        baseUrlInput.value = provider.baseURL
        seedModelOptions(provider.models)

        const saved = providerProfiles[profileKeyOf(provider.baseURL)]
        // 有存过就用存过的模型和 Key，否则用该服务商的默认模型
        if (saved?.model) {
          modelName = saved.model
          modelInput.value = saved.model
        } else if (provider.model) {
          modelName = provider.model
          modelInput.value = provider.model
        }
        if (provider.model) modelInput.placeholder = provider.model

        if (saved?.apiKey) {
          apiKey = saved.apiKey
          apiKeyInput.value = saved.apiKey
        } else {
          apiKey = ''
          apiKeyInput.value = ''
        }

        // 存过 Key 就直接去改模型名，没存过就让人填 Key
        ;(saved?.apiKey ? modelInput : apiKeyInput).focus()
      })
    }

    let agentsHintRef = document.createElement('div')

    const buildMemory = (pane: HTMLElement): void => {
      title(pane, '记忆')
      desc(pane, '偏好和约定写在 MEMORY.md（每轮对话都会带上）；一次性的结论写进日志。都是工作区里的普通 Markdown，随时能改。')

      const tools = document.createElement('div')
      tools.className = 'set-note'
      tools.style.marginLeft = '0'
      tools.textContent = 'agent 也能自己记：偏好说「记住……」写这里；多字段模板/清单会存到 记忆/模板/，不占每轮上下文；问「我之前说过什么」会用 recall 检索。'
      pane.appendChild(tools)

      const snapshot = {
        facts: '',
        recentLogs: [] as string[],
        files: [] as Array<{ path: string; size: number; mtime: number }>,
        templates: [] as Array<{ path: string; title: string }>,
      }

      const areaCtl = document.createElement('div')
      areaCtl.className = 'set-field set-field-top'
      const areaLabel = document.createElement('label')
      areaLabel.textContent = 'MEMORY.md'
      const areaWrap = document.createElement('div')
      areaWrap.className = 'set-field-ctl'
      areaCtl.append(areaLabel, areaWrap)
      pane.appendChild(areaCtl)

      const area = document.createElement('textarea')
      area.className = 'memory-area'
      area.spellcheck = false
      area.rows = 10
      area.placeholder = ['## 偏好', '- 用 PowerShell，不要 Python 脚本', '', '## 环境', '- 工作区在 D:\...'].join('\n')
      areaWrap.appendChild(area)

      const footRow = document.createElement('div')
      footRow.className = 'memory-foot'
      footRow.style.padding = '6px 0 0 0'
      footRow.style.borderTop = 'none'
      const hint = document.createElement('span')
      hint.className = 'memory-hint'
      hint.textContent = '失焦自动保存，下一轮对话就生效。'
      const revealBtn = button('打开记忆目录')
      revealBtn.classList.add('small')
      revealBtn.addEventListener('click', () => {
        void window.th.memory.reveal()
      })
      footRow.append(hint, revealBtn)
      pane.appendChild(footRow)

      // 失焦就存，省得和下面的「保存」按钮打架
      let savedValue = ''
      const flush = (): void => {
        if (area.value === savedValue) return
        void window.th.memory.save(area.value).then(() => {
          savedValue = area.value
          hint.textContent = '已自动保存。'
        })
      }
      area.addEventListener('blur', flush)

      /* 语义检索开关 */
      const semanticRow = document.createElement('div')
      semanticRow.className = 'set-field'
      const semanticLabel = document.createElement('label')
      semanticLabel.textContent = '语义检索'
      const semanticWrap = document.createElement('div')
      semanticWrap.className = 'set-field-ctl memory-semantic'
      const semanticCheck = document.createElement('input')
      semanticCheck.type = 'checkbox'
      semanticCheck.className = 'set-check'
      semanticCheck.checked = cfgDraft.memorySemantic === true
      semanticCheck.addEventListener('change', () => {
        cfgDraft.memorySemantic = semanticCheck.checked
      })
      const semanticText = document.createElement('span')
      semanticText.textContent = '本地向量模型（bge-small-zh，首次会下载约 90MB）'
      const semanticBtn = button('建索引')
      semanticBtn.classList.add('small')
      const semanticState = document.createElement('span')
      semanticState.className = 'memory-semantic-state'
      semanticBtn.addEventListener('click', () => {
        semanticState.textContent = '建索引中…（首次要下载模型）'
        void window.th.memory.buildSemantic().then((result) => {
          semanticState.textContent = result.ok ? `索引好了：${result.lines} 条` : `失败：${result.reason ?? '未知原因'}`
        })
      })
      void window.th.memory.semanticStatus().then((status) => {
        if (!status.available) {
          // 没有内置模型：开关和建索引都禁用，避免用户点了以为在下载
          semanticCheck.disabled = true
          semanticBtn.disabled = true
          semanticState.textContent = status.reason ?? '本地模型不可用'
          return
        }
        if (!status.enabled) {
          semanticState.textContent = '未开启（当前用 BM25 关键词检索）'
        } else {
          semanticState.textContent = '已开启'
        }
      })
      semanticWrap.append(semanticCheck, semanticText, semanticBtn, semanticState)
      semanticRow.append(semanticLabel, semanticWrap)
      pane.appendChild(semanticRow)

      const logTitle = document.createElement('div')
      logTitle.className = 'set-title'
      logTitle.style.marginTop = '20px'
      logTitle.textContent = '最近的会话结论'
      pane.appendChild(logTitle)

      const logs = document.createElement('div')
      logs.className = 'memory-logs'
      pane.appendChild(logs)

      const tplTitle = document.createElement('div')
      tplTitle.className = 'set-title'
      tplTitle.style.marginTop = '20px'
      tplTitle.textContent = '模板'
      pane.appendChild(tplTitle)

      const tplNote = document.createElement('div')
      tplNote.className = 'set-note'
      tplNote.style.marginLeft = '0'
      tplNote.textContent = '多字段模板、申请格式、清单放这里。不进每轮上下文，模型需要时会自己去读。'
      pane.appendChild(tplNote)

      const tplList = document.createElement('div')
      tplList.className = 'memory-files'
      pane.appendChild(tplList)

      const renderTemplates = (): void => {
        tplList.textContent = ''
        if (snapshot.templates.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'memory-empty'
          empty.textContent = '还没有模板。跟它说「把这段格式存成模板」就会出现在这里。'
          tplList.appendChild(empty)
          return
        }
        for (const tpl of snapshot.templates) {
          const row = document.createElement('button')
          row.className = 'memory-file'
          row.textContent = `${tpl.title}  ·  ${tpl.path}`
          row.addEventListener('click', () => {
            document.dispatchEvent(new CustomEvent('th:open-path', { detail: tpl.path, bubbles: true }))
          })
          tplList.appendChild(row)
        }
      }

      const filesTitle = document.createElement('div')
      filesTitle.className = 'set-title'
      filesTitle.style.marginTop = '20px'
      filesTitle.textContent = '记忆目录'
      pane.appendChild(filesTitle)

      const files = document.createElement('div')
      files.className = 'memory-files'
      pane.appendChild(files)

      const renderLogs = (): void => {
        logs.textContent = ''
        if (snapshot.recentLogs.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'memory-empty'
          empty.textContent = '还没有日志。聊出结论后让它「记一下」，或者直接在这里写。'
          logs.appendChild(empty)
          return
        }
        for (const line of snapshot.recentLogs) {
          const item = document.createElement('div')
          item.className = 'memory-log'
          item.textContent = line.replace(/^-\s*/, '')
          logs.appendChild(item)
        }
      }

      const renderFiles = (): void => {
        files.textContent = ''
        if (snapshot.files.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'memory-empty'
          empty.textContent = '记忆目录还没建。保存一次就会创建 记忆/MEMORY.md。'
          files.appendChild(empty)
          return
        }
        for (const file of snapshot.files) {
          const row = document.createElement('button')
          row.className = 'memory-file'
          row.title = `${(file.size / 1024).toFixed(1)} KB`
          row.textContent = file.path
          row.addEventListener('click', () => {
            // 交给主界面打开（dialogs 不直接依赖编辑器内部函数）
            document.dispatchEvent(new CustomEvent('th:open-path', { detail: row.textContent ?? '', bubbles: true }))
          })
          files.appendChild(row)
        }
      }

      void window.th.memory.snapshot().then((data) => {
        snapshot.facts = data.factsFull
        snapshot.recentLogs = data.recentLogs
        snapshot.files = data.files
        snapshot.templates = data.templates
        area.value = data.factsFull
        savedValue = data.factsFull
        renderLogs()
        renderTemplates()
        renderFiles()
      })
    }

    const buildAgents = (pane: HTMLElement): void => {
      title(pane, '项目约定')
      desc(pane, '这里写的规则会随每次提问一起交给 agent：代码风格、目录习惯、不能碰的文件。')

      agentsHintRef = document.createElement('p')
      agentsHintRef.className = 'set-note'
      agentsHintRef.textContent = `项目约定将读取：${workspaceRoot.replace(/[\\/]+$/, '')}/AGENTS.md`
      pane.appendChild(agentsHintRef)

      const area = document.createElement('textarea')
      area.className = 'agents-area'
      area.rows = 10
      area.spellcheck = false
      area.placeholder = '- SQL 关键字一律大写\n- 笔记统一放 知识库/<分类>/\n- 不要改动 .assets/ 下的文件'
      pane.appendChild(area)

      const row = document.createElement('div')
      row.className = 'agents-row'
      const status = document.createElement('span')
      status.className = 'agents-status'
      const templateBtn = button('插入模板')
      const saveBtn = button('保存约定')
      const openBtn = button('打开文件夹')
      row.append(status, templateBtn, saveBtn, openBtn)
      pane.appendChild(row)

      const pathOf = (): string => `${workspaceRoot.replace(/[\\/]+$/, '')}/AGENTS.md`

      void window.th.fs
        .read(pathOf())
        .then((file) => {
          area.value = file.text
          status.textContent = '已加载'
        })
        .catch(() => {
          status.textContent = '还没有 AGENTS.md'
        })

      templateBtn.addEventListener('click', () => {
        const template = [
          '# 项目约定',
          '',
          '## 目录',
          '- 笔记按日期放在 2026-10-29/ 这样的目录里',
          '- 长期知识统一放 知识库/<分类>/',
          '- 截图放 .assets/，不要手动整理',
          '',
          '## 写作风格',
          '- SQL 关键字一律大写，缩进用两个空格',
          '- 中文正文里不要混用英文标点',
          '',
          '## 不要做的事',
          '- 不要修改 .history/ 和 .tasks/ 里的文件',
          '- 改写已有文件前先看内容，不要整篇重写',
        ].join('\n')
        area.value = area.value.trim() ? `${area.value.trim()}\n\n${template}` : template
        status.textContent = '模板已插入，记得点保存'
      })

      saveBtn.addEventListener('click', () => {
        status.textContent = '保存中…'
        void window.th.fs
          .write(pathOf(), area.value, { encoding: 'utf8', bom: false, eol: 'LF' })
          .then(() => {
            status.textContent = area.value.trim() ? '已保存，下一句提问就生效' : '已清空（下次提问不再带约定）'
          })
          .catch((err: unknown) => {
            status.textContent = `保存失败：${err instanceof Error ? err.message : String(err)}`
          })
      })

      openBtn.addEventListener('click', () => {
        void window.th.fs.reveal(pathOf()).catch(() => {
          void window.th.fs.openDir(workspaceRoot)
        })
      })
    }

    const buildTasks = (pane: HTMLElement): void => {
      title(pane, '定时任务')
      desc(pane, '后台自动运行，只读原稿、只新建文件；跑出来的内容落在工作区里。')

      if (tasks.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'task-meta'
        empty.textContent = '暂无任务'
        pane.appendChild(empty)
        return
      }

      for (const task of tasks) {
        const row = document.createElement('div')
        row.className = 'task-row'

        const taskHead = document.createElement('div')
        taskHead.className = 'task-head'

        const label = document.createElement('label')
        label.className = 'task-check'
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.checked = task.enabled
        checkbox.addEventListener('change', () => {
          taskEnabled.set(task.id, checkbox.checked)
          void window.th.tasks.toggle(task.id, checkbox.checked)
        })
        const name = document.createElement('span')
        name.textContent = task.name
        label.append(checkbox, name)

        const runBtn = document.createElement('button')
        runBtn.className = 'btn small'
        runBtn.textContent = '立即运行'
        runBtn.addEventListener('click', () => {
          runBtn.disabled = true
          runBtn.textContent = '运行中…'
          void window.th.tasks
            .run(task.id)
            .then(() => {
              runBtn.textContent = '已完成'
            })
            .catch((err: unknown) => {
              runBtn.textContent = '失败'
              console.error(err)
            })
            .finally(() => {
              setTimeout(() => {
                runBtn.disabled = false
                runBtn.textContent = '立即运行'
              }, 2000)
            })
        })

        taskHead.append(label, runBtn)

        const meta = document.createElement('div')
        meta.className = 'task-meta'
        const last = task.lastResult
          ? ` · 上次：${task.lastResult.replace(/\s+/g, ' ').slice(0, 60)}${task.lastResult.length > 60 ? '…' : ''}`
          : ''
        meta.textContent = `${task.next}${last}`

        row.append(taskHead, meta)
        pane.appendChild(row)
      }
    }

    const buildUpdate = (pane: HTMLElement): void => {
      title(pane, '更新')
      desc(pane, 'Windows 会自动下载安装包，下完在状态栏提示重启；macOS 未签名，只能提示你去下载页。')

      const row = document.createElement('label')
      row.className = 'set-check'
      const box2 = document.createElement('input')
      box2.type = 'checkbox'
      box2.checked = autoCheckUpdate
      box2.addEventListener('change', () => {
        autoCheckUpdate = box2.checked
      })
      const text = document.createElement('span')
      text.textContent = '启动后自动检查新版本'
      row.append(box2, text)
      pane.appendChild(row)

      const verCtl = field(pane, '当前版本')
      const verText = document.createElement('span')
      verText.className = 'set-version'
      verText.textContent = version ? `v${version}` : '读取失败'
      const checkBtn = button('立即检查')
      checkBtn.classList.add('small')
      checkBtn.style.marginLeft = '14px'
      verCtl.append(verText, checkBtn)
      checkBtn.addEventListener('click', () => {
        checkBtn.disabled = true
        checkBtn.textContent = '检查中…'
        void window.th.ai
          .updateCheck()
          .catch(() => undefined)
          .finally(() => {
            setTimeout(() => {
              checkBtn.disabled = false
              checkBtn.textContent = '立即检查'
            }, 1200)
          })
      })
      note(pane, '检查结果会显示在状态栏右下角；没有新版本时不会有任何打扰。')
    }

    const buildTools = (pane: HTMLElement): void => {
      title(pane, '工具能力')
      desc(pane, 'agent 能用哪些工具。关掉的工具模型就看不到，可以缩短提示词、减少误选。')

      const listBox = document.createElement('div')
      listBox.className = 'tool-list'
      pane.appendChild(listBox)

      const status = document.createElement('div')
      status.className = 'set-note'
      status.textContent = '读取中…'
      pane.appendChild(status)

      const enabledSet = new Set<string>(cfgDraft.enabledTools)
      const groups: Array<['text' | 'file' | 'app', string]> = [
        ['text', '文本处理'],
        ['file', '文件操作'],
        ['app', '应用控制'],
      ]

      void window.th.tools
        .list()
        .then((items) => {
          listBox.textContent = ''
          status.textContent = ''
          for (const [group, label] of groups) {
            const inGroup = items.filter((item) => item.group === group)
            if (inGroup.length === 0) continue

            const head = document.createElement('div')
            head.className = 'tool-group-label'
            head.textContent = label
            listBox.appendChild(head)

            for (const item of inGroup) {
              const row = document.createElement('label')
              row.className = 'tool-row'
              const box = document.createElement('input')
              box.type = 'checkbox'
              box.checked = enabledSet.size > 0 ? enabledSet.has(item.name) : item.enabled
              box.addEventListener('change', () => {
                if (box.checked) enabledSet.add(item.name)
                else enabledSet.delete(item.name)
                toolState.enabled = [...enabledSet]
              })
              const textWrap = document.createElement('div')
              textWrap.className = 'tool-row-text'
              const name = document.createElement('span')
              name.className = 'tool-row-name'
              name.textContent = item.label
              if (item.dangerous) {
                const badge = document.createElement('span')
                badge.className = 'tool-badge'
                badge.textContent = '需确认'
                name.appendChild(badge)
              }
              const descEl = document.createElement('span')
              descEl.className = 'tool-row-desc'
              descEl.textContent = item.summary
              textWrap.append(name, descEl)
              row.append(box, textWrap)
              listBox.appendChild(row)
            }
          }

          const count = document.createElement('div')
          count.className = 'set-note'
          count.style.marginLeft = '0'
          count.textContent = `共 ${items.length} 个内置工具`
          listBox.appendChild(count)
        })
        .catch(() => {
          status.textContent = '读取工具列表失败'
        })

      const capCtl = field(pane, '工具上限')
      const capInput = document.createElement('input')
      capInput.type = 'number'
      capInput.min = '5'
      capInput.max = '60'
      capInput.value = String(cfgDraft.toolCap)
      capInput.addEventListener('change', () => {
        const value = Math.min(Math.max(Number(capInput.value) || 35, 5), 60)
        capInput.value = String(value)
        toolState.cap = value
      })
      capCtl.appendChild(capInput)
      note(pane, '超过上限的工具不会进提示词（含以后接入的 MCP 工具），防止模型选错。')

      const mcpTitle = document.createElement('div')
      mcpTitle.className = 'set-title'
      mcpTitle.style.marginTop = '18px'
      mcpTitle.textContent = 'MCP 服务器'
      pane.appendChild(mcpTitle)

      note(
        pane,
        '接外部工具服务器（stdio / HTTP / SSE），配置和 Claude Desktop 的 mcpServers 一样。工具名会加前缀（服务器名__工具名），比如 db-kb__query。改完点保存才生效。'
      )

      const mcpList = document.createElement('div')
      mcpList.className = 'mcp-list'
      pane.appendChild(mcpList)

      const renderMcp = (): void => {
        mcpList.textContent = ''
        if (cfgDraft.mcpServers.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'set-note'
          empty.style.marginLeft = '0'
          empty.textContent = '还没配置服务器。下面「添加服务器」可以手填，也可以直接粘一段 JSON。'
          mcpList.appendChild(empty)
          return
        }
        for (const server of cfgDraft.mcpServers) {
          const row = document.createElement('div')
          row.className = 'mcp-row'

          const toggle = document.createElement('input')
          toggle.type = 'checkbox'
          toggle.className = 'set-check'
          toggle.checked = server.enabled
          toggle.title = server.enabled ? '已启用' : '已停用'
          toggle.addEventListener('change', () => {
            server.enabled = toggle.checked
          })

          const info = document.createElement('div')
          info.className = 'mcp-info'
          const nameLine = document.createElement('div')
          nameLine.className = 'mcp-name'
          nameLine.textContent = server.name
          const cmdLine = document.createElement('div')
          cmdLine.className = 'mcp-cmd'
          cmdLine.textContent = [server.command, ...(server.args ?? [])].join(' ')
          info.append(nameLine, cmdLine)

          const state = document.createElement('span')
          state.className = 'mcp-state'
          state.textContent = '未连接'
          void window.th.mcp.status().then((list) => {
            const found = list.find((item) => item.name === server.name)
            if (!found) return
            if (found.connected) {
              state.textContent = `已连接 · ${found.tools} 个工具`
              state.classList.add('ok')
            } else {
              state.textContent = found.error ? `连接失败：${found.error}` : '未连接'
              state.classList.add(found.error ? 'bad' : '')
            }
          })

          const policy = document.createElement('select')
          policy.className = 'mcp-policy'
          for (const [value, text] of [
            ['confirm-write', '写操作需确认'],
            ['confirm-all', '全部需确认'],
            ['allow-all', '全部允许'],
          ] as Array<[string, string]>) {
            const option = document.createElement('option')
            option.value = value
            option.textContent = text
            policy.appendChild(option)
          }
          policy.value = server.policy ?? 'confirm-write'
          policy.addEventListener('change', () => {
            server.policy = policy.value as 'confirm-write' | 'confirm-all' | 'allow-all'
          })

          const remove = document.createElement('button')
          remove.className = 'icon-btn'
          remove.textContent = '✕'
          remove.title = '移除'
          remove.addEventListener('click', () => {
            cfgDraft.mcpServers = cfgDraft.mcpServers.filter((item) => item !== server)
            renderMcp()
          })

          row.append(toggle, info, state, policy, remove)
          mcpList.appendChild(row)
        }
      }
      renderMcp()

      const mcpActions = document.createElement('div')
      mcpActions.className = 'mcp-actions'
      const addBtn = button('添加服务器')
      addBtn.classList.add('small')
      addBtn.addEventListener('click', () => {
        openMcpAddDialog({
          commit: (servers) => {
            for (const server of servers) {
              cfgDraft.mcpServers.push({ ...server, name: server.name, enabled: true, policy: 'confirm-write' })
            }
            renderMcp()
          },
        })
      })

      const reconnectBtn = button('重新连接')
      reconnectBtn.classList.add('small')
      reconnectBtn.addEventListener('click', () => {
        void window.th.mcp.reconnect('').then(() => {
          renderMcp()
        })
      })
      mcpActions.append(addBtn, reconnectBtn)
      pane.appendChild(mcpActions)
    }

    const buildAbout = (pane: HTMLElement): void => {
      title(pane, '关于')
      desc(pane, 'TextHarness 是一个本地优先的文本编辑器，数据全部留在你自己的机器上。')

      const verCtl = field(pane, '版本')
      const verText = document.createElement('span')
      verText.className = 'set-version'
      verText.textContent = version ? `v${version}` : '读取失败'
      verCtl.appendChild(verText)

      const siteCtl = field(pane, '官网')
      const siteBtn = button('打开下载页')
      siteBtn.addEventListener('click', () => {
        void window.th.app.openUrl('http://47.109.100.9/')
      })
      siteCtl.appendChild(siteBtn)

      const keyHint = document.createElement('div')
      keyHint.className = 'set-note'
      keyHint.innerHTML =
        '常用快捷键：<code>Ctrl+S</code> 保存 · <code>Ctrl+W</code> 关闭 · ' +
        '<code>Ctrl+B</code> 文件树 · <code>Ctrl+Alt+J</code> 格式化 JSON · <code>Ctrl+,</code> 设置'
      pane.appendChild(keyHint)
    }

    /* ================= 导航 ================= */
    const sections: SettingsSection[] = [
      { id: 'workspace', group: '通用', label: '工作区', keywords: ['目录', '路径', '图库', 'assets'], build: buildWorkspace },
      { id: 'editor', group: '通用', label: '编辑器', keywords: ['编码', '主题', 'utf8', 'gbk', '换行'], build: buildEditor },
      { id: 'look', group: '通用', label: '外观', keywords: ['背景', '壁纸', '模糊', '不透明度'], build: buildLook },
      { id: 'model', group: 'AI', label: '模型接入', keywords: ['api', 'key', 'baseurl', '推理', 'deepseek'], build: buildModel },
      { id: 'agents', group: 'AI', label: '项目约定', keywords: ['agents.md', '规则', '约定'], build: buildAgents },
      { id: 'memory', group: 'AI', label: '记忆', keywords: ['记忆', '偏好', '日志', 'remember'], build: buildMemory },
      { id: 'tasks', group: 'AI', label: '定时任务', keywords: ['定时', '自动', '计划'], build: buildTasks },
      { id: 'tools', group: 'AI', label: '工具能力', keywords: ['工具', 'mcp', '开关', '上限'], build: buildTools },
      { id: 'update', group: '其他', label: '更新', keywords: ['版本', '升级', '检查'], build: buildUpdate },
      { id: 'about', group: '其他', label: '关于', keywords: ['版本', '官网', '快捷键'], build: buildAbout },
    ]

    const panes = new Map<string, HTMLElement>()
    const buttons = new Map<string, HTMLElement>()
    let activeId = localStorage.getItem('th.settings.section') ?? 'workspace'

    const paneOf = (section: SettingsSection): HTMLElement => {
      const cached = panes.get(section.id)
      if (cached) return cached
      const pane = paneBase()
      section.build(pane)
      panes.set(section.id, pane)
      paneWrap.appendChild(pane)
      return pane
    }

    const show = (id: string): void => {
      activeId = id
      localStorage.setItem('th.settings.section', id)
      // 防御：先清掉所有 active，避免出现两个分页同时可见
      for (const panel of Array.from(paneWrap.querySelectorAll<HTMLElement>('.set-pane'))) {
        panel.classList.remove('active')
      }
      for (const [key, panel] of panes) panel.classList.toggle('active', key === id)
      for (const [key, btn] of buttons) btn.classList.toggle('on', key === id)
      const section = sections.find((s) => s.id === id)
      if (section) paneOf(section).classList.add('active')
    }

    let lastGroup = ''
    for (const section of sections) {
      if (section.group !== lastGroup) {
        lastGroup = section.group
        const groupEl = document.createElement('div')
        groupEl.className = 'set-group'
        groupEl.textContent = section.group
        navList.appendChild(groupEl)
      }
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'set-nav-item'
      btn.dataset['id'] = section.id
      btn.dataset['group'] = section.group
      btn.dataset['search'] = [section.label, section.group, ...section.keywords].join(' ').toLowerCase()
      btn.textContent = section.label
      btn.addEventListener('click', () => show(section.id))
      navList.appendChild(btn)
      buttons.set(section.id, btn)
    }

    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase()
      for (const [id, btn] of buttons) {
        const hit = !q || (btn.dataset['search'] ?? '').includes(q)
        btn.classList.toggle('hidden', !hit)
      }
      // 分组标题：该组没有任何可见项就一起藏
      for (const groupEl of Array.from(navList.querySelectorAll<HTMLElement>('.set-group'))) {
        const group = groupEl.textContent ?? ''
        const anyVisible = Array.from(buttons.values()).some(
          (b) => b.dataset['group'] === group && !b.classList.contains('hidden')
        )
        groupEl.classList.toggle('hidden', !anyVisible)
      }
      // 当前页被过滤掉时，自动跳到第一个可见项
      const activeBtn = buttons.get(activeId)
      if (activeBtn?.classList.contains('hidden')) {
        const first = Array.from(buttons.values()).find((b) => !b.classList.contains('hidden'))
        const id = first?.dataset['id']
        if (id) show(id)
      }
    })

    show(activeId)

    /* ================= 保存 / 关闭 ================= */
    cancel.addEventListener('click', () => finish(null))
    closeBtn.addEventListener('click', () => finish(null))
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) finish(null)
    })

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(null)
      }
    }
    document.addEventListener('keydown', onKey, true)

    save.addEventListener('click', () => {
      finish({
        ...current,
        workspaceRoot,
        defaultEncoding,
        theme,
        llmBaseUrl: baseUrl.trim(),
        llmModel: modelName.trim(),
        llmApiKey: apiKey.trim(),
        providerProfiles: (() => {
          rememberProviderCreds()
          return providerProfiles
        })(),
        llmReasoning: reasoning,
        autoCheckUpdate,
        enabledTools: toolState.enabled.length > 0 ? toolState.enabled : current.enabledTools,
        toolCap: toolState.cap,
        bgImage,
        bgPreset,
        mdTheme,
        mdLineNumbers,
        bgOpacity,
        bgBlur,
        bgDim,
        // 用面板里的勾选状态覆盖，别把打开面板时的旧值写回去
        tasks: current.tasks.map((task) => ({
          ...task,
          enabled: taskEnabled.get(task.id) ?? task.enabled,
        })),
      })
    })
  })
}

/** 添加 MCP 服务器：多行 JSON 输入框 */
/** 解析 Claude Desktop 格式，返回服务器列表（不写配置） */
export interface ParsedMcpServer {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  transport?: 'stdio' | 'http' | 'sse'
}

/** 常见写法：streamable_http / streamableHttp / sse / http */
function normalizeTransport(type: unknown, url: string): 'stdio' | 'http' | 'sse' {
  const raw = String(type ?? '').toLowerCase().replace(/[^a-z]/g, '')
  if (raw === 'sse') return 'sse'
  if (raw.includes('http')) return 'http'
  if (/\/sse\/?$/i.test(url)) return 'sse'
  return 'http'
}

export function parseMcpServers(raw: string): {
  ok: boolean
  servers?: ParsedMcpServer[]
  error?: string
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` }
  }
  const root = parsed as Record<string, unknown>
  const source = (root['mcpServers'] as Record<string, unknown> | undefined) ?? root
  if (!source || typeof source !== 'object') return { ok: false, error: '没有找到 mcpServers 结构' }

  const servers: ParsedMcpServer[] = []
  for (const [name, value] of Object.entries(source)) {
    const entry = value as {
      command?: unknown
      args?: unknown
      env?: unknown
      url?: unknown
      headers?: unknown
      type?: unknown
    }
    const command = typeof entry?.command === 'string' ? entry.command.trim() : ''
    const url = typeof entry?.url === 'string' ? entry.url.trim() : ''

    if (!command && !url) {
      return { ok: false, error: `服务器 ${name} 既没有 command（stdio）也没有 url（http/sse）` }
    }
    if (url && !/^https?:\/\//i.test(url)) {
      return { ok: false, error: `服务器 ${name} 的 url 必须以 http:// 或 https:// 开头` }
    }
    if (entry.args !== undefined && !Array.isArray(entry.args)) {
      return { ok: false, error: `服务器 ${name} 的 args 必须是数组` }
    }
    servers.push({
      name,
      command: command || undefined,
      args: command ? (Array.isArray(entry.args) ? entry.args.map((item) => String(item)) : []) : undefined,
      env: entry.env && typeof entry.env === 'object' ? (entry.env as Record<string, string>) : undefined,
      url: url || undefined,
      headers:
        entry.headers && typeof entry.headers === 'object' ? (entry.headers as Record<string, string>) : undefined,
      transport: url ? normalizeTransport(entry.type, url) : 'stdio',
    })
  }
  if (servers.length === 0) return { ok: false, error: '没有解析出任何服务器' }
  return { ok: true, servers }
}

/** 明显的危险命令特征，弹窗里标红提醒（仍然由用户决定） */
/** Authorization 这类头只显示前后几位，避免 token 裸露在屏幕上 */
function maskHeaders(headers?: Record<string, string>): string {
  if (!headers) return ''
  const keys = Object.keys(headers)
  if (keys.length === 0) return ''
  return keys
    .map((key) => {
      const value = String(headers[key] ?? '')
      if (!/auth|token|key|secret/i.test(key)) return `${key}: ${value}`
      const kept = value.length > 12 ? `${value.slice(0, 7)}…${value.slice(-4)}` : '****'
      return `${key}: ${kept}`
    })
    .join('，')
}

function looksRisky(command: string, args: string[]): boolean {
  const line = `${command} ${args.join(' ')}`
  return /curl[^|]*\|\s*(sh|bash)|wget[^|]*\|\s*(sh|bash)|powershell\s+-enc|rm\s+-rf|Remove-Item\s+-Recurse/i.test(line)
}

/**
 * 添加 MCP 服务器弹窗。
 *  - 从设置里点「添加服务器」：只改草稿，随设置一起保存
 *  - 从 agent 提议：直接写配置并重连（afterAdd 回调）
 */
export function openMcpAddDialog(options: {
  initialJson?: string
  /** 直接落配置（agent 提议时用），不传就交给调用方处理草稿 */
  commit?: (servers: ParsedMcpServer[]) => void
} = {}): void {
  const overlay = document.createElement('div')
  overlay.className = 'overlay'
  const modal = document.createElement('div')
  modal.className = 'modal'
  modal.style.width = 'min(600px, calc(100vw - 60px))'

  const body = document.createElement('div')
  body.className = 'body'
  const label = document.createElement('div')
  label.className = 'ask-label'
  label.textContent = '粘贴 Claude Desktop 格式的 mcpServers JSON'
  const area = document.createElement('textarea')
  area.className = 'ask-area'
  area.rows = 10
  area.spellcheck = false
  area.value =
    options.initialJson ??
    ['{', '  "basic-memory": {', '    "command": "uvx",', '    "args": ["--prerelease=allow", "basic-memory", "mcp"]', '  }', '}'].join(
      String.fromCharCode(10)
    )

  const preview = document.createElement('div')
  preview.className = 'mcp-preview'

  const refresh = (): void => {
    const result = parseMcpServers(area.value)
    preview.textContent = ''
    if (!result.ok) {
      preview.textContent = `✗ ${result.error ?? '解析失败'}`
      preview.classList.add('bad')
      return
    }
    preview.classList.remove('bad')
    for (const server of result.servers ?? []) {
      const line = document.createElement('div')
      line.className = 'mcp-preview-line'
      const maskedHeaders = maskHeaders(server.headers)
      line.textContent = server.url
        ? `${server.name}：${server.transport === 'sse' ? 'SSE' : 'HTTP'} ${server.url}${maskedHeaders ? `（${maskedHeaders}）` : ''}`
        : `${server.name}：${server.command ?? ''} ${(server.args ?? []).join(' ')}`
      if (server.command && looksRisky(server.command, server.args ?? [])) {
        const warn = document.createElement('span')
        warn.className = 'mcp-warn'
        warn.textContent = ' ⚠ 这条命令看起来有风险，确认来源可信'
        line.appendChild(warn)
      }
      preview.appendChild(line)
    }
    const hint = document.createElement('div')
    hint.className = 'mcp-preview-hint'
    hint.textContent = '添加后会立即启用并连接'
    preview.appendChild(hint)
  }
  area.addEventListener('input', refresh)
  refresh()

  body.append(label, area, preview)

  const foot = document.createElement('div')
  foot.className = 'foot'
  const cancel = document.createElement('button')
  cancel.className = 'btn'
  cancel.textContent = '取消'
  cancel.addEventListener('click', () => overlay.remove())
  const ok = document.createElement('button')
  ok.className = 'btn primary'
  ok.textContent = '添加并连接'
  ok.addEventListener('click', () => {
    const result = parseMcpServers(area.value)
    if (!result.ok || !result.servers) {
      preview.textContent = `✗ ${result.error ?? '解析失败'}`
      preview.classList.add('bad')
      return
    }
    overlay.remove()
    options.commit?.(result.servers)
  })
  foot.append(cancel, ok)

  modal.append(body, foot)
  overlay.appendChild(modal)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove()
  })
  document.body.appendChild(overlay)
  area.focus()
}


