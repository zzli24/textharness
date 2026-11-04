import { diffLines } from 'diff'
import { GutterMarker, gutter, type EditorView } from '@codemirror/view'
import { RangeSet, StateEffect, StateField, type EditorState } from '@codemirror/state'

/**
 * 行号旁的改动标记：把当前文档和「基线」（上次打开/保存时的内容）做行级 diff，
 * 新增行标绿、修改行标琥珀。删掉的行已经不在文档里，没法标。
 *
 * 大文件（>8000 行）直接不算，避免每次输入都跑 diff。
 */

const MAX_LINES = 8000

export const setBaselineEffect = StateEffect.define<string>()

const baselineField = StateField.define<string>({
  // 建 state 时就把当前内容当基线：刚打开的文件不该有改动标记
  create: (state) => state.doc.toString(),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setBaselineEffect)) return effect.value
    }
    return value
  },
})

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: 'added' | 'modified') {
    super()
  }

  eq(other: GutterMarker): boolean {
    return other instanceof ChangeMarker && other.kind === this.kind
  }

  toDOM(): Node {
    const span = document.createElement('span')
    span.className = `cm-change-marker ${this.kind}`
    span.title = this.kind === 'added' ? '新增行' : '修改行'
    return span
  }
}

const addedMarker = new ChangeMarker('added')
const modifiedMarker = new ChangeMarker('modified')

function buildMarkers(state: EditorState): RangeSet<GutterMarker> {
  const baseline = state.field(baselineField, false)
  if (!baseline) return RangeSet.empty
  const doc = state.doc
  if (doc.lines > MAX_LINES) return RangeSet.empty
  const current = doc.toString()
  if (current === baseline) return RangeSet.empty

  const changes = diffLines(baseline, current)
  const ranges = []
  let lineNo = 1
  let previousRemoved = false
  for (const change of changes) {
    const count = change.count ?? (change.value ? change.value.split('\n').length : 0)
    if (change.removed) {
      previousRemoved = true
      continue
    }
    if (change.added) {
      // 紧跟在删除块后面的新增 = 修改；否则就是纯新增
      const marker = previousRemoved ? modifiedMarker : addedMarker
      for (let i = 0; i < count; i += 1) {
        if (lineNo > doc.lines) break
        ranges.push(marker.range(doc.line(lineNo).from))
        lineNo += 1
      }
      previousRemoved = false
      continue
    }
    previousRemoved = false
    lineNo += count
  }
  return RangeSet.of(ranges, true)
}

const markersField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(markers, tr) {
    const baselineChanged = tr.effects.some((effect) => effect.is(setBaselineEffect))
    if (!tr.docChanged && !baselineChanged) return markers
    return buildMarkers(tr.state)
  },
  provide: (field) =>
    gutter({
      class: 'cm-change-gutter',
      markers: (view) => view.state.field(field) ?? RangeSet.empty,
      initialSpacer: () => addedMarker,
    }),
})

export function changeMarkers() {
  return [baselineField, markersField]
}

export function setBaseline(view: EditorView, text: string): void {
  view.dispatch({ effects: setBaselineEffect.of(text) })
}

/** 保存后把基线推进到最新内容（会清掉改动标记） */
export function withBaseline(state: EditorState, text: string): EditorState {
  return state.update({ effects: setBaselineEffect.of(text) }).state
}
