/**
 * CSV 表格视图的纯逻辑：排序、类型推断、合并区间、撤销栈。
 *
 * 刻意不碰 DOM —— 这样能用脚本直接跑测试（scripts/test-grid.mjs），
 * 排序/合并这类容易出错的逻辑不依赖界面。
 */

export type SortDir = 'asc' | 'desc'

export interface SortKey {
  col: number
  dir: SortDir
}

export type CellKind = 'number' | 'date' | 'text'

export function cloneRows(rows: string[][]): string[][] {
  return rows.map((row) => [...row])
}

/* ---------------- 类型推断 ---------------- */

const NUMBER_RE = /^-?(?:\d+|\d*\.\d+)$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/

export function detectCellKind(values: string[]): CellKind {
  let filled = 0
  let numbers = 0
  let dates = 0
  for (const raw of values) {
    const value = (raw ?? '').trim()
    if (!value) continue
    filled += 1
    if (NUMBER_RE.test(value)) numbers += 1
    else if (DATE_RE.test(value)) dates += 1
  }
  if (filled === 0) return 'text'
  if (numbers === filled) return 'number'
  if (dates === filled) return 'date'
  return 'text'
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
}

export function compareCells(a: string, b: string, kind: CellKind): number {
  const left = (a ?? '').trim()
  const right = (b ?? '').trim()
  if (kind === 'number') {
    const diff = Number(left) - Number(right)
    return diff === 0 ? 0 : diff > 0 ? 1 : -1
  }
  if (kind === 'date') {
    const diff = Date.parse(left.replace(' ', 'T')) - Date.parse(right.replace(' ', 'T'))
    if (Number.isNaN(diff)) return compareText(left, right)
    return diff === 0 ? 0 : diff > 0 ? 1 : -1
  }
  return compareText(left, right)
}

/* ---------------- 排序 ---------------- */

/**
 * 按 keys 依次比较；空白值永远排在最后（不随升/降序翻转）。
 * 稳定排序：值全相等时保持原来的行顺序。
 */
export function sortRows(rows: string[][], keys: SortKey[], hasHeader: boolean): string[][] {
  if (keys.length === 0) return cloneRows(rows)
  const header = hasHeader ? [rows[0] ?? []] : []
  const body = (hasHeader ? rows.slice(1) : rows).map((row, index) => ({ row, index }))

  const kinds = keys.map((key) =>
    detectCellKind(body.map((item) => item.row[key.col] ?? ''))
  )

  body.sort((left, right) => {
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i]
      const a = left.row[key.col] ?? ''
      const b = right.row[key.col] ?? ''
      const aEmpty = a.trim() === ''
      const bEmpty = b.trim() === ''
      if (aEmpty && bEmpty) continue
      if (aEmpty) return 1
      if (bEmpty) return -1
      const result = compareCells(a, b, kinds[i])
      if (result !== 0) return key.dir === 'asc' ? result : -result
    }
    return left.index - right.index
  })

  return [...header, ...body.map((item) => item.row)]
}

/* ---------------- 合并 ---------------- */

export interface MergeSpan {
  /** 数据行下标（不含表头行） */
  start: number
  span: number
}

/**
 * 计算「显示合并」的区间：相邻且值相同的非空单元格合并。
 * 只负责算，不负责渲染；行号是数据行坐标（调用方自己加表头偏移）。
 */
export function mergeSpans(values: string[]): MergeSpan[] {
  const spans: MergeSpan[] = []
  let start = 0
  while (start < values.length) {
    const value = (values[start] ?? '').trim()
    if (!value) {
      start += 1
      continue
    }
    let end = start + 1
    while (end < values.length && (values[end] ?? '').trim() === value) end += 1
    if (end - start > 1) spans.push({ start, span: end - start })
    start = end
  }
  return spans
}

/* ---------------- 撤销栈 ---------------- */

export class GridHistory {
  private undoStack: string[][][] = []
  private redoStack: string[][][] = []

  constructor(private readonly limit = 100) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** 记录一次变更前的快照；调用方负责只在真正发生变化时调用 */
  push(before: string[][]): void {
    this.undoStack.push(cloneRows(before))
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack = []
  }

  undo(current: string[][]): string[][] | null {
    const previous = this.undoStack.pop()
    if (!previous) return null
    this.redoStack.push(cloneRows(current))
    return cloneRows(previous)
  }

  redo(current: string[][]): string[][] | null {
    const next = this.redoStack.pop()
    if (!next) return null
    this.undoStack.push(cloneRows(current))
    return cloneRows(next)
  }

  clear(): void {
    this.undoStack = []
    this.redoStack = []
  }
}

/* ---------------- 行列操作（纯数据） ---------------- */

export function emptyRow(width: number): string[] {
  return new Array(Math.max(width, 1)).fill('')
}

export function insertRow(rows: string[][], at: number): string[][] {
  const width = rows[0]?.length ?? 1
  const next = cloneRows(rows)
  next.splice(at, 0, emptyRow(width))
  return next
}

export function removeRowAt(rows: string[][], at: number): string[][] {
  if (rows.length <= 1) return cloneRows(rows)
  const next = cloneRows(rows)
  next.splice(at, 1)
  return next
}

export function insertColumn(rows: string[][], at: number): string[][] {
  return rows.map((row) => {
    const next = [...row]
    next.splice(at, 0, '')
    return next
  })
}

export function removeColumnAt(rows: string[][], at: number): string[][] {
  if ((rows[0]?.length ?? 0) <= 1) return cloneRows(rows)
  return rows.map((row) => {
    const next = [...row]
    next.splice(at, 1)
    return next
  })
}

/** 列选中范围：anchor 到 target 之间的所有列 */
export function columnRange(anchor: number, target: number): number[] {
  const from = Math.min(anchor, target)
  const to = Math.max(anchor, target)
  const result: number[] = []
  for (let col = from; col <= to; col += 1) result.push(col)
  return result
}
