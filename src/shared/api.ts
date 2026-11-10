import type {
  AccessRequest,
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
  ScriptRequest,
  SelectionInfo,
  ToolListItem,
  UpdateEvent,
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
  archive: {
    categories(): Promise<string[]>
    notes(): Promise<string[]>
    headings(path: string): Promise<{
      ok: boolean
      headings: Array<{ level: number; text: string; line: number }>
      text?: string
    }>
    append(
      path: string,
      section: string,
      afterLine?: number
    ): Promise<{
      ok: boolean
      path: string
      text: string
      undo?: { path: string; action: 'delete' | 'restore'; previous?: string }
    }>
    noteContent(path: string): Promise<{ ok: boolean; text: string }>
    write(request: {
      target: 'knowledge' | 'memory'
      category?: string
      title: string
      content: string
      memoryKind?: 'fact' | 'log' | 'template'
      onConflict?: 'append' | 'overwrite' | 'rename'
      source?: string
    }): Promise<{
      ok: boolean
      path: string
      undo?: { path: string; action: 'delete' | 'restore'; previous?: string }
      text: string
    }>
    undo(undo: { path: string; action: 'delete' | 'restore'; previous?: string }): Promise<boolean>
    resetGrant(): Promise<{ ok: boolean }>
    draftList(): Promise<{ drafts: unknown[]; pending: number; workspace: string }>
    draftCreate(input: {
      title: string
      content: string
      target: 'knowledge' | 'memory'
      category?: string
      memoryKind?: 'fact' | 'log' | 'template'
      source?: string
      mergeInto?: string
      summarize: boolean
    }): Promise<{ draft: unknown; pending: number }>
    draftUpdate(id: string, patch: { title?: string; content?: string }): Promise<{ draft: unknown; pending: number }>
    draftDiscard(id: string): Promise<{ pending: number }>
    draftConfirm(id: string, force?: boolean): Promise<{
      ok: boolean
      stale?: boolean
      path?: string
      text?: string
      pending?: number
      undo?: { path: string; action: 'delete' | 'restore'; previous?: string }
    }>
    draftRegenerate(id: string): Promise<{ ok: boolean; pending?: number; text?: string }>
    onDraftChanged(cb: (payload: { pending: number }) => void): void
  }
  mcp: {
    status(): Promise<
      Array<{ name: string; enabled: boolean; command: string; connected: boolean; tools: number; error?: string }>
    >
    reconnect(name: string): Promise<
      Array<{ name: string; enabled: boolean; command: string; connected: boolean; tools: number; error?: string }>
    >
  }
  memory: {
    snapshot(): Promise<{
      facts: string
      factsFull: string
      recentLogs: string[]
      exists: boolean
      files: Array<{ path: string; size: number; mtime: number }>
      templates: Array<{ path: string; title: string }>
    }>
    save(content: string): Promise<{ ok: boolean }>
    ensure(): Promise<{ ok: boolean }>
    reveal(): Promise<{ ok: boolean }>
    buildSemantic(): Promise<{ ok: boolean; lines?: number; reason?: string }>
    semanticStatus(): Promise<{ available: boolean; enabled: boolean; reason?: string }>
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
    /** 用户手势授权：允许访问工作区外的这个文件 */
    allow(path: string): Promise<boolean>
    pickImage(): Promise<string | null>
    pickImages(): Promise<string[]>
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
  editor: {
    onAppRpc(cb: (payload: { id: string; action: string; payload?: unknown }) => void): void
    appReply(payload: { id: string; ok: boolean; data?: unknown; text: string }): void
    debugApp?(action: string, payload?: unknown): Promise<{ ok: boolean; data?: unknown; text: string }>
    onSelectionRequest(cb: (payload: { id: string }) => void): void
    selectionReply(payload: SelectionInfo): void
    onSelectionReplace(cb: (payload: { id: string; text: string; from: number; to: number }) => void): void
    selectionReplaced(payload: { id: string; ok: boolean }): void
  }
  tools: {
    list(): Promise<ToolListItem[]>
  }
  ai: {
    model(): Promise<ModelInfo>
    models(): Promise<{ models: string[]; error?: string }>
    chat(payload: { id: string; messages: ChatMessage[]; knowledgeMode?: boolean }): Promise<unknown>
    abort(id: string): void
    onDelta(cb: (delta: ChatDelta) => void): void
    onDone(cb: (done: ChatDone) => void): void
    onUsage(cb: (usage: { prompt: number; completion: number; reasoning: number; cached: number; estimated: boolean }) => void): void
    onRetry(cb: (payload: { attempt: number; reason: string }) => void): void
    onTool(cb: (event: ToolEventPayload) => void): void
    onApproval(cb: (request: ApprovalRequest) => void): void
    approvalResult(id: string, ok: boolean): void
    onConfirm(
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
    ): void
    replyConfirm(id: string, index: number): void
    openUrl(url: string): Promise<void>

    updateCheck(): Promise<void>
    updateInstall(): Promise<{ ok: boolean; reason?: string }>
    updateFeed(): Promise<string>
    onUpdateEvent(cb: (event: UpdateEvent) => void): void
    onScriptApproval(cb: (request: ScriptRequest) => void): void
    onAccessRequest(cb: (request: AccessRequest) => void): void
    accessResult(id: string, decision: 'deny' | 'read' | 'write'): void
    onOpenFile(cb: (path: string) => void): void
  }
  app: {
    setDirty(count: number): void
    activity(): void
    copyText(text: string): Promise<void>
    readText(): Promise<string>
    version(): Promise<string>
    takePendingFile(): Promise<string | null>
    capturePage(target: string): Promise<{ ok: boolean; width: number; height: number }>
    /** 拖入的 File 取绝对路径，取不到返回空串 */
    pathForFile(file: File): string
    /** 用系统浏览器打开外部链接（仅 http/https） */
    openUrl(url: string): Promise<void>
    /** 选择要导入的文件夹/文件 */
    importPick(source: 'markdown' | 'enex' | 'docx' | 'html' | 'zip'): Promise<string | null>
    /** 执行导入 */
    importRun(options: {
      source: 'markdown' | 'enex' | 'docx' | 'html' | 'zip'
      inputPath: string
      conflict?: 'rename' | 'skip' | 'overwrite'
    }): Promise<{
      ok: boolean
      source: string
      targetDir: string
      imported: number
      skipped: number
      failed: number
      errors: string[]
    }>
    /** 备份整个工作区为 zip */
    backupCreate(): Promise<{ ok: boolean; path?: string; files: number; bytes: number; error?: string }>
    /** 从 zip 备份恢复 */
    backupRestore(): Promise<{ ok: boolean; restored: number; skipped: number; error?: string }>
    /** 飞书集成状态 */
    feishuStatus(): Promise<{
      installed: boolean
      configured: boolean
      cliPath?: string
      identity?: string
      error?: string
    }>
    feishuInstall(): Promise<{ ok: boolean; error?: string }>
    feishuLogin(): Promise<{ ok: boolean; error?: string }>
    feishuPull(doc: string): Promise<{
      ok: boolean
      path?: string
      title?: string
      revision?: number
      error?: string
    }>
    feishuPush(path: string, doc?: string): Promise<{ ok: boolean; revision?: number; error?: string }>
    onFeishuProgress(cb: (progress: { phase: string; message: string; url?: string }) => void): () => void
    /** OneNote 导出环境状态 */
    oneNoteStatus(): Promise<{
      platform: string
      oneNoteFound: boolean
      wordFound: boolean
      toolInstalled: boolean
      ready: boolean
      reason?: string
    }>
    /** 下载/调用 OneNote 导出工具，并把结果导入工作区 */
    oneNoteRun(): Promise<{
      ok: boolean
      imported: number
      skipped: number
      failed: number
      targetDir?: string
      error?: string
      logPath?: string
    }>
    /** 订阅 OneNote 导出进度，返回取消订阅函数 */
    onOneNoteProgress(cb: (progress: { phase: string; percent?: number; message?: string }) => void): () => void
    /** 在文件管理器中定位文件 */
    revealPath(target: string): Promise<void>
    /** 复制图片到系统剪贴板 */
    copyImage(dataUrl: string): Promise<{ ok: boolean }>
    /** 保存卡片导出的 PNG/SVG/PDF 数据 */
    saveExport(dataUrl: string, defaultName: string, kind: 'png' | 'svg' | 'pdf'): Promise<{ ok: boolean; path?: string }>
    /** 把卡片截图转成 PDF（主进程隐藏窗口 printToPDF） */
    exportPdf(pngDataUrl: string, defaultName: string): Promise<{ ok: boolean; path?: string }>
    /** 仅开发期存在 */
    debugAccess?(path: string, mode: 'read' | 'write'): Promise<'deny' | 'read' | 'write'>
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
