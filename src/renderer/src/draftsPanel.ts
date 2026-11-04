/**
 * 归档草稿：列表 + 确认（对比/编辑）。
 *
 * 流程：归档面板里勾了「先让 AI 总结」→ 后台生成草稿 → 头部图标 badge 显示待确认数
 * → 点开这个面板 → 确认/编辑/丢弃。
 */
export interface DraftRecord {
  id: string
  status: 'running' | 'pending' | 'written' | 'discarded' | 'failed'
  title: string
  content: string
  target: 'knowledge' | 'memory'
  category?: string
  memoryKind?: 'fact' | 'log' | 'template'
  source: string
  mergeInto?: string
  mode?: 'append' | 'rewrite'
  baseContent?: string
  createdAt: number
  updatedAt: number
  error?: string
  summarized: boolean
}

import { openDiff } from './diffView'
import { confirmDialog } from './dialogs'

export interface DraftsDeps {
  toast(message: string): void
  onChanged(): void
}

const STATUS_TEXT: Record<DraftRecord['status'], string> = {
  running: '总结中…',
  pending: '待确认',
  written: '已写入',
  discarded: '已丢弃',
  failed: '失败',
}

export async function openDraftsPanel(deps: DraftsDeps): Promise<void> {
  const existing = document.getElementById('drafts-overlay')
  if (existing) {
    existing.remove()
    return
  }
  const { drafts } = await window.th.archive.draftList()

  const overlay = document.createElement('div')
  overlay.className = 'overlay'
  overlay.id = 'drafts-overlay'
  const modal = document.createElement('div')
  modal.className = 'modal drafts-modal'

  const head = document.createElement('div')
  head.className = 'drafts-head'
  const title = document.createElement('strong')
  title.textContent = '归档草稿'
  const sub = document.createElement('span')
  sub.className = 'drafts-sub'
  sub.textContent = '后台总结好的内容在这里确认；确认后才写进知识库/记忆。'
  const spacer = document.createElement('span')
  spacer.style.flex = '1'
  const close = document.createElement('button')
  close.className = 'icon-btn'
  close.textContent = '✕'
  close.addEventListener('click', () => overlay.remove())
  head.append(title, sub, spacer, close)

  const body = document.createElement('div')
  body.className = 'drafts-body'

  const visible = (drafts as DraftRecord[]).filter((d) => d.status !== 'written' && d.status !== 'discarded')
  if (visible.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'drafts-empty'
    empty.textContent = '没有待确认的草稿。归档时勾上「先让 AI 总结」就会出现在这里。'
    body.appendChild(empty)
  }

  for (const draft of visible) {
    const row = document.createElement('button')
    row.className = 'draft-row'
    const left = document.createElement('div')
    left.className = 'draft-main'
    const name = document.createElement('div')
    name.className = 'draft-title'
    name.textContent = draft.title || '未命名'
    const meta = document.createElement('div')
    meta.className = 'draft-meta'
    const where = draft.mergeInto
      ? `追加 → ${draft.mergeInto}`
      : draft.target === 'knowledge'
        ? `知识库/${draft.category ?? '未分类'}`
        : `记忆/${draft.memoryKind ?? 'log'}`
    meta.textContent = `${where} · ${STATUS_TEXT[draft.status]}${draft.error ? ` · ${draft.error}` : ''}`
    left.append(name, meta)
    const time = document.createElement('span')
    time.className = 'draft-time'
    time.textContent = new Date(draft.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    row.append(left, time)
    row.addEventListener('click', () => {
      overlay.remove()
      void openDraftReview(draft, deps)
    })
    body.appendChild(row)
  }

  modal.append(head, body)
  overlay.appendChild(modal)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove()
  })
  document.body.appendChild(overlay)
}

async function openDraftReview(draft: DraftRecord, deps: DraftsDeps): Promise<void> {
  const overlay = document.createElement('div')
  overlay.className = 'overlay'
  const modal = document.createElement('div')
  modal.className = 'modal draft-review'

  const head = document.createElement('div')
  head.className = 'drafts-head'
  const title = document.createElement('strong')
  title.textContent = '确认草稿'
  const sub = document.createElement('span')
  sub.className = 'drafts-sub'
  sub.textContent = draft.mergeInto
    ? draft.mode === 'rewrite'
      ? '下面是 AI 重组后的整篇文档，确认前可以看 diff、也可以直接改。'
      : '下面是准备追加的章节，确认后会接在目标文档末尾（可撤销）。'
    : draft.summarized
      ? '下面是 AI 总结的结果，可以直接改；确认后写入。'
      : '这次没有总结成功，下面是原文，确认后写入。'
  const spacer = document.createElement('span')
  spacer.style.flex = '1'
  const close = document.createElement('button')
  close.className = 'icon-btn'
  close.textContent = '✕'
  close.addEventListener('click', () => overlay.remove())
  head.append(title, sub, spacer, close)

  const body = document.createElement('div')
  body.className = 'draft-review-body'

  const titleInput = document.createElement('input')
  titleInput.className = 'archive-input'
  titleInput.value = draft.title

  const area = document.createElement('textarea')
  area.className = 'archive-area draft-review-area'
  area.value = draft.content
  area.spellcheck = false

  const where = document.createElement('div')
  where.className = 'draft-review-where'
  where.textContent = draft.mergeInto
    ? draft.mode === 'rewrite'
      ? `将按新结构覆盖 ${draft.mergeInto}`
      : `将追加到 ${draft.mergeInto}`
    : draft.target === 'knowledge'
      ? `将写入 知识库/${draft.category ?? '未分类'}/<标题>.md`
      : `将写入 记忆/${draft.memoryKind ?? 'log'}`

  body.append(titleInput, where, area)

  /** 追加模式下：拉原文，算合并结果，提供 diff */
  let originalText = ''
  const diffBar = document.createElement('div')
  diffBar.className = 'draft-diff-bar'
  const diffInfo = document.createElement('span')
  diffInfo.className = 'draft-diff-info'
  const diffBtn = document.createElement('button')
  diffBtn.className = 'btn small'
  diffBtn.textContent = '查看对比'
  diffBtn.disabled = true
  diffBar.append(diffInfo, diffBtn)
  body.appendChild(diffBar)

  // rewrite=草稿就是整篇新文档；append=原文 + 分隔符 + 新章节
  const mergedText = (): string =>
    draft.mode === 'rewrite' ? `${area.value.trim()}\n` : `${originalText.trimEnd()}\n\n---\n\n${area.value.trim()}\n`

  const refreshDiffInfo = (): void => {
    if (!draft.mergeInto) {
      diffBar.hidden = true
      return
    }
    diffBar.hidden = false
    const added = area.value.trim() ? area.value.trim().split('\n').length : 0
    const before = originalText ? originalText.split('\n').length : 0
    diffInfo.textContent =
      draft.mode === 'rewrite'
        ? `原文 ${before} 行 → 重组后 ${added} 行（覆盖写入）`
        : `原文 ${before} 行 → 追加 ${added} 行 → 共 ${before + added + 2} 行`
    diffBtn.disabled = !originalText
  }

  if (draft.mergeInto) {
    if (draft.mode === 'rewrite' && typeof draft.baseContent === 'string') {
      // 重组模式：草稿里已经存了原文，直接用
      originalText = draft.baseContent
      refreshDiffInfo()
    } else {
      void window.th.archive.noteContent(draft.mergeInto).then((result) => {
        originalText = result.ok ? result.text : ''
        refreshDiffInfo()
        if (!result.ok) diffInfo.textContent = `读不到目标文档：${result.text}`
      })
    }
  } else {
    diffBar.hidden = true
  }

  area.addEventListener('input', refreshDiffInfo)

  diffBtn.addEventListener('click', () => {
    openDiff({
      leftText: originalText,
      rightText: mergedText(),
      leftName: draft.mergeInto ?? '原文',
      rightName: `${draft.mergeInto ?? '目标'}（追加后）`,
    })
  })

  const foot = document.createElement('div')
  foot.className = 'archive-foot'
  const hint = document.createElement('span')
  hint.className = 'archive-hint'
  hint.textContent = draft.error ? `上次总结失败：${draft.error}` : ''
  const discard = document.createElement('button')
  discard.className = 'btn'
  discard.textContent = '丢弃'
  discard.addEventListener('click', () => {
    void window.th.archive.draftDiscard(draft.id).then(() => {
      overlay.remove()
      deps.toast('已丢弃')
      deps.onChanged()
    })
  })
  const regen = document.createElement('button')
  regen.className = 'btn'
  regen.textContent = '重新总结'
  regen.addEventListener('click', () => {
    regen.disabled = true
    hint.textContent = '重新总结中…'
    void window.th.archive.draftUpdate(draft.id, { title: titleInput.value, content: area.value }).then(() =>
      window.th.archive.draftRegenerate(draft.id).then((result) => {
        if (!result.ok) {
          hint.textContent = result.text ?? '重新总结失败'
          regen.disabled = false
          return
        }
        void window.th.archive.draftList().then((list) => {
          const fresh = (list.drafts as DraftRecord[]).find((item) => item.id === draft.id)
          if (fresh) {
            area.value = fresh.content
            hint.textContent = '已重新总结，检查后确认写入'
          }
          regen.disabled = false
          deps.onChanged()
        })
      })
    )
  })
  const confirm = document.createElement('button')
  confirm.className = 'btn primary'
  confirm.textContent = '确认写入'
  confirm.addEventListener('click', () => {
    confirm.disabled = true
    void window.th.archive
      .draftUpdate(draft.id, { title: titleInput.value.trim() || draft.title, content: area.value })
      .then(() => window.th.archive.draftConfirm(draft.id))
      .then(async (result) => {
        if (!result.ok && result.stale) {
          const choice = await confirmDialog({
            title: '目标文档已变化',
            message: '草稿生成之后，目标文档被修改过。',
            detail: '继续覆盖会丢掉这些新改动；建议先点「重新总结」让 AI 基于最新内容重组。',
            buttons: ['取消', '仍然覆盖'],
            defaultId: 0,
            cancelId: 0,
            primaryId: 1,
          })
          if (choice !== 1) {
            confirm.disabled = false
            return
          }
          const forced = await window.th.archive.draftConfirm(draft.id, true)
          if (!forced.ok) {
            deps.toast(forced.text ?? '写入失败')
            confirm.disabled = false
            return
          }
          overlay.remove()
          if (forced.path) {
            document.dispatchEvent(new CustomEvent('th:reload-path', { detail: forced.path, bubbles: true }))
          }
          deps.toast(`已写入 ${forced.path ?? ''}`)
          deps.onChanged()
          return
        }
        if (!result.ok) {
          deps.toast(result.text ?? '写入失败')
          confirm.disabled = false
          return
        }
        overlay.remove()
        deps.toast(`已写入 ${result.path ?? ''}`)
        deps.onChanged()
      })
      .catch((err: unknown) => {
        confirm.disabled = false
        deps.toast(err instanceof Error ? err.message : String(err))
      })
  })
  foot.append(hint, discard, regen, confirm)

  modal.append(head, body, foot)
  overlay.appendChild(modal)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove()
  })
  document.body.appendChild(overlay)
  area.focus()
}
