import type { ArchiveRequest } from '@shared/types'

/**
 * 归档面板：聊天勾选、编辑器右键、AI 提议共用的唯一入口。
 *
 * 设计要点：
 *  - 写入前一定先看预览（标题/分类/目标/正文）
 *  - 目标可切：知识库（资料）/ 记忆（偏好·结论·模板）
 *  - 写完就地显示路径 + 撤销，不依赖 toast 的一闪而过
 */
export interface ArchivePrefill {
  target?: 'knowledge' | 'memory'
  title?: string
  content: string
  category?: string
  memoryKind?: 'fact' | 'log' | 'template'
  source?: string
}

export interface ArchivePanelDeps {
  toast(message: string): void
  /** 写入完成，或已提交为草稿时调用（用于清掉聊天里的勾选） */
  onWritten?(path?: string): void
}

let openPanel: HTMLElement | null = null

export function closeArchivePanel(): void {
  openPanel?.remove()
  openPanel = null
}

export function openArchivePanel(prefill: ArchivePrefill, deps: ArchivePanelDeps): void {
  closeArchivePanel()

  const overlay = document.createElement('div')
  overlay.className = 'overlay'
  const modal = document.createElement('div')
  modal.className = 'modal archive-modal'

  const head = document.createElement('div')
  head.className = 'archive-head'
  const titleEl = document.createElement('strong')
  titleEl.textContent = '归档'
  const sub = document.createElement('span')
  sub.className = 'archive-sub'
  sub.textContent = '知识库 = 你可查的资料；记忆 = 模型随身带的上下文。写入前可以先改标题和分类。'
  const spacer = document.createElement('span')
  spacer.style.flex = '1'
  const closeBtn = document.createElement('button')
  closeBtn.className = 'icon-btn'
  closeBtn.textContent = '✕'
  closeBtn.addEventListener('click', () => closeArchivePanel())
  head.append(titleEl, sub, spacer, closeBtn)

  const body = document.createElement('div')
  body.className = 'archive-body'

  /* 目标 */
  const targetRow = document.createElement('div')
  targetRow.className = 'archive-row'
  const targetLabel = document.createElement('label')
  targetLabel.textContent = '存到'
  const seg = document.createElement('div')
  seg.className = 'archive-seg'
  const segKnowledge = document.createElement('button')
  segKnowledge.type = 'button'
  segKnowledge.textContent = '知识库'
  const segMemory = document.createElement('button')
  segMemory.type = 'button'
  segMemory.textContent = '记忆'
  seg.append(segKnowledge, segMemory)
  targetRow.append(targetLabel, seg)

  /* 标题 */
  const titleRow = document.createElement('div')
  titleRow.className = 'archive-row'
  const titleLabel = document.createElement('label')
  titleLabel.textContent = '标题'
  const titleInput = document.createElement('input')
  titleInput.className = 'archive-input'
  titleInput.value = prefill.title ?? ''
  titleInput.placeholder = '会用作文件名'
  titleRow.append(titleLabel, titleInput)

  /* 分类（知识库）：树形选择器，支持多级 + 新建 */
  const categoryRow = document.createElement('div')
  categoryRow.className = 'archive-row'
  const categoryLabel = document.createElement('label')
  categoryLabel.textContent = '分类'
  const categoryWrap = document.createElement('div')
  categoryWrap.className = 'archive-inline category-picker'
  const categoryBtn = document.createElement('button')
  categoryBtn.type = 'button'
  categoryBtn.className = 'archive-input category-btn'
  categoryBtn.textContent = '未分类'
  const categoryPanel = document.createElement('div')
  categoryPanel.className = 'cat-tree'
  categoryPanel.hidden = true

  const catTreeList = document.createElement('div')
  catTreeList.className = 'cat-tree-list'
  const catNewRow = document.createElement('div')
  catNewRow.className = 'cat-tree-new'
  const categoryNew = document.createElement('input')
  categoryNew.className = 'archive-input'
  categoryNew.placeholder = '新建分类，可用 a/b 建二级'
  const catNewBtn = document.createElement('button')
  catNewBtn.type = 'button'
  catNewBtn.className = 'btn small'
  catNewBtn.textContent = '新建'
  catNewRow.append(categoryNew, catNewBtn)
  categoryPanel.append(catTreeList, catNewRow)
  categoryWrap.append(categoryBtn, categoryPanel)
  categoryRow.append(categoryLabel, categoryWrap)

  let selectedCategory = ''

  /* 记忆类型 */
  const kindRow = document.createElement('div')
  kindRow.className = 'archive-row'
  const kindLabel = document.createElement('label')
  kindLabel.textContent = '记忆类型'
  const kindSelect = document.createElement('select')
  kindSelect.className = 'archive-input'
  for (const [value, text] of [
    ['fact', '长期事实（每轮注入，≤200 字）'],
    ['log', '会话结论（只注入最近几条）'],
    ['template', '模板（不进上下文）'],
  ] as Array<[string, string]>) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = text
    kindSelect.appendChild(option)
  }
  kindRow.append(kindLabel, kindSelect)

  /* 正文预览 */
  const contentRow = document.createElement('div')
  contentRow.className = 'archive-row archive-row-top'
  const contentLabel = document.createElement('label')
  contentLabel.textContent = '内容'
  const contentArea = document.createElement('textarea')
  contentArea.className = 'archive-area'
  contentArea.value = prefill.content
  contentArea.spellcheck = false
  contentRow.append(contentLabel, contentArea)

  /* 方式：新建 / 追加到已有 */
  const mergeRow = document.createElement('div')
  mergeRow.className = 'archive-row'
  const mergeLabel = document.createElement('label')
  mergeLabel.textContent = '方式'
  const mergeWrap = document.createElement('div')
  mergeWrap.className = 'archive-inline'
  const mergeSelect = document.createElement('select')
  mergeSelect.className = 'archive-input'
  for (const [value, text] of [
    ['new', '新建文档'],
    ['merge', '追加到已有文档'],
  ] as Array<[string, string]>) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = text
    mergeSelect.appendChild(option)
  }
  const noteSelect = document.createElement('select')
  noteSelect.className = 'archive-input'
  noteSelect.hidden = true
  mergeWrap.append(mergeSelect, noteSelect)
  mergeRow.append(mergeLabel, mergeWrap)

  // 文档列表缓存；按当前分类过滤（MySQL → 只显示 知识库/MySQL/*.md）
  let allNotes: string[] = []
  const currentCategory = (): string => selectedCategory.trim()

  const renderNotes = (): void => {
    const category = currentCategory()
    const filtered = category
      ? allNotes.filter((note) => note.startsWith(`知识库/${category}/`))
      : allNotes
    noteSelect.textContent = ''
    if (filtered.length === 0) {
      const option = document.createElement('option')
      option.value = ''
      option.textContent = category ? `${category} 分类下还没有文档` : '还没有任何文档'
      noteSelect.appendChild(option)
    } else {
      for (const note of filtered) {
        const option = document.createElement('option')
        option.value = note
        option.textContent = note.replace(/^知识库\//, '')
        noteSelect.appendChild(option)
      }
    }
    void refreshInsertOptions()
    updateMeta()
  }

  const refreshInsertOptions = async (): Promise<void> => {
    resetInsertOptions()
    const merging = mergeSelect.value === 'merge'
    insertRow.hidden = !merging
    const note = noteSelect.value
    if (!merging || !note) return
    const result = await window.th.archive.headings(note)
    if (!result.ok) return
    for (const heading of result.headings) {
      const option = document.createElement('option')
      option.value = String(heading.line)
      option.textContent = `${'　'.repeat(Math.max(0, heading.level - 1))}${heading.text}`
      insertSelect.appendChild(option)
    }
  }

  void window.th.archive.notes().then((notes) => {
    allNotes = notes
    renderNotes()
  })

  mergeSelect.addEventListener('change', () => {
    const merging = mergeSelect.value === 'merge'
    noteSelect.hidden = !merging
    // 追加模式下分类仍然有用：它决定文档列表的范围
    categoryRow.hidden = target !== 'knowledge'
    if (merging) renderNotes()
    updateMeta()
  })

  noteSelect.addEventListener('change', () => void refreshInsertOptions())
  categoryNew.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      catNewBtn.click()
    }
  })

  /* 插入位置（仅追加模式） */
  const insertRow = document.createElement('div')
  insertRow.className = 'archive-row'
  insertRow.hidden = true
  const insertLabel = document.createElement('label')
  insertLabel.textContent = '插入位置'
  const insertSelect = document.createElement('select')
  insertSelect.className = 'archive-input'
  const resetInsertOptions = (): void => {
    insertSelect.textContent = ''
    const end = document.createElement('option')
    end.value = ''
    end.textContent = '文末'
    insertSelect.appendChild(end)
  }
  resetInsertOptions()
  insertRow.append(insertLabel, insertSelect)

  /* 先总结 */
  const summarizeBox = document.createElement('label')
  summarizeBox.className = 'archive-check'
  const summarizeInput = document.createElement('input')
  summarizeInput.type = 'checkbox'
  summarizeInput.checked = true
  const summarizeText = document.createElement('span')
  summarizeText.textContent = '先让 AI 总结，后台生成草稿再确认（推荐）'
  summarizeBox.append(summarizeInput, summarizeText)

  const meta = document.createElement('div')
  meta.className = 'archive-meta'

  body.append(targetRow, titleRow, categoryRow, mergeRow, insertRow, kindRow, contentRow, summarizeBox, meta)

  const foot = document.createElement('div')
  foot.className = 'archive-foot'
  const hint = document.createElement('span')
  hint.className = 'archive-hint'
  const cancel = document.createElement('button')
  cancel.className = 'btn'
  cancel.textContent = '取消'
  cancel.addEventListener('click', () => closeArchivePanel())
  const submit = document.createElement('button')
  submit.className = 'btn primary'
  submit.textContent = '写入'
  foot.append(hint, cancel, submit)

  modal.append(head, body, foot)
  overlay.appendChild(modal)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeArchivePanel()
  })
  document.body.appendChild(overlay)
  openPanel = overlay

  /* ---- 状态与渲染 ---- */
  let target: 'knowledge' | 'memory' = prefill.target ?? 'knowledge'
  let categories: string[] = []

  const renderTarget = (): void => {
    segKnowledge.classList.toggle('on', target === 'knowledge')
    segMemory.classList.toggle('on', target === 'memory')
    categoryRow.hidden = target !== 'knowledge'
    kindRow.hidden = target !== 'memory'
    // 追加只对知识库有意义
    if (mergeRow) mergeRow.hidden = target !== 'knowledge'
    if (target === 'memory') kindSelect.value = prefill.memoryKind ?? 'log'
    updateMeta()
  }

  const updateMeta = (): void => {
    const chars = contentArea.value.length
    meta.textContent = `${contentArea.value.split('\n').length} 行 · ${chars} 字符${
      target === 'memory' && kindSelect.value === 'fact' && chars > 200 ? ' · 超过 200 字，长期记忆装不下' : ''
    }`
    hint.textContent =
      mergeSelect.value === 'merge'
        ? `会${insertSelect.value === '' ? '追加到文末' : '插入到选中章节之后'} → ${noteSelect.value || '（选一篇文档）'}`
        : target === 'knowledge'
          ? '会写入 知识库/<分类>/<标题>.md'
          : `会写入 记忆/${kindSelect.value === 'template' ? '模板' : kindSelect.value === 'log' ? '日志' : 'MEMORY.md'}`
  }

  const applyCategory = (value: string): void => {
    selectedCategory = value.trim()
    categoryBtn.textContent = selectedCategory || '未分类'
    categoryBtn.title = selectedCategory ? `知识库/${selectedCategory}` : '会写到 知识库/未分类/'
    categoryPanel.hidden = true
    renderNotes()
    updateMeta()
  }

  /** 把 a、a/b、a/b/c 画成带缩进的树 */
  const renderCategoryTree = (): void => {
    catTreeList.textContent = ''
    const nodes = new Map<string, string[]>()
    for (const path of categories) {
      const parts = path.split('/')
      const parent = parts.slice(0, -1).join('/')
      const list = nodes.get(parent) ?? []
      list.push(path)
      nodes.set(parent, list)
    }
    const walk = (parent: string, depth: number): void => {
      for (const path of nodes.get(parent) ?? []) {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = path === selectedCategory ? 'cat-node active' : 'cat-node'
        row.style.paddingLeft = `${8 + depth * 14}px`
        const name = path.split('/').pop() ?? path
        row.textContent = depth === 0 ? name : `└ ${name}`
        row.title = `知识库/${path}`
        row.addEventListener('click', () => applyCategory(path))
        catTreeList.appendChild(row)
        walk(path, depth + 1)
      }
    }
    const root = document.createElement('button')
    root.type = 'button'
    root.className = selectedCategory === '' ? 'cat-node active' : 'cat-node'
    root.textContent = '未分类'
    root.addEventListener('click', () => applyCategory(''))
    catTreeList.appendChild(root)
    walk('', 0)
    if (categories.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'cat-tree-empty'
      empty.textContent = '还没有分类，下面新建一个'
      catTreeList.appendChild(empty)
    }
  }

  categoryBtn.addEventListener('click', () => {
    categoryPanel.hidden = !categoryPanel.hidden
    if (!categoryPanel.hidden) {
      renderCategoryTree()
      categoryNew.focus()
    }
  })
  catNewBtn.addEventListener('click', () => {
    const value = categoryNew.value.trim()
    if (!value) return
    if (!categories.includes(value)) {
      categories.push(value)
      categories.sort()
    }
    categoryNew.value = ''
    applyCategory(value)
  })

  const loadCategories = async (): Promise<void> => {
    categories = await window.th.archive.categories()
    renderCategoryTree()
    const preset = prefill.category && categories.includes(prefill.category) ? prefill.category : categories[0]
    applyCategory(prefill.category || preset || '')
  }

  segKnowledge.addEventListener('click', () => {
    target = 'knowledge'
    renderTarget()
  })
  segMemory.addEventListener('click', () => {
    target = 'memory'
    renderTarget()
  })
  kindSelect.addEventListener('change', updateMeta)
  contentArea.addEventListener('input', updateMeta)
  titleInput.addEventListener('input', updateMeta)

  /* ---- 写入 ---- */
  submit.addEventListener('click', () => {
    const title = titleInput.value.trim() || '未命名'

    // 追加到已有文档：不勾「先总结」就只往文末追加；勾了就交给 AI 重组整篇（走草稿）
    if (mergeSelect.value === 'merge' && !summarizeInput.checked) {
      const section = contentArea.value.trim()
      const note = noteSelect.value
      if (!note) {
        deps.toast('先选一篇要追加的文档')
        return
      }
      if (!section) {
        deps.toast('内容为空，没什么可追加')
        return
      }
      submit.disabled = true
      const afterLine = insertSelect.value === '' ? undefined : Number(insertSelect.value)
      void window.th.archive
        .append(note, section, afterLine)
        .then((result) => {
          if (!result.ok) {
            submit.disabled = false
            deps.toast(result.text || '追加失败')
            return
          }
          deps.onWritten?.(result.path)
          body.querySelectorAll('input,select,textarea,button').forEach((el) => {
            ;(el as HTMLInputElement).disabled = true
          })
          const doneRow = document.createElement('div')
          doneRow.className = 'archive-done'
          const text = document.createElement('span')
          text.textContent = `已追加到 ${result.path}`
          const openBtn = document.createElement('button')
          openBtn.className = 'btn small'
          openBtn.textContent = '打开'
          openBtn.addEventListener('click', () => {
            document.dispatchEvent(new CustomEvent('th:open-path', { detail: { path: result.path }, bubbles: true }))
          })
          const undoBtn = document.createElement('button')
          undoBtn.className = 'btn small'
          undoBtn.textContent = '撤销'
          if (result.undo) {
            undoBtn.addEventListener('click', () => {
              void window.th.archive.undo(result.undo as NonNullable<typeof result.undo>).then((ok) => {
                deps.toast(ok ? '已撤销追加' : '撤销失败')
                closeArchivePanel()
              })
            })
          } else {
            undoBtn.disabled = true
          }
          doneRow.append(text, openBtn, undoBtn)
          foot.textContent = ''
          const closeBtnX = document.createElement('button')
          closeBtnX.className = 'btn'
          closeBtnX.textContent = '关闭'
          closeBtnX.addEventListener('click', () => closeArchivePanel())
          foot.append(doneRow, closeBtnX)
        })
        .catch((err: unknown) => {
          submit.disabled = false
          deps.toast(err instanceof Error ? err.message : String(err))
        })
      return
    }

    // 勾了「先让 AI 总结」：只创建草稿，后台总结完再让用户确认
    if (summarizeInput.checked) {
      const content = contentArea.value
      const category = selectedCategory.trim() || '未分类'
      const memoryKind = kindSelect.value as 'fact' | 'log' | 'template'
      if (target === 'memory' && memoryKind === 'fact' && content.length > 200) {
        deps.toast('长期事实最多 200 字，改成「会话结论」或「模板」再试')
        return
      }
      submit.disabled = true
      void window.th.archive
        .draftCreate({
          title,
          content,
          target,
          category: target === 'knowledge' ? category : undefined,
          memoryKind: target === 'memory' ? memoryKind : undefined,
          source: prefill.source ?? 'chat',
          mergeInto: mergeSelect.value === 'merge' && noteSelect.value ? noteSelect.value : undefined,
          summarize: true,
        })
        .then(() => {
          deps.toast('已提交，后台总结后会出现在「归档草稿」里')
          deps.onWritten?.()
          closeArchivePanel()
        })
        .catch((err: unknown) => {
          submit.disabled = false
          deps.toast(err instanceof Error ? err.message : String(err))
        })
      return
    }
    const request: ArchiveRequest = {
      target,
      title,
      content: contentArea.value,
      source: prefill.source ?? 'chat',
    }
    if (target === 'knowledge') {
      request.category = selectedCategory.trim() || '未分类'
    } else {
      request.memoryKind = kindSelect.value as 'fact' | 'log' | 'template'
      if (request.memoryKind === 'fact' && contentArea.value.length > 200) {
        deps.toast('长期事实最多 200 字，改成「会话结论」或「模板」再试')
        return
      }
    }

    submit.disabled = true
    void window.th.archive
      .write(request)
      .then((result) => {
        if (!result.ok) {
          deps.toast(result.text || '写入失败')
          return
        }
        deps.onWritten?.(result.path)
        body.querySelectorAll('input,select,textarea,button').forEach((el) => {
          ;(el as HTMLInputElement).disabled = true
        })
        const doneRow = document.createElement('div')
        doneRow.className = 'archive-done'
        const text = document.createElement('span')
        text.textContent = `已写入 ${result.path}`
        const openBtn = document.createElement('button')
        openBtn.className = 'btn small'
        openBtn.textContent = '打开'
        openBtn.addEventListener('click', () => {
          document.dispatchEvent(new CustomEvent('th:open-path', { detail: { path: result.path }, bubbles: true }))
        })
        const undoBtn = document.createElement('button')
        undoBtn.className = 'btn small'
        undoBtn.textContent = '撤销'
        if (result.undo) {
          undoBtn.addEventListener('click', () => {
            void window.th.archive.undo(result.undo as NonNullable<typeof result.undo>).then((ok) => {
              deps.toast(ok ? '已撤销' : '撤销失败')
              closeArchivePanel()
            })
          })
        } else {
          undoBtn.disabled = true
        }
        doneRow.append(text, openBtn, undoBtn)
        foot.textContent = ''
        const close = document.createElement('button')
        close.className = 'btn'
        close.textContent = '关闭'
        close.addEventListener('click', () => closeArchivePanel())
        foot.append(doneRow, close)
        submit.disabled = false
      })
      .catch((err: unknown) => {
        submit.disabled = false
        deps.toast(err instanceof Error ? err.message : String(err))
      })
  })

  renderTarget()
  void loadCategories()
  titleInput.focus()
  titleInput.select()
}
