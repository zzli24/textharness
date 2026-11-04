import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AccessRequest,
  ApprovalRequest,
  ScriptRequest,
  SelectionInfo,
  ToolListItem,
  UpdateEvent,
  AppConfig,
  ChatDelta,
  ChatDone,
  ChatMessage,
  FileMeta,
  FileStat,
  ReplaceResult,
  SavedEditorState,
  SearchOptions,
  SearchResult,
  StoredSession,
  TaskEvent,
  ToolEventPayload,
} from '@shared/types'

const api = {
  platform: process.platform,
  config: {
    get: () => ipcRenderer.invoke('config:get') as Promise<AppConfig>,
    patch: (patch: Partial<AppConfig>) => ipcRenderer.invoke('config:patch', patch) as Promise<AppConfig>,
    pickDirectory: () => ipcRenderer.invoke('config:pickDirectory') as Promise<string | null>,
  },
  fs: {
    tree: (root: string) => ipcRenderer.invoke('fs:tree', root),
    read: (path: string, options?: { maxBytes?: number }) => ipcRenderer.invoke('fs:read', path, options),
    stat: (path: string) => ipcRenderer.invoke('fs:stat', path) as Promise<FileStat>,
    files: () => ipcRenderer.invoke('fs:files') as Promise<string[]>,
    openDir: (path: string) => ipcRenderer.invoke('fs:openDir', path) as Promise<string>,
    write: (path: string, text: string, meta: FileMeta, dryRun = false) =>
      ipcRenderer.invoke('fs:write', path, text, meta, dryRun),
    create: (parent: string, name: string, isDir: boolean) =>
      ipcRenderer.invoke('fs:create', parent, name, isDir) as Promise<string>,
    rename: (from: string, to: string) => ipcRenderer.invoke('fs:rename', from, to) as Promise<string>,
    remove: (path: string) => ipcRenderer.invoke('fs:remove', path) as Promise<void>,
    reveal: (path: string) => ipcRenderer.invoke('fs:reveal', path) as Promise<void>,
    trash: (path: string) => ipcRenderer.invoke('fs:trash', path) as Promise<void>,
    pickOpen: () => ipcRenderer.invoke('fs:pickOpen') as Promise<string | null>,
    allow: (path: string) => ipcRenderer.invoke('fs:allow', path) as Promise<boolean>,
    pickImage: () => ipcRenderer.invoke('fs:pickImage') as Promise<string | null>,
    pickImages: () => ipcRenderer.invoke('fs:pickImages') as Promise<string[]>,
    importImage: (sourcePath: string) =>
      ipcRenderer.invoke('fs:importImage', sourcePath) as Promise<{ path: string; name: string } | null>,
    readImageData: (sourcePath: string) =>
      ipcRenderer.invoke('fs:readImageData', sourcePath) as Promise<{ dataUrl: string; name: string } | null>,
    writeImage: (dataUrl: string, originalName: string) =>
      ipcRenderer.invoke('fs:writeImage', dataUrl, originalName) as Promise<{ path: string; name: string }>,
    pickSave: (defaultPath: string) => ipcRenderer.invoke('fs:pickSave', defaultPath) as Promise<string | null>,
    exists: (path: string) => ipcRenderer.invoke('fs:exists', path) as Promise<boolean>,
    ensureDir: (path: string) => ipcRenderer.invoke('fs:ensureDir', path) as Promise<void>,
    nextPath: (dir: string, name: string) => ipcRenderer.invoke('fs:nextPath', dir, name) as Promise<string>,
  },
  assets: {
    save: (input: { docPath: string | null; mime: string; bytes: Uint8Array }) =>
      ipcRenderer.invoke('assets:save', input) as Promise<string>,
    info: () => ipcRenderer.invoke('assets:info') as Promise<{ dir: string; today: string }>,
  },
  editor: {
    onAppRpc: (cb: (payload: { id: string; action: string; payload?: unknown }) => void) => {
      ipcRenderer.on('app:rpc', (_event, payload: { id: string; action: string; payload?: unknown }) => cb(payload))
    },
    appReply: (payload: { id: string; ok: boolean; data?: unknown; text: string }) =>
      ipcRenderer.send('app:rpc:reply', payload),
    /** 仅开发期：直接触发一次应用控制，用来验证链路 */
    debugApp: (action: string, payload?: unknown) =>
      ipcRenderer.invoke('debug:app', action, payload) as Promise<{ ok: boolean; data?: unknown; text: string }>,
    onSelectionRequest: (cb: (payload: { id: string }) => void) => {
      ipcRenderer.on('editor:selection:request', (_event, payload: { id: string }) => cb(payload))
    },
    selectionReply: (payload: SelectionInfo) => ipcRenderer.send('editor:selection:reply', payload),
    onSelectionReplace: (cb: (payload: { id: string; text: string; from: number; to: number }) => void) => {
      ipcRenderer.on('editor:selection:replace', (_event, payload: { id: string; text: string; from: number; to: number }) => cb(payload))
    },
    selectionReplaced: (payload: { id: string; ok: boolean }) => ipcRenderer.send('editor:selection:replaced', payload),
  },
  archive: {
    categories: () => ipcRenderer.invoke('archive:categories') as Promise<string[]>,
    notes: () => ipcRenderer.invoke('archive:notes') as Promise<string[]>,
    headings: (path: string) =>
      ipcRenderer.invoke('archive:headings', path) as Promise<{
        ok: boolean
        headings: Array<{ level: number; text: string; line: number }>
        text?: string
      }>,
    append: (path: string, section: string, afterLine?: number) =>
      ipcRenderer.invoke('archive:append', path, section, afterLine) as Promise<{
        ok: boolean
        path: string
        text: string
        undo?: { path: string; action: 'delete' | 'restore'; previous?: string }
      }>,
    noteContent: (path: string) =>
      ipcRenderer.invoke('archive:noteContent', path) as Promise<{ ok: boolean; text: string }>,
    write: (request: {
      target: 'knowledge' | 'memory'
      category?: string
      title: string
      content: string
      memoryKind?: 'fact' | 'log' | 'template'
      onConflict?: 'append' | 'overwrite' | 'rename'
      source?: string
    }) =>
      ipcRenderer.invoke('archive:write', request) as Promise<{
        ok: boolean
        path: string
        undo?: { path: string; action: 'delete' | 'restore'; previous?: string }
        text: string
      }>,
    undo: (undo: { path: string; action: 'delete' | 'restore'; previous?: string }) =>
      ipcRenderer.invoke('archive:undo', undo) as Promise<boolean>,
    resetGrant: () => ipcRenderer.invoke('archive:resetGrant') as Promise<{ ok: boolean }>,
    draftList: () =>
      ipcRenderer.invoke('archive:draftList') as Promise<{
        drafts: Array<Record<string, unknown>>
        pending: number
        workspace: string
      }>,
    draftCreate: (input: {
      title: string
      content: string
      target: 'knowledge' | 'memory'
      category?: string
      memoryKind?: 'fact' | 'log' | 'template'
      source?: string
      mergeInto?: string
      summarize: boolean
    }) => ipcRenderer.invoke('archive:draftCreate', input) as Promise<{ draft: Record<string, unknown>; pending: number }>,
    draftUpdate: (id: string, patch: { title?: string; content?: string }) =>
      ipcRenderer.invoke('archive:draftUpdate', id, patch) as Promise<{ draft: Record<string, unknown>; pending: number }>,
    draftDiscard: (id: string) => ipcRenderer.invoke('archive:draftDiscard', id) as Promise<{ pending: number }>,
    draftConfirm: (id: string, force = false) =>
      ipcRenderer.invoke('archive:draftConfirm', id, force) as Promise<{
        ok: boolean
        path?: string
        text?: string
        pending?: number
        undo?: { path: string; action: 'delete' | 'restore'; previous?: string }
      }>,
    draftRegenerate: (id: string) =>
      ipcRenderer.invoke('archive:draftRegenerate', id) as Promise<{ ok: boolean; pending?: number; text?: string }>,
    onDraftChanged: (cb: (payload: { pending: number }) => void) => {
      ipcRenderer.on('archive:draftChanged', (_event, payload: { pending: number }) => cb(payload))
    },
  },
  mcp: {
    status: () =>
      ipcRenderer.invoke('mcp:status') as Promise<
        Array<{ name: string; enabled: boolean; command: string; connected: boolean; tools: number; error?: string }>
      >,
    reconnect: (name: string) =>
      ipcRenderer.invoke('mcp:reconnect', name) as Promise<
        Array<{ name: string; enabled: boolean; command: string; connected: boolean; tools: number; error?: string }>
      >,
  },
  memory: {
    snapshot: () =>
      ipcRenderer.invoke('memory:snapshot') as Promise<{
        facts: string
        factsFull: string
        recentLogs: string[]
        exists: boolean
        files: Array<{ path: string; size: number; mtime: number }>
        templates: Array<{ path: string; title: string }>
      }>,
    save: (content: string) => ipcRenderer.invoke('memory:save', content) as Promise<{ ok: boolean }>,
    ensure: () => ipcRenderer.invoke('memory:ensure') as Promise<{ ok: boolean }>,
    reveal: () => ipcRenderer.invoke('memory:reveal') as Promise<{ ok: boolean }>,
    buildSemantic: () => ipcRenderer.invoke('memory:buildSemantic') as Promise<{ ok: boolean; lines?: number; reason?: string }>,
    semanticStatus: () =>
      ipcRenderer.invoke('memory:semanticStatus') as Promise<{ available: boolean; enabled: boolean; reason?: string }>,
  },
  tools: {
    list: () => ipcRenderer.invoke('tools:list') as Promise<ToolListItem[]>,
  },
  ai: {
    model: () => ipcRenderer.invoke('ai:model'),
    models: () => ipcRenderer.invoke('ai:models') as Promise<{ models: string[]; error?: string }>,
    chat: (payload: { id: string; messages: ChatMessage[]; knowledgeMode?: boolean }) =>
      ipcRenderer.invoke('ai:chat', payload),
    abort: (id: string) => ipcRenderer.send('ai:abort', id),
    onDelta: (cb: (delta: ChatDelta) => void) => {
      ipcRenderer.on('ai:delta', (_event, delta: ChatDelta) => cb(delta))
    },
    onDone: (cb: (done: ChatDone) => void) => {
      ipcRenderer.on('ai:done', (_event, done: ChatDone) => cb(done))
    },
    onUsage: (cb: (usage: { prompt: number; completion: number; reasoning: number; cached: number; estimated: boolean }) => void) => {
      ipcRenderer.on('ai:usage', (_event, usage) => cb(usage))
    },
    onRetry: (cb: (payload: { attempt: number; reason: string }) => void) => {
      ipcRenderer.on('ai:retry', (_event, payload) => cb(payload))
    },
    onTool: (cb: (event: ToolEventPayload) => void) => {
      ipcRenderer.on('ai:tool', (_event, payload: ToolEventPayload) => cb(payload))
    },
    onApproval: (cb: (request: ApprovalRequest) => void) => {
      ipcRenderer.on('ai:approval', (_event, request: ApprovalRequest) => cb(request))
    },
    approvalResult: (id: string, ok: boolean) => ipcRenderer.send('ai:approval:result', { id, ok }),
    onConfirm: (
      cb: (request: {
        id: string
        title: string
        message: string
        detail?: string
        buttons: string[]
        primaryId?: number
        defaultId?: number
        cancelId?: number
      }) => void
    ) => {
      ipcRenderer.on('ui:confirm', (_event, request) => cb(request))
    },
    replyConfirm: (id: string, index: number) => ipcRenderer.send('ui:confirm:reply', { id, index }),
    openUrl: (url: string) => ipcRenderer.invoke('app:openUrl', url) as Promise<void>,
    updateCheck: () => ipcRenderer.invoke('update:check') as Promise<void>,
    updateInstall: () => ipcRenderer.invoke('update:install') as Promise<void>,
    updateFeed: () => ipcRenderer.invoke('update:feed') as Promise<string>,
    onUpdateEvent: (cb: (event: UpdateEvent) => void) => {
      ipcRenderer.on('update:event', (_event, payload: UpdateEvent) => cb(payload))
    },
    onScriptApproval: (cb: (request: ScriptRequest) => void) => {
      ipcRenderer.on('ai:script', (_event, request: ScriptRequest) => cb(request))
    },
    onAccessRequest: (cb: (request: AccessRequest) => void) => {
      ipcRenderer.on('ai:access', (_event, request: AccessRequest) => cb(request))
    },
    accessResult: (id: string, decision: 'deny' | 'read' | 'write') =>
      ipcRenderer.send('ai:access:result', { id, decision }),
    onOpenFile: (cb: (path: string) => void) => {
      ipcRenderer.on('file:open', (_event, path: string) => cb(path))
    },
  },
  app: {
    setDirty: (count: number) => ipcRenderer.send('app:setDirty', count),
    activity: () => ipcRenderer.send('app:activity'),
    copyText: (text: string) => ipcRenderer.invoke('app:copyText', text) as Promise<void>,
    readText: () => ipcRenderer.invoke('app:readText') as Promise<string>,
    version: () => ipcRenderer.invoke('app:version') as Promise<string>,
    takePendingFile: () => ipcRenderer.invoke('app:takePendingFile') as Promise<string | null>,
    /** 从资源管理器拖进来的 File 取真实路径（Electron 32+ 起 File.path 已移除） */
    /** 仅开发期：直接触发一次授权申请，用来验证弹窗（打包后不存在） */
    ...(process.env['NODE_ENV'] !== 'development'
      ? {}
      : {
          debugAccess: (path: string, mode: 'read' | 'write') =>
            ipcRenderer.invoke('debug:access', path, mode) as Promise<'deny' | 'read' | 'write'>,
        }),
    pathForFile: (file: File) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    },
  },
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    toggle: (id: string, enabled: boolean) => ipcRenderer.invoke('tasks:toggle', id, enabled),
    run: (id: string) => ipcRenderer.invoke('tasks:run', id) as Promise<void>,
    onEvent: (cb: (event: TaskEvent) => void) => {
      ipcRenderer.on('task:event', (_event, payload: TaskEvent) => cb(payload))
    },
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    load: (id: string) => ipcRenderer.invoke('sessions:load', id),
    save: (session: StoredSession) => ipcRenderer.invoke('sessions:save', session),
    delete: (id: string) => ipcRenderer.invoke('sessions:delete', id),
  },
  search: {
    files: (options: SearchOptions) => ipcRenderer.invoke('search:files', options),
    replace: (paths: string[], options: SearchOptions, replacement: string) =>
      ipcRenderer.invoke('search:replace', paths, options, replacement),
  },
  state: {
    load: () => ipcRenderer.invoke('state:load') as Promise<SavedEditorState | null>,
    save: (state: SavedEditorState) => ipcRenderer.invoke('state:save', state) as Promise<void>,
  },
}

contextBridge.exposeInMainWorld('th', api)
