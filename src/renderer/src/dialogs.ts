import type { AppConfig, Encoding } from '@shared/types'
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

export async function openSettings(current: AppConfig): Promise<AppConfig | null> {
  const [tasks, model] = await Promise.all([
    window.th.tasks.list().catch(() => []),
    window.th.ai.model().catch(() => null),
  ])

  return new Promise((resolve) => {
    const parts = createModal('设置')

    const rootLabel = document.createElement('label')
    rootLabel.textContent = '工作目录'
    const rootRow = document.createElement('div')
    rootRow.style.display = 'flex'
    rootRow.style.gap = '8px'
    const rootInput = document.createElement('input')
    rootInput.type = 'text'
    rootInput.value = current.workspaceRoot
    rootInput.readOnly = true
    rootInput.style.flex = '1'
    const pick = button('选择…')
    rootRow.append(rootInput, pick)
    rootLabel.appendChild(rootRow)

    const encLabel = document.createElement('label')
    encLabel.textContent = '新建文件的默认编码'
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
    encSelect.value = current.defaultEncoding
    encLabel.appendChild(encSelect)

    const themeLabel = document.createElement('label')
    themeLabel.textContent = '主题'
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
    themeSelect.value = current.theme
    themeLabel.appendChild(themeSelect)

    /* 图库目录：粘贴的截图存这里，左侧树不显示 */
    const galleryLabel = document.createElement('label')
    galleryLabel.textContent = '图库目录（粘贴的截图存这里）'
    const galleryRow = document.createElement('div')
    galleryRow.style.display = 'flex'
    galleryRow.style.gap = '8px'
    const galleryInput = document.createElement('input')
    galleryInput.type = 'text'
    galleryInput.readOnly = true
    galleryInput.style.flex = '1'
    const galleryOpen = button('打开文件夹')
    galleryRow.append(galleryInput, galleryOpen)
    galleryLabel.appendChild(galleryRow)

    const galleryHint = document.createElement('div')
    galleryHint.className = 'hint'
    galleryHint.textContent = '截图按日期分文件夹存放；编辑器里用相对路径引用，悬停可预览。'
    galleryLabel.appendChild(galleryHint)

    void window.th.assets
      .info()
      .then((info) => {
        galleryInput.value = info.dir
        galleryInput.title = info.dir
        galleryOpen.addEventListener('click', () => {
          void window.th.fs.openDir(info.dir)
        })
      })
      .catch(() => {
        galleryInput.value = '读取失败'
      })

    parts.body.append(rootLabel, galleryLabel, encLabel, themeLabel)

    /* ---------- 背景图 ---------- */
    let bgImage = current.bgImage
    let bgPreset = current.bgPreset ?? 0
    let bgOpacity = current.bgOpacity
    let bgBlur = current.bgBlur
    let bgDim = current.bgDim

    const presets = [
      { id: 1, name: '深夜蓝', file: 'bg/1-deep-blue.jpg' },
      { id: 2, name: '暮色紫', file: 'bg/2-dusk-purple.jpg' },
      { id: 3, name: '晨曦橙', file: 'bg/3-dawn-warm.jpg' },
      { id: 4, name: '森林青', file: 'bg/4-forest-teal.jpg' },
      { id: 5, name: '石墨灰', file: 'bg/5-graphite.jpg' },
    ]

    const lookBox = document.createElement('div')
    lookBox.className = 'task-section'

    const lookTitle = document.createElement('div')
    lookTitle.className = 'task-title'
    lookTitle.textContent = '背景图'
    lookBox.appendChild(lookTitle)

    const lookHint = document.createElement('div')
    lookHint.className = 'hint'
    lookHint.textContent = '整窗铺满，面板自动变半透明。自定义图片会复制到工作区的 .assets/bg/ 里。'
    lookBox.appendChild(lookHint)

    /* 预设缩略图 + 无背景 + 自定义 */
    const swatches = document.createElement('div')
    swatches.className = 'bg-swatches'
    lookBox.appendChild(swatches)

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

    /* 自定义图片行 */
    const customRow = document.createElement('div')
    customRow.className = 'bg-custom'
    const customBtn = button('自定义图片…')
    const customName = document.createElement('span')
    customName.className = 'bg-custom-name'
    customRow.append(customBtn, customName)
    lookBox.appendChild(customRow)

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
          // 先读成 data URL，交给裁剪对话框选范围
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
      lookBox.appendChild(row)
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
    parts.body.appendChild(lookBox)

    /* ---------- 模型接入 ---------- */
    const modelBox = document.createElement('div')
    modelBox.className = 'task-section'

    const modelTitle = document.createElement('div')
    modelTitle.className = 'task-title'
    modelTitle.textContent = '模型接入'
    modelBox.appendChild(modelTitle)

    const status = document.createElement('div')
    status.className = 'model-status'
    if (model) {
      status.innerHTML =
        `<strong>${model.model || '未配置'}</strong>` +
        `<span class="sep">·</span>${escapeText(model.origin)}` +
        `<span class="sep">·</span>` +
        (model.hasKey
          ? '<span class="ok">Key 已就绪</span>'
          : '<span class="bad">未配置，AI 面板不可用</span>') +
        `<div class="model-url">${escapeText(model.baseURL)}</div>`
    } else {
      status.textContent = '读取失败'
    }
    modelBox.appendChild(status)

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

    const providerLabel = document.createElement('label')
    providerLabel.textContent = '服务商'
    const providerSelect = document.createElement('select')
    for (const [index, provider] of PROVIDERS.entries()) {
      const option = document.createElement('option')
      option.value = String(index)
      option.textContent = provider.baseURL ? `${provider.name}（${provider.baseURL}）` : provider.name
      providerSelect.appendChild(option)
    }
    const currentBase = current.llmBaseUrl.trim().replace(/\/+$/, '')
    const matched = PROVIDERS.findIndex((p) => p.baseURL && p.baseURL === currentBase)
    providerSelect.value = String(matched >= 0 ? matched : PROVIDERS.length - 1)
    providerLabel.appendChild(providerSelect)
    modelBox.appendChild(providerLabel)

    const mkField = (label: string, value: string, placeholder: string, password = false): HTMLInputElement => {
      const wrap = document.createElement('label')
      wrap.textContent = label
      const input = document.createElement('input')
      input.type = password ? 'password' : 'text'
      input.value = value
      input.placeholder = placeholder
      wrap.appendChild(input)
      modelBox.appendChild(wrap)
      return input
    }

    const baseUrlInput = mkField('Base URL（可选）', current.llmBaseUrl, 'https://api.deepseek.com/v1')
    const modelInput = mkField('模型名（可选）', current.llmModel, 'deepseek-chat')
    const apiKeyInput = mkField('API Key（必填）', current.llmApiKey, 'sk-…', true)

    const reasoningLabel = document.createElement('label')
    reasoningLabel.textContent = '推理等级'
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
    reasoningSelect.value = current.llmReasoning ?? 'auto'
    reasoningLabel.appendChild(reasoningSelect)

    const reasoningHint = document.createElement('div')
    reasoningHint.className = 'hint'
    reasoningHint.textContent =
      '选非「自动」时会向接口多发一个 reasoning_effort 字段；部分中转不支持该参数会报 400，遇到就切回自动。'
    reasoningLabel.appendChild(reasoningHint)
    modelBox.appendChild(reasoningLabel)

    providerSelect.addEventListener('change', () => {
      const provider = PROVIDERS[Number(providerSelect.value)]
      if (!provider || !provider.baseURL) return
      baseUrlInput.value = provider.baseURL
      // 换服务商时把模型名也换成该家的常见模型，避免沿用旧模型导致 404
      if (provider.model) {
        modelInput.value = provider.model
        modelInput.placeholder = provider.model
      }
      apiKeyInput.focus()
    })

    parts.body.appendChild(modelBox)

    /* ---------- 项目约定 AGENTS.md ---------- */
    const agentsPath = `${current.workspaceRoot.replace(/[\\/]+$/, '')}/AGENTS.md`

    const agentsBox = document.createElement('div')
    agentsBox.className = 'task-section'

    const agentsTitle = document.createElement('div')
    agentsTitle.className = 'task-title'
    agentsTitle.textContent = '项目约定（AGENTS.md）'
    agentsBox.appendChild(agentsTitle)

    const agentsHint = document.createElement('div')
    agentsHint.className = 'hint'
    agentsHint.textContent =
      '这里写的规则会随每次提问一起交给 agent，例如代码风格、目录习惯、不能碰的文件。保存在工作区根目录，用记事本也能改。'
    agentsBox.appendChild(agentsHint)

    const agentsArea = document.createElement('textarea')
    agentsArea.className = 'agents-area'
    agentsArea.rows = 7
    agentsArea.spellcheck = false
    agentsArea.placeholder =
      '- SQL 关键字一律大写\n- 笔记统一放 知识库/<分类>/\n- 不要改动 .assets/ 下的文件'
    agentsBox.appendChild(agentsArea)

    const agentsRow = document.createElement('div')
    agentsRow.className = 'agents-row'

    const agentsStatus = document.createElement('span')
    agentsStatus.className = 'agents-status'

    const agentsTemplate = button('插入模板')
    const agentsSave = button('保存约定')
    const agentsOpen = button('打开文件夹')

    agentsRow.append(agentsStatus, agentsTemplate, agentsSave, agentsOpen)
    agentsBox.appendChild(agentsRow)

    void window.th.fs
      .read(agentsPath)
      .then((file) => {
        agentsArea.value = file.text
        agentsStatus.textContent = '已加载'
      })
      .catch(() => {
        agentsStatus.textContent = '还没有 AGENTS.md'
      })

    agentsTemplate.addEventListener('click', () => {
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
      agentsArea.value = agentsArea.value.trim() ? `${agentsArea.value.trim()}\n\n${template}` : template
      agentsStatus.textContent = '模板已插入，记得点保存'
    })

    agentsSave.addEventListener('click', () => {
      agentsStatus.textContent = '保存中…'
      void window.th.fs
        .write(agentsPath, agentsArea.value, { encoding: 'utf8', bom: false, eol: 'LF' })
        .then(() => {
          agentsStatus.textContent = agentsArea.value.trim() ? '已保存，下一句提问就生效' : '已清空（下次提问不再带约定）'
        })
        .catch((err: unknown) => {
          agentsStatus.textContent = `保存失败：${err instanceof Error ? err.message : String(err)}`
        })
    })

    agentsOpen.addEventListener('click', () => {
      void window.th.fs.reveal(agentsPath).catch(() => {
        void window.th.fs.openDir(current.workspaceRoot)
      })
    })

    parts.body.appendChild(agentsBox)

    /* ---------- 定时任务 ---------- */
    const taskBox = document.createElement('div')
    taskBox.className = 'task-section'

    const taskTitle = document.createElement('div')
    taskTitle.className = 'task-title'
    taskTitle.textContent = '定时任务（后台自动运行，只读原稿、只新建文件）'
    taskBox.appendChild(taskTitle)

    if (tasks.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'task-meta'
      empty.textContent = '暂无任务'
      taskBox.appendChild(empty)
    }

    // 勾选状态先记下来：保存时用这份，避免被打开面板时的旧快照覆盖
    const taskEnabled = new Map<string, boolean>()

    for (const task of tasks) {
      const row = document.createElement('div')
      row.className = 'task-row'

      const head = document.createElement('div')
      head.className = 'task-head'

      const label = document.createElement('label')
      label.className = 'task-check'
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = task.enabled
      taskEnabled.set(task.id, task.enabled)
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

      head.append(label, runBtn)

      const meta = document.createElement('div')
      meta.className = 'task-meta'
      const last = task.lastResult
        ? ` · 上次：${task.lastResult.replace(/\s+/g, ' ').slice(0, 60)}${task.lastResult.length > 60 ? '…' : ''}`
        : ''
      meta.textContent = `${task.next}${last}`

      row.append(head, meta)
      taskBox.appendChild(row)
    }

    // 自动检查更新：默认开；关掉后只在手动点状态栏时检查
    const updateLabel = document.createElement('label')
    updateLabel.className = 'set-check'
    const updateBox = document.createElement('input')
    updateBox.type = 'checkbox'
    updateBox.checked = current.autoCheckUpdate !== false
    const updateText = document.createElement('span')
    updateText.textContent = '启动后自动检查新版本（Windows 会自动下载，重启后生效）'
    updateLabel.append(updateBox, updateText)
    parts.body.appendChild(updateLabel)

    parts.body.appendChild(taskBox)

    const cancel = button('取消')
    const save = button('保存', true)
    parts.foot.append(cancel, save)

    let settled = false
    const finish = (value: AppConfig | null): void => {
      if (settled) return
      settled = true
      parts.close()
      resolve(value)
    }

    cancel.addEventListener('click', () => finish(null))
    save.addEventListener('click', () => {
      finish({
        ...current,
        workspaceRoot: rootInput.value.trim() || current.workspaceRoot,
        defaultEncoding: encSelect.value as Encoding,
        theme: themeSelect.value as AppConfig['theme'],
        llmBaseUrl: baseUrlInput.value.trim(),
        llmModel: modelInput.value.trim(),
        llmApiKey: apiKeyInput.value.trim(),
        llmReasoning: reasoningSelect.value as AppConfig['llmReasoning'],
        autoCheckUpdate: updateBox.checked,
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
    parts.root.addEventListener('mousedown', (event) => {
      if (event.target === parts.root) finish(null)
    })

    pick.addEventListener('click', () => {
      void window.th.config.pickDirectory().then((dir) => {
        if (dir) rootInput.value = dir
      })
    })
  })
}