import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SavedEditorState, SavedEditorTab } from '@shared/types'

export type { SavedEditorState, SavedEditorTab }

function statePath(): string {
  return join(app.getPath('userData'), 'editor-state.json')
}

export function loadEditorState(): SavedEditorState | null {
  try {
    const raw = readFileSync(statePath(), 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw) as SavedEditorState
    if (!Array.isArray(parsed.tabs)) return null
    return {
      tabs: parsed.tabs,
      activeIndex: Number.isFinite(parsed.activeIndex) ? parsed.activeIndex : 0,
      cleanExit: parsed.cleanExit !== false,
    }
  } catch {
    return null
  }
}

export interface SaveStateResult {
  ok: boolean
  error?: string
  file?: string
}

export function saveEditorState(state: SavedEditorState): SaveStateResult {
  const file = statePath()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(state), 'utf8')
    return { ok: true, file }
  } catch (err) {
    console.error('[editor-state] save failed', err)
    return { ok: false, error: String(err), file }
  }
}

/** 正常退出时调用：把标记改成干净退出 */
export function markCleanExit(): void {
  const state = loadEditorState()
  if (!state) return
  saveEditorState({ ...state, cleanExit: true })
}
