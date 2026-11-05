/**
 * CSV 表格视图：把 CSV/TSV 文本渲染成可编辑网格。
 *
 * 设计要点：表格只是"视图"，真正的文档内容仍然是 CSV 文本——
 * 单元格改动会序列化回文本，交给上层的 EditorState，
 * 这样保存、脏标记、会话恢复、文本对比全都不用改。
 *
 * 排序、合并、撤销这些容易出错的逻辑放在 gridModel.ts（纯数据，可单测），
 * 这里只负责 DOM 与交互。
 */

import {
  GridHistory,
  cloneRows,
  columnRange,
  emptyRow,
  insertColumn,
  insertRow,
  mergeSpans,
  removeColumnAt,
  removeRowAt,
  sortRows,
  type SortDir,
  type SortKey,
} from './gridModel'

/** 猜分隔符：, 或者制表符 */
export function detectDelimiter(text: string, hint?: string): ',' | '\t' | ';' {
  if (hint === '.tsv') return '\t'
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const commas = (firstLine.match(/,/g) ?? []).length
  const tabs = (firstLine.match(/\t/g) ?? []).length
  const semis = (firstLine.match(/;/g) ?? []).length
  if (tabs > commas && tabs >= semis) return '\t'
  if (semis > commas && semis > 0) return ';'
  return ','
}

/** 解析 CSV（支持引号包裹、双引号转义、字段内换行） */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  // 只去掉文件结尾多出来的那个空行，别把真正的空数据行吃掉
  if (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop()
  return rows.length > 0 ? rows : [['']]
}

/** 序列化回 CSV；只在必要时加引号 */
export function serializeCsv(rows: string[][], delimiter: string): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const needQuote =
            cell.includes(delimiter) || cell.includes('"') || cell.includes('\n') || cell.includes('\r')
          return needQuote ? `"${cell.replace(/"/g, '""')}"` : cell
        })
        .join(delimiter)
    )
    .join('\n')
}

export interface GridApi {
  /** 用新文本刷新网格（外部改动时调用） */
  setText(text: string): void
  /** 当前 CSV 文本 */
  getText(): string
  cellCount(): { rows: number; cols: number }
  addRow(): void
  addColumn(): void
  removeRow(index: number): void
  removeColumn(index: number): void
  focus(): void
  /** 撤销 / 重做：返回是否真的动了 */
  undo(): boolean
  redo(): boolean
  /** 按某列排序（append=true 时追加为次级排序键） */
  sortBy(col: number, dir: SortDir, append?: boolean): void
  /** 打开 / 关闭某列的显示合并 */
  mergeColumn(col: number): void
  /** 选中若干列（-1 表示清空） */
  selectColumns(cols: number[]): void
}

/** Markdown 表格 → 二维数组；不是表格返回 null */
export function markdownToRows(text: string): string[][] | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().startsWith('|'))
  if (lines.length < 2) return null
  const rows: string[][] = []
  for (const line of lines) {
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())
    if (cells.length === 0) continue
    // 跳过 |---|:--:| 这种分隔行
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === '')) continue
    rows.push(cells)
  }
  return rows.length > 0 ? rows : null
}

/** 二维数组 → Markdown 表格 */
export function rowsToMarkdown(rows: string[][]): string {
  if (rows.length === 0) return ''
  const cols = Math.max(...rows.map((row) => row.length))
  const pad = (row: string[]): string[] => Array.from({ length: cols }, (_, i) => (row[i] ?? '').replace(/\|/g, '\\|'))
  const header = pad(rows[0])
  const divider = Array.from({ length: cols }, () => '---')
  const body = rows.slice(1).map(pad)
  return [`| ${header.join(' | ')} |`, `| ${divider.join(' | ')} |`, ...body.map((row) => `| ${row.join(' | ')} |`)].join('\n')
}

/** 从剪贴板粘贴的多行文本 → 二维数组（Excel 复制出来是制表符分隔） */
export function blockToRows(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '')
  const lines = normalized.split('\n')
  const delimiter = lines.some((line) => line.includes('\t')) ? '\t' : null
  return lines.map((line) => (delimiter ? line.split(delimiter) : splitLooseCsvLine(line)))
}

function splitLooseCsvLine(line: string): string[] {
  const cells: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      cells.push(field)
      field = ''
    } else field += ch
  }
  cells.push(field)
  return cells
}

export interface GridOptions {
  /** 右键菜单里「复制整表为 Markdown」 */
  onCopyMarkdown?: (rows: string[][]) => void
}

export function createGrid(
  host: HTMLElement,
  delimiter: string,
  onChange: (text: string) => void,
  options: GridOptions = {}
): GridApi {
  let rows: string[][] = [['']]
  let table: HTMLTableElement | null = null
  let wrap: HTMLDivElement | null = null
  let suppressChange = false
  let hasHeader = true
  let sortKeys: SortKey[] = []
  const mergeCols = new Set<number>()
  let selectedCols: number[] = []
  let anchorCol = -1
  let lastFocus: { r: number; c: number } | null = null

  const history = new GridHistory(120)
  /** 连续输入合并成一次撤销：记录这串输入开始前的快照 */
  let burst: string[][] | null = null
  let burstTimer: number | null = null

  const serialized = (): string => serializeCsv(rows, delimiter)

  const emit = (): void => {
    if (suppressChange) return
    onChange(serialized())
  }

  const cellAt = (r: number, c: number): HTMLTableCellElement | null =>
    table?.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`) ?? null

  const normalizeWidth = (): void => {
    const width = Math.max(...rows.map((row) => row.length), 1)
    for (const row of rows) {
      while (row.length < width) row.push('')
    }
  }

  /* ---------------- 撤销 ---------------- */

  const commitBurst = (): void => {
    if (burstTimer) {
      window.clearTimeout(burstTimer)
      burstTimer = null
    }
    if (!burst) return
    history.push(burst)
    burst = null
    updateToolbar()
  }

  const noteEdit = (before: string[][]): void => {
    if (!burst) burst = before
    if (burstTimer) window.clearTimeout(burstTimer)
    burstTimer = window.setTimeout(() => {
      burstTimer = null
      commitBurst()
    }, 700)
  }

  /** 结构操作：先落掉正在输入的内容，再把快照压栈 */
  const applyChange = (next: string[][]): void => {
    commitBurst()
    // 没有实际变化（比如只有一列时删列）就别污染撤销栈
    if (serializeCsv(next, delimiter) === serializeCsv(rows, delimiter)) {
      rows = next
      rebuild()
      return
    }
    history.push(rows)
    rows = next
    sortKeys = []
    rebuild()
    emit()
  }

  function undo(): boolean {
    commitBurst()
    const previous = history.undo(rows)
    if (!previous) return false
    rows = previous
    sortKeys = []
    rebuild()
    emit()
    return true
  }

  function redo(): boolean {
    commitBurst()
    const next = history.redo(rows)
    if (!next) return false
    rows = next
    sortKeys = []
    rebuild()
    emit()
    return true
  }

  /* ---------------- 排序 ---------------- */

  function applySort(col: number, dir: SortDir, append = false): void {
    if (append) {
      sortKeys = [...sortKeys.filter((key) => key.col !== col), { col, dir }]
    } else {
      const existing = sortKeys.find((key) => key.col === col)
      if (existing && existing.dir === dir) {
        sortKeys = sortKeys.filter((key) => key.col !== col)
      } else {
        sortKeys = [{ col, dir }]
      }
    }
    const next = sortRows(rows, sortKeys, hasHeader)
    commitBurst()
    if (serializeCsv(next, delimiter) === serializeCsv(rows, delimiter)) {
      rebuild()
      return
    }
    history.push(rows)
    rows = next
    rebuild()
    emit()
  }

  /* ---------------- 渲染 ---------------- */

  function rebuild(): void {
    normalizeWidth()
    const focus = lastFocus
    suppressChange = true
    host.textContent = ''
    wrap = document.createElement('div')
    wrap.className = 'grid-wrap'
    wrap.appendChild(buildToolbar())
    wrap.appendChild(buildTable())
    host.appendChild(wrap)
    suppressChange = false
    updateToolbar()
    if (focus) cellAt(focus.r, focus.c)?.focus()
  }

  /** 手改单元格以后排序就不再成立了，把表头的排序标记摘掉（不重建，别打断输入） */
  function clearSortBadges(): void {
    if (!sortKeys.length) return
    sortKeys = []
    wrap?.querySelectorAll('.grid-sort').forEach((el) => el.remove())
  }

  function buildToolbar(): HTMLDivElement {
    const bar = document.createElement('div')
    bar.className = 'grid-toolbar'

    const undoBtn = document.createElement('button')
    undoBtn.className = 'grid-btn'
    undoBtn.dataset['act'] = 'undo'
    undoBtn.textContent = '↶ 撤销'
    undoBtn.title = '撤销（Ctrl+Z）'
    undoBtn.addEventListener('click', () => undo())

    const redoBtn = document.createElement('button')
    redoBtn.className = 'grid-btn'
    redoBtn.dataset['act'] = 'redo'
    redoBtn.textContent = '↷ 重做'
    redoBtn.title = '重做（Ctrl+Shift+Z）'
    redoBtn.addEventListener('click', () => redo())

    const sep = document.createElement('span')
    sep.className = 'grid-sep'

    const label = document.createElement('label')
    label.className = 'grid-check'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.dataset['act'] = 'header'
    checkbox.checked = hasHeader
    checkbox.addEventListener('change', () => {
      hasHeader = checkbox.checked
      sortKeys = []
      rebuild()
    })
    label.appendChild(checkbox)
    label.appendChild(document.createTextNode(' 首行是表头'))

    const hint = document.createElement('span')
    hint.className = 'grid-hint'
    hint.textContent = '点列头选列 · 双击列头排序 · 右键列头菜单 · Ctrl+Z 撤销'

    bar.append(undoBtn, redoBtn, sep, label, hint)
    return bar
  }

  function buildTable(): HTMLTableElement {
    const cols = rows[0]?.length ?? 1
    const offset = hasHeader ? 1 : 0

    /** col → (起始绝对行 → 跨行数) */
    const spans = new Map<number, Map<number, number>>()
    for (const col of mergeCols) {
      if (col >= cols) continue
      const values = rows.slice(offset).map((row) => row[col] ?? '')
      const map = new Map<number, number>()
      for (const span of mergeSpans(values)) {
        map.set(span.start + offset, span.span)
      }
      if (map.size) spans.set(col, map)
    }

    const el = document.createElement('table')
    el.className = 'grid-table'

    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    const corner = document.createElement('th')
    corner.className = 'grid-corner'
    corner.title = '首行是否作为表头，可以在左边勾选'
    headRow.appendChild(corner)

    for (let c = 0; c < cols; c += 1) {
      const th = document.createElement('th')
      th.className = 'grid-col-head'
      th.dataset['c'] = String(c)
      if (selectedCols.includes(c)) th.classList.add('col-selected')
      if (mergeCols.has(c)) th.classList.add('merged-col')

      const name = document.createElement('span')
      name.className = 'grid-col-name'
      name.textContent = columnName(c)
      th.appendChild(name)

      const sortIndex = sortKeys.findIndex((key) => key.col === c)
      if (sortIndex >= 0) {
        const badge = document.createElement('span')
        badge.className = 'grid-sort'
        badge.textContent = `${sortKeys[sortIndex].dir === 'asc' ? '▲' : '▼'}${sortKeys.length > 1 ? sortIndex + 1 : ''}`
        th.appendChild(badge)
      }

      const caret = document.createElement('button')
      caret.className = 'grid-col-caret'
      caret.type = 'button'
      caret.dataset['c'] = String(c)
      caret.textContent = '▾'
      caret.title = '列操作'
      th.appendChild(caret)

      th.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).closest('.grid-col-caret')) return
        selectColumn(c, event.shiftKey)
      })
      th.addEventListener('dblclick', (event) => {
        event.preventDefault()
        const existing = sortKeys.find((key) => key.col === c)
        const nextDir: SortDir = existing?.dir === 'asc' ? 'desc' : 'asc'
        applySort(c, nextDir, event.shiftKey)
      })
      th.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        selectColumn(c, event.shiftKey)
        openColumnMenu(c, event)
      })
      headRow.appendChild(th)
    }
    thead.appendChild(headRow)
    el.appendChild(thead)

    const tbody = document.createElement('tbody')
    rows.forEach((row, r) => {
      const tr = document.createElement('tr')
      const rowHead = document.createElement('th')
      rowHead.className = 'grid-row-head'
      rowHead.dataset['r'] = String(r)
      rowHead.textContent = String(r + 1)
      rowHead.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        onRowMenu(r, event)
      })
      tr.appendChild(rowHead)

      for (let c = 0; c < cols; c += 1) {
        const spanMap = spans.get(c)
        if (spanMap) {
          const span = spanMap.get(r)
          if (span) {
            const td = document.createElement('td')
            td.dataset['r'] = String(r)
            td.dataset['c'] = String(c)
            td.dataset['span'] = String(span)
            td.rowSpan = span
            td.textContent = row[c] ?? ''
            td.classList.add('merged-cell')
            if (selectedCols.includes(c)) td.classList.add('col-selected')
            tr.appendChild(td)
            continue
          }
          // 落在合并区间内部的行：这一列不生成单元格
          let covered = false
          for (const [start, size] of spanMap) {
            if (r > start && r < start + size) {
              covered = true
              break
            }
          }
          if (covered) continue
        }

        const td = document.createElement('td')
        td.dataset['r'] = String(r)
        td.dataset['c'] = String(c)
        td.contentEditable = 'true'
        td.spellcheck = false
        td.textContent = row[c] ?? ''
        if (selectedCols.includes(c)) td.classList.add('col-selected')
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    })
    el.appendChild(tbody)

    // 合并单元格也要能编辑（改一行等于改整组）
    el.querySelectorAll<HTMLTableCellElement>('td.merged-cell').forEach((td) => {
      td.contentEditable = 'true'
      td.spellcheck = false
      td.title = `合并了 ${td.dataset['span'] ?? '?'} 行，编辑会同时改这组`
    })

    table = el
    return el
  }

  /* ---------------- 工具栏状态 ---------------- */

  function updateToolbar(): void {
    if (!wrap) return
    const undoBtn = wrap.querySelector<HTMLButtonElement>('button[data-act="undo"]')
    const redoBtn = wrap.querySelector<HTMLButtonElement>('button[data-act="redo"]')
    if (undoBtn) undoBtn.disabled = !history.canUndo && !burst && !burstTimer
    if (redoBtn) redoBtn.disabled = !history.canRedo
  }

  /* ---------------- 列选中 ---------------- */

  function selectColumn(col: number, extend: boolean): void {
    if (extend && anchorCol >= 0) {
      selectedCols = columnRange(anchorCol, col)
    } else {
      anchorCol = col
      selectedCols = [col]
    }
    rebuild()
  }

  function clearSelection(): void {
    if (!selectedCols.length) return
    selectedCols = []
    anchorCol = -1
    rebuild()
  }

  /* ---------------- 菜单 ---------------- */

  function openColumnMenu(col: number, event: MouseEvent): void {
    const append = event.shiftKey
    const colName = columnName(col)
    menuAt(event, [
      [`「${colName}」升序`, () => applySort(col, 'asc', append)],
      [`「${colName}」降序`, () => applySort(col, 'desc', append)],
      ['清除排序', () => {
        sortKeys = []
        rebuild()
      }],
      ['---', () => undefined],
      [mergeCols.has(col) ? '取消合并相同值（仅显示）' : '合并相同值（仅显示）', () => {
        if (mergeCols.has(col)) mergeCols.delete(col)
        else mergeCols.add(col)
        rebuild()
      }],
      ['---', () => undefined],
      ['左侧插入列', () => applyChange(insertColumn(rows, col))],
      ['右侧插入列', () => applyChange(insertColumn(rows, col + 1))],
      ['删除这一列', () => applyChange(removeColumnAt(rows, col))],
      ['---', () => undefined],
      ['复制这一列', () => {
        const text = rows.map((row) => row[col] ?? '').join('\n')
        void navigator.clipboard.writeText(text)
      }],
    ])
  }

  function onRowMenu(r: number, event: MouseEvent): void {
    menuAt(event, [
      ['在此上方插入行', () => applyChange(insertRow(rows, r))],
      ['在此下方插入行', () => applyChange(insertRow(rows, r + 1))],
      ['删除这一行', () => applyChange(removeRowAt(rows, r))],
      ['---', () => undefined],
      ['复制整表为 Markdown', () => options.onCopyMarkdown?.(rows.map((row) => [...row]))],
    ])
  }

  function onCellMenu(r: number, c: number, event: MouseEvent): void {
    menuAt(event, [
      ['左侧插入列', () => applyChange(insertColumn(rows, c))],
      ['右侧插入列', () => applyChange(insertColumn(rows, c + 1))],
      ['删除这一列', () => applyChange(removeColumnAt(rows, c))],
      ['---', () => undefined],
      ['复制整表为 Markdown', () => options.onCopyMarkdown?.(rows.map((row) => [...row]))],
    ])
    void r
  }

  function menuAt(event: MouseEvent, items: Array<[string, () => void]>): void {
    document.querySelector('.ctx-menu')?.remove()
    const menu = document.createElement('div')
    menu.className = 'ctx-menu'
    menu.style.left = `${event.clientX}px`
    menu.style.top = `${event.clientY}px`
    for (const [label, action] of items) {
      if (label === '---') {
        const sep = document.createElement('div')
        sep.className = 'ctx-sep'
        menu.appendChild(sep)
        continue
      }
      const btn = document.createElement('button')
      btn.textContent = label
      btn.addEventListener('click', () => {
        menu.remove()
        action()
      })
      menu.appendChild(btn)
    }
    document.body.appendChild(menu)
    const close = (e: MouseEvent): void => {
      if (menu.contains(e.target as Node)) return
      menu.remove()
      document.removeEventListener('mousedown', close, true)
    }
    document.addEventListener('mousedown', close, true)
  }

  /* ---------------- 交互 ---------------- */

  function bindInteractions(): void {
    host.addEventListener('input', (event) => {
      const td = (event.target as HTMLElement | null)?.closest('td')
      if (!td) return
      const r = Number((td as HTMLElement).dataset['r'])
      const c = Number((td as HTMLElement).dataset['c'])
      if (Number.isNaN(r) || Number.isNaN(c)) return
      const before = burst ? null : cloneRows(rows)
      const value = td.textContent ?? ''
      const span = Number((td as HTMLElement).dataset['span'] ?? '1')
      for (let i = 0; i < Math.max(span, 1); i += 1) {
        if (rows[r + i]) rows[r + i][c] = value
      }
      if (before) noteEdit(before)
      clearSortBadges()
      emit()
      updateToolbar()
    })

    host.addEventListener('focusin', (event) => {
      const td = (event.target as HTMLElement | null)?.closest('td')
      if (!td) return
      lastFocus = { r: Number((td as HTMLElement).dataset['r']), c: Number((td as HTMLElement).dataset['c']) }
    })

    host.addEventListener('focusout', (event) => {
      commitBurst()
      // 合并单元格改了值以后可能不再相等，等焦点落定再重算
      const td = (event.target as HTMLElement | null)?.closest('td')
      const col = td ? Number((td as HTMLElement).dataset['c']) : -1
      if (td?.classList.contains('merged-cell') || (col >= 0 && mergeCols.has(col))) {
        window.setTimeout(() => rebuild(), 0)
      }
    })

    host.addEventListener('keydown', (event) => {
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
        return
      }
      if (event.key === 'Escape') {
        clearSelection()
        return
      }

      const td = (event.target as HTMLElement | null)?.closest('td') as HTMLTableCellElement | null
      if (!td) return
      const r = Number(td.dataset['r'])
      const c = Number(td.dataset['c'])
      const cols = rows[0]?.length ?? 1
      let target: HTMLTableCellElement | null = null
      if (event.key === 'Tab') {
        target = event.shiftKey ? cellAt(r, c - 1) ?? cellAt(r - 1, cols - 1) : cellAt(r, c + 1) ?? cellAt(r + 1, 0)
      } else if (event.key === 'Enter') {
        target = event.shiftKey ? cellAt(r - 1, c) : cellAt(r + 1, c)
      } else if (event.key === 'ArrowDown' && !event.shiftKey) {
        target = cellAt(r + 1, c)
      } else if (event.key === 'ArrowUp' && !event.shiftKey) {
        target = cellAt(r - 1, c)
      }
      if (!target) return
      event.preventDefault()
      target.focus()
      const range = document.createRange()
      range.selectNodeContents(target)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    })

    host.addEventListener('contextmenu', (event) => {
      const caret = (event.target as HTMLElement | null)?.closest('.grid-col-caret')
      if (caret) {
        event.preventDefault()
        const col = Number((caret as HTMLElement).dataset['c'])
        selectColumn(col, event.shiftKey)
        openColumnMenu(col, event)
        return
      }
      const head = (event.target as HTMLElement | null)?.closest('.grid-col-head')
      if (head) {
        // 表头自己处理 contextmenu，这里不拦截
        return
      }
      const rowHead = (event.target as HTMLElement | null)?.closest('.grid-row-head')
      if (rowHead) {
        event.preventDefault()
        onRowMenu(Number((rowHead as HTMLElement).dataset['r']), event)
        return
      }
      const td = (event.target as HTMLElement | null)?.closest('td')
      if (!td) return
      event.preventDefault()
      onCellMenu(Number((td as HTMLElement).dataset['r']), Number((td as HTMLElement).dataset['c']), event)
    })

    host.addEventListener('click', (event) => {
      const caret = (event.target as HTMLElement | null)?.closest('.grid-col-caret')
      if (!caret) return
      event.stopPropagation()
      const col = Number((caret as HTMLElement).dataset['c'])
      selectColumn(col, event.shiftKey)
      const rect = (caret as HTMLElement).getBoundingClientRect()
      const fake = { clientX: rect.left, clientY: rect.bottom + 2 } as MouseEvent
      openColumnMenu(col, fake)
    })

    /* 从 Excel / 网页复制一块区域后，直接粘到某个格子里铺开 */
    host.addEventListener('paste', (event) => {
      const target = (event.target as HTMLElement | null)?.closest('td')
      if (!target) return
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (!/[\t\n]/.test(text)) return
      event.preventDefault()
      const block = blockToRows(text)
      if (block.length === 0) return

      const r0 = Number((target as HTMLElement).dataset['r'])
      const c0 = Number((target as HTMLElement).dataset['c'])
      const next = cloneRows(rows)
      const needRows = r0 + block.length
      const needCols = Math.max(next[0]?.length ?? 1, c0 + Math.max(...block.map((line) => line.length)))
      while (next.length < needRows) next.push(emptyRow(needCols))
      next.forEach((row) => {
        while (row.length < needCols) row.push('')
      })
      block.forEach((line, dr) => {
        line.forEach((cell, dc) => {
          next[r0 + dr][c0 + dc] = cell
        })
      })
      applyChange(next)
    })
  }

  /* ---------------- 对外 API ---------------- */

  const api: GridApi = {
    setText(text: string): void {
      rows = parseCsv(text, delimiter)
      sortKeys = []
      mergeCols.clear()
      selectedCols = []
      anchorCol = -1
      history.clear()
      burst = null
      burstTimer = null
      rebuild()
    },
    getText: serialized,
    cellCount: () => ({ rows: rows.length, cols: rows[0]?.length ?? 0 }),
    addRow(): void {
      applyChange(insertRow(rows, rows.length))
    },
    addColumn(): void {
      applyChange(insertColumn(rows, rows[0]?.length ?? 1))
    },
    removeRow(index: number): void {
      applyChange(removeRowAt(rows, index))
    },
    removeColumn(index: number): void {
      applyChange(removeColumnAt(rows, index))
    },
    focus(): void {
      const first = cellAt(hasHeader ? 1 : 0, 0) ?? cellAt(0, 0)
      first?.focus()
    },
    undo,
    redo,
    sortBy(col: number, dir: SortDir, append = false): void {
      applySort(col, dir, append)
    },
    mergeColumn(col: number): void {
      if (mergeCols.has(col)) mergeCols.delete(col)
      else mergeCols.add(col)
      rebuild()
    },
    selectColumns(cols: number[]): void {
      selectedCols = [...cols]
      rebuild()
    },
  }

  // 首次挂载
  bindInteractions()
  rebuild()

  return api
}

/** 0 → A, 25 → Z, 26 → AA */
export function columnName(index: number): string {
  let n = index
  let name = ''
  do {
    name = String.fromCharCode((n % 26) + 65) + name
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return name
}
