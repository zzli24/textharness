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
      const el = button(label, index === (spec.defaultId ?? 0))
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
      const PROVIDERS: Array<{ name: string; baseURL: string; model?: string }> = [
        { name: 'DeepSeek 官方', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        { name: '阿里云百炼（通义千问）', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
        { name: '月之暗面 Kimi', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
        { name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
        { name: '硅基流动 SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
        { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
        { name: '本地 Ollama', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
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
      modelInput.addEventListener('input', () => {
        modelName = modelInput.value
      })
      const apiKeyInput = mkInput('API Key', apiKey, 'sk-…', true)
      apiKeyInput.addEventListener('input', () => {
        apiKey = apiKeyInput.value
      })

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
        const provider = PROVIDERS[Number(providerSelect.value)]
        if (!provider || !provider.baseURL) return
        baseUrl = provider.baseURL
        baseUrlInput.value = provider.baseURL
        if (provider.model) {
          modelName = provider.model
          modelInput.value = provider.model
          modelInput.placeholder = provider.model
        }
        apiKeyInput.focus()
      })
    }

    let agentsHintRef = document.createElement('div')

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
      verCtl.appendChild(verText)

      const actCtl = field(pane, '手动检查')
      const checkBtn = button('立即检查')
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
      actCtl.appendChild(checkBtn)
      note(pane, '检查结果会显示在状态栏右下角；没有新版本时不会有任何打扰。')
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
      { id: 'tasks', group: 'AI', label: '定时任务', keywords: ['定时', '自动', '计划'], build: buildTasks },
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
        llmReasoning: reasoning,
        autoCheckUpdate,
        bgImage,
        bgPreset,
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
