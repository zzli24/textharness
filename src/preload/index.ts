import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AccessRequest,
  ApprovalRequest,
  ScriptRequest,
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
  ai: {
    model: () => ipcRenderer.invoke('ai:model'),
    models: () => ipcRenderer.invoke('ai:models') as Promise<{ models: string[]; error?: string }>,
    chat: (payload: { id: string; messages: ChatMessage[] }) => ipcRenderer.invoke('ai:chat', payload),
    abort: (id: string) => ipcRenderer.send('ai:abort', id),
    onDelta: (cb: (delta: ChatDelta) => void) => {
      ipcRenderer.on('ai:delta', (_event, delta: ChatDelta) => cb(delta))
    },
    onDone: (cb: (done: ChatDone) => void) => {
      ipcRenderer.on('ai:done', (_event, done: ChatDone) => cb(done))
    },
    onTool: (cb: (event: ToolEventPayload) => void) => {
      ipcRenderer.on('ai:tool', (_event, payload: ToolEventPayload) => cb(payload))
    },
    onApproval: (cb: (request: ApprovalRequest) => void) => {
      ipcRenderer.on('ai:approval', (_event, request: ApprovalRequest) => cb(request))
    },
    approvalResult: (id: string, ok: boolean) => ipcRenderer.send('ai:approval:result', { id, ok }),
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
