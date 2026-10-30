import type {
  ApprovalRequest,
  AppConfig,
  ChatDelta,
  ChatDone,
  ChatMessage,
  Encoding,
  FileContent,
  FileMeta,
  FileStat,
  ModelInfo,
  ReplaceResult,
  SavedEditorState,
  SaveResult,
  SearchOptions,
  SearchResult,
  SessionSummary,
  StoredSession,
  TaskConfig,
  TaskEvent,
  ToolEventPayload,
  TreeNode,
} from './types'

export interface TaskView extends TaskConfig {
  running: boolean
  next: string
}

export interface ThApi {
  /** win32 / darwin / linux，用于路径分隔符和快捷键文案 */
  platform: string
  config: {
    get(): Promise<AppConfig>
    patch(patch: Partial<AppConfig>): Promise<AppConfig>
    pickDirectory(): Promise<string | null>
  }
  fs: {
    tree(root: string): Promise<TreeNode[]>
    read(path: string, options?: { maxBytes?: number }): Promise<FileContent>
    stat(path: string): Promise<FileStat>
    files(): Promise<string[]>
    openDir(path: string): Promise<string>
    write(path: string, text: string, meta: FileMeta, dryRun?: boolean): Promise<SaveResult>
    create(parent: string, name: string, isDir: boolean): Promise<string>
    rename(from: string, to: string): Promise<string>
    remove(path: string): Promise<void>
    reveal(path: string): Promise<void>
    trash(path: string): Promise<void>
    pickOpen(): Promise<string | null>
    pickImage(): Promise<string | null>
    importImage(sourcePath: string): Promise<{ path: string; name: string } | null>
    readImageData(sourcePath: string): Promise<{ dataUrl: string; name: string } | null>
    writeImage(dataUrl: string, originalName: string): Promise<{ path: string; name: string }>
    pickSave(defaultPath: string): Promise<string | null>
    exists(path: string): Promise<boolean>
    ensureDir(path: string): Promise<void>
    nextPath(dir: string, name: string): Promise<string>
  }
  assets: {
    save(input: { docPath: string | null; mime: string; bytes: Uint8Array }): Promise<string>
    info(): Promise<{ dir: string; today: string }>
  }
  ai: {
    model(): Promise<ModelInfo>
    models(): Promise<{ models: string[]; error?: string }>
    chat(payload: { id: string; messages: ChatMessage[] }): Promise<{ id: string }>
    abort(id: string): void
    onDelta(cb: (delta: ChatDelta) => void): void
    onDone(cb: (done: ChatDone) => void): void
    onTool(cb: (event: ToolEventPayload) => void): void
    onApproval(cb: (request: ApprovalRequest) => void): void
    approvalResult(id: string, ok: boolean): void
    onOpenFile(cb: (path: string) => void): void
  }
  app: {
    setDirty(count: number): void
    activity(): void
    copyText(text: string): Promise<void>
    readText(): Promise<string>
    version(): Promise<string>
    takePendingFile(): Promise<string | null>
  }
  tasks: {
    list(): Promise<TaskView[]>
    toggle(id: string, enabled: boolean): Promise<boolean>
    run(id: string): Promise<void>
    onEvent(cb: (event: TaskEvent) => void): void
  }
  sessions: {
    list(): Promise<SessionSummary[]>
    load(id: string): Promise<StoredSession | null>
    save(session: StoredSession): Promise<void>
    delete(id: string): Promise<void>
  }
  search: {
    files(options: SearchOptions): Promise<SearchResult>
    replace(paths: string[], options: SearchOptions, replacement: string): Promise<ReplaceResult>
  }
  state: {
    load(): Promise<SavedEditorState | null>
    save(state: SavedEditorState): Promise<void>
  }
}

export type { AppConfig, Encoding, FileMeta, TreeNode }
