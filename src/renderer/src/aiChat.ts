import type { ChatMessage, ModelInfo, SessionSummary, StoredSession, StoredTool, ToolEventPayload } from '@shared/types'
import { requestApproval } from './approval'
import { openArchivePanel } from './archivePanel'

/** 待发送的图片附件 */
interface Attachment {
  id: string
  name: string
  path: string
  /** 降采样后的 data URL，发给模型用 */
  dataUrl: string
}

export interface ChatDeps {
  getSelectionText(): string
  getActiveFile(): { title: string; path: string | null; content: string } | null
  onInsert(text: string): void
  onError(message: string): void
  getWorkspaceLabel(): string
  /** 还没配置模型时，引导用户去设置 */
  onNeedConfig(): void
  /** 在面板里切了模型，通知外层同步配置 */
  onModelChanged?(name: string): void
}

interface UiMessage {
  role: 'user' | 'assistant'
  content: string
  apiContent: string
  /** 这条消息带的图片 data URL */
  images?: string[]
  reasoning: string
  tools: StoredTool[]
  el: HTMLDivElement
  bodyEl: HTMLDivElement
  toolBox: HTMLDivElement
  thinkingEl: HTMLDetailsElement | null
  done: boolean
}

const TOOL_META: Record<string, { icon: string; label: string }> = {
  list_dir: { icon: '📁', label: '列目录' },
  read_file: { icon: '📄', label: '读文件' },
  write_file: { icon: '✍️', label: '写文件' },
  search_files: { icon: '🔍', label: '搜索' },
  open_in_editor: { icon: '↗', label: '打开' },
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 接口报错常常是一整坨 JSON，抽出人能看的 message */
function cleanApiError(raw: string): string {
  const text = raw.trim()
  const start = text.indexOf('{')
  if (start >= 0) {
    try {
      const parsed = JSON.parse(text.slice(start)) as { error?: { message?: string } }
      if (parsed.error?.message) {
        const hint = parsed.error.message.includes('reasoning_content')
          ? '\n（该接口要求回传思考内容；已自动重试，若仍失败请点 ＋ 新建会话）'
          : ''
        return parsed.error.message + hint
      }
    } catch {
      /* 不是 JSON，原样返回 */
    }
  }
  return text
}

/** 行内格式：行内代码 / 加粗 / 文件引用链接 */
function inline(text: string): string {
  const parts = text.split(/(`[^`\n]+`)/)
  return parts
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`')) {
        const inner = part.slice(1, -1)
        // 整段就是文件路径时也做成链接，但保留等宽样式
        const only = CITATION_ONLY_RE.exec(inner)
        if (only) {
          const line = only[2]
          const attr = line ? ` data-line="${line}"` : ''
          return `<a class="cite code-cite" data-path="${only[1]}"${attr}>${inner}</a>`
        }
        return `<code>${inner}</code>`
      }
      return linkCitations(part)
    })
    .join('')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
}

const CITATION_EXT = 'md|markdown|txt|sql|json|csv|tsv|log|ts|js|mjs|py|sh|ps1|yml|yaml|ini|conf|html|css|go|rs|java'
// 1) 带目录的路径：目录段不含空格，文件名允许空格（用户的笔记名里常有空格）
// 2) 工作区根目录下的裸文件名：不允许空格，避免误吞普通词
const CITATION_RE = new RegExp(
  '(?<![\\w/:.-])(' +
    `(?:[^\\s/\\n]{1,24}/)+(?:[^/\\n]{1,80}?\\.(?:${CITATION_EXT}))` +
    `|[^\\s/\\n]{1,80}\\.(?:${CITATION_EXT})` +
    ')(?::(\\d+))?',
  'g'
)

/** 反引号里整段就是一个文件路径时，同样渲染成链接（模型很爱这么写） */
const CITATION_ONLY_RE = new RegExp(
  `^((?:[^\\s/\\n]{1,24}/)+(?:[^/\\n]{1,80}?\\.(?:${CITATION_EXT}))|[^\\s/\\n]{1,80}\\.(?:${CITATION_EXT}))(?::(\\d+))?$`
)

/** 把 `路径:行号` 变成可点击跳转的链接 */
function linkCitations(text: string): string {
  return text.replace(CITATION_RE, (_match, path: string, line?: string) => {
    const attr = line ? ` data-line="${line}"` : ''
    return `<a class="cite" data-path="${path}"${attr}>${path}${line ? `:${line}` : ''}</a>`
  })
}

/**
 * 轻量 markdown → HTML。
 * 刻意做成"文档式"排版：标题、列表、代码卡片，和 DSH 的对话观感一致。
 */
function renderMarkdown(source: string): string {
  const codeBlocks: string[] = []
  const withPlaceholders = source.replace(
    /```([\w+-]*)\r?\n?([\s\S]*?)```/g,
    (_match, lang: string, code: string) => {
      codeBlocks.push(code.replace(/\n$/, ''))
      return `\u0000CODE${codeBlocks.length - 1}\u0000\u0001${lang}\u0001`
    }
  )

  const lines = escapeHtml(withPlaceholders).split('\n')
  const out: string[] = []
  let list: string[] | null = null
  let listTag: 'ul' | 'ol' = 'ul'

  const flushList = (): void => {
    if (list) {
      out.push(`<${listTag}>${list.join('')}</${listTag}>`)
      list = null
    }
  }

  for (const line of lines) {
    const code = /^\u0000CODE(\d+)\u0000\u0001([^\u0001]*)\u0001$/.exec(line.trim())
    if (code) {
      flushList()
      const index = Number(code[1])
      const lang = code[2] ? code[2].toUpperCase() : '代码块'
      out.push(
        `<div class="code-card"><div class="code-head"><span>${escapeHtml(lang)}</span>` +
          `<button class="code-copy" type="button">复制</button></div>` +
          `<pre>${escapeHtml(codeBlocks[index])}</pre></div>`
      )
      continue
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line)
    if (heading) {
      flushList()
      const level = Math.min(heading[1].length + 1, 4)
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }

    const bullet = /^\s*[-*]\s+(.+)$/.exec(line)
    const ordered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line)
    if (bullet || ordered) {
      const tag: 'ul' | 'ol' = bullet ? 'ul' : 'ol'
      if (listTag !== tag) flushList()
      listTag = tag
      list ??= []
      list.push(`<li>${inline(bullet ? bullet[1] : ordered![2])}</li>`)
      continue
    }

    if (!line.trim()) {
      flushList()
      continue
    }

    flushList()
    out.push(`<p>${inline(line)}</p>`)
  }
  flushList()
  return out.join('')
}

function summarizeArgs(name: string, raw: string): string {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(raw || '{}')
  } catch {
    return raw.slice(0, 80)
  }
  if (name === 'write_file') return `${String(args['path'] ?? '')}（${String(args['content'] ?? '').length} 字符）`
  if (name === 'read_file') return String(args['path'] ?? '') + (args['offset'] ? ` 第 ${args['offset']} 行起` : '')
  if (name === 'search_files') return `${String(args['pattern'] ?? '')}${args['path'] ? ` @ ${args['path']}` : ''}`
  return String(args['path'] ?? args['pattern'] ?? '')
}

export interface ChatApi {
  init(): Promise<void>
  focus(): void
  pushSelection(): void
  reset(): void
  /** 启动时恢复最近一次会话 */
  restoreLast(): Promise<void>
  /** 配置变更后刷新模型徽标与可用状态 */
  refreshModel(): Promise<void>
}

export function createChat(deps: ChatDeps): ChatApi {
  const messagesEl = document.getElementById('ai-messages') as HTMLDivElement
  const inputEl = document.getElementById('ai-input') as HTMLTextAreaElement
  const sendBtn = document.getElementById('ai-send') as HTMLButtonElement
  const stopBtn = document.getElementById('ai-stop') as HTMLButtonElement
  const ctxSelection = document.getElementById('ctx-selection') as HTMLInputElement
  const ctxFile = document.getElementById('ctx-file') as HTMLInputElement
  const ctxKnowledge = document.getElementById('ctx-knowledge') as HTMLInputElement
  const modelEl = document.getElementById('ai-model') as HTMLSpanElement
  const hintEl = document.getElementById('ai-hint') as HTMLSpanElement
  const usageEl = document.getElementById('ai-usage') as HTMLSpanElement

  /* ---------------- 右侧对话轮次线 ---------------- */
  /**
   * 每一轮问答在右侧留一个短刻度：
   *  - 悬停刻度弹出卡片，显示这一轮的问题 + 回答开头（不用滚回去找）
   *  - 当前视口所在的那一轮刻度更长更实
   *  - 点一下跳到这一轮
   */
  function setupTurnRail(): void {
    const chatRoot = messagesEl.parentElement
    if (!chatRoot) return

    const rail = document.createElement('div')
    rail.className = 'turn-rail'
    chatRoot.appendChild(rail)

    const preview = document.createElement('div')
    preview.className = 'turn-preview'
    preview.hidden = true
    chatRoot.appendChild(preview)

    interface TurnInfo {
      el: HTMLElement
      question: string
      answer: string
    }

    /** 把消息流切成「一问一答」的轮次 */
    function collectTurns(): TurnInfo[] {
      const nodes = [...messagesEl.querySelectorAll<HTMLElement>('.msg')]
      const turns: TurnInfo[] = []
      let current: TurnInfo | null = null
      /** 只取正文：去掉「思考过程」和工具卡片，否则摘要里全是「完成 · 22ms」 */
      const cleanText = (node: HTMLElement): string => {
        const clone = node.cloneNode(true) as HTMLElement
        clone.querySelectorAll('.thinking, .tool').forEach((child) => child.remove())
        return (clone.innerText || '').replace(/\s+/g, ' ').trim()
      }

      for (const node of nodes) {
        const text = cleanText(node)
        if (node.classList.contains('user')) {
          if (current) turns.push(current)
          current = { el: node, question: text, answer: '' }
          continue
        }
        // 助手消息：把这一轮里所有助手输出的开头拼起来
        if (current && !current.answer && text) current.answer = text
      }
      if (current) turns.push(current)
      return turns
    }

    let turns: TurnInfo[] = []
    let activeIndex = -1

    const showPreview = (turn: TurnInfo, tick: HTMLElement): void => {
      preview.textContent = ''
      const q = document.createElement('div')
      q.className = 'turn-preview-q'
      q.textContent = turn.question.slice(0, 80) || '（空提问）'
      const a = document.createElement('div')
      a.className = 'turn-preview-a'
      a.textContent = turn.answer.slice(0, 160) || '（还没有回答）'
      preview.append(q, a)
      preview.hidden = false

      const chatRect = chatRoot.getBoundingClientRect()
      const tickRect = tick.getBoundingClientRect()
      const width = 280
      const left = Math.max(8, chatRect.width - width - 22)
      preview.style.left = `${left}px`
      // 卡片以刻度为中心竖直对齐，但不越出聊天区
      const wanted = tickRect.top - chatRect.top + tickRect.height / 2 - preview.offsetHeight / 2
      const maxTop = chatRect.height - preview.offsetHeight - 8
      preview.style.top = `${Math.max(8, Math.min(wanted, Math.max(8, maxTop)))}px`
    }

    const hidePreview = (): void => {
      preview.hidden = true
    }

    const render = (): void => {
      const chatRect = chatRoot.getBoundingClientRect()
      const msgRect = messagesEl.getBoundingClientRect()
      rail.style.top = `${Math.max(0, msgRect.top - chatRect.top)}px`
      rail.style.height = `${Math.max(0, msgRect.height)}px`

      turns = collectTurns()
      // 刻度等距：轮次多了也不会挤成一条线
      const count = turns.length
      const gap = count > 1 ? Math.min(18, Math.max(4, (msgRect.height - 8) / count)) : 0
      // 刻度组整体居中：轮次少的时候不要挤在顶部
      const groupHeight = count > 1 ? (count - 1) * gap : 0
      const startY = Math.max(4, (msgRect.height - groupHeight) / 2)
      const scrollTop = messagesEl.scrollTop
      const nextActive = (() => {
        let index = -1
        turns.forEach((turn, i) => {
          if (turn.el.offsetTop <= scrollTop + 24) index = i
        })
        return index
      })()

      rail.textContent = ''
      turns.forEach((turn, index) => {
        const tick = document.createElement('button')
        tick.type = 'button'
        tick.className = 'turn-tick'
        if (index === nextActive) tick.classList.add('current')
        tick.style.top = `${startY + index * gap}px`
        tick.addEventListener('mouseenter', () => showPreview(turn, tick))
        tick.addEventListener('mouseleave', hidePreview)
        tick.addEventListener('focus', () => showPreview(turn, tick))
        tick.addEventListener('blur', hidePreview)
        tick.addEventListener('click', () => {
          turn.el.scrollIntoView({ behavior: 'smooth', block: 'start' })
          hidePreview()
        })
        rail.appendChild(tick)
      })
      activeIndex = nextActive
    }

    let raf = 0
    const schedule = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        render()
      })
    }

    new MutationObserver(schedule).observe(messagesEl, { childList: true, subtree: true, characterData: true })
    messagesEl.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    rail.addEventListener('mouseleave', hidePreview)
    schedule()
    void activeIndex
  }

  /* 用量：本轮 + 本会话累计 */
  let turnUsage = { prompt: 0, completion: 0, reasoning: 0, cached: 0, estimated: false }
  let sessionUsage = { prompt: 0, completion: 0, reasoning: 0, cached: 0 }
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

  function renderUsage(): void {
    if (turnUsage.prompt + turnUsage.completion === 0) {
      usageEl.hidden = true
      return
    }
    usageEl.hidden = false
    const star = turnUsage.estimated ? '~' : ''
    usageEl.textContent = `${star}↑${fmt(turnUsage.prompt)} ↓${fmt(turnUsage.completion)}`
    usageEl.title = [
      `本轮：输入 ${turnUsage.prompt} · 输出 ${turnUsage.completion}${turnUsage.reasoning ? `（思考 ${turnUsage.reasoning}）` : ''}${turnUsage.cached ? ` · 命中缓存 ${turnUsage.cached}` : ''}`,
      turnUsage.estimated ? '（服务端没返回用量，按字符估算）' : '',
      `本会话累计：输入 ${sessionUsage.prompt} · 输出 ${sessionUsage.completion}`,
    ]
      .filter(Boolean)
      .join('\n')
  }

  window.th.ai.onRetry(({ attempt, reason }) => {
    hintEl.textContent = `重试中（第 ${attempt} 次 · ${reason}）`
  })

  window.th.ai.onUsage((usage) => {
    turnUsage = { ...turnUsage, ...usage }
    sessionUsage = {
      prompt: sessionUsage.prompt + usage.prompt,
      completion: sessionUsage.completion + usage.completion,
      reasoning: sessionUsage.reasoning + usage.reasoning,
      cached: sessionUsage.cached + usage.cached,
    }
    renderUsage()
  })
  const scrollBtn = document.getElementById('ai-scroll-bottom') as HTMLButtonElement
  const attachBtn = document.getElementById('ai-attach') as HTMLButtonElement | null
  const attachRow = document.getElementById('ai-attach-row') as HTMLDivElement | null

  const messages: UiMessage[] = []
  /** 勾选待归档的消息 */
  const picked = new Set<UiMessage>()
  let archiveBar: HTMLDivElement | null = null
  let streaming = false
  let currentId: string | null = null
  let current: UiMessage | null = null
  let toolsSinceText = false
  let sessionId: string = crypto.randomUUID()
  let modelReady = false
  const attachments: Attachment[] = []

  function nearBottom(): boolean {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140
  }

  function scrollToBottom(force = false): void {
    if (force || nearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function updateScrollButton(): void {
    scrollBtn.hidden = nearBottom()
  }

  messagesEl.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement | null)?.closest('a.cite') as HTMLElement | null
    if (!link) return
    event.preventDefault()
    const path = link.dataset['path'] ?? ''
    if (!path) return
    const line = Number(link.dataset['line'] ?? '0') || undefined
    window.dispatchEvent(new CustomEvent('th:open-path', { detail: { path, line } }))
  })

  messagesEl.addEventListener('scroll', updateScrollButton)
  scrollBtn.addEventListener('click', () => {
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' })
  })

  function renderEmpty(): void {
    if (messages.length > 0) return

    if (!modelReady) {
      messagesEl.innerHTML = `<div class="empty-chat">
        <div class="empty-title">先接一个模型</div>
        <div class="empty-sub">
          AI 面板需要模型的地址和 Key。填一次就能用，
          Key 会存在本机配置文件里，不会上传。
        </div>
        <div class="chips">
          <button data-config="1">打开设置填写</button>
        </div>
      </div>`
      messagesEl.querySelector<HTMLButtonElement>('[data-config]')?.addEventListener('click', () => deps.onNeedConfig())
      return
    }

    messagesEl.innerHTML = `<div class="empty-chat">
      <div class="empty-title">给 agent 派个活</div>
      <div class="empty-sub">它能读文件、写文件、搜代码。工作区：<span class="ws">${escapeHtml(
        deps.getWorkspaceLabel()
      )}</span></div>
      <div class="chips">
        <button data-prompt="看一下今天目录里有什么文件，简单说说都是干什么的">今天目录里有什么？</button>
        <button data-prompt="在当前工作区搜索 TODO，按文件归类列出来">搜一下 TODO</button>
        <button data-prompt="帮我写一个排查慢查询的 SQL 脚本，存到今天的目录并在编辑器打开">写个排查慢 SQL 的脚本</button>
      </div>
    </div>`
    messagesEl.querySelectorAll<HTMLButtonElement>('.chips button').forEach((btn) => {
      btn.addEventListener('click', () => {
        inputEl.value = btn.dataset['prompt'] ?? ''
        inputEl.focus()
        autoGrow()
      })
    })
  }

  function pushToast(message: string): void {
    document.dispatchEvent(new CustomEvent('th:toast', { detail: message }))
  }

  function refreshArchiveBar(): void {
    if (!archiveBar) return
    const count = picked.size
    archiveBar.hidden = count === 0
    if (count === 0) return
    const label = archiveBar.querySelector('.archive-bar-count')
    if (label) label.textContent = `${count} 条`
  }

  function togglePick(msg: UiMessage): void {
    if (picked.has(msg)) picked.delete(msg)
    else picked.add(msg)
    msg.el.classList.toggle('picked', picked.has(msg))
    const box = msg.el.querySelector('.msg-check')
    if (box) box.textContent = picked.has(msg) ? '✓' : ''
    refreshArchiveBar()
  }

  /** 给消息挂一个 hover 才出现的勾选圈 */
  /** 元素先挂按钮，等 UiMessage 构造完再补 click 绑定 */
  const pendingCheck = new WeakMap<HTMLElement, HTMLButtonElement>()
  function attachCheckForEl(el: HTMLElement): void {
    const box = document.createElement('button')
    box.type = 'button'
    box.className = 'msg-check'
    box.title = '勾选后可以归档'
    el.appendChild(box)
    pendingCheck.set(el, box)
  }

  function attachCheck(msg: UiMessage): void {
    const box = pendingCheck.get(msg.el) ?? document.createElement('button')
    box.addEventListener('click', (event) => {
      event.stopPropagation()
      togglePick(msg)
    })
  }

  function pickedText(): { title: string; content: string } {
    const ordered = messages.filter((msg) => picked.has(msg))
    const firstUser = ordered.find((msg) => msg.role === 'user')
    const title = (firstUser?.content ?? ordered[0]?.content ?? '归档内容')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 30)
    const parts: string[] = []
    for (const msg of ordered) {
      const text = msg.content.trim()
      if (!text) continue
      parts.push(msg.role === 'user' ? `## 问：${text}` : text)
    }
    return { title, content: parts.join('\n\n') }
  }

  function ensureArchiveBar(): void {
    if (archiveBar) return
    const bar = document.createElement('div')
    bar.className = 'archive-bar'
    bar.hidden = true

    const count = document.createElement('span')
    count.className = 'archive-bar-count'
    const toKnowledge = document.createElement('button')
    toKnowledge.className = 'btn small primary'
    toKnowledge.textContent = '归档'
    toKnowledge.addEventListener('click', () => {
      const { title, content } = pickedText()
      openArchivePanel(
        { target: 'knowledge', title, content, source: 'chat' },
        {
          toast: pushToast,
          onWritten: () => {
            for (const msg of [...picked]) togglePick(msg)
          },
        }
      )
    })

    const toMemory = document.createElement('button')
    toMemory.className = 'btn small'
    toMemory.textContent = '记记忆'
    toMemory.addEventListener('click', () => {
      const { title, content } = pickedText()
      const brief = content.replace(/\s+/g, ' ').trim().slice(0, 180)
      openArchivePanel(
        { target: 'memory', memoryKind: 'log', title, content: brief, source: 'chat' },
        {
          toast: pushToast,
          onWritten: () => {
            for (const msg of [...picked]) togglePick(msg)
          },
        }
      )
    })

    const clear = document.createElement('button')
    clear.className = 'btn small'
    clear.textContent = '取消'
    clear.addEventListener('click', () => {
      for (const msg of [...picked]) togglePick(msg)
    })

    bar.append(count, toKnowledge, toMemory, clear)
    // 放进输入卡片内部（textarea 上方），和输入框同属一个 .composer-box，绝不会叠
    const box = document.querySelector('#ai-composer .composer-box')
    const textarea = document.getElementById('ai-input')
    if (box && textarea) box.insertBefore(bar, textarea)
    else messagesEl.parentElement?.appendChild(bar)
    archiveBar = bar
  }

  function newAssistant(): UiMessage {
    const el = document.createElement('div')
    el.className = 'msg assistant'

    const bodyEl = document.createElement('div')
    bodyEl.className = 'msg-body'

    const toolBox = document.createElement('div')
    toolBox.className = 'tool-box'

    el.append(bodyEl, toolBox)
    messagesEl.appendChild(el)
    attachCheckForEl(el)

    const msg: UiMessage = {
      role: 'assistant',
      content: '',
      apiContent: '',
      reasoning: '',
      tools: [],
      el,
      bodyEl,
      toolBox,
      thinkingEl: null,
      done: false,
    }
    attachCheck(msg)
    ensureArchiveBar()
    scrollToBottom(true)
    return msg
  }

  function addUserMessage(display: string, apiContent: string, images: string[] = []): UiMessage {
    const el = document.createElement('div')
    el.className = 'msg user'
    const bodyEl = document.createElement('div')
    bodyEl.className = 'msg-body'
    bodyEl.innerHTML = renderMarkdown(display)
    el.appendChild(bodyEl)
    if (images.length > 0) {
      const strip = document.createElement('div')
      strip.className = 'msg-images'
      for (const src of images) {
        const img = document.createElement('img')
        img.src = src
        img.alt = '附图'
        strip.appendChild(img)
      }
      el.appendChild(strip)
    }
    messagesEl.appendChild(el)
    attachCheckForEl(el)

    const msg: UiMessage = {
      role: 'user',
      content: display,
      apiContent,
      reasoning: '',
      tools: [],
      el,
      bodyEl,
      toolBox: document.createElement('div'),
      thinkingEl: null,
      done: true,
    }
    attachCheck(msg)
    ensureArchiveBar()
    messages.push(msg)
    scrollToBottom(true)
    return msg
  }

  /** 每次重绘后给代码卡片挂上复制按钮 */
  function bindCopyButtons(root: HTMLElement): void {
    root.querySelectorAll<HTMLButtonElement>('.code-copy').forEach((btn) => {
      if (btn.dataset['bound']) return
      btn.dataset['bound'] = '1'
      btn.addEventListener('click', () => {
        const code = btn.closest('.code-card')?.querySelector('pre')?.textContent ?? ''
        void navigator.clipboard.writeText(code)
        const original = btn.textContent
        btn.textContent = '已复制'
        setTimeout(() => {
          btn.textContent = original
        }, 1200)
      })
    })
  }

  function paintBody(msg: UiMessage): void {
    if (!msg.content) {
      msg.bodyEl.innerHTML = ''
      msg.bodyEl.classList.remove('cursor-blink')
      return
    }
    msg.bodyEl.innerHTML = renderMarkdown(msg.content)
    bindCopyButtons(msg.bodyEl)
    msg.bodyEl.classList.toggle('cursor-blink', !msg.done)
  }

  function ensureThinking(msg: UiMessage): HTMLDetailsElement {
    if (msg.thinkingEl) return msg.thinkingEl
    const details = document.createElement('details')
    details.className = 'thinking'
    const summary = document.createElement('summary')
    summary.textContent = '思考过程'
    const box = document.createElement('div')
    details.append(summary, box)
    msg.el.insertBefore(details, msg.bodyEl)
    msg.thinkingEl = details
    return details
  }

  function createToolCard(payload: ToolEventPayload): HTMLElement {
    const meta = TOOL_META[payload.name] ?? { icon: '⚙', label: payload.name }
    const card = document.createElement('div')
    card.className = 'tool running'
    card.dataset['callId'] = payload.toolCallId

    const head = document.createElement('div')
    head.className = 'tool-head'

    const icon = document.createElement('span')
    icon.className = 'tool-icon'
    icon.textContent = meta.icon

    const name = document.createElement('span')
    name.className = 'tool-name'
    name.textContent = meta.label

    const args = document.createElement('span')
    args.className = 'tool-args'
    args.textContent = summarizeArgs(payload.name, payload.args)

    const state = document.createElement('span')
    state.className = 'tool-state'
    state.textContent = '运行中'

    head.append(icon, name, args, state)

    const body = document.createElement('div')
    body.className = 'tool-body'
    body.hidden = true

    head.addEventListener('click', () => {
      body.hidden = !body.hidden
    })

    card.append(head, body)
    return card
  }

  function updateToolCard(payload: ToolEventPayload): void {
    const card = messagesEl.querySelector<HTMLElement>(`[data-call-id="${payload.toolCallId}"]`)
    if (!card) return
    card.classList.remove('running')
    card.classList.add(payload.ok ? 'ok' : 'fail')
    const state = card.querySelector('.tool-state')
    if (state) {
      const took =
        typeof payload.ms === 'number' ? (payload.ms < 1000 ? `${payload.ms}ms` : `${(payload.ms / 1000).toFixed(1)}s`) : ''
      state.textContent = payload.ok ? `完成${took ? ` · ${took}` : ''}` : '失败'
    }
    const body = card.querySelector<HTMLElement>('.tool-body')
    if (body) {
      body.textContent = payload.summary ?? ''
      body.hidden = payload.ok === true
    }
  }

  function buildContext(): string {
    const parts: string[] = []
    if (ctxSelection.checked) {
      const selection = deps.getSelectionText()
      if (selection.trim()) parts.push(`【用户选中的代码】\n\`\`\`\n${selection}\n\`\`\``)
    }
    if (ctxFile.checked) {
      const file = deps.getActiveFile()
      if (file) {
        parts.push(
          `【当前文件：${file.title}${file.path ? `（${file.path}）` : ''}】\n\`\`\`\n${file.content.slice(0, 8000)}\n\`\`\``
        )
      }
    }
    return parts.length ? `${parts.join('\n\n')}\n\n---\n\n` : ''
  }

  /** 大图先降采样：既省 token 也避免请求体过大 */
  async function shrinkDataUrl(src: string, max = 1400, quality = 0.82): Promise<string> {
    try {
      const img = new Image()
      img.src = src
      await img.decode()
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      if (scale === 1 && src.length < 800_000) return src
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(img.width * scale))
      canvas.height = Math.max(1, Math.round(img.height * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) return src
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/jpeg', quality)
    } catch {
      return src
    }
  }

  function renderAttachments(): void {
    if (!attachRow) return
    attachRow.textContent = ''
    attachRow.hidden = attachments.length === 0
    for (const item of attachments) {
      const chip = document.createElement('div')
      chip.className = 'attach-chip'
      chip.title = item.name
      const img = document.createElement('img')
      img.src = item.dataUrl
      img.alt = item.name
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'attach-remove'
      remove.textContent = '✕'
      remove.title = '移除这张图'
      remove.addEventListener('click', () => {
        const index = attachments.findIndex((a) => a.id === item.id)
        if (index >= 0) attachments.splice(index, 1)
        renderAttachments()
      })
      chip.append(img, remove)
      attachRow.appendChild(chip)
    }
  }

  async function addAttachmentFromPath(path: string): Promise<void> {
    try {
      const info = await window.th.fs.readImageData(path)
      if (!info) return
      const dataUrl = await shrinkDataUrl(info.dataUrl)
      attachments.push({ id: crypto.randomUUID(), name: info.name, path, dataUrl })
      renderAttachments()
    } catch (err) {
      deps.onError(err instanceof Error ? err.message : String(err))
    }
  }

  async function addAttachmentFromFile(file: File): Promise<void> {
    const raw = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(new Error('读不到这张图'))
      reader.readAsDataURL(file)
    })
    if (!raw) return
    const dataUrl = await shrinkDataUrl(raw)
    attachments.push({ id: crypto.randomUUID(), name: file.name || '粘贴的图片', path: '', dataUrl })
    renderAttachments()
  }

  /** 从 dataTransfer 取图片文件：真实拖拽/files 有值，合成事件可能只在 items 里 */
  function imagesFromDataTransfer(dt: DataTransfer | null): File[] {
    if (!dt) return []
    const out: File[] = []
    for (const file of Array.from(dt.files ?? [])) {
      if (file.type.startsWith('image/')) out.push(file)
    }
    if (out.length === 0) {
      for (const item of Array.from(dt.items ?? [])) {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
        const file = item.getAsFile()
        if (file) out.push(file)
      }
    }
    return out
  }

  // 附件入口：按钮 / 粘贴 / 拖入
  if (attachBtn) {
    attachBtn.addEventListener('click', () => {
      void window.th.fs.pickImages().then((paths) => {
        for (const path of paths) void addAttachmentFromPath(path)
      })
    })
  }

  // 粘贴：挂在 document 上，焦点在输入框或面板里都能接住
  document.addEventListener('paste', (event) => {
    const active = document.activeElement
    const inComposer =
      active === inputEl || (active instanceof Element && !!active.closest('#ai-composer'))
    if (!inComposer) return
    const files = imagesFromDataTransfer(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    for (const file of files) void addAttachmentFromFile(file)
  })

  // 拖拽：挂在 document 捕获阶段（和粘贴一致），避免被编辑器/文件树的拖拽逻辑抢走
  const inComposer = (target: EventTarget | null): boolean =>
    target instanceof Element && !!target.closest('#ai-composer')

  document.addEventListener(
    'dragover',
    (event) => {
      if (!inComposer(event.target) || !event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      document.getElementById('ai-composer')?.classList.add('drop-image')
    },
    true
  )

  document.addEventListener(
    'dragleave',
    (event) => {
      if (!inComposer(event.target)) return
      document.getElementById('ai-composer')?.classList.remove('drop-image')
    },
    true
  )

  document.addEventListener(
    'drop',
    (event) => {
      if (!inComposer(event.target)) return
      document.getElementById('ai-composer')?.classList.remove('drop-image')
      const files = imagesFromDataTransfer(event.dataTransfer)
      if (files.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      for (const file of files) void addAttachmentFromFile(file)
    },
    true
  )

  function autoGrow(): void {
    inputEl.style.height = 'auto'
    const next = Math.min(inputEl.scrollHeight, 200)
    inputEl.style.height = `${next}px`
    // 内容没超出时不该出现滚动条
    inputEl.style.overflowY = inputEl.scrollHeight > 200 ? 'auto' : 'hidden'
  }

  // 选中文字和整个文件是同一件事的两种粒度，互斥；知识库开关独立
  function syncContextExclusive(): void {
    ctxSelection.addEventListener('change', () => {
      if (ctxSelection.checked) ctxFile.checked = false
    })
    ctxFile.addEventListener('change', () => {
      if (ctxFile.checked) ctxSelection.checked = false
    })
  }
  syncContextExclusive()

  async function send(): Promise<void> {
    turnUsage = { prompt: 0, completion: 0, reasoning: 0, cached: 0, estimated: false }
    renderUsage()
    if (streaming) return
    if (!modelReady) {
      deps.onNeedConfig()
      return
    }
    const text = inputEl.value.trim()
    if (!text && attachments.length === 0) return

    messagesEl.querySelector('.empty-chat')?.remove()
    inputEl.value = ''
    autoGrow()

    const images = attachments.map((item) => item.dataUrl)
    const userMessage = addUserMessage(
      text || (images.length > 0 ? '（看图）' : ''),
      buildContext() + (text || '请描述这些图片的内容。'),
      images
    )
    userMessage.images = images
    attachments.length = 0
    renderAttachments()
    void persist()

    const assistant = newAssistant()
    messages.push(assistant)
    current = assistant
    toolsSinceText = false

    const id = crypto.randomUUID()
    currentId = id
    streaming = true
    sendBtn.hidden = true
    stopBtn.hidden = false
    hintEl.textContent = '思考中…'
    updateScrollButton()

    const payload: ChatMessage[] = [
      { role: 'system', content: '你是内嵌在文本编辑器里的编码 agent。' },
      ...messages.map((m) => {
        const item: ChatMessage =
          m.images && m.images.length > 0
            ? {
                role: m.role,
                content: [
                  { type: 'text', text: m.apiContent },
                  ...m.images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
                ],
              }
            : { role: m.role, content: m.apiContent }
        // 思考模式下 assistant 轮次必须回传 reasoning_content
        if (m.role === 'assistant' && m.reasoning) item.reasoning_content = m.reasoning
        return item
      }),
    ]

    try {
      await window.th.ai.chat({
      knowledgeMode: ctxKnowledge.checked, id, messages: payload })
    } catch (err) {
      finish({ id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  function finish(done: { id: string; error?: string; aborted?: boolean; steps?: number }): void {
    if (done.id !== currentId) return
    streaming = false
    currentId = null
    sendBtn.hidden = false
    stopBtn.hidden = true

    if (current) {
      current.done = true
      current.bodyEl.classList.remove('cursor-blink')
      if (done.error) current.content += `\n\n> 请求失败：${cleanApiError(done.error)}`
      else if (done.aborted) current.content += '\n\n> 已停止'
      paintBody(current)
    }
    // 兜底：任何残留的"生成中"光标都清掉
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue
      msg.done = true
      msg.bodyEl.classList.remove('cursor-blink')
    }
    current = null
    hintEl.textContent = done.steps ? `${done.steps} 步` : ''
    inputEl.focus()
    scrollToBottom()
    updateScrollButton()
    void persist()
  }

  window.th.ai.onDelta(({ id, kind, text }) => {
    if (id !== currentId) return
    if (kind === 'reasoning') {
      const target = current ?? newAssistant()
      current = target
      target.reasoning += text
      const details = ensureThinking(target)
      const box = details.querySelector('div')
      if (box) box.textContent = target.reasoning
      return
    }
    if (!current || toolsSinceText) {
      // 上一段正文已经结束（后面跟了工具调用），收尾再新起一段
      if (current) {
        current.done = true
        current.bodyEl.classList.remove('cursor-blink')
        paintBody(current)
      }
      current = newAssistant()
      messages.push(current)
      toolsSinceText = false
    }
    current.content += text
    paintBody(current)
    hintEl.textContent = '生成中…'
    scrollToBottom()
  })

  window.th.ai.onTool((payload) => {
    if (payload.id !== currentId) return
    if (!current) {
      current = newAssistant()
      messages.push(current)
    }
    if (payload.phase === 'start') {
      current.toolBox.appendChild(createToolCard(payload))
      toolsSinceText = true
      hintEl.textContent = `${TOOL_META[payload.name]?.label ?? payload.name}…`
    } else {
      updateToolCard(payload)
      current.tools.push({
        name: payload.name,
        args: payload.args,
        ok: Boolean(payload.ok),
        summary: payload.summary,
        ms: payload.ms,
      })
      hintEl.textContent = ''
    }
    scrollToBottom()
  })

  window.th.ai.onDone((done) => finish(done))

  // 主进程要改文件 → 弹出 diff 让用户确认
  window.th.ai.onApproval((request) => {
    void requestApproval(request).then((ok) => window.th.ai.approvalResult(request.id, ok))
  })

  function init(): Promise<void> {
    renderEmpty()
    sendBtn.addEventListener('click', () => void send())
    stopBtn.addEventListener('click', () => {
      if (currentId) window.th.ai.abort(currentId)
    })
    inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void send()
      }
    })
    inputEl.addEventListener('input', autoGrow)
    document.getElementById('ai-selection')?.addEventListener('click', () => pushSelection())
    document.getElementById('ai-new')?.addEventListener('click', () => reset())

    return refreshModel()
  }

  async function refreshModel(): Promise<void> {
    let info: ModelInfo
    try {
      info = await window.th.ai.model()
    } catch {
      return
    }

    modelReady = info.hasKey
    currentModel = info.model || '未配置'
    modelEl.textContent = info.model || '未配置'
    modelEl.title = info.hasKey ? `${info.baseURL}（${info.origin}）· 点击切换模型` : '点击配置模型'

    const dot = document.getElementById('ai-dot')
    dot?.classList.toggle('ok', info.hasKey)
    dot?.classList.toggle('bad', !info.hasKey)

    hintEl.textContent = info.hasKey ? '' : '未配置模型'
    if (messages.length === 0) renderEmpty()
  }

  function focus(): void {
    inputEl.focus()
  }

  function pushSelection(): void {
    const selection = deps.getSelectionText()
    if (!selection.trim()) {
      deps.onError('先在编辑器里选中一段文本')
      return
    }
    inputEl.value = inputEl.value ? `${inputEl.value}\n${selection}` : selection
    inputEl.focus()
    autoGrow()
  }

  function reset(): void {
    if (streaming && currentId) window.th.ai.abort(currentId)
    messages.length = 0
    messagesEl.textContent = ''
    renderEmpty()
    current = null
    hintEl.textContent = ''
    updateScrollButton()
    sessionId = crypto.randomUUID()
  }

  /* ------------------------------------------------------------------ */
  /* 会话持久化                                                          */
  /* ------------------------------------------------------------------ */

  function toStored(): StoredSession {
    const firstUser = messages.find((m) => m.role === 'user')
    const title = (firstUser?.content ?? '新会话').replace(/\s+/g, ' ').trim().slice(0, 40) || '新会话'
    return {
      id: sessionId,
      title,
      updatedAt: Date.now(),
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        images: m.images && m.images.length > 0 ? m.images : undefined,
        reasoning: m.reasoning || undefined,
        tools: m.tools.length ? m.tools : undefined,
      })),
    }
  }

  async function persist(): Promise<void> {
    if (messages.length === 0) return
    try {
      await window.th.sessions.save(toStored())
    } catch {
      /* 存不下来不影响聊天 */
    }
  }

  /** 把历史消息重建成界面（不触发新一轮请求） */
  function restore(session: StoredSession): void {
    if (streaming && currentId) window.th.ai.abort(currentId)
    streaming = false
    currentId = null
    current = null

    messages.length = 0
    messagesEl.textContent = ''
    sessionId = String(session.id)

    for (const item of session.messages) {
      if (item.role === 'user') {
        addUserMessage(item.content, item.content, item.images ?? [])
        continue
      }

      const msg = newAssistant()
      msg.content = item.content
      msg.reasoning = item.reasoning ?? ''
      msg.tools = item.tools ?? []
      msg.done = true

      if (msg.reasoning) {
        const details = ensureThinking(msg)
        const box = details.querySelector('div')
        if (box) box.textContent = msg.reasoning
      }

      for (const tool of msg.tools) {
        const card = createToolCard({
          id: session.id,
          toolCallId: crypto.randomUUID(),
          name: tool.name,
          args: tool.args,
          phase: 'start',
        })
        card.classList.remove('running')
        card.classList.add(tool.ok ? 'ok' : 'fail')
        const state = card.querySelector('.tool-state')
        if (state) {
          const took = typeof tool.ms === 'number' ? (tool.ms < 1000 ? `${tool.ms}ms` : `${(tool.ms / 1000).toFixed(1)}s`) : ''
          state.textContent = tool.ok ? `完成${took ? ` · ${took}` : ''}` : '失败'
        }
        const body = card.querySelector<HTMLElement>('.tool-body')
        if (body) {
          body.textContent = tool.summary ?? ''
          body.hidden = tool.ok === true
        }
        msg.toolBox.appendChild(card)
      }

      paintBody(msg)
      messages.push(msg)
    }

    if (messages.length === 0) renderEmpty()
    scrollToBottom(true)
    updateScrollButton()
  }

  async function restoreLast(): Promise<void> {
    try {
      const list = await window.th.sessions.list()
      const newest = list[0]
      if (!newest) return
      const session = await window.th.sessions.load(newest.id)
      if (session && session.messages.length > 0) restore(session)
    } catch {
      /* 恢复失败就当新会话 */
    }
  }

  /* ---------------- 历史会话菜单 ---------------- */

  const historyBtn = document.getElementById('ai-history') as HTMLButtonElement | null
  const historyMenu = document.getElementById('ai-history-menu') as HTMLDivElement | null

  function closeHistory(): void {
    if (historyMenu) historyMenu.hidden = true
  }

  async function openHistory(): Promise<void> {
    if (!historyMenu) return
    if (!historyMenu.hidden) {
      closeHistory()
      return
    }

    const list = await window.th.sessions.list().catch(() => [] as SessionSummary[])
    historyMenu.textContent = ''

    if (list.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'history-empty'
      empty.textContent = '还没有历史会话'
      historyMenu.appendChild(empty)
    }

    for (const item of list) {
      const row = document.createElement('button')
      row.className = 'history-item'
      if (item.id === sessionId) row.classList.add('current')

      const title = document.createElement('span')
      title.className = 'history-title'
      title.textContent = item.title

      const meta = document.createElement('span')
      meta.className = 'history-meta'
      const date = new Date(item.updatedAt)
      meta.textContent = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(
        date.getMinutes()
      ).padStart(2, '0')} · ${item.messageCount} 条`

      const del = document.createElement('span')
      del.className = 'history-del'
      del.textContent = '×'
      del.title = '删除该会话'
      del.addEventListener('click', (event) => {
        event.stopPropagation()
        void window.th.sessions.delete(item.id).then(() => {
          if (item.id === sessionId) reset()
          void openHistory()
        })
      })

      row.append(title, meta, del)
      row.addEventListener('click', () => {
        void window.th.sessions.load(item.id).then((session) => {
          if (session) restore(session)
          closeHistory()
        })
      })
      historyMenu.appendChild(row)
    }

    historyMenu.hidden = false
  }

  historyBtn?.addEventListener('click', () => void openHistory())
  document.addEventListener('mousedown', (event) => {
    if (!historyMenu || historyMenu.hidden) return
    const target = event.target as Node
    if (!historyMenu.contains(target) && !historyBtn?.contains(target)) closeHistory()
  })

  /* ---------------- 模型选择器 ---------------- */

  const modelBtn = document.getElementById('ai-model') as HTMLButtonElement
  const modelMenu = document.getElementById('ai-model-menu') as HTMLDivElement
  const modelFilter = document.getElementById('model-filter') as HTMLInputElement
  const modelListEl = document.getElementById('model-list') as HTMLDivElement

  let allModels: string[] = []
  let currentModel = ''

  function closeModelMenu(): void {
    modelMenu.hidden = true
  }

  function renderModelList(filter = ''): void {
    const needle = filter.trim().toLowerCase()
    const items = allModels.filter((name) => !needle || name.toLowerCase().includes(needle)).slice(0, 300)
    modelListEl.textContent = ''

    if (items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'model-empty'
      empty.textContent = '没有匹配的模型'
      modelListEl.appendChild(empty)
      return
    }

    for (const name of items) {
      const row = document.createElement('button')
      row.className = name === currentModel ? 'model-item current' : 'model-item'

      const label = document.createElement('span')
      label.textContent = name
      row.appendChild(label)

      if (name === currentModel) {
        const tick = document.createElement('span')
        tick.className = 'tick'
        tick.textContent = '✓'
        row.appendChild(tick)
      }

      row.addEventListener('click', () => void pickModel(name))
      modelListEl.appendChild(row)
    }
  }

  async function pickModel(name: string): Promise<void> {
    try {
      await window.th.config.patch({ llmModel: name })
      deps.onModelChanged?.(name)
      currentModel = name
      modelBtn.textContent = name
      modelBtn.title = `当前模型：${name}（点击切换）`
      closeModelMenu()
    } catch (err) {
      deps.onError(err instanceof Error ? err.message : String(err))
    }
  }

  async function openModelMenu(): Promise<void> {
    if (!modelReady) {
      deps.onNeedConfig()
      return
    }
    if (!modelMenu.hidden) {
      closeModelMenu()
      return
    }
    closeHistory()
    currentModel = modelBtn.textContent?.trim() ?? ''
    modelFilter.value = ''
    modelListEl.innerHTML = '<div class="model-empty">加载模型列表…</div>'
    modelMenu.hidden = false
    modelFilter.focus()

    const result = await window.th.ai.models().catch(() => ({ models: [], error: '请求失败' }))
    allModels = result.models
    renderModelList()
    if (result.error && result.models.length > 0) {
      const note = document.createElement('div')
      note.className = 'model-empty'
      note.textContent = `（列表接口异常，用内置清单：${result.error.slice(0, 40)}）`
      modelListEl.appendChild(note)
    }
  }

  // 勾了却没内容时给个提示，避免"勾了好像没生效"的困惑
  ctxSelection.addEventListener('change', () => {
    if (ctxSelection.checked && !deps.getSelectionText().trim()) {
      deps.onError('编辑器里没有选中文字，这一项不会附加内容')
    }
  })
  ctxFile.addEventListener('change', () => {
    if (!ctxFile.checked) return
    const file = deps.getActiveFile()
    if (!file || !file.content.trim()) deps.onError('当前没有打开的文件，这一项不会附加内容')
  })

  modelBtn.addEventListener('click', () => void openModelMenu())
  modelFilter.addEventListener('input', () => renderModelList(modelFilter.value))
  modelMenu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModelMenu()
  })
  document.addEventListener('mousedown', (event) => {
    if (modelMenu.hidden) return
    const target = event.target as Node
    if (!modelMenu.contains(target) && !modelBtn.contains(target)) closeModelMenu()
  })

  setupTurnRail()

  return { init, focus, pushSelection, reset, restoreLast, refreshModel }
}
