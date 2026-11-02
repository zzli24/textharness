import { createModal } from './dialogs'

/* ------------------------------------------------------------------ */
/* 行级文本对比                                                         */
/* ------------------------------------------------------------------ */

export interface DiffRow {
  kind: 'same' | 'add' | 'del' | 'mod'
  leftNo?: number
  leftText?: string
  rightNo?: number
  rightText?: string
}

/** LCS 上限：超过就退化为逐行比较，避免大文件卡死界面 */
const MAX_CELLS = 4_000_000

/**
 * 逐行对比。返回按"视觉行"对齐的结果：
 * 删除的行和新增的行会尽量配成一对（mod），这样左右两栏能对齐。
 */
export function diffLines(left: string[], right: string[]): DiffRow[] {
  const n = left.length
  const m = right.length

  if ((n + 1) * (m + 1) > MAX_CELLS) {
    // 太大的文件：只做等长逐行比对
    const rows: DiffRow[] = []
    for (let i = 0; i < Math.max(n, m); i += 1) {
      const l = left[i]
      const r = right[i]
      if (l === r) rows.push({ kind: 'same', leftNo: i + 1, leftText: l, rightNo: i + 1, rightText: r })
      else if (l === undefined) rows.push({ kind: 'add', rightNo: i + 1, rightText: r })
      else if (r === undefined) rows.push({ kind: 'del', leftNo: i + 1, leftText: l })
      else rows.push({ kind: 'mod', leftNo: i + 1, leftText: l, rightNo: i + 1, rightText: r })
    }
    return rows
  }

  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        left[i] === right[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }

  const ops: Array<{ type: 'same' | 'del' | 'add'; i: number; j: number }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      ops.push({ type: 'same', i, j })
      i += 1
      j += 1
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ type: 'del', i, j })
      i += 1
    } else {
      ops.push({ type: 'add', i, j })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ type: 'del', i, j })
    i += 1
  }
  while (j < m) {
    ops.push({ type: 'add', i, j })
    j += 1
  }

  // 把相邻的 del/add 配成 mod，左右行号对齐
  const rows: DiffRow[] = []
  let k = 0
  while (k < ops.length) {
    const op = ops[k]
    if (op.type === 'same') {
      rows.push({ kind: 'same', leftNo: op.i + 1, leftText: left[op.i], rightNo: op.j + 1, rightText: right[op.j] })
      k += 1
      continue
    }
    const dels: number[] = []
    const adds: number[] = []
    while (k < ops.length && ops[k].type !== 'same') {
      if (ops[k].type === 'del') dels.push(ops[k].i)
      else adds.push(ops[k].j)
      k += 1
    }
    const count = Math.max(dels.length, adds.length)
    for (let t = 0; t < count; t += 1) {
      const li = dels[t]
      const ri = adds[t]
      if (li !== undefined && ri !== undefined) {
        rows.push({ kind: 'mod', leftNo: li + 1, leftText: left[li], rightNo: ri + 1, rightText: right[ri] })
      } else if (li !== undefined) {
        rows.push({ kind: 'del', leftNo: li + 1, leftText: left[li] })
      } else if (ri !== undefined) {
        rows.push({ kind: 'add', rightNo: ri + 1, rightText: right[ri] })
      }
    }
  }
  return rows
}

/* ------------------------------------------------------------------ */
/* 对比窗口                                                             */
/* ------------------------------------------------------------------ */

function buildCell(no: number | undefined, text: string | undefined): HTMLElement {
  const cell = document.createElement('div')
  cell.className = 'cmp-cell'
  const num = document.createElement('span')
  num.className = 'cmp-ln'
  num.textContent = no ? String(no) : ''
  const body = document.createElement('span')
  body.className = 'cmp-tx'
  body.textContent = text ?? ''
  cell.append(num, body)
  return cell
}

export interface OpenDiffOptions {
  leftText?: string
  rightText?: string
  leftName?: string
  rightName?: string
}

export function openDiff(options: OpenDiffOptions = {}): void {
  let leftText = options.leftText ?? ''
  let rightText = options.rightText ?? ''
  let leftName = options.leftName ?? '原始文本'
  let rightName = options.rightName ?? '更改后文本'
  let mode: 'edit' | 'diff' = leftText || rightText ? 'diff' : 'edit'

  const parts = createModal('文本对比', { tall: true })
  parts.root.querySelector<HTMLElement>('.modal')?.classList.add('cmp-modal')

  const head = document.createElement('div')
  head.className = 'cmp-head'

  const makeHead = (): void => {
    head.textContent = ''
    for (const side of ['left', 'right'] as const) {
      const box = document.createElement('div')
      box.className = 'cmp-head-side'
      const label = document.createElement('span')
      label.className = 'cmp-head-name'
      label.textContent = side === 'left' ? leftName : rightName
      const open = document.createElement('button')
      open.className = 'cmp-open'
      open.textContent = '打开文件'
      open.addEventListener('click', () => void openFile(side))
      box.append(label, open)
      head.appendChild(box)
    }
  }

  const body = document.createElement('div')
  body.className = 'cmp-body'

  const stats = document.createElement('div')
  stats.className = 'cmp-stats'

  const tool = document.createElement('div')
  tool.className = 'cmp-tool'

  const editBtn = document.createElement('button')
  editBtn.className = 'btn'
  editBtn.textContent = '返回编辑'
  editBtn.addEventListener('click', () => {
    mode = 'edit'
    render()
  })

  const diffBtn = document.createElement('button')
  diffBtn.className = 'btn primary'
  diffBtn.textContent = '开始对比'
  diffBtn.addEventListener('click', () => {
    leftText = leftArea.value
    rightText = rightArea.value
    mode = 'diff'
    render()
  })

  /* 关闭：按钮 / Esc / 点遮罩 三种方式 */
  const closeBtn = document.createElement('button')
  closeBtn.className = 'btn'
  closeBtn.textContent = '关闭对比'
  closeBtn.style.marginRight = 'auto'
  closeBtn.addEventListener('click', () => close())

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  function close(): void {
    document.removeEventListener('keydown', onKey, true)
    parts.root.removeEventListener('mousedown', onBackdrop)
    parts.close()
  }

  function onBackdrop(event: MouseEvent): void {
    if (event.target === parts.root) close()
  }

  document.addEventListener('keydown', onKey, true)
  parts.root.addEventListener('mousedown', onBackdrop as EventListener)

  parts.body.append(head, stats, body, tool)
  parts.foot.append(closeBtn, editBtn, diffBtn)

  const leftArea = document.createElement('textarea')
  leftArea.className = 'cmp-input'
  leftArea.placeholder = '粘贴或在这里输入原始文本…'
  leftArea.value = leftText

  const rightArea = document.createElement('textarea')
  rightArea.className = 'cmp-input'
  rightArea.placeholder = '粘贴或在这里输入修改后的文本…'
  rightArea.value = rightText

  async function openFile(side: 'left' | 'right'): Promise<void> {
    const path = await window.th.fs.pickOpen()
    if (!path) return
    const file = await window.th.fs.read(path)
    const name = path.split(/[\\/]/).pop() ?? path
    if (side === 'left') {
      leftText = file.text
      leftName = name
    } else {
      rightText = file.text
      rightName = name
    }
    mode = 'diff'
    render()
  }

  function render(): void {
    makeHead()
    body.textContent = ''
    stats.textContent = ''
    tool.textContent = ''

    if (mode === 'edit') {
      const wrap = document.createElement('div')
      wrap.className = 'cmp-edit'
      wrap.append(leftArea, rightArea)
      body.appendChild(wrap)
      diffBtn.style.display = ''
      editBtn.style.display = 'none'
      return
    }

    const rows = diffLines(leftText.split('\n'), rightText.split('\n'))
    let same = 0
    let added = 0
    let removed = 0
    for (const row of rows) {
      if (row.kind === 'same') same += 1
      else if (row.kind === 'add') added += 1
      else if (row.kind === 'del') removed += 1
      else {
        added += 1
        removed += 1
      }
    }
    stats.append(
      Object.assign(document.createElement('span'), { className: 'cmp-chip', textContent: `相同 ${same} 行` }),
      Object.assign(document.createElement('span'), { className: 'cmp-chip add', textContent: `新增 ${added} 行` }),
      Object.assign(document.createElement('span'), { className: 'cmp-chip del', textContent: `删除 ${removed} 行` })
    )
    if (added === 0 && removed === 0) {
      stats.appendChild(
        Object.assign(document.createElement('span'), { className: 'cmp-chip same', textContent: '两边完全一致' })
      )
    }

    const list = document.createElement('div')
    list.className = 'cmp-rows'
    const frag = document.createDocumentFragment()
    for (const row of rows) {
      const line = document.createElement('div')
      line.className = `cmp-row ${row.kind}`
      line.append(buildCell(row.leftNo, row.leftText), buildCell(row.rightNo, row.rightText))
      frag.appendChild(line)
    }
    list.appendChild(frag)
    body.appendChild(list)

    diffBtn.style.display = 'none'
    editBtn.style.display = ''
  }

  render()
}
