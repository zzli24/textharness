import type { ApprovalRequest } from '../../shared/types'
import { createModal } from './dialogs'
import { diffLines } from './diffView'

/**
 * 写入确认：主进程准备改动某个文件时，先在这里把 diff 摊开给用户看。
 * 返回 true 才真的落盘。
 */
export function requestApproval(request: ApprovalRequest): Promise<boolean> {
  return new Promise((resolve) => {
    const parts = createModal('agent 想修改文件', { tall: true })
    parts.root.querySelector<HTMLElement>('.modal')?.classList.add('cmp-modal')

    const head = document.createElement('div')
    head.className = 'approval-head'
    const file = document.createElement('div')
    file.className = 'approval-path'
    file.textContent = request.path
    const summary = document.createElement('div')
    summary.className = 'approval-summary'
    summary.textContent = request.summary
    head.append(file, summary)

    const body = document.createElement('div')
    body.className = 'approval-body'

    const before = request.before.split('\n')
    const after = request.after.split('\n')
    const rows = diffLines(before, after)

    let added = 0
    let removed = 0
    for (const row of rows) {
      if (row.kind === 'add') added += 1
      else if (row.kind === 'del') removed += 1
      else if (row.kind === 'mod') {
        added += 1
        removed += 1
      }
    }

    const stats = document.createElement('div')
    stats.className = 'cmp-stats'
    stats.append(
      Object.assign(document.createElement('span'), {
        className: 'cmp-chip add',
        textContent: `+${added}`,
      }),
      Object.assign(document.createElement('span'), {
        className: 'cmp-chip del',
        textContent: `-${removed}`,
      })
    )

    // 只渲染有变化的行附近，避免整篇 diff 太长
    const keep: typeof rows = []
    let gap = 0
    rows.forEach((row, index) => {
      const changed = row.kind !== 'same'
      if (changed) {
        gap = 0
        keep.push(row)
        return
      }
      gap += 1
      const nearChange =
        rows[index - 1]?.kind !== 'same' || rows[index + 1]?.kind !== 'same'
      if (nearChange) {
        gap = 0
        keep.push(row)
        return
      }
      if (gap === 3) {
        keep.push({ kind: 'same', leftText: '…', rightText: '…' })
      }
    })

    const list = document.createElement('div')
    list.className = 'cmp-rows'
    for (const row of keep) {
      const line = document.createElement('div')
      line.className = `cmp-row ${row.kind}`
      const left = document.createElement('div')
      left.className = 'cmp-cell'
      left.append(
        Object.assign(document.createElement('span'), {
          className: 'cmp-ln',
          textContent: row.leftNo ? String(row.leftNo) : '',
        }),
        Object.assign(document.createElement('span'), { className: 'cmp-tx', textContent: row.leftText ?? '' })
      )
      const right = document.createElement('div')
      right.className = 'cmp-cell'
      right.append(
        Object.assign(document.createElement('span'), {
          className: 'cmp-ln',
          textContent: row.rightNo ? String(row.rightNo) : '',
        }),
        Object.assign(document.createElement('span'), { className: 'cmp-tx', textContent: row.rightText ?? '' })
      )
      line.append(left, right)
      list.appendChild(line)
    }
    body.appendChild(list)

    const hint = document.createElement('div')
    hint.className = 'approval-hint'
    hint.textContent = '左侧是原文件，右侧是改动后。确认后会先备份到 .history/ 再写入。'

    parts.body.append(head, stats, body, hint)

    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey, true)
      parts.close()
      resolve(ok)
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        finish(true)
      }
    }
    document.addEventListener('keydown', onKey, true)

    const deny = document.createElement('button')
    deny.className = 'btn'
    deny.textContent = '拒绝'
    deny.addEventListener('click', () => finish(false))

    const allow = document.createElement('button')
    allow.className = 'btn primary'
    allow.textContent = '允许写入'
    allow.addEventListener('click', () => finish(true))

    parts.foot.append(deny, allow)
    allow.focus()
  })
}
