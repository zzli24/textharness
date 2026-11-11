import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppConfig, ChatMessage, FileMeta } from '@shared/types'
import { dayStamp, savePastedImage } from './services/assets'
import { loadEditorState, saveEditorState, type SavedEditorState } from './services/editorState'
import { registerServiceIpc } from './ipcServices'
import { importNotes, type ImportSource } from './services/importer'
import { createBackup, restoreBackup } from './services/backup'
import { getOneNoteStatus, runOneNoteExport } from './services/onenote'
import {
  feishuStatus,
  installLarkCli,
  loginFeishu,
  pullFeishuDoc,
  pullFeishuDocs,
  pushFeishuDoc,
  searchFeishuDocs,
  switchFeishuApp,
  listFeishuDocs,
  feishuDocInfo,
  feishuRemoteContent,
} from './services/feishu'
import { loadConfig, patchConfig } from './services/config'
import { trace } from './services/logger'
import { ensureMemoryDir, listMemoryFiles, readMemory, writeMemoryFile } from './services/memory'
import {
  appendToNote,
  archiveUndo,
  archiveWrite,
  insertAfterHeading,
  listHeadings,
  listKnowledgeCategories,
  listKnowledgeNotes,
  type ArchiveRequest,
} from './services/archive'
import { createDraft, getDraft, loadDrafts, pendingCount, updateDraft } from './services/drafts'
import { reorganizeForMerge, summarizeForArchive } from './services/summarize'
import { connectMcpServers, disconnectMcpServer, mcpStatus, mcpToolDefs } from './services/mcp'
import { runAgent, type AgentMessage } from './services/agent'
import { listModels, modelInfo } from './services/llm'
import { deleteSession, listSessions, loadSession, saveSession, type StoredSession } from './services/sessions'
import { listFiles, replaceInFiles, searchInFiles } from './services/search'
import { TOOL_DEFS } from './services/tools'
import { TOOL_CAP_DEFAULT, TOOL_META, defaultEnabledTools } from './services/toolMeta'
import type { SearchOptions, SelectionInfo, ToolListItem } from '@shared/types'
import {
  assertInside,
  createEntry,
  ensureDir,
  listTree,
  nextAvailablePath,
  readFileContent,
  removeEntry,
  renameEntry,
  statFile,
  writeFileContent,
} from './services/files'

export interface IpcDeps {
  getWindow(): BrowserWindow | null
  getScheduler(): {
    runNow(id: string): Promise<void>
    isRunning(id: string): boolean
    describe(task: AppConfig['tasks'][number]): string
    touch(): void
  } | null
  /** 取走启动参数里的文件路径（取一次就清空） */
  takePendingFile(): string | null
}

/* ------------------------------------------------------------------ */
/* 外部文件授权                                                        */
/*                                                                     */
/* 工作区仍是默认沙箱：AI 工具（tools.ts）只认工作区，越界直接报错。    */
/* 但「用户亲自点名的文件」必须能打开——文件对话框、拖进窗口、命令行、  */
/* 文件关联。这类路径记在下面的表里，只对本进程有效，重启即清空。       */
/* ------------------------------------------------------------------ */

const externalFiles = new Set<string>()

const normPath = (p: string): string => resolve(p).toLowerCase()

function allowExternalFile(path: string): void {
  try {
    externalFiles.add(normPath(path))
  } catch {
    /* 忽略非法路径 */
  }
}

function isExternalAllowed(path: string): boolean {
  try {
    return externalFiles.has(normPath(path))
  } catch {
    return false
  }
}

function insideWorkspace(root: string, target: string): boolean {
  const r = resolve(root)
  const t = resolve(target)
  return t === r || t.startsWith(r + sep)
}

/** 统一入口：工作区内放行；工作区外只认已授权的文件（读写都适用） */
function guard(path: string): string {
  const cfg = loadConfig()
  if (insideWorkspace(cfg.workspaceRoot, path) || isExternalAllowed(path)) return resolve(path)
  throw new Error(
    `这个文件在工作区之外：${path}\n要编辑它，请用「Ctrl+O 打开文件…」，或者直接把文件拖进窗口。`
  )
}

export interface UpdateBridge {
  checkUpdateNow(): Promise<void>
  quitAndInstallUpdate(): { ok: boolean; reason?: string }
  updateFeed(): string
}

/** 设置页「工具能力」用：内置工具 + 当前开关状态 */
function listTools(): ToolListItem[] {
  const cfg = loadConfig()
  const enabled = enabledToolSet(cfg)
  return TOOL_DEFS.map((tool) => {
    const meta = TOOL_META[tool.function.name]
    return {
      name: tool.function.name,
      label: meta?.label ?? tool.function.name,
      group: meta?.group ?? 'text',
      summary: meta?.summary ?? tool.function.description.slice(0, 60),
      enabled: enabled.has(tool.function.name),
      dangerous: meta?.dangerous ?? false,
    }
  })
}

/** 当前生效的工具集合：配置里没写就用默认值 */
export function enabledToolSet(cfg: { enabledTools?: string[]; toolCap?: number }): Set<string> {
  const base = cfg.enabledTools && cfg.enabledTools.length > 0 ? cfg.enabledTools : defaultEnabledTools()
  const cap = Math.min(Math.max(cfg.toolCap ?? TOOL_CAP_DEFAULT, 5), 60)
  return new Set(base.slice(0, cap))
}

interface InAppConfirmSpec {
  title: string
  message: string
  detail?: string
  buttons: string[]
  /** 蓝色按钮下标 */
  primaryId?: number
  /** 回车触发下标 */
  defaultId?: number
  /** Esc 触发下标 */
  cancelId?: number
}

const pendingConfirms = new Map<string, (index: number) => void>()

/**
 * 应用内确认框：走渲染层自绘的 confirmDialog，样式跟主题一致，
 * 不再弹 Windows 原生对话框（截图难看、按钮顺序不跟应用）。
 * 窗口没了或超时就按「取消」处理。
 */
function askInApp(sender: Electron.WebContents, spec: InAppConfirmSpec): Promise<number> {
  const id = `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return new Promise((resolve) => {
    const finish = (index: number): void => {
      if (!pendingConfirms.has(id)) return
      pendingConfirms.delete(id)
      clearTimeout(timer)
      resolve(index)
    }
    const timer = setTimeout(() => finish(spec.cancelId ?? 0), 5 * 60 * 1000)
    pendingConfirms.set(id, finish)
    if (sender.isDestroyed()) {
      finish(spec.cancelId ?? 0)
      return
    }
    sender.send('ui:confirm', { id, ...spec })
  })
}

export function registerIpc(deps: IpcDeps & Partial<UpdateBridge>): void {
  ipcMain.on('ui:confirm:reply', (_event, payload: { id: string; index: number }) => {
    pendingConfirms.get(payload.id)?.(Number(payload.index) || 0)
  })
  // 记忆 / MCP 的 handler 在 ipcServices.ts 里注册
  registerServiceIpc()
  const checkUpdateNow = deps.checkUpdateNow ?? (async () => undefined)
  const quitAndInstallUpdate = deps.quitAndInstallUpdate ?? (() => ({ ok: false, reason: '更新模块未初始化' }))
  const updateFeed = deps.updateFeed ?? (() => '')

  /* ---------- 配置 ---------- */
  // 仅开发期：把当前窗口截图写到指定路径，给官网截图用
  ipcMain.handle('debug:capturePage', async (event, target: string) => {
    if (app.isPackaged) throw new Error('仅开发期可用')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('没有窗口')
    const image = await win.capturePage()
    writeFileSync(String(target), image.toPNG())
    return { ok: true, width: image.getSize().width, height: image.getSize().height }
  })

  ipcMain.handle('config:get', () => loadConfig())

  ipcMain.handle('config:patch', (_e, patch: Partial<AppConfig>) => patchConfig(patch))

  ipcMain.handle('config:pickDirectory', async () => {
    const win = deps.getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  /* ---------- 文件 ---------- */
  ipcMain.handle('fs:tree', async (_e, root: string) => {
    const cfg = loadConfig()
    assertInside(cfg.workspaceRoot, root)
    return listTree(root)
  })

  ipcMain.handle('fs:read', async (_e, path: string, options?: { maxBytes?: number }) => {
    guard(path)
    return readFileContent(path, options)
  })

  ipcMain.handle('fs:stat', async (_e, path: string) => {
    guard(path)
    return statFile(path)
  })

  ipcMain.handle('fs:files', async () => {
    const cfg = loadConfig()
    return listFiles(cfg.workspaceRoot)
  })

  ipcMain.handle('search:files', async (_e, options: SearchOptions) => {
    const cfg = loadConfig()
    return searchInFiles(cfg.workspaceRoot, options)
  })

  ipcMain.handle(
    'search:replace',
    async (_e, paths: string[], options: SearchOptions, replacement: string) => {
      const cfg = loadConfig()
      return replaceInFiles(cfg.workspaceRoot, paths, options, replacement)
    }
  )

  ipcMain.handle('fs:write', async (_e, path: string, text: string, meta: FileMeta, dryRun = false) => {
    guard(path)
    return writeFileContent(path, text, meta, dryRun)
  })

  ipcMain.handle('fs:create', async (_e, parent: string, name: string, isDir: boolean) => {
    const cfg = loadConfig()
    assertInside(cfg.workspaceRoot, parent)
    return createEntry(parent, name, isDir)
  })

  ipcMain.handle('fs:rename', async (_e, from: string, to: string) => {
    const cfg = loadConfig()
    assertInside(cfg.workspaceRoot, from)
    assertInside(cfg.workspaceRoot, dirname(to))
    return renameEntry(from, to)
  })

  ipcMain.handle('fs:remove', async (_e, path: string) => {
    const cfg = loadConfig()
    assertInside(cfg.workspaceRoot, path)
    await removeEntry(path)
  })

  ipcMain.handle('fs:reveal', async (_e, path: string) => {
    const abs = guard(path)

    try {
      shell.showItemInFolder(abs)
      return { ok: true }
    } catch (err) {
      // 兜底：至少把所在目录打开
      const message = await shell.openPath(dirname(abs))
      return { ok: !message, error: message || String(err) }
    }
  })

  ipcMain.handle('fs:trash', async (_e, path: string) => {
    guard(path)
    await shell.trashItem(path)
  })

  ipcMain.handle('app:copyText', (_e, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.handle('app:readText', () => clipboard.readText())

  // 启动时命令行带进来的文件，由渲染进程启动完成后取走
  ipcMain.handle('app:takePendingFile', () => deps.takePendingFile())

  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('fs:openDir', async (_e, path: string) => {
    const cfg = loadConfig()
    assertInside(cfg.workspaceRoot, path)
    await ensureDir(path)
    return shell.openPath(path)
  })

  ipcMain.handle('assets:info', () => {
    const cfg = loadConfig()
    const dir = join(cfg.workspaceRoot, cfg.assetsDir || '.assets', 'img')
    return { dir, today: join(dir, dayStamp()) }
  })

  ipcMain.handle('state:load', () => loadEditorState())
  ipcMain.handle('state:save', (_e, state: SavedEditorState) => saveEditorState({ ...state, cleanExit: false }))

  ipcMain.handle('fs:exists', (_e, path: string) => existsSync(path))

  ipcMain.handle('fs:ensureDir', async (_e, path: string) => {
    const cfg = loadConfig()
    assertInside(cfg.workspaceRoot, path)
    await ensureDir(path)
  })

  ipcMain.handle('fs:nextPath', async (_e, dir: string, name: string) => {
    const cfg = loadConfig()
    assertInside(cfg.workspaceRoot, dir)
    return nextAvailablePath(dir, name)
  })

  ipcMain.handle('fs:pickOpen', async () => {
    const win = deps.getWindow()
    const options = {
      properties: ['openFile'] as Array<'openFile'>,
      filters: [
        { name: '文本', extensions: ['txt', 'md', 'sql', 'json', 'log', 'yml', 'yaml', 'ini', 'csv'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    // 用户亲手选的文件：授权，可以被 fs:read / fs:stat / fs:write 访问
    allowExternalFile(result.filePaths[0])
    return result.filePaths[0]
  })

  /** 渲染层有明确的用户手势（拖入窗口、命令行、最近文件）时调这个 */
  ipcMain.handle('fs:allow', (_e, path: string) => {
    if (!existsSync(path)) return false
    allowExternalFile(path)
    return true
  })

  ipcMain.handle('fs:pickImage', async () => {
    const win = deps.getWindow()
    const options = {
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // 多选图片（给 AI 面板做附件用，不做裁剪）
  ipcMain.handle('fs:pickImages', async () => {
    const win = deps.getWindow()
    const options = {
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })

  /** 把用户选的图片复制进工作区 .assets/bg/，配置里只存相对路径 */
  ipcMain.handle('fs:importImage', async (_e, sourcePath: string) => {
    const cfg = loadConfig()
    if (!existsSync(sourcePath)) return null
    const dir = join(cfg.workspaceRoot, cfg.assetsDir, 'bg')
    await mkdir(dir, { recursive: true })

    const original = basename(sourcePath)
    const ext = extname(original)
    const stem = original.slice(0, original.length - ext.length)
    let target = join(dir, original)
    let index = 1
    while (existsSync(target)) {
      target = join(dir, `${stem}-${index}${ext}`)
      index += 1
    }
    await copyFile(sourcePath, target)
    return {
      path: relative(cfg.workspaceRoot, target).split(sep).join('/'),
      name: basename(target),
    }
  })

  const IMAGE_MIME: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
  }

  /** 把图片读成 data URL（裁剪对话框要用，th-asset 只允许工作区内路径） */
  ipcMain.handle('fs:readImageData', async (_e, sourcePath: string) => {
    if (!existsSync(sourcePath)) return null
    const data = await readFile(sourcePath)
    if (data.byteLength > 40 * 1024 * 1024) throw new Error('图片太大（超过 40 MB）')
    const type = IMAGE_MIME[extname(sourcePath).toLowerCase()] ?? 'image/png'
    return {
      dataUrl: `data:${type};base64,${data.toString('base64')}`,
      name: basename(sourcePath),
    }
  })

  /** 保存裁剪结果到 .assets/bg/ */
  ipcMain.handle('fs:writeImage', async (_e, dataUrl: string, originalName: string) => {
    const match = /^data:image\/(png|jpeg|webp);base64,([\s\S]+)$/.exec(dataUrl)
    if (!match) throw new Error('图片数据格式不对')
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
    const buffer = Buffer.from(match[2], 'base64')
    if (buffer.length < 1024) throw new Error('图片数据不完整，请重新选取')
    // 至少校验一下文件头，避免把半截数据写进工作区
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50
    const isWebp = buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    if (!isJpeg && !isPng && !isWebp) throw new Error('图片数据格式无法识别')
    const cfg = loadConfig()
    const dir = join(cfg.workspaceRoot, cfg.assetsDir, 'bg')
    await mkdir(dir, { recursive: true })

    const stem = (originalName.replace(/\.[^.]+$/, '') || 'background').slice(0, 40)
    const stamp = Date.now().toString(36)
    let target = join(dir, `${stem}-${stamp}.${ext}`)
    let index = 1
    while (existsSync(target)) {
      target = join(dir, `${stem}-${stamp}-${index}.${ext}`)
      index += 1
    }
    await writeFile(target, buffer)
    return {
      path: relative(cfg.workspaceRoot, target).split(sep).join('/'),
      name: basename(target),
    }
  })

  ipcMain.handle('fs:pickSave', async (_e, defaultPath: string) => {
    const win = deps.getWindow()
    const cfg = loadConfig()
    const options = {
      defaultPath,
      filters: [
        { name: '文本', extensions: ['txt', 'md', 'sql', 'json', 'log', 'yml', 'yaml', 'ini', 'csv'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    // 另存到工作区外也允许，但要先授权，否则接下来的 fs:write 会被拦
    allowExternalFile(result.filePath)
    return result.filePath
  })

  /* ---------- 图库 ---------- */
  ipcMain.handle('assets:save', (_e, input: { docPath: string | null; mime: string; bytes: Uint8Array }) => {
    const cfg = loadConfig()
    if (input.docPath) assertInside(cfg.workspaceRoot, input.docPath)
    return savePastedImage(cfg.workspaceRoot, cfg.assetsDir, input.docPath, input.mime, Buffer.from(input.bytes))
  })

  /* ---------- 内置对话（直连模型） ---------- */
  const controllers = new Map<string, AbortController>()

  /* 写入确认：主进程发起 → 渲染进程弹 diff → 回结果 */
  const pendingApprovals = new Map<string, (ok: boolean) => void>()

  ipcMain.on('ai:approval:result', (_e, payload: { id: string; ok: boolean }) => {
    const resolve = pendingApprovals.get(payload.id)
    if (!resolve) return
    pendingApprovals.delete(payload.id)
    resolve(Boolean(payload.ok))
  })

  /* 工作区外文件：agent 申请 → 用户点一次 → 本次会话记住 */
  const pendingAccess = new Map<string, (decision: 'deny' | 'read' | 'write') => void>()
  /** 规范化路径 → 已授予的权限（进程内记住，重启失效） */
  const agentAccess = new Map<string, 'read' | 'write'>()

  /** agent 申请工作区外文件的权限：已授权直接返回，否则弹窗问用户 */
  async function requestAgentAccess(
    sender: Electron.WebContents,
    path: string,
    mode: 'read' | 'write'
  ): Promise<'deny' | 'read' | 'write'> {
    const cfg = loadConfig()
    if (insideWorkspace(cfg.workspaceRoot, path)) return 'write'

    const key = normPath(path)
    const granted = agentAccess.get(key)
    if (granted === 'write' || (granted === 'read' && mode === 'read')) return granted
    // 定时任务等没有窗口的场景：不给权限，也不弹窗
    if (sender.isDestroyed()) return 'deny'

    return new Promise<'deny' | 'read' | 'write'>((resolve) => {
      const accessId = `ac_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      const timer = setTimeout(() => {
        if (pendingAccess.delete(accessId)) resolve('deny')
      }, 120_000)
      pendingAccess.set(accessId, (decision) => {
        clearTimeout(timer)
        if (decision !== 'deny') agentAccess.set(key, decision)
        resolve(decision)
      })
      sender.send('ai:access', { id: accessId, path, mode })
    })
  }

  // 开发期调试入口：真机打包后不存在
  if (!app.isPackaged) {
    ipcMain.handle('debug:access', (event, path: string, mode: 'read' | 'write') =>
      requestAgentAccess(event.sender, path, mode)
    )
  }

  ipcMain.on('ai:access:result', (_e, payload: { id: string; decision: 'deny' | 'read' | 'write' }) => {
    const resolve = pendingAccess.get(payload.id)
    if (!resolve) return
    pendingAccess.delete(payload.id)
    resolve(payload.decision ?? 'deny')
  })

  ipcMain.handle('ai:model', () => modelInfo(loadConfig()))
  ipcMain.handle('ai:models', () => listModels(loadConfig()))

  ipcMain.handle('ai:chat', async (event, payload: { id: string; messages: ChatMessage[]; knowledgeMode?: boolean }) => {
    const cfg = loadConfig()
    // 每次对话前确保 MCP 已连：否则「设置页还没打开过」时模型看不到外部工具
    try {
      await connectMcpServers(cfg.mcpServers)
    } catch (err) {
      trace(`MCP 连接失败（不影响本轮对话）: ${err instanceof Error ? err.message : String(err)}`)
    }
    const controller = new AbortController()
    controllers.set(payload.id, controller)
    const sender = event.sender
    const send = (channel: string, data: unknown): void => {
      if (!sender.isDestroyed()) sender.send(channel, data)
    }

    void runAgent({
      cfg,
      // 用户在设置里关掉的工具，模型就看不到
      allowedTools: [...enabledToolSet(cfg)],
      // 知识库开关：只有用户勾了才鼓励检索，避免每轮都去翻笔记
      systemExtra: payload.knowledgeMode
        ? [
            '本轮用户勾选了「知识库」：回答前先用 search_files 在 知识库/ 里检索相关笔记，优先引用已有结论，引用格式写成 路径:行号。',
            '知识库里没有相关内容时，明确说一句知识库里没有，再给通用答案，不要编造笔记内容。',
          ].join(String.fromCharCode(10))
        : [
            '本轮用户没有勾选「知识库」：不要主动检索 知识库/，直接回答问题。',
            '只有用户明确说查知识库、看看笔记、我以前记过吗，才检索。',
          ].join(String.fromCharCode(10)),
      messages: payload.messages.filter((m) => m.role !== 'system') as AgentMessage[],
      signal: controller.signal,
      toolContext: {
        root: cfg.workspaceRoot,
        assetsDir: cfg.assetsDir,
        userData: app.getPath('userData'),
        memorySemantic: cfg.memorySemantic === true,
        openInEditor: (path: string) => send('file:open', path),
        requestAccess: (path: string, mode: 'read' | 'write') => requestAgentAccess(sender, path, mode),
        appControl: (action: string, payload?: unknown) => requestAppControl(sender, action, payload),
        confirmMcpCall: async (server: string, tool: string, args: unknown): Promise<boolean> => {
          let preview = ''
          try {
            preview = JSON.stringify(args, null, 2).slice(0, 500)
          } catch {
            preview = String(args)
          }
          const choice = await askInApp(sender, {
            title: '外部工具调用',
            message: `MCP 服务器「${server}」要执行 ${tool.split('__')[1] ?? tool}`,
            detail: `参数：\n${preview}`,
            buttons: ['拒绝', '允许'],
            // 蓝色给「允许」，但回车/Esc 仍是拒绝，避免误触
            primaryId: 1,
            defaultId: 0,
            cancelId: 0,
          })
          return choice === 1
        },
        // 归档区写入门禁：默认拒；用户选「本轮都允许」后，本次会话不再问
        archiveWrite: async (path: string, summary: string): Promise<'allow' | 'session' | 'deny'> => {
          if (archiveGrant.get(sender.id)) return 'allow'
          const choice = await askInApp(sender, {
            title: '写入归档区',
            message: 'agent 想往 知识库/记忆 里写文件',
            detail: summary,
            buttons: ['取消', '写入', '本轮都允许'],
            primaryId: 1,
            defaultId: 0,
            cancelId: 0,
          })
          if (choice === 2) {
            archiveGrant.set(sender.id, true)
            return 'session'
          }
          return choice === 1 ? 'allow' : 'deny'
        },
        // 危险操作：用原生确认框，避免在渲染层再做一套弹窗
        confirm: async (title: string, detail: string): Promise<boolean> => {
          const win = BrowserWindow.fromWebContents(sender)
          const options = {
            type: 'warning' as const,
            title,
            message: title,
            detail,
            buttons: ['取消', '确定'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          }
          const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
          return result.response === 1
        },
        getSelection: async () => {
          cachedSelection = await requestSelection(sender)
          if (!cachedSelection) return null
          return { text: cachedSelection.text, from: cachedSelection.from, to: cachedSelection.to, path: cachedSelection.path }
        },
        replaceSelection: async (text: string) => {
          if (!cachedSelection) return false
          const ok = await replaceSelection(sender, text, cachedSelection)
          if (ok) cachedSelection = null
          return ok
        },
        approve: (request) =>
          new Promise<boolean>((resolve) => {
            const approvalId = `ap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
            const timer = setTimeout(() => {
              if (pendingApprovals.delete(approvalId)) resolve(false)
            }, 120_000)
            pendingApprovals.set(approvalId, (ok) => {
              clearTimeout(timer)
              resolve(ok)
            })
            send('ai:approval', { id: approvalId, ...request })
          }),
        // 脚本执行前确认：把源码摊给用户看
        approveScript: (request) =>
          new Promise<boolean>((resolve) => {
            const approvalId = `sc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
            const timer = setTimeout(() => {
              if (pendingApprovals.delete(approvalId)) resolve(false)
            }, 300_000)
            pendingApprovals.set(approvalId, (ok) => {
              clearTimeout(timer)
              resolve(ok)
            })
            send('ai:script', { id: approvalId, ...request })
          }),
      },
      events: {
        onDelta: (kind, text) => send('ai:delta', { id: payload.id, kind, text }),
        onTool: (toolEvent) => send('ai:tool', { id: payload.id, ...toolEvent }),
        onUsage: (usage) => send('ai:usage', { id: payload.id, ...usage }),
        onRetry: (attempt, reason) => send('ai:retry', { id: payload.id, attempt, reason }),
      },
    })
      .then(({ steps }) => send('ai:done', { id: payload.id, steps }))
      .catch((err: unknown) => {
        const aborted = controller.signal.aborted
        send('ai:done', {
          id: payload.id,
          aborted,
          error: aborted ? undefined : err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => controllers.delete(payload.id))

    return { id: payload.id }
  })

  ipcMain.on('ai:abort', (_e, id: string) => {
    controllers.get(id)?.abort()
    controllers.delete(id)
  })

  /* ---------- 定时任务 ---------- */
  ipcMain.handle('tasks:list', () => {
    const cfg = loadConfig()
    const scheduler = deps.getScheduler()
    return cfg.tasks.map((task) => ({
      ...task,
      running: scheduler?.isRunning(task.id) ?? false,
      next: scheduler?.describe(task) ?? '',
    }))
  })

  ipcMain.handle('tasks:toggle', (_e, id: string, enabled: boolean) => {
    const cfg = loadConfig()
    patchConfig({ tasks: cfg.tasks.map((task) => (task.id === id ? { ...task, enabled } : task)) })
    return true
  })

  ipcMain.handle('tasks:run', async (_e, id: string) => {
    const scheduler = deps.getScheduler()
    if (!scheduler) throw new Error('调度器未启动')
    await scheduler.runNow(id)
  })

  ipcMain.on('app:activity', () => deps.getScheduler()?.touch())

  // 只允许 http/https，避免被当成任意协议处理器
  function dataUrlToBuffer(dataUrl: string): Buffer {
    const comma = dataUrl.indexOf(',')
    const meta = comma >= 0 ? dataUrl.slice(0, comma) : ''
    const body = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
    return meta.includes('base64') ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8')
  }

  ipcMain.handle(
    'app:saveExport',
    async (_event, dataUrl: string, defaultName: string, kind: 'png' | 'svg' | 'pdf') => {
      const filters =
        kind === 'png'
          ? [{ name: 'PNG 图片', extensions: ['png'] }]
          : kind === 'svg'
            ? [{ name: 'SVG 图片', extensions: ['svg'] }]
            : [{ name: 'PDF 文档', extensions: ['pdf'] }]
      const picked = await dialog.showSaveDialog({
        title: '保存卡片',
        defaultPath: join(app.getPath('downloads'), defaultName),
        filters,
      })
      if (picked.canceled || !picked.filePath) return { ok: false }
      await writeFile(picked.filePath, dataUrlToBuffer(dataUrl))
      return { ok: true, path: picked.filePath }
    }
  )

  ipcMain.handle('app:exportPdf', async (_event, pngDataUrl: string, defaultName: string) => {
    const picked = await dialog.showSaveDialog({
      title: '保存卡片 PDF',
      defaultPath: join(app.getPath('downloads'), defaultName),
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
    })
    if (picked.canceled || !picked.filePath) return { ok: false }

    const buffer = dataUrlToBuffer(pngDataUrl)
    // PNG 头里读宽高：16/20 字节，大端
    let width = 0
    let height = 0
    if (buffer.length > 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
      width = buffer.readUInt32BE(16)
      height = buffer.readUInt32BE(20)
    }

    // 用临时文件而不是 data: URL：2x 卡片图片可以有十几 MB，
    // Chromium 的 data URL 长度上限会直接报 ERR_INVALID_URL (-300)
    const tempDir = await mkdtemp(join(app.getPath('temp'), 'th-card-'))
    const pngPath = join(tempDir, 'card.png')
    const htmlPath = join(tempDir, 'card.html')
    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: { sandbox: true },
    })
    try {
      await writeFile(pngPath, buffer)
      const html =
        '<!doctype html><html><head><meta charset="utf-8"><style>' +
        '@page { margin: 0; }' +
        'html, body { margin: 0; padding: 0; background: #fff; }' +
        'img { display: block; width: 100%; height: auto; }' +
        '</style></head><body><img src="' + pathToFileURL(pngPath).href + '"></body></html>'
      await writeFile(htmlPath, html, 'utf8')
      await win.loadFile(htmlPath)

      // 页面高度按卡片比例算，整张卡片放在一页里，不分页切断
      const pageWidthIn = 8.27
      const pageHeightIn =
        width > 0 && height > 0
          ? Math.min(200, Math.max(2, (pageWidthIn * height) / width))
          : 11.69

      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: { width: pageWidthIn, height: pageHeightIn },
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        preferCSSPageSize: false,
      })
      await writeFile(picked.filePath, pdf)
      return { ok: true, path: picked.filePath }
    } finally {
      win.destroy()
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
  ipcMain.handle('onenote:status', async () => getOneNoteStatus())

  ipcMain.handle('onenote:run', async (event) => {
    const config = loadConfig()
    const configOnProgress = (progress: { phase: string; percent?: number; message?: string }): void => {
      if (!event.sender.isDestroyed()) event.sender.send('onenote:progress', progress)
    }
    const exported = await runOneNoteExport(configOnProgress)
    if (!exported.ok || !exported.dir) {
      return {
        ok: false,
        imported: 0,
        skipped: 0,
        failed: 0,
        error: exported.error ?? '导出失败',
        logPath: exported.logPath,
      }
    }
    configOnProgress({ phase: 'import', message: '正在导入到工作区…' })
    const result = await importNotes({
      source: 'markdown',
      inputPath: exported.dir,
      workspaceRoot: config.workspaceRoot,
    })
    return {
      ok: result.ok,
      imported: result.imported,
      skipped: result.skipped,
      failed: result.failed,
      targetDir: result.targetDir,
      error: result.errors[0],
    }
  })

  ipcMain.handle('feishu:status', async () => feishuStatus())

  ipcMain.handle('feishu:install', async (event) => {
    const send = (progress: unknown): void => {
      if (!event.sender.isDestroyed()) event.sender.send('feishu:progress', progress)
    }
    return installLarkCli(send as never)
  })

  ipcMain.handle('feishu:login', async (event) => {
    const send = (progress: unknown): void => {
      if (!event.sender.isDestroyed()) event.sender.send('feishu:progress', progress)
    }
    return loginFeishu(send as never)
  })

  ipcMain.handle('feishu:pull', async (_event, doc: string) => pullFeishuDoc(doc))

  ipcMain.handle('feishu:switchApp', async (event, mode: 'new' | 'bind', payload: { appId?: string; appSecret?: string }) => {
    const send = (progress: unknown): void => {
      if (!event.sender.isDestroyed()) event.sender.send('feishu:progress', progress)
    }
    return switchFeishuApp(mode, payload ?? {}, send as never)
  })

  ipcMain.handle('feishu:list', async () => listFeishuDocs())
  ipcMain.handle('feishu:docInfo', async (_event, path: string) => feishuDocInfo(path))
  ipcMain.handle('feishu:remote', async (_event, path: string) => feishuRemoteContent(path))

  ipcMain.handle('feishu:search', async (_event, query: string) => searchFeishuDocs(query))

  ipcMain.handle('feishu:pullMany', async (event, refs: string[]) =>
    pullFeishuDocs(refs, (message) => {
      if (!event.sender.isDestroyed()) event.sender.send('feishu:progress', { phase: 'fetch', message })
    })
  )
  ipcMain.handle('feishu:push', async (_event, path: string, doc?: string) => pushFeishuDoc(path, doc))

  ipcMain.handle('app:copyImage', async (_event, dataUrl: string) => {
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) return { ok: false }
    clipboard.writeImage(image)
    return { ok: true }
  })

  ipcMain.handle('app:revealPath', async (_event, target: string) => {
    shell.showItemInFolder(target)
  })

  ipcMain.handle('import:pick', async (_event, source: ImportSource) => {
    const isFolder = source === 'markdown'
    const filters =
      source === 'enex'
        ? [{ name: 'Evernote 导出', extensions: ['enex'] }]
        : source === 'docx'
          ? [{ name: 'Word 文档', extensions: ['docx'] }]
          : source === 'html'
            ? [{ name: '网页', extensions: ['html', 'htm'] }]
            : source === 'zip'
              ? [{ name: '压缩包', extensions: ['zip'] }]
              : []
    const picked = await dialog.showOpenDialog({
      title: isFolder ? '选择 Markdown / Obsidian 文件夹' : '选择要导入的文件',
      properties: isFolder ? ['openDirectory'] : ['openFile'],
      filters: filters.length > 0 ? filters : undefined,
    })
    return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]
  })

  ipcMain.handle(
    'import:run',
    async (
      _event,
      options: { source: ImportSource; inputPath: string; conflict?: 'rename' | 'skip' | 'overwrite' }
    ) => {
      const config = loadConfig()
      return importNotes({ ...options, workspaceRoot: config.workspaceRoot })
    }
  )

  ipcMain.handle('backup:create', async () => {
    const config = loadConfig()
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
    const picked = await dialog.showSaveDialog({
      title: '备份工作区',
      defaultPath: join(app.getPath('documents'), 'textharness-backup-' + stamp + '.zip'),
      filters: [{ name: 'ZIP 备份', extensions: ['zip'] }],
    })
    if (picked.canceled || !picked.filePath) return { ok: false, files: 0, bytes: 0 }
    return createBackup(config.workspaceRoot, picked.filePath)
  })

  ipcMain.handle('backup:restore', async () => {
    const config = loadConfig()
    const picked = await dialog.showOpenDialog({
      title: '从备份恢复',
      properties: ['openFile'],
      filters: [{ name: 'ZIP 备份', extensions: ['zip'] }],
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, restored: 0, skipped: 0 }
    return restoreBackup(picked.filePaths[0], config.workspaceRoot)
  })

  ipcMain.handle('app:openUrl', async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http/https 链接')
    await shell.openExternal(url)
  })

  /* ---------- 应用控制 RPC（agent 操作编辑器本身） ---------- */
  const pendingApp = new Map<string, (value: { ok: boolean; data?: unknown; text: string }) => void>()

  ipcMain.on('app:rpc:reply', (_e, payload: { id: string; ok: boolean; data?: unknown; text: string }) => {
    const resolve = pendingApp.get(payload.id)
    if (!resolve) return
    pendingApp.delete(payload.id)
    resolve(payload)
  })

  function requestAppControl(
    sender: Electron.WebContents,
    action: string,
    payload: unknown,
    timeoutMs = 6000
  ): Promise<{ ok: boolean; data?: unknown; text: string }> {
    return new Promise((resolve) => {
      if (sender.isDestroyed()) {
        resolve({ ok: false, text: '窗口已关闭，无法操作界面。' })
        return
      }
      const id = `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      const timer = setTimeout(() => {
        pendingApp.delete(id)
        resolve({ ok: false, text: '界面没有响应（超时）。' })
      }, timeoutMs)
      pendingApp.set(id, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
      sender.send('app:rpc', { id, action, payload })
    })
  }

  // 仅开发期：用来验证应用控制链路
  if (!app.isPackaged) {
    ipcMain.handle('debug:app', (event, action: string, payload: unknown) =>
      requestAppControl(event.sender, action, payload)
    )
  }

  /* ---------- 编辑器选区桥 ---------- */
  // 主进程的工具要拿选区/替换选区，但选区只在渲染层。用「请求-回复」走两趟 IPC。
  const pendingSelection = new Map<string, (value: SelectionInfo | null) => void>()
  const pendingReplace = new Map<string, (ok: boolean) => void>()
  const lastSelection = new Map<number, SelectionInfo>()

  ipcMain.on('editor:selection:reply', (_e, payload: SelectionInfo) => {
    const resolve = pendingSelection.get(payload.id)
    if (!resolve) return
    pendingSelection.delete(payload.id)
    resolve(payload.text ? payload : null)
  })

  ipcMain.on('editor:selection:replaced', (_e, payload: { id: string; ok: boolean }) => {
    const resolve = pendingReplace.get(payload.id)
    if (!resolve) return
    pendingReplace.delete(payload.id)
    resolve(Boolean(payload.ok))
  })

  const requestSelection = (sender: Electron.WebContents, timeoutMs = 4000): Promise<SelectionInfo | null> =>
    new Promise((resolve) => {
      if (sender.isDestroyed()) {
        resolve(null)
        return
      }
      const id = `sel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      const timer = setTimeout(() => {
        pendingSelection.delete(id)
        resolve(null)
      }, timeoutMs)
      pendingSelection.set(id, (value) => {
        clearTimeout(timer)
        if (value) lastSelection.set(sender.id, value)
        resolve(value)
      })
      sender.send('editor:selection:request', { id })
    })

  const replaceSelection = (sender: Electron.WebContents, text: string, current: SelectionInfo): Promise<boolean> =>
    new Promise((resolve) => {
      if (sender.isDestroyed()) {
        resolve(false)
        return
      }
      const id = `rep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      const timer = setTimeout(() => {
        pendingReplace.delete(id)
        resolve(false)
      }, 4000)
      pendingReplace.set(id, (ok) => {
        clearTimeout(timer)
        resolve(ok)
      })
      sender.send('editor:selection:replace', { id, text, from: current.from, to: current.to })
    })

  let cachedSelection: SelectionInfo | null = null

  ipcMain.handle('tools:list', () => {
    const base = listTools()
    // 外部 MCP 工具也列出来，让用户知道现在挂了多少个
    const external = mcpToolDefs().map((tool) => ({
      name: tool.function.name,
      label: tool.function.name,
      group: 'mcp' as const,
      summary: tool.function.description,
      enabled: true,
      dangerous: false,
    }))
    return [...base, ...external]
  })

  /* ---------- 自动更新 ---------- */
  ipcMain.handle('update:check', () => checkUpdateNow())
  ipcMain.handle('update:install', () => quitAndInstallUpdate())
  ipcMain.handle('update:feed', () => updateFeed())

  /* ---------- 会话 ---------- */
  ipcMain.handle('sessions:list', () => listSessions())
  ipcMain.handle('sessions:load', (_e, id: string) => loadSession(id))
  ipcMain.handle('sessions:save', (_e, session: StoredSession) => saveSession(session))
  ipcMain.handle('sessions:delete', (_e, id: string) => deleteSession(id))

  /* 草稿任务队列：一次只跑一个总结，避免并发触发限流 */
  const draftJobs: Array<() => Promise<void>> = []
  let draftJobRunning = false
  const runNextDraftJob = (): void => {
    if (draftJobRunning) return
    const job = draftJobs.shift()
    if (!job) return
    draftJobRunning = true
    void job().finally(() => {
      draftJobRunning = false
      runNextDraftJob()
    })
  }
  const enqueueDraftJob = (job: () => Promise<void>): void => {
    draftJobs.push(job)
    runNextDraftJob()
  }

  /** 本轮已允许写归档区的 webContents（新会话时清空） */
  const archiveGrant = new Map<number, boolean>()

  /* ---------- 归档 ---------- */
  ipcMain.handle('archive:headings', (_e, relPath: string) => {
    const cfg = loadConfig()
    try {
      const text = readFileSync(join(cfg.workspaceRoot, String(relPath)), 'utf8')
      return { ok: true, headings: listHeadings(text) }
    } catch (err) {
      return { ok: false, headings: [], text: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('archive:append', (_e, relPath: string, section: string, afterLine?: number) => {
    const cfg = loadConfig()
    try {
      if (typeof afterLine === 'number' && afterLine >= 0) {
        const target = join(cfg.workspaceRoot, String(relPath))
        const previous = readFileSync(target, 'utf8')
        writeFileSync(target, insertAfterHeading(previous, afterLine, String(section)), 'utf8')
        return { ok: true, path: relPath, text: `已插入到 ${relPath}`, undo: { path: target, action: 'restore' as const, previous } }
      }
      return appendToNote(cfg.workspaceRoot, String(relPath), String(section))
    } catch (err) {
      return { ok: false, path: relPath, text: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('archive:noteContent', (_e, relPath: string) => {
    const cfg = loadConfig()
    const target = join(cfg.workspaceRoot, String(relPath))
    try {
      return { ok: true, text: readFileSync(target, 'utf8') }
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('archive:notes', () => {
    const cfg = loadConfig()
    return listKnowledgeNotes(cfg.workspaceRoot)
  })
  ipcMain.handle('archive:categories', () => {
    const cfg = loadConfig()
    return listKnowledgeCategories(cfg.workspaceRoot)
  })
  ipcMain.handle('archive:write', (_e, request: ArchiveRequest) => {
    const cfg = loadConfig()
    const granted = archiveGrant.get(_e.sender.id) === true
    if (!granted) archiveGrant.set(_e.sender.id, true)
    return archiveWrite(cfg.workspaceRoot, request)
  })
  ipcMain.handle('archive:undo', (_e, undo: { path: string; action: 'delete' | 'restore'; previous?: string }) => {
    const cfg = loadConfig()
    return archiveUndo(cfg.workspaceRoot, undo)
  })
  ipcMain.handle('archive:draftList', () => {
    const cfg = loadConfig()
    return { drafts: loadDrafts(app.getPath('userData')), pending: pendingCount(app.getPath('userData')), workspace: cfg.workspaceRoot }
  })

  ipcMain.handle(
    'archive:draftCreate',
    async (
      _e,
      input: {
        title: string
        content: string
        target: 'knowledge' | 'memory'
        category?: string
        memoryKind?: 'fact' | 'log' | 'template'
        source?: string
        mergeInto?: string
        summarize: boolean
      }
    ) => {
      const userData = app.getPath('userData')
      const cfg = loadConfig()
      // 原样长度有限，避免草稿文件过大
      const draft = createDraft(userData, {
        title: input.title,
        content: input.content,
        target: input.target,
        category: input.category,
        memoryKind: input.memoryKind,
        source: input.source ?? 'chat',
        mergeInto: input.mergeInto,
        mode: input.mergeInto ? (input.summarize ? 'rewrite' : 'append') : undefined,
        status: input.summarize ? 'running' : 'pending',
        summarized: !input.summarize,
      })

      if (input.summarize) {
        enqueueDraftJob(async () => {
          try {
            if (input.mergeInto) {
              // 合并 + 总结：让模型把新内容并进原文档并重组整篇
              const existing = readFileSync(join(cfg.workspaceRoot, input.mergeInto), 'utf8')
              const merged = await reorganizeForMerge(cfg, existing, input.content, input.title)
              updateDraft(userData, draft.id, {
                content: merged,
                baseContent: existing,
                mode: 'rewrite',
                status: 'pending',
                summarized: true,
              })
            } else {
              const summary = await summarizeForArchive(cfg, input.content, input.title)
              updateDraft(userData, draft.id, { content: summary, status: 'pending', summarized: true })
            }
          } catch (err) {
            // 总结失败就保留原文，标成 failed 但仍可确认写入
            updateDraft(userData, draft.id, {
              status: 'pending',
              summarized: false,
              error: err instanceof Error ? err.message : String(err),
            })
          }
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('archive:draftChanged', { pending: pendingCount(userData) })
          }
        })
      }

      // 立刻通知界面刷新 badge（总结完成后还会再通知一次）
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('archive:draftChanged', { pending: pendingCount(userData) })
      }
      return { draft, pending: pendingCount(userData) }
    }
  )

  ipcMain.handle('archive:draftUpdate', (_e, id: string, patch: { title?: string; content?: string }) => {
    const userData = app.getPath('userData')
    const updated = updateDraft(userData, id, patch)
    return { draft: updated, pending: pendingCount(userData) }
  })

  ipcMain.handle('archive:draftDiscard', (_e, id: string) => {
    const userData = app.getPath('userData')
    updateDraft(userData, id, { status: 'discarded' })
    return { pending: pendingCount(userData) }
  })

  ipcMain.handle('archive:draftConfirm', (_e, id: string, force = false) => {
    const userData = app.getPath('userData')
    const cfg = loadConfig()
    const draft = getDraft(userData, id)
    if (!draft) return { ok: false, text: '草稿不存在' }
    try {
      if (draft.mergeInto && draft.mode === 'rewrite') {
        const target = join(cfg.workspaceRoot, draft.mergeInto)
        const previous = readFileSync(target, 'utf8')
        // 草稿基于旧快照：目标文件期间被改过就提醒，避免覆盖别人的修改
        if (!force && typeof draft.baseContent === 'string' && previous !== draft.baseContent) {
          return {
            ok: false,
            stale: true,
            text: '目标文档在草稿生成之后被修改过，直接覆盖会丢掉这些改动',
          }
        }
        writeFileSync(target, `${draft.content.trim()}\n`, 'utf8')
        updateDraft(userData, id, { status: 'written' })
        return {
          ok: true,
          path: draft.mergeInto,
          undo: { path: target, action: 'restore' as const, previous },
          pending: pendingCount(userData),
          text: `已按新结构覆盖 ${draft.mergeInto}`,
        }
      }
      if (draft.mergeInto) {
        const appended = appendToNote(cfg.workspaceRoot, draft.mergeInto, draft.content)
        if (!appended.ok) return { ok: false, text: appended.text }
        updateDraft(userData, id, { status: 'written' })
        return {
          ok: true,
          path: appended.path,
          undo: appended.undo,
          pending: pendingCount(userData),
          text: appended.text,
        }
      }
      const result = archiveWrite(cfg.workspaceRoot, {
        target: draft.target,
        category: draft.category,
        title: draft.title,
        content: draft.content,
        memoryKind: draft.memoryKind,
        source: draft.source,
      })
      updateDraft(userData, id, { status: 'written' })
      return { ok: true, path: result.path, undo: result.undo, pending: pendingCount(userData), text: result.text }
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('archive:draftRegenerate', async (_e, id: string) => {
    const userData = app.getPath('userData')
    const cfg = loadConfig()
    const draft = getDraft(userData, id)
    if (!draft) return { ok: false }
    updateDraft(userData, id, { status: 'running', error: undefined })
    try {
      const summary = await summarizeForArchive(cfg, draft.content, draft.title)
      updateDraft(userData, id, { content: summary, status: 'pending', summarized: true })
      return { ok: true, pending: pendingCount(userData) }
    } catch (err) {
      updateDraft(userData, id, {
        status: 'pending',
        error: err instanceof Error ? err.message : String(err),
      })
      return { ok: false, text: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('archive:resetGrant', () => {
    archiveGrant.clear()
    return { ok: true }
  })

}
