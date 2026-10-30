import type { AccessRequest, ApprovalRequest, ScriptRequest } from '../../shared/types'
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

/**
 * agent 想访问工作区外的文件：问一次权限。
 * 允许后本次会话记住，同一文件后续不再打扰。
 */
export function requestAccess(request: AccessRequest): Promise<'deny' | 'read' | 'write'> {
  return new Promise((resolve) => {
    const parts = createModal(request.mode === 'write' ? 'agent 想修改工作区外的文件' : 'agent 想读取工作区外的文件')
    parts.root.querySelector<HTMLElement>('.modal')?.classList.add('access-modal')

    const head = document.createElement('div')
    head.className = 'approval-head'
    const file = document.createElement('div')
    file.className = 'approval-path'
    file.textContent = request.path
    const hint = document.createElement('div')
    hint.className = 'approval-summary'
    hint.textContent =
      request.mode === 'write'
        ? '这个文件不在工作区里。允许后 agent 可以读它、也可以写入修改。'
        : '这个文件不在工作区里。允许后 agent 只能读取内容，不能改。'
    head.append(file, hint)

    const note = document.createElement('div')
    note.className = 'hint'
    note.textContent = '授权只在本次运行有效；关掉程序或换文件会重新询问。AI 不会因此获得工作区外其它文件的访问权。'

    parts.body.append(head, note)

    const deny = document.createElement('button')
    deny.className = 'btn'
    deny.textContent = '拒绝'
    const readOnly = document.createElement('button')
    readOnly.className = 'btn'
    readOnly.textContent = '仅允许读取'
    const allowWrite = document.createElement('button')
    allowWrite.className = 'btn primary'
    allowWrite.textContent = request.mode === 'write' ? '允许读取和修改' : '允许读取'
    if (request.mode === 'read') readOnly.style.display = 'none'
    parts.foot.append(deny, readOnly, allowWrite)

    const finish = (decision: 'deny' | 'read' | 'write'): void => {
      parts.close()
      resolve(decision)
    }

    deny.addEventListener('click', () => finish('deny'))
    readOnly.addEventListener('click', () => finish('read'))
    // 只读申请时主按钮就是"允许读取"，别错给成读写权限
    allowWrite.addEventListener('click', () => finish(request.mode === 'write' ? 'write' : 'read'))
    parts.root.addEventListener('mousedown', (event) => {
      if (event.target === parts.root) finish('deny')
    })
    document.addEventListener(
      'keydown',
      function onKey(event) {
        if (event.key === 'Escape') {
          document.removeEventListener('keydown', onKey, true)
          finish('deny')
        }
      },
      true
    )
  })
}

/**
 * agent 想跑一段脚本：把源码摊开给用户看，点了才执行。
 * 脚本以用户身份运行，能读写任何文件——所以必须有人看着。
 */
export function requestScriptApproval(request: ScriptRequest): Promise<boolean> {
  return new Promise((resolve) => {
    const parts = createModal('agent 想运行一段脚本')
    parts.root.querySelector<HTMLElement>('.modal')?.classList.add('access-modal')

    const head = document.createElement('div')
    head.className = 'approval-head'
    const pathEl = document.createElement('div')
    pathEl.className = 'approval-path'
    pathEl.textContent = request.scriptPath
    const hint = document.createElement('div')
    hint.className = 'approval-summary'
    hint.textContent = `超时 ${Math.round(request.timeoutMs / 1000)} 秒。脚本以你的身份运行，能读写这台机器上你有权限的任何文件，请先看清楚再点运行。`
    head.append(pathEl, hint)

    const pre = document.createElement('pre')
    pre.className = 'script-preview'
    pre.textContent = request.code.length > 20_000 ? `${request.code.slice(0, 20_000)}\n…（脚本太长，已截断显示）` : request.code

    parts.body.append(head, pre)

    const deny = document.createElement('button')
    deny.className = 'btn'
    deny.textContent = '拒绝'
    const allow = document.createElement('button')
    allow.className = 'btn primary'
    allow.textContent = '运行'
    parts.foot.append(deny, allow)

    const finish = (ok: boolean): void => {
      parts.close()
      resolve(ok)
    }
    deny.addEventListener('click', () => finish(false))
    allow.addEventListener('click', () => finish(true))
    parts.root.addEventListener('mousedown', (event) => {
      if (event.target === parts.root) finish(false)
    })
    document.addEventListener(
      'keydown',
      function onKey(event) {
        if (event.key === 'Escape') {
          document.removeEventListener('keydown', onKey, true)
          finish(false)
        }
      },
      true
    )
  })
}
