/**
 * CSV 表格视图：把 CSV/TSV 文本渲染成可编辑网格。
 *
 * 设计要点：表格只是"视图"，真正的文档内容仍然是 CSV 文本——
 * 单元格改动会序列化回文本，交给上层的 EditorState，
 * 这样保存、脏标记、会话恢复、文本对比全都不用改。
 */

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
  let suppressChange = false

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

  function build(): void {
    normalizeWidth()
    const cols = rows[0]?.length ?? 1

    const el = document.createElement('table')
    el.className = 'grid-table'

    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    const corner = document.createElement('th')
    corner.className = 'grid-corner'
    headRow.appendChild(corner)
    for (let c = 0; c < cols; c += 1) {
      const th = document.createElement('th')
      th.className = 'grid-col-head'
      th.textContent = columnName(c)
      headRow.appendChild(th)
    }
    thead.appendChild(headRow)
    el.appendChild(thead)

    const tbody = document.createElement('tbody')
    rows.forEach((row, r) => {
      const tr = document.createElement('tr')
      const th = document.createElement('th')
      th.className = 'grid-row-head'
      th.textContent = String(r + 1)
      th.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        onRowMenu(r, event)
      })
      tr.appendChild(th)
      row.forEach((cell, c) => {
        const td = document.createElement('td')
        td.dataset['r'] = String(r)
        td.dataset['c'] = String(c)
        td.contentEditable = 'true'
        td.spellcheck = false
        td.textContent = cell
        tr.appendChild(td)
      })
      tbody.appendChild(tr)
    })
    el.appendChild(tbody)

    el.addEventListener('input', (event) => {
      const td = (event.target as HTMLElement | null)?.closest('td')
      if (!td) return
      const r = Number((td as HTMLElement).dataset['r'])
      const c = Number((td as HTMLElement).dataset['c'])
      if (Number.isNaN(r) || Number.isNaN(c)) return
      rows[r][c] = td.textContent ?? ''
      emit()
    })

    el.addEventListener('keydown', (event) => {
      const td = (event.target as HTMLElement | null)?.closest('td') as HTMLTableCellElement | null
      if (!td) return
      const r = Number(td.dataset['r'])
      const c = Number(td.dataset['c'])
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

    el.addEventListener('contextmenu', (event) => {
      const th = (event.target as HTMLElement | null)?.closest('th')
      if (th) return
      const td = (event.target as HTMLElement | null)?.closest('td')
      if (!td) return
      event.preventDefault()
      const r = Number((td as HTMLElement).dataset['r'])
      const c = Number((td as HTMLElement).dataset['c'])
      onCellMenu(r, c, event)
    })

    /* 从 Excel / 网页复制一块区域后，直接粘到某个格子里铺开 */
    el.addEventListener('paste', (event) => {
      const target = (event.target as HTMLElement | null)?.closest('td')
      if (!target) return
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (!/[\t\n]/.test(text)) return
      event.preventDefault()
      const block = blockToRows(text)
      if (block.length === 0) return

      const r0 = Number((target as HTMLElement).dataset['r'])
      const c0 = Number((target as HTMLElement).dataset['c'])
      const needRows = r0 + block.length
      const needCols = Math.max(rows[0]?.length ?? 1, c0 + Math.max(...block.map((line) => line.length)))
      while (rows.length < needRows) rows.push(new Array(rows[0]?.length ?? 1).fill(''))
      rows.forEach((row) => {
        while (row.length < needCols) row.push('')
      })
      block.forEach((line, dr) => {
        line.forEach((cell, dc) => {
          rows[r0 + dr][c0 + dc] = cell
        })
      })
      build()
      emit()
    })

    host.textContent = ''
    host.appendChild(el)
    table = el
  }

  function onRowMenu(r: number, event: MouseEvent): void {
    menuAt(event, [
      ['在此上方插入行', () => { rows.splice(r, 0, new Array(rows[0].length).fill('')); build(); emit() }],
      ['在此下方插入行', () => { rows.splice(r + 1, 0, new Array(rows[0].length).fill('')); build(); emit() }],
      ['删除这一行', () => { if (rows.length > 1) { rows.splice(r, 1); build(); emit() } }],
    ])
  }

  function onCellMenu(r: number, c: number, event: MouseEvent): void {
    menuAt(event, [
      ['左侧插入列', () => { rows.forEach((row) => row.splice(c, 0, '')); build(); emit() }],
      ['右侧插入列', () => { rows.forEach((row) => row.splice(c + 1, 0, '')); build(); emit() }],
      ['删除这一列', () => { if ((rows[0]?.length ?? 0) > 1) { rows.forEach((row) => row.splice(c, 1)); build(); emit() } }],
      ['---', () => undefined],
      ['复制整表为 Markdown', () => options.onCopyMarkdown?.(rows.map((row) => [...row]))],
    ])
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

  return {
    setText(text: string): void {
      suppressChange = true
      rows = parseCsv(text, delimiter)
      build()
      suppressChange = false
    },
    getText: serialized,
    cellCount: () => ({ rows: rows.length, cols: rows[0]?.length ?? 0 }),
    addRow(): void {
      rows.push(new Array(rows[0]?.length ?? 1).fill(''))
      build()
      emit()
    },
    addColumn(): void {
      rows.forEach((row) => row.push(''))
      build()
      emit()
    },
    removeRow(index: number): void {
      if (rows.length <= 1) return
      rows.splice(index, 1)
      build()
      emit()
    },
    removeColumn(index: number): void {
      if ((rows[0]?.length ?? 0) <= 1) return
      rows.forEach((row) => row.splice(index, 1))
      build()
      emit()
    },
    focus(): void {
      const first = cellAt(0, 0)
      first?.focus()
    },
  }
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
